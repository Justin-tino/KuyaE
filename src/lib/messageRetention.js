'use strict';

/**
 * Temporary chat retention.
 *
 * A conversation is deleted 24 hours after its last message (messages cascade
 * with it). The sweep runs:
 *   - when the chat API is used (so an expired chat never comes back),
 *   - on a timer while the server is awake,
 *   - and, when the Supabase project has pg_cron, by the job in setup.sql.
 * Whichever runs first frees the storage.
 */

const { config } = require('../config');
const { getClient } = require('../supabase');
const { publishChange } = require('../realtime');

const RETENTION_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// Even though every chat API call checks for expiry, do not run the delete on
// each one: once a minute is plenty and keeps polling cheap.
const MIN_SWEEP_GAP_MS = 60 * 1000;

let sweeping = false;
let lastSweepAt = 0;
let timer = null;

/** ISO timestamp: everything last active before this has expired. */
function retentionCutoff() {
  return new Date(Date.now() - RETENTION_MS).toISOString();
}

/** ISO timestamp: when a conversation last active at `lastMessageAt` expires. */
function expiryOf(lastMessageAt) {
  const base = new Date(lastMessageAt || Date.now()).getTime();
  return new Date(base + RETENTION_MS).toISOString();
}

/**
 * Delete every conversation whose 24 hours are up. Never throws: a failed
 * cleanup must not break the request that triggered it. Returns how many
 * conversations were removed (0 when another sweep is already running).
 */
async function sweepExpiredConversations(force = false) {
  if (sweeping) return 0;
  const now = Date.now();
  if (!force && now - lastSweepAt < MIN_SWEEP_GAP_MS) return 0;
  lastSweepAt = now;
  const sb = getClient();
  if (!sb) return 0;

  sweeping = true;
  try {
    const { data, error } = await sb
      .from('conversations')
      .delete()
      .lt('last_message_at', retentionCutoff())
      .select('id');
    if (error) return 0;
    const count = (data || []).length;
    if (count) {
      console.log(`[messages] deleted ${count} expired conversation${count === 1 ? '' : 's'}`);
      // Open chat windows refresh and drop the expired thread right away.
      publishChange('conversations', 'DELETE', null);
    }
    return count;
  } catch (err) {
    console.warn('[messages] cleanup failed:', err.message);
    return 0;
  } finally {
    sweeping = false;
  }
}

/** Start the in-process cleanup timer (also sweeps once shortly after boot). */
function startMessageRetention() {
  if (!config.configured || timer) return;

  timer = setInterval(() => {
    sweepExpiredConversations();
  }, SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();

  const first = setTimeout(() => {
    sweepExpiredConversations();
  }, 8000);
  if (first.unref) first.unref();
}

module.exports = {
  RETENTION_MS,
  retentionCutoff,
  expiryOf,
  sweepExpiredConversations,
  startMessageRetention,
};
