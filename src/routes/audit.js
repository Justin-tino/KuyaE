'use strict';

const express = require('express');
const { getClient, friendlyDbError } = require('../supabase');
const { serializeAuditLog } = require('../lib/serialize');
const { cleanText, clampInt, escapeLike, isUuid } = require('../lib/helpers');
const { todayStr, addDaysStr, dayRange, isValidDateStr, daysBetween } = require('../lib/tz');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/** GET /api/audit - admin only, newest first. */
router.get('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const fromDate = isValidDateStr(req.query.from) ? req.query.from : addDaysStr(todayStr(), -6);
    const toDate = isValidDateStr(req.query.to) ? req.query.to : todayStr();
    if (daysBetween(fromDate, toDate) < 0 || daysBetween(fromDate, toDate) > 92) {
      return res.status(400).json({ error: 'Please choose a range of 92 days or fewer.' });
    }
    const { fromIso, toIso } = dayRange(fromDate, toDate);

    const limit = clampInt(req.query.limit, 1, 200, 50);
    const offset = clampInt(req.query.offset, 0, 100000, 0);

    const sb = getClient();
    let query = sb
      .from('audit_logs')
      .select('id, user_id, username, action, entity, entity_id, details, created_at', { count: 'exact' })
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const userId = cleanText(req.query.userId, 40);
    if (userId && isUuid(userId)) query = query.eq('user_id', userId);
    const action = cleanText(req.query.action, 60);
    if (action) query = query.ilike('action', `%${escapeLike(action)}%`);
    const entity = cleanText(req.query.entity, 40);
    if (entity) query = query.eq('entity', entity);

    const { data, error, count } = await query;
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    return res.json({
      logs: (data || []).map(serializeAuditLog),
      total: count || 0,
      range: { from: fromDate, to: toDate },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
