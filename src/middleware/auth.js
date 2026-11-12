'use strict';

const crypto = require('crypto');
const { config } = require('../config');
const { getClient } = require('../supabase');

const SESSION_MS = config.sessionHours * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

/** Create a new session row and return the raw token (only sent to the browser). */
async function createSession(sb, userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  const { error } = await sb.from('sessions').insert({
    token_hash: hashToken(token),
    user_id: userId,
    user_agent: (req.get('user-agent') || '').slice(0, 200),
    expires_at: expiresAt,
  });
  if (error) throw error;
  // Housekeeping: drop expired sessions once in a while.
  if (Math.random() < 0.1) {
    sb.from('sessions')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .then(() => {}, () => {});
  }
  return { token, expiresAt };
}

function setSessionCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: SESSION_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, { path: '/' });
}

/** Load the logged-in user (if any) from the session cookie onto req.user. */
async function attachUser(req, res, next) {
  try {
    const token = req.cookies ? req.cookies[config.cookieName] : null;
    if (!token) return next();
    const sb = getClient();
    if (!sb) return next();
    const { data, error } = await sb
      .from('sessions')
      .select('expires_at, user:users!sessions_user_id_fkey(id, username, full_name, role, is_active)')
      .eq('token_hash', hashToken(token))
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) return next(error);
    if (data && data.user && data.user.is_active) {
      req.user = {
        id: data.user.id,
        username: data.user.username,
        fullName: data.user.full_name,
        role: data.user.role,
        sessionExpiresAt: data.expires_at,
        tokenHash: hashToken(token),
      };
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in to continue.' });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Please sign in to continue.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your account does not have permission to do this.' });
    }
    return next();
  };
}

/**
 * Lightweight CSRF protection:
 *  - state-changing requests must carry the app's custom header
 *    (browsers will not attach custom headers to cross-site form posts),
 *  - and the Origin/Referer, when present, must match this host.
 */
function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const requestedWith = req.get('x-requested-with');
  if (requestedWith !== 'kuyae-pos') {
    return res.status(403).json({ error: 'Request blocked for security reasons.' });
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== req.get('host')) {
        return res.status(403).json({ error: 'Request blocked for security reasons.' });
      }
    } catch {
      return res.status(403).json({ error: 'Request blocked for security reasons.' });
    }
  }
  return next();
}

/** Delete every session of a user (optionally keeping one token hash alive). */
async function revokeUserSessions(sb, userId, keepTokenHash) {
  let query = sb.from('sessions').delete().eq('user_id', userId);
  if (keepTokenHash) query = query.neq('token_hash', keepTokenHash);
  await query;
}

module.exports = {
  hashToken,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireRole,
  csrfProtection,
  revokeUserSessions,
};
