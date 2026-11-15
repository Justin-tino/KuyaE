'use strict';

const express = require('express');
const { z } = require('zod');
const { config } = require('../config');
const { getClient, friendlyDbError } = require('../supabase');
const { auditLog } = require('../lib/audit');
const { cleanText, firstZodError } = require('../lib/helpers');
const { serializeSettings } = require('../lib/serialize');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const SETTINGS_SELECT = 'restaurant_name, address, phone, receipt_footer';

/** GET /api/settings - any signed-in user (used on receipts and headers). */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const sb = getClient();
    const { data, error } = await sb.from('settings').select(SETTINGS_SELECT).eq('id', 1).maybeSingle();
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    const settings = serializeSettings(data);
    settings.timezone = config.timezone;
    return res.json({ settings });
  } catch (err) {
    return next(err);
  }
});

/** PATCH /api/settings - admin only. */
router.patch('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      restaurantName: z.string().trim().min(1, 'Restaurant name is required').max(80),
      address: z.string().trim().max(160).optional().default(''),
      phone: z.string().trim().max(40).optional().default(''),
      receiptFooter: z.string().trim().max(160).optional().default(''),
    });
    const parsed = schema.safeParse({
      restaurantName: cleanText(req.body && req.body.restaurantName, 80),
      address: cleanText(req.body && req.body.address, 160),
      phone: cleanText(req.body && req.body.phone, 40),
      receiptFooter: cleanText(req.body && req.body.receiptFooter, 160),
    });
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });

    const sb = getClient();
    const { data, error } = await sb
      .from('settings')
      .update({
        restaurant_name: parsed.data.restaurantName,
        address: parsed.data.address,
        phone: parsed.data.phone,
        receipt_footer: parsed.data.receiptFooter,
      })
      .eq('id', 1)
      .select(SETTINGS_SELECT)
      .single();
    if (error) return res.status(500).json({ error: friendlyDbError(error) });

    auditLog(req, 'settings_update', 'settings', '1', { restaurantName: data.restaurant_name });
    const settings = serializeSettings(data);
    settings.timezone = config.timezone;
    return res.json({ settings });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
