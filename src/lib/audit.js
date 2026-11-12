'use strict';

const { getClient } = require('../supabase');

/**
 * Write an entry to the audit log. Never throws - auditing must never break
 * the actual operation.
 */
async function auditLog(req, action, entity, entityId, details) {
  try {
    const sb = getClient();
    if (!sb) return;
    const user = req && req.user ? req.user : null;
    await sb.from('audit_logs').insert({
      user_id: user ? user.id : null,
      username: user ? user.username : (details && details.attemptedUsername) || null,
      action,
      entity: entity || null,
      entity_id: entityId ? String(entityId) : null,
      details: sanitizeDetails(details),
    });
  } catch (err) {
    console.error('[audit] failed to write log:', err.message);
  }
}

const SENSITIVE_KEYS = ['password', 'passwordhash', 'password_hash', 'newpassword', 'currentpassword', 'token', 'token_hash'];

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEYS.includes(key.toLowerCase())) continue;
    if (value === undefined) continue;
    if (value && typeof value === 'object') {
      out[key] = Array.isArray(value) ? value.slice(0, 50) : sanitizeDetails(value);
    } else {
      out[key] = typeof value === 'string' && value.length > 500 ? value.slice(0, 500) : value;
    }
  }
  return out;
}

module.exports = { auditLog };
