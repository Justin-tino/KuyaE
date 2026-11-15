'use strict';

/**
 * Realtime hub.
 *
 * Browser tabs keep one Server-Sent Events connection to /api/events.
 * Update events reach the browsers three ways, in order of speed:
 *   1. Direct broadcast from the API routes the moment a write succeeds
 *      (instant, and the only one that never depends on the database).
 *   2. Supabase Realtime (instant when the project has it enabled).
 *   3. A lightweight safety poll that compares row signatures (catches
 *      anything the first two miss, and keeps working when Realtime is off).
 *
 * Events pushed to browsers:
 *   { type: 'hello', realtime: bool }
 *   { type: 'ping' }                               -> keeps the client watchdog happy
 *   { type: 'change', table, eventType, record }   -> pages refetch their data
 *   { type: 'order_created', order: {...} }        -> kitchen: new order alert
 */

const { config } = require('./config');
const { getClient } = require('./supabase');
const { toCents } = require('./lib/helpers');

const clients = new Set();
const channels = new Map(); // table -> { ch, up }
let realtimeUp = false;
let channelStarted = false;
let lastPollAt = 0;
let lastSlowPollAt = 0;
let lastSignatures = null;
let lastOrderSignature = null;
let lastOrderId = null;
let pollFailures = 0;

// One channel per table. Supabase Realtime only reliably registers a single
// postgres_changes binding per channel, so bundling every table into one
// channel silently drops most events.
const REALTIME_TABLES = ['orders', 'order_items', 'menu_items', 'users', 'settings', 'audit_logs'];

// Orders drive the live kitchen / cashier screens, so they are polled quickly.
const ORDER_POLL_MS = 4000;
// Other tables only feed admin screens - a slower sweep is plenty.
const SLOW_POLL_MS = 20000;
const HEARTBEAT_MS = 15000;
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

/** Accepts both the raw database row and the API (serialized) order shape. */
function orderAlertPayload(order) {
  if (!order || !order.id) return null;
  const number = order.number !== undefined ? order.number : order.order_number;
  if (number === undefined || number === null) return null;
  return {
    id: order.id,
    number,
    numberLabel: order.numberLabel || `#${String(number).padStart(3, '0')}`,
    customerName: order.customerName !== undefined ? order.customerName : order.customer_name,
    orderType: order.orderType || order.order_type,
    totalCents: order.totalCents !== undefined ? order.totalCents : toCents(order.total),
    paymentStatus: order.paymentStatus || order.payment_status,
    createdAt: order.createdAt || order.created_at,
  };
}

function handleChange(table, payload) {
  try {
    const eventType = payload.eventType || payload.event_type || 'UPDATE';
    const rawRecord = eventType === 'DELETE' ? payload.old : payload.new;
    const record = sanitizeRecord(table, rawRecord);

    if (table === 'users' || table === 'audit_logs') {
      broadcast({ type: 'change', table, eventType, record }, 'admin');
    } else {
      broadcast({ type: 'change', table, eventType, record });
    }

    if (table === 'orders' && eventType === 'INSERT') {
      const order = orderAlertPayload(record);
      if (order) broadcast({ type: 'order_created', order });
    }
  } catch (err) {
    // A bad payload must never take down the hub (or the request that sent it).
    console.warn('[realtime] could not publish change:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Public helpers - routes call these right after a successful write so the
// other screens update instantly, with no wait for the database to notify us.
// ---------------------------------------------------------------------------

/** Tell every connected screen that a table changed. */
function publishChange(table, eventType = 'UPDATE', record = null) {
  if (clients.size === 0) return;
  try {
    handleChange(table, { eventType, new: record });
  } catch (err) {
    // Live updates must never break the write that produced them.
    console.warn('[realtime] publish failed:', err.message);
  }
}

/** Announce a brand new order (fires both the refetch and the kitchen alert). */
function publishOrderCreated(record) {
  if (clients.size === 0) return;
  try {
    handleChange('orders', { eventType: 'INSERT', new: record });
  } catch (err) {
    console.warn('[realtime] publish failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Supabase Realtime
// ---------------------------------------------------------------------------

function startRealtimeChannel() {
  const sb = getClient();
  if (!sb || channelStarted) return;
  channelStarted = true;

  for (const table of REALTIME_TABLES) subscribeTable(sb, table);
}

function refreshRealtimeUp() {
  const up = [...channels.values()].filter((entry) => entry.up).length;
  realtimeUp = up === REALTIME_TABLES.length;
  return up;
}

function subscribeTable(sb, table) {
  try {
    const ch = sb.channel(`pos-${table}`);
    const entry = { ch, up: false };
    channels.set(table, entry);
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) =>
      handleChange(table, payload)
    );
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        entry.up = true;
        const up = refreshRealtimeUp();
        if (up === REALTIME_TABLES.length) {
          console.log('[realtime] connected to Supabase Realtime');
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        entry.up = false;
        const up = refreshRealtimeUp();
        if (up === 0) console.warn(`[realtime] channel ${status}, falling back to polling`);
        // Retry this table after a delay (supabase-js also retries internally).
        if (status !== 'CLOSED') {
          setTimeout(() => {
            if (!entry.up) {
              try {
                entry.ch.subscribe();
              } catch {
                /* ignored - polling keeps things working */
              }
            }
          }, 10000);
        }
      }
    });
  } catch (err) {
    console.warn(`[realtime] could not watch ${table}:`, err.message);
    realtimeUp = false;
  }
}

// ---------------------------------------------------------------------------
// Safety poll
// ---------------------------------------------------------------------------

/** Most recently changed order - one row, covers inserts and updates alike. */
async function latestOrderChange(sb) {
  const { data } = await sb
    .from('orders')
    .select('id, order_number, updated_at')
    .order('updated_at', { ascending: false })
    .limit(1);
  const row = data && data[0];
  return row ? `${row.id}|${row.updated_at}` : null;
}

/** Highest order number - used to spot a new order even if updates lag. */
async function newestOrder(sb) {
  const { data } = await sb
    .from('orders')
    .select('id, order_number, customer_name, order_type, total, payment_status, created_at')
    .order('order_number', { ascending: false })
    .limit(1);
  return data && data[0] ? data[0] : null;
}

/** Fingerprint of the slower admin tables. */
async function tableSignature(sb, table, timeCol) {
  const [{ count }, { data }] = await Promise.all([
    sb.from(table).select('*', { count: 'exact', head: true }),
    sb.from(table).select(timeCol).order(timeCol, { ascending: false }).limit(1),
  ]);
  const latest = data && data[0] ? data[0][timeCol] : '';
  return `${count || 0}|${latest}`;
}

async function pollOrders() {
  const sb = getClient();
  if (!sb) return;

  const [changeSignature, latest] = await Promise.all([
    latestOrderChange(sb).catch(() => null),
    newestOrder(sb).catch(() => null),
  ]);

  if (changeSignature !== null) {
    const isFirstRun = lastOrderSignature === null;
    if (!isFirstRun && changeSignature !== lastOrderSignature) {
      handleChange('orders', { eventType: 'UPDATE', new: null });
    }
    lastOrderSignature = changeSignature;
  }

  if (latest) {
    const isNewOrder = lastOrderId !== null && latest.id !== lastOrderId;
    lastOrderId = latest.id;
    if (isNewOrder) {
      handleChange('orders', { eventType: 'INSERT', new: latest });
    }
  }
}

async function pollSlowTables() {
  const sb = getClient();
  if (!sb) return;
  const tables = [
    ['menu_items', 'updated_at'],
    ['users', 'updated_at'],
    ['settings', 'updated_at'],
    ['audit_logs', 'created_at'],
  ];
  const results = await Promise.all(
    tables.map(([table, timeCol]) => tableSignature(sb, table, timeCol).catch(() => null))
  );
  const signatures = {};
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
}

async function pollOnce() {
  try {
    await pollOrders();
    pollFailures = 0;
  } catch (err) {
    pollFailures += 1;
    if (pollFailures === 1 || pollFailures % 10 === 0) {
      console.warn('[realtime] order poll failed:', err.message);
    }
  }
}

function pollTick() {
  if (!clients.size) return;
  const now = Date.now();
  if (now - lastPollAt >= ORDER_POLL_MS) {
    lastPollAt = now;
    pollOnce();
  }
  if (now - lastSlowPollAt >= SLOW_POLL_MS) {
    lastSlowPollAt = now;
    pollSlowTables().catch(() => {});
  }
}

/** Register a browser SSE connection. */
function addSseClient(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Tell the browser to come back fast (within 3s) if the stream drops -
  // the default can be slow and grows, which delays live updates.
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');

  const client = { res, role: user.role, expiresAt: new Date(user.sessionExpiresAt).getTime() };
  clients.add(client);
  sseSend(client, { type: 'hello', realtime: realtimeUp, timezone: config.timezone, serverTime: Date.now() });

  req.on('close', () => clients.delete(client));
  pollTick();
  return client;
}

function startRealtime() {
  if (!config.configured) return;

  startRealtimeChannel();

  // Heartbeat: keeps proxies (Render) from closing idle SSE connections, tells
  // the client watchdog the stream is alive, and drops expired sessions.
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
      sseSend(client, { type: 'ping', at: now });
    }
  }, HEARTBEAT_MS);

  setInterval(pollTick, 2000);
}

function realtimeStatus() {
  return { realtimeUp, sseClients: clients.size };
}

module.exports = {
  startRealtime,
  addSseClient,
  broadcast,
  publishChange,
  publishOrderCreated,
  realtimeStatus,
};
