'use strict';

/**
 * Realtime hub.
 *
 * Browser tabs keep one Server-Sent Events connection to /api/events.
 * This module watches the database two ways:
 *   1. Supabase Realtime (instant, when available)
 *   2. A lightweight safety poll (catches anything Realtime misses and keeps
 *      working even if Realtime is unavailable on the project)
 *
 * Events pushed to browsers:
 *   { type: 'hello', realtime: bool }
 *   { type: 'change', table, eventType, record }   -> pages refetch their data
 *   { type: 'order_created', order: {...} }        -> kitchen: new order alert
 */

const { config } = require('./config');
const { getClient } = require('./supabase');
const { toCents } = require('./lib/helpers');

const clients = new Set();
let channel = null;
let realtimeUp = false;
let channelStarted = false;
let lastPollAt = 0;
let lastSignatures = null;
let lastOrderId = null;
let pollFailures = 0;

const POLL_FAST_MS = 3000; // realtime unavailable
const POLL_SAFETY_MS = 15000; // realtime up - safety net only
const SAFE_USERS_FIELDS = ['id', 'username', 'full_name', 'role', 'is_active'];

function sseSend(client, payload) {
  try {
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function broadcast(payload, requiredRole) {
  for (const client of [...clients]) {
    if (requiredRole && client.role !== requiredRole) continue;
    sseSend(client, payload);
  }
}

function sanitizeRecord(table, record) {
  if (!record) return null;
  if (table === 'users') {
    const out = {};
    for (const key of SAFE_USERS_FIELDS) if (key in record) out[key] = record[key];
    return out;
  }
  if (table === 'sessions') return null;
  return record;
}

function handleChange(table, payload) {
  const eventType = payload.eventType || payload.event_type || 'UPDATE';
  const rawRecord = eventType === 'DELETE' ? payload.old : payload.new;
  const record = sanitizeRecord(table, rawRecord);

  if (table === 'users' || table === 'audit_logs') {
    broadcast({ type: 'change', table, eventType, record }, 'admin');
  } else {
    broadcast({ type: 'change', table, eventType, record });
  }

  if (table === 'orders' && eventType === 'INSERT' && record) {
    broadcast({
      type: 'order_created',
      order: {
        id: record.id,
        number: record.order_number,
        numberLabel: `#${String(record.order_number).padStart(3, '0')}`,
        customerName: record.customer_name,
        orderType: record.order_type,
        totalCents: toCents(record.total),
        paymentStatus: record.payment_status,
        createdAt: record.created_at,
      },
    });
  }
}

function startRealtimeChannel() {
  const sb = getClient();
  if (!sb || channelStarted) return;
  channelStarted = true;

  try {
    channel = sb.channel('pos-live');
    for (const table of ['orders', 'order_items', 'menu_items', 'users', 'settings', 'audit_logs']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) =>
        handleChange(table, payload)
      );
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        realtimeUp = true;
        console.log('[realtime] connected to Supabase Realtime');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (realtimeUp) console.warn(`[realtime] channel ${status}, falling back to polling`);
        realtimeUp = false;
        // Try to resubscribe after a delay (supabase-js also retries internally).
        if (status !== 'CLOSED') {
          setTimeout(() => {
            if (!realtimeUp && channel) {
              try {
                channel.subscribe();
              } catch {
                /* ignored - polling keeps things working */
              }
            }
          }, 10000);
        }
      }
    });
  } catch (err) {
    console.warn('[realtime] could not start Supabase Realtime:', err.message);
    realtimeUp = false;
  }
}

/** Small fingerprint of each table used by the safety poll. */
async function tableSignature(sb, table, timeCol) {
  const [{ count }, { data }] = await Promise.all([
    sb.from(table).select('*', { count: 'exact', head: true }),
    sb.from(table).select(timeCol).order(timeCol, { ascending: false }).limit(1),
  ]);
  const latest = data && data[0] ? data[0][timeCol] : '';
  return `${count || 0}|${latest}`;
}

async function pollOnce() {
  const sb = getClient();
  if (!sb) return;
  try {
    const tables = [
      ['orders', 'updated_at'],
      ['menu_items', 'updated_at'],
      ['users', 'updated_at'],
      ['settings', 'updated_at'],
      ['audit_logs', 'created_at'],
    ];
    const signatures = {};
    const results = await Promise.all(
      tables.map(([table, timeCol]) => tableSignature(sb, table, timeCol).catch(() => null))
    );
    tables.forEach(([table], idx) => {
      signatures[table] = results[idx];
    });

    if (lastSignatures) {
      for (const [table] of tables) {
        if (signatures[table] !== null && signatures[table] !== lastSignatures[table]) {
          handleChange(table, { eventType: 'UPDATE', new: null });
        }
      }
    }
    lastSignatures = signatures;
    pollFailures = 0;

    // Detect new orders for the kitchen alert (independent of signature).
    const { data: latest } = await sb
      .from('orders')
      .select('id, order_number, customer_name, order_type, total, payment_status, created_at')
      .order('order_number', { ascending: false })
      .limit(1);
    const row = latest && latest[0];
    if (row) {
      if (lastOrderId === null) {
        lastOrderId = row.id;
      } else if (row.id !== lastOrderId) {
        lastOrderId = row.id;
        handleChange('orders', { eventType: 'INSERT', new: row });
      }
    }
  } catch (err) {
    pollFailures += 1;
    if (pollFailures === 1 || pollFailures % 10 === 0) {
      console.warn('[realtime] safety poll failed:', err.message);
    }
  }
}

function pollTick() {
  if (!clients.size) return;
  const minGap = realtimeUp ? POLL_SAFETY_MS : POLL_FAST_MS;
  if (Date.now() - lastPollAt < minGap) return;
  lastPollAt = Date.now();
  pollOnce();
}

/** Register a browser SSE connection. */
function addSseClient(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = { res, role: user.role, expiresAt: new Date(user.sessionExpiresAt).getTime() };
  clients.add(client);
  sseSend(client, { type: 'hello', realtime: realtimeUp, timezone: config.timezone });

  req.on('close', () => clients.delete(client));
  if (client.role === 'admin' || clients.size > 0) pollTick();
  return client;
}

function startRealtime() {
  if (!config.configured) return;

  startRealtimeChannel();

  // Heartbeat keeps proxies (Render) from closing idle SSE connections and
  // drops sessions that expired while connected.
  setInterval(() => {
    const now = Date.now();
    for (const client of [...clients]) {
      if (client.expiresAt < now) {
        try {
          client.res.end();
        } catch {
          /* ignore */
        }
        clients.delete(client);
        continue;
      }
      try {
        client.res.write(': ping\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, 20000);

  setInterval(pollTick, 3000);
}

function realtimeStatus() {
  return { realtimeUp, sseClients: clients.size };
}

module.exports = { startRealtime, addSseClient, broadcast, realtimeStatus };
