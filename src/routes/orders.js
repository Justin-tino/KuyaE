'use strict';

const express = require('express');
const { z } = require('zod');
const { getClient, friendlyDbError } = require('../supabase');
const { auditLog } = require('../lib/audit');
const { cleanText, firstZodError, isUuid, toCents, fromCents, clampInt, escapeLike } = require('../lib/helpers');
const { serializeOrder, ORDER_SELECT } = require('../lib/serialize');
const { todayStr, dayRange, isValidDateStr, daysBetween } = require('../lib/tz');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ORDER_STATUSES = ['pending', 'preparing', 'served', 'cancelled'];
const PAYMENT_STATUSES = ['pending', 'paid'];

/** Validates from/to date filters (local restaurant dates). */
function parseRangeQuery(query) {
  const fromDate = isValidDateStr(query.from) ? query.from : todayStr();
  const toDate = isValidDateStr(query.to) ? query.to : fromDate;
  const span = daysBetween(fromDate, toDate);
  if (span < 0) return { error: 'The start date must come before the end date.' };
  if (span > 92) return { error: 'Please choose a range of 92 days or fewer.' };
  const { fromIso, toIso } = dayRange(fromDate, toDate);
  return { fromDate, toDate, fromIso, toIso };
}

const createOrderSchema = z.object({
  customerName: z.string().trim().max(80).optional().default(''),
  orderType: z.enum(['dine_in', 'take_out'], { errorMap: () => ({ message: 'Choose Dine In or Take Out.' }) }),
  notes: z.string().trim().max(300).optional().default(''),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid('Invalid menu item'),
        quantity: z.coerce.number().int('Quantity must be a whole number').min(1).max(99),
      })
    )
    .min(1, 'Please add at least one menu item.')
    .max(60, 'Too many different items in one order.'),
  payment: z.object({
    status: z.enum(['paid', 'pending']),
    method: z.enum(['cash', 'online']).nullable().optional(),
    cashReceived: z.coerce.number().nonnegative().max(1000000).nullable().optional(),
    reference: z.string().trim().max(60).optional().default(''),
  }),
});

/** GET /api/orders - cashier & admin history list. */
router.get('/', requireAuth, requireRole('cashier', 'admin'), async (req, res, next) => {
  try {
    const range = parseRangeQuery(req.query);
    if (range.error) return res.status(400).json({ error: range.error });

    const limit = clampInt(req.query.limit, 1, 500, 200);
    const offset = clampInt(req.query.offset, 0, 100000, 0);

    const sb = getClient();
    let query = sb
      .from('orders')
      .select(ORDER_SELECT, { count: 'exact' })
      .gte('created_at', range.fromIso)
      .lt('created_at', range.toIso)
      .order('order_number', { ascending: false })
      .range(offset, offset + limit - 1);

    if (req.query.status && ORDER_STATUSES.includes(req.query.status)) {
      query = query.eq('status', req.query.status);
    }
    if (req.query.payment && PAYMENT_STATUSES.includes(req.query.payment)) {
      query = query.eq('payment_status', req.query.payment);
    }
    const search = cleanText(req.query.search, 40);
    if (search) {
      if (/^\d+$/.test(search.replace('#', ''))) {
        query = query.eq('order_number', parseInt(search.replace('#', ''), 10));
      } else {
        query = query.ilike('customer_name', `%${escapeLike(search)}%`);
      }
    }

    const { data, error, count } = await query;
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    return res.json({
      orders: (data || []).map(serializeOrder),
      total: count || 0,
      range: { from: range.fromDate, to: range.toDate },
    });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/orders/next-customer-name - "Customer 3" suggestion for the cashier. */
router.get('/next-customer-name', requireAuth, requireRole('cashier', 'admin'), async (req, res, next) => {
  try {
    const { fromIso, toIso } = dayRange(todayStr(), todayStr());
    const sb = getClient();
    const { count, error } = await sb
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', fromIso)
      .lt('created_at', toIso);
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    return res.json({ name: `Customer ${(count || 0) + 1}` });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/orders/pending-payments - unpaid orders (oldest first). */
router.get('/pending-payments', requireAuth, requireRole('cashier', 'admin'), async (req, res, next) => {
  try {
    const sb = getClient();
    const { data, error } = await sb
      .from('orders')
      .select(ORDER_SELECT)
      .eq('payment_status', 'pending')
      .neq('status', 'cancelled')
      .order('order_number', { ascending: true })
      .limit(300);
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    const orders = (data || []).map(serializeOrder);
    return res.json({
      orders,
      totalUnpaidCents: orders.reduce((sum, o) => sum + o.totalCents, 0),
    });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/orders/kitchen - active orders, first come first served. */
router.get('/kitchen', requireAuth, requireRole('kitchen', 'admin', 'cashier'), async (req, res, next) => {
  try {
    const sb = getClient();
    const { data, error } = await sb
      .from('orders')
      .select(ORDER_SELECT)
      .in('status', ['pending', 'preparing'])
      .order('order_number', { ascending: true })
      .limit(200);
    if (error) return res.status(503).json({ error: friendlyDbError(error) });

    const { fromIso, toIso } = dayRange(todayStr(), todayStr());
    const { data: servedToday } = await sb
      .from('orders')
      .select(ORDER_SELECT)
      .eq('status', 'served')
      .gte('served_at', fromIso)
      .lt('served_at', toIso)
      .order('served_at', { ascending: false })
      .limit(100);

    const orders = (data || []).map(serializeOrder);
    return res.json({
      orders,
      servedToday: (servedToday || []).map(serializeOrder),
    });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/orders/:id */
router.get('/:id', requireAuth, requireRole('cashier', 'admin', 'kitchen'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid order.' });
    const sb = getClient();
    const { data, error } = await sb.from('orders').select(ORDER_SELECT).eq('id', id).maybeSingle();
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    if (!data) return res.status(404).json({ error: 'Order not found.' });
    return res.json({ order: serializeOrder(data) });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/orders - cashier receives an order. */
router.post('/', requireAuth, requireRole('cashier', 'admin'), async (req, res, next) => {
  try {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });
    const body = parsed.data;

    // Merge repeated items into single lines.
    const merged = new Map();
    for (const item of body.items) {
      const total = Math.min(99, (merged.get(item.menuItemId) || 0) + item.quantity);
      merged.set(item.menuItemId, total);
    }
    const itemsPayload = [...merged.entries()].map(([menuItemId, quantity]) => ({
      menu_item_id: menuItemId,
      quantity,
    }));

    // Suggested auto name: "Customer N" based on today's order count.
    const { fromIso, toIso } = dayRange(todayStr(), todayStr());
    const sb = getClient();
    const { count } = await sb
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', fromIso)
      .lt('created_at', toIso);
    const autoName = `Customer ${(count || 0) + 1}`;

    const { data: created, error } = await sb.rpc('create_pos_order', {
      p_customer_name: body.customerName || '',
      p_order_type: body.orderType,
      p_notes: body.notes || '',
      p_items: itemsPayload,
      p_payment_status: body.payment.status,
      p_payment_method: body.payment.method || null,
      p_cash_received: body.payment.cashReceived !== undefined && body.payment.cashReceived !== null
        ? fromCents(toCents(body.payment.cashReceived))
        : null,
      p_reference: body.payment.reference || '',
      p_created_by: req.user.id,
      p_auto_name: autoName,
    });
    if (error) {
      const message = String(error.message || '').replace(/^P\d{4}:\s*/, '');
      if (error.code === 'P0001' || /^[A-Z].*[a-z]/.test(message)) {
        return res.status(400).json({ error: message || 'Could not save the order.' });
      }
      return res.status(503).json({ error: friendlyDbError(error) });
    }

    const row = Array.isArray(created) ? created[0] : created;
    const { data: full, error: fetchError } = await sb
      .from('orders')
      .select(ORDER_SELECT)
      .eq('id', row.id)
      .single();
    if (fetchError) return res.status(500).json({ error: friendlyDbError(fetchError) });

    const order = serializeOrder(full);
    await auditLog(req, 'order_create', 'order', order.id, {
      orderNumber: order.number,
      customerName: order.customerName,
      orderType: order.orderType,
      totalCents: order.totalCents,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      items: order.items.map((i) => `${i.quantity}x ${i.name}`),
    });
    return res.status(201).json({ order });
  } catch (err) {
    return next(err);
  }
});

const paySchema = z.object({
  method: z.enum(['cash', 'online'], { errorMap: () => ({ message: 'Choose Cash or Online.' }) }),
  cashReceived: z.coerce.number().nonnegative().max(1000000).nullable().optional(),
  reference: z.string().trim().max(60).optional().default(''),
});

/** POST /api/orders/:id/pay - settle a pending payment. */
router.post('/:id/pay', requireAuth, requireRole('cashier', 'admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid order.' });
    const parsed = paySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });
    const body = parsed.data;

    const sb = getClient();
    const { data: order, error } = await sb
      .from('orders')
      .select('id, order_number, total, payment_status, status, customer_name')
      .eq('id', id)
      .maybeSingle();
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'cancelled') return res.status(400).json({ error: 'This order was cancelled.' });
    if (order.payment_status === 'paid') {
      return res.status(409).json({ error: 'This order was already paid.' });
    }

    const totalCents = toCents(order.total);
    let cashReceivedCents = null;
    let changeCents = null;
    if (body.method === 'cash') {
      if (body.cashReceived === undefined || body.cashReceived === null) {
        return res.status(400).json({ error: 'Enter the cash received from the customer.' });
      }
      cashReceivedCents = toCents(body.cashReceived);
      if (cashReceivedCents < totalCents) {
        return res.status(400).json({ error: 'Cash received is less than the total.' });
      }
      changeCents = cashReceivedCents - totalCents;
    }

    const { data: updated, error: updateError } = await sb
      .from('orders')
      .update({
        payment_status: 'paid',
        payment_method: body.method,
        cash_received: cashReceivedCents === null ? null : fromCents(cashReceivedCents),
        change_amount: changeCents === null ? null : fromCents(changeCents),
        reference_number: body.method === 'online' ? body.reference || null : null,
        paid_by: req.user.id,
        paid_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('payment_status', 'pending')
      .select('id')
      .maybeSingle();
    if (updateError) return res.status(500).json({ error: friendlyDbError(updateError) });
    if (!updated) return res.status(409).json({ error: 'This order was already paid or cancelled.' });

    const { data: full } = await sb.from('orders').select(ORDER_SELECT).eq('id', id).single();
    const serialized = serializeOrder(full);
    await auditLog(req, 'order_paid', 'order', id, {
      orderNumber: order.order_number,
      customerName: order.customer_name,
      method: body.method,
      totalCents,
      cashReceivedCents,
      changeCents,
      reference: body.reference || null,
    });
    return res.json({ order: serialized });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/orders/:id/start - kitchen starts cooking. */
router.post('/:id/start', requireAuth, requireRole('kitchen', 'admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid order.' });
    const sb = getClient();
    const { data: updated, error } = await sb
      .from('orders')
      .update({ status: 'preparing', started_at: new Date().toISOString(), served_by: null })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id, order_number')
      .maybeSingle();
    if (error) return res.status(500).json({ error: friendlyDbError(error) });
    if (!updated) return res.status(409).json({ error: 'This order is no longer waiting.' });
    await auditLog(req, 'order_start', 'order', id, { orderNumber: updated.order_number });
    const { data: full } = await sb.from('orders').select(ORDER_SELECT).eq('id', id).single();
    return res.json({ order: serializeOrder(full) });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/orders/:id/serve - "Done & Served". */
router.post('/:id/serve', requireAuth, requireRole('kitchen', 'admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid order.' });
    const sb = getClient();
    const { data: updated, error } = await sb
      .from('orders')
      .update({ status: 'served', served_at: new Date().toISOString(), served_by: req.user.id })
      .eq('id', id)
      .in('status', ['pending', 'preparing'])
      .select('id, order_number')
      .maybeSingle();
    if (error) return res.status(500).json({ error: friendlyDbError(error) });
    if (!updated) return res.status(409).json({ error: 'This order was already served or cancelled.' });
    await auditLog(req, 'order_serve', 'order', id, { orderNumber: updated.order_number });
    const { data: full } = await sb.from('orders').select(ORDER_SELECT).eq('id', id).single();
    return res.json({ order: serializeOrder(full) });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/orders/:id/cancel - cashier/admin cancels an active order. */
router.post('/:id/cancel', requireAuth, requireRole('cashier', 'admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid order.' });
    const reason = cleanText(req.body && req.body.reason, 200);
    if (reason.length < 3) return res.status(400).json({ error: 'Please type a short reason for cancelling.' });

    const sb = getClient();
    const { data: order, error } = await sb
      .from('orders')
      .select('id, order_number, status, customer_name, total')
      .eq('id', id)
      .maybeSingle();
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'served') return res.status(400).json({ error: 'Served orders cannot be cancelled.' });
    if (order.status === 'cancelled') return res.status(409).json({ error: 'This order was already cancelled.' });

    const { data: updated, error: updateError } = await sb
      .from('orders')
      .update({
        status: 'cancelled',
        cancel_reason: reason,
        cancelled_by: req.user.id,
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', id)
      .in('status', ['pending', 'preparing'])
      .select('id')
      .maybeSingle();
    if (updateError) return res.status(500).json({ error: friendlyDbError(updateError) });
    if (!updated) return res.status(409).json({ error: 'This order was already served or cancelled.' });

    const { data: full } = await sb.from('orders').select(ORDER_SELECT).eq('id', id).single();
    await auditLog(req, 'order_cancel', 'order', id, {
      orderNumber: order.order_number,
      customerName: order.customer_name,
      totalCents: toCents(order.total),
      reason,
    });
    return res.json({ order: serializeOrder(full) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
