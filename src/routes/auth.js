'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { config } = require('../config');
const { getClient, friendlyDbError } = require('../supabase');
const { auditLog } = require('../lib/audit');
const { cleanText, firstZodError } = require('../lib/helpers');
const loginGuard = require('../lib/loginGuard');
const {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  revokeUserSessions,
} = require('../middleware/auth');

const router = express.Router();

// Dummy hash used to keep response times similar whether or not the username exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts from this device. Please wait a few minutes.' },
});

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username is too long')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username can only contain letters, numbers, dots, dashes and underscores');

/** GET /api/status - app readiness (used by the login/setup screen). */
router.get('/status', async (req, res) => {
  const base = {
    configured: config.configured,
    needsSetup: false,
    missing: config.missingEnvVars,
    timezone: config.timezone,
    restaurantName: null,
  };
  if (!config.configured) return res.json(base);

  try {
    const sb = getClient();
    const { count, error } = await sb.from('users').select('*', { count: 'exact', head: true });
    if (error) {
      return res.json({ ...base, dbError: true, dbMessage: friendlyDbError(error) });
    }
    let restaurantName = null;
    const { data: settings } = await sb.from('settings').select('restaurant_name').eq('id', 1).maybeSingle();
    if (settings) restaurantName = settings.restaurant_name;
    return res.json({ ...base, needsSetup: (count || 0) === 0, restaurantName });
  } catch (err) {
    return res.json({ ...base, dbError: true, dbMessage: friendlyDbError(err) });
  }
});

/** POST /api/setup/first-admin - allowed only while the users table is empty. */
router.post('/setup/first-admin', loginLimiter, async (req, res, next) => {
  try {
    if (!config.configured) {
      return res.status(503).json({ error: 'Supabase is not configured yet. See the setup instructions.' });
    }
    const schema = z.object({
      fullName: z.string().trim().min(2, 'Please enter your full name').max(80),
      username: usernameSchema,
      password: passwordSchema,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });

    const sb = getClient();
    const { count, error: countError } = await sb.from('users').select('*', { count: 'exact', head: true });
    if (countError) return res.status(503).json({ error: friendlyDbError(countError) });
    if ((count || 0) > 0) {
      return res.status(409).json({ error: 'Setup was already completed. Please sign in.' });
    }

    const username = parsed.data.username.toLowerCase();
    const passwordHash = await bcrypt.hash(parsed.data.password, 11);
    const { data: user, error } = await sb
      .from('users')
      .insert({
        username,
        full_name: cleanText(parsed.data.fullName, 80),
        role: 'admin',
        password_hash: passwordHash,
      })
      .select('id, username, full_name, role, is_active')
      .single();
    if (error) {
      if (String(error.message).includes('duplicate')) {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
      return res.status(500).json({ error: friendlyDbError(error) });
    }

    const { token } = await createSession(sb, user.id, req);
    setSessionCookie(res, token);
    req.user = { id: user.id, username: user.username, fullName: user.full_name, role: user.role };
    await auditLog(req, 'setup_first_admin', 'user', user.id, { username: user.username });
    return res.json({ user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role } });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/auth/login */
router.post('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    if (!config.configured) {
      return res.status(503).json({ error: 'Supabase is not configured yet. See the setup instructions.' });
    }
    const username = cleanText(req.body && req.body.username, 30).toLowerCase();
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
    if (!username || !password) {
      return res.status(400).json({ error: 'Please enter your username and password.' });
    }

    const lock = loginGuard.checkLock(username);
    if (lock.locked) {
      await auditLog({ user: null }, 'login_locked', 'auth', null, { attemptedUsername: username });
      return res
        .status(429)
        .json({ error: `Too many failed attempts. Try again in ${lock.retryInMinutes} minute(s).` });
    }

    const sb = getClient();
    const { data: user, error } = await sb
      .from('users')
      .select('id, username, full_name, role, is_active, password_hash')
      .eq('username', username)
      .maybeSingle();
    if (error) return res.status(503).json({ error: friendlyDbError(error) });

    const hash = user ? user.password_hash : DUMMY_HASH;
    const passwordOk = await bcrypt.compare(password, hash);

    if (!user || !passwordOk) {
      loginGuard.recordFailure(username);
      await auditLog({ user: null }, 'login_failed', 'auth', null, { attemptedUsername: username });
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }
    if (!user.is_active) {
      await auditLog({ user: null }, 'login_failed', 'auth', user.id, {
        attemptedUsername: username,
        reason: 'account disabled',
      });
      return res.status(403).json({ error: 'This account has been disabled. Please ask the admin.' });
    }

    loginGuard.recordSuccess(username);
    await sb.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);
    const { token } = await createSession(sb, user.id, req);
    setSessionCookie(res, token);
    req.user = { id: user.id, username: user.username, fullName: user.full_name, role: user.role };
    await auditLog(req, 'login_success', 'auth', user.id, { username: user.username });
    return res.json({ user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role } });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/auth/logout */
router.post('/auth/logout', async (req, res, next) => {
  try {
    const sb = getClient();
    if (req.user && req.user.tokenHash && sb) {
      await sb.from('sessions').delete().eq('token_hash', req.user.tokenHash);
      await auditLog(req, 'logout', 'auth', req.user.id, { username: req.user.username });
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/auth/me */
router.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      fullName: req.user.fullName,
      role: req.user.role,
    },
  });
});

/** POST /api/auth/change-password - change your own password. */
router.post('/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      currentPassword: z.string().min(1, 'Enter your current password'),
      newPassword: passwordSchema,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });

    const sb = getClient();
    const { data: user, error } = await sb
      .from('users')
      .select('id, password_hash')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    if (!user) return res.status(401).json({ error: 'Account not found.' });

    const ok = await bcrypt.compare(parsed.data.currentPassword, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Your current password is incorrect.' });

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 11);
    const { error: updateError } = await sb
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', req.user.id);
    if (updateError) return res.status(500).json({ error: friendlyDbError(updateError) });

    // Sign out every other device for safety.
    await revokeUserSessions(sb, req.user.id, req.user.tokenHash);
    await auditLog(req, 'password_change', 'user', req.user.id, { username: req.user.username });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
