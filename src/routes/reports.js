'use strict';

const express = require('express');
const { getClient, friendlyDbError } = require('../supabase');
const { toCents } = require('../lib/helpers');
const { serializeOrder, ORDER_SELECT } = require('../lib/serialize');
const { todayStr, dayRange, isValidDateStr, daysBetween, eachDateStr, toLocalDateStr } = require('../lib/tz');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const MAX_ORDERS = 5000;

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
    const { data, error } = await sb
      .from('orders')
      .select(ORDER_SELECT)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('order_number', { ascending: true })
      .limit(MAX_ORDERS);
    if (error) return res.status(503).json({ error: friendlyDbError(error) });

    const orders = (data || []).map(serializeOrder);
    const active = orders.filter((o) => o.status !== 'cancelled');
    const cancelled = orders.filter((o) => o.status === 'cancelled');

    let grossCents = 0;
    let paidCents = 0;
    let unpaidCents = 0;
    let cashCents = 0;
    let cashCount = 0;
    let onlineCents = 0;
    let onlineCount = 0;
    let dineInCount = 0;
    let dineInCents = 0;
    let takeOutCount = 0;
    let takeOutCents = 0;
    let itemsSold = 0;

    const itemMap = new Map();
    const staffMap = new Map();
    const dailyMap = new Map();
    const dates = eachDateStr(fromDate, toDate);
    for (const d of dates) dailyMap.set(d, { date: d, ordersCount: 0, grossCents: 0, paidCents: 0 });

    for (const order of active) {
      grossCents += order.totalCents;
      if (order.paymentStatus === 'paid') {
        paidCents += order.totalCents;
        if (order.paymentMethod === 'cash') {
          cashCents += order.totalCents;
          cashCount += 1;
        } else if (order.paymentMethod === 'online') {
          onlineCents += order.totalCents;
          onlineCount += 1;
        }
      } else {
        unpaidCents += order.totalCents;
      }
      if (order.orderType === 'dine_in') {
        dineInCount += 1;
        dineInCents += order.totalCents;
      } else {
        takeOutCount += 1;
        takeOutCents += order.totalCents;
      }
      for (const item of order.items) {
        itemsSold += item.quantity;
        const entry = itemMap.get(item.name) || { name: item.name, quantity: 0, salesCents: 0 };
        entry.quantity += item.quantity;
        entry.salesCents += item.lineTotalCents;
        itemMap.set(item.name, entry);
      }
      const staffName = order.createdByName || 'Unknown';
      const staff = staffMap.get(staffName) || { name: staffName, ordersCount: 0, salesCents: 0 };
      staff.ordersCount += 1;
      staff.salesCents += order.totalCents;
      staffMap.set(staffName, staff);

      const localDate = toLocalDateStr(new Date(order.createdAt));
      const daily = dailyMap.get(localDate);
      if (daily) {
        daily.ordersCount += 1;
        daily.grossCents += order.totalCents;
        if (order.paymentStatus === 'paid') daily.paidCents += order.totalCents;
      }
    }

    const topItems = [...itemMap.values()]
      .sort((a, b) => b.quantity - a.quantity || b.salesCents - a.salesCents)
      .slice(0, 15);
    const staff = [...staffMap.values()].sort((a, b) => b.salesCents - a.salesCents);

    return res.json({
      range: { from: fromDate, to: toDate },
      generatedAt: new Date().toISOString(),
      truncated: orders.length >= MAX_ORDERS,
      summary: {
        ordersCount: active.length,
        grossCents,
        paidCents,
        unpaidCents,
        cashCents,
        cashCount,
        onlineCents,
        onlineCount,
        cancelledCount: cancelled.length,
        cancelledCents: cancelled.reduce((sum, o) => sum + o.totalCents, 0),
        avgOrderCents: active.length ? Math.round(grossCents / active.length) : 0,
        itemsSold,
      },
      orderTypes: {
        dineIn: { count: dineInCount, totalCents: dineInCents },
        takeOut: { count: takeOutCount, totalCents: takeOutCents },
      },
      daily: dates.map((d) => dailyMap.get(d)),
      topItems,
      staff,
      orders: orders.slice(-300),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
