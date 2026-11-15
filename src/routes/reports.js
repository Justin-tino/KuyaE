'use strict';

const express = require('express');
const { getClient, friendlyDbError } = require('../supabase');
const { serializeOrder, ORDER_SELECT } = require('../lib/serialize');
const { todayStr, dayRange, isValidDateStr, daysBetween, eachDateStr } = require('../lib/tz');
const { aggregateSales, fetchOrdersInRange, MAX_REPORT_ORDERS } = require('../lib/salesReport');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Admin only. Everything is aggregated from orders in the range.
 * Cancelled orders never count as sales; they are reported separately.
 */
router.get('/sales', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const fromDate = isValidDateStr(req.query.from) ? req.query.from : todayStr();
    const toDate = isValidDateStr(req.query.to) ? req.query.to : fromDate;
    const span = daysBetween(fromDate, toDate);
    if (span < 0) return res.status(400).json({ error: 'The start date must come before the end date.' });
    if (span > 92) return res.status(400).json({ error: 'Please choose a range of 92 days or fewer.' });

    const { fromIso, toIso } = dayRange(fromDate, toDate);
    const sb = getClient();
    const loaded = await fetchOrdersInRange(sb, fromIso, toIso, ORDER_SELECT);
    if (loaded.error) return res.status(503).json({ error: friendlyDbError(loaded.error) });
    if (loaded.tooMany) {
      return res.status(400).json({
        error: `This period has more than ${MAX_REPORT_ORDERS.toLocaleString('en-US')} orders. Please choose a shorter date range.`,
      });
    }

    const orders = loaded.rows.map(serializeOrder);
    const report = aggregateSales(orders, eachDateStr(fromDate, toDate));

    return res.json({
      range: { from: fromDate, to: toDate },
      generatedAt: new Date().toISOString(),
      truncated: false,
      summary: report.summary,
      orderTypes: report.orderTypes,
      daily: report.daily,
      topItems: report.topItems,
      staff: report.staff,
      orders: orders.slice(-300),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
