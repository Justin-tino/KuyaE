'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { getClient, friendlyDbError } = require('../supabase');
const { auditLog } = require('../lib/audit');
const { cleanText, firstZodError, isUuid } = require('../lib/helpers');
const { serializeUser } = require('../lib/serialize');
const { requireAuth, requireRole, revokeUserSessions, flushSessionCache } = require('../middleware/auth');

const router = express.Router();

const USER_SELECT = 'id, username, full_name, role, is_active, last_login_at, created_at, updated_at';

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username is too long')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username can only contain letters, numbers, dots, dashes and underscores');

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

const createSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter the full name').max(80),
  username: usernameSchema,
  role: z.enum(['admin', 'cashier', 'kitchen'], { errorMap: () => ({ message: 'Choose a role.' }) }),
  password: passwordSchema,
});

const updateSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter the full name').max(80).optional(),
  username: usernameSchema.optional(),
  role: z.enum(['admin', 'cashier', 'kitchen']).optional(),
  isActive: z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true').optional(),
  newPassword: passwordSchema.optional(),
});

async function countOtherActiveAdmins(sb, excludeUserId) {
  const { count, error } = await sb
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('is_active', true)
    .neq('id', excludeUserId);
  if (error) throw error;
  return count || 0;
}

/** GET /api/users - admin only. */
router.get('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const sb = getClient();
    const { data, error } = await sb
      .from('users')
      .select(USER_SELECT)
      .order('role')
      .order('full_name');
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    return res.json({ users: (data || []).map(serializeUser) });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/users - admin creates a staff account. */
router.post('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse({
      fullName: cleanText(req.body && req.body.fullName, 80),
      username: cleanText(req.body && req.body.username, 30),
      role: req.body && req.body.role,
      password: req.body && req.body.password,
    });
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });

    const sb = getClient();
    const passwordHash = await bcrypt.hash(parsed.data.password, 11);
    const { data, error } = await sb
      .from('users')
      .insert({
        username: parsed.data.username.toLowerCase(),
        full_name: parsed.data.fullName,
        role: parsed.data.role,
        password_hash: passwordHash,
      })
      .select(USER_SELECT)
      .single();
    if (error) {
      if (String(error.message).includes('duplicate')) {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
      return res.status(500).json({ error: friendlyDbError(error) });
    }

    auditLog(req, 'user_create', 'user', data.id, {
      username: data.username,
      fullName: data.full_name,
      role: data.role,
    });
    return res.status(201).json({ user: serializeUser(data) });
  } catch (err) {
    return next(err);
  }
});

/** PATCH /api/users/:id - admin edits name, username, role, status, password. */
router.patch('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid user.' });

    const parsed = updateSchema.safeParse({
      fullName: req.body && req.body.fullName !== undefined ? cleanText(req.body.fullName, 80) : undefined,
      username: req.body && req.body.username !== undefined ? cleanText(req.body.username, 30) : undefined,
      role: req.body && req.body.role !== undefined ? req.body.role : undefined,
      isActive: req.body && req.body.isActive !== undefined ? req.body.isActive : undefined,
      newPassword: req.body && req.body.newPassword ? req.body.newPassword : undefined,
    });
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });

    const sb = getClient();
    const { data: target, error: findError } = await sb
      .from('users')
      .select(USER_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (findError) return res.status(503).json({ error: friendlyDbError(findError) });
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const updates = {};
    if (parsed.data.fullName !== undefined) updates.full_name = parsed.data.fullName;
    if (parsed.data.username !== undefined) updates.username = parsed.data.username.toLowerCase();
    if (parsed.data.role !== undefined) updates.role = parsed.data.role;
    if (parsed.data.isActive !== undefined) updates.is_active = parsed.data.isActive;

    const losingAdmin =
      target.role === 'admin' &&
      ((parsed.data.role !== undefined && parsed.data.role !== 'admin') || parsed.data.isActive === false);
    if (losingAdmin) {
      if (id === req.user.id) {
        return res.status(400).json({ error: 'You cannot remove your own admin access.' });
      }
      const others = await countOtherActiveAdmins(sb, id);
      if (others < 1) {
        return res.status(400).json({ error: 'There must always be at least one active admin.' });
      }
    }
    if (parsed.data.isActive === false && id === req.user.id) {
      return res.status(400).json({ error: 'You cannot disable your own account.' });
    }

    let passwordChanged = false;
    if (parsed.data.newPassword) {
      updates.password_hash = await bcrypt.hash(parsed.data.newPassword, 11);
      passwordChanged = true;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { data, error } = await sb.from('users').update(updates).eq('id', id).select(USER_SELECT).single();
    if (error) {
      if (String(error.message).includes('duplicate')) {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
      return res.status(500).json({ error: friendlyDbError(error) });
    }

    // Security: kick out sessions when the account is disabled or password reset.
    // Awaited on purpose: the disabled account must lose access immediately.
    if (parsed.data.isActive === false || passwordChanged) {
      await revokeUserSessions(sb, id, null); // also flushes the session cache
    }

    auditLog(req, 'user_update', 'user', id, {
      username: data.username,
      changed: Object.keys(updates).filter((k) => k !== 'password_hash'),
      passwordReset: passwordChanged,
    });
    return res.json({ user: serializeUser(data) });
  } catch (err) {
    return next(err);
  }
});

/** DELETE /api/users/:id - admin removes a staff account. */
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid user.' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });

    const sb = getClient();
    const { data: target, error: findError } = await sb
      .from('users')
      .select(USER_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (findError) return res.status(503).json({ error: friendlyDbError(findError) });
    if (!target) return res.status(404).json({ error: 'User not found.' });

    if (target.role === 'admin' && target.is_active) {
      const others = await countOtherActiveAdmins(sb, id);
      if (others < 1) return res.status(400).json({ error: 'There must always be at least one active admin.' });
    }

    const { error } = await sb.from('users').delete().eq('id', id);
    if (error) return res.status(500).json({ error: friendlyDbError(error) });
    // The database cascades the session rows; drop their cached lookups too.
    flushSessionCache();

    auditLog(req, 'user_delete', 'user', id, {
      username: target.username,
      fullName: target.full_name,
      role: target.role,
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
