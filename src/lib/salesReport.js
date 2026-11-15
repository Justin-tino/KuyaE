'use strict';

const { toLocalDateStr } = require('./tz');

const TOP_ITEMS_LIMIT = 15;

// PostgREST caps a response at its "Max Rows" setting (1,000 by default), so a
// single .limit(5000) would silently truncate the sales totals. Page through
// every order instead, and refuse a range that is too large to load safely.
const PAGE_SIZE = 1000;
const MAX_REPORT_ORDERS = 20000;

/**
 * Fetch every order created inside the UTC range, exactly once.
 *
 * Uses keyset pagination on the unique order number, so no order is skipped
 * or counted twice even when the response size is capped by the server.
 */
async function fetchOrdersInRange(sb, fromIso, toIso, select = '*') {
  const { count, error: countError } = await sb
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', fromIso)
    .lt('created_at', toIso);
  if (countError) return { error: countError };
  if ((count || 0) > MAX_REPORT_ORDERS) return { tooMany: true };

  const rows = [];
  let lastOrderNumber = null;
  for (;;) {
    let query = sb
      .from('orders')
      .select(select)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('order_number', { ascending: true })
      .limit(PAGE_SIZE);
    if (lastOrderNumber !== null) query = query.gt('order_number', lastOrderNumber);

    const { data, error } = await query;
    if (error) return { error };
    if (!data || data.length === 0) break;

    rows.push(...data);
    lastOrderNumber = data[data.length - 1].order_number;
    if (rows.length > MAX_REPORT_ORDERS) return { tooMany: true };
  }
  return { rows };
}

/**
 * Aggregate serialized orders (money already in integer cents) into the
 * sales-report shape. Cancelled orders are excluded from every sales total
 * but reported separately.
 *
 * Every money total is built from the same active-order list, so these
 * identities always hold:
 *   gross = paid + unpaid
 *   gross = cash + online + otherPaid + unpaid
 *   gross = dineIn + takeOut
 *   gross = sum(daily.grossCents)
 *   gross = sum(staff.salesCents)
 *   gross = itemsCents  (orders and their lines are written in one transaction)
 */
function aggregateSales(orders, dates) {
  const active = orders.filter((order) => order.status !== 'cancelled');
  const cancelled = orders.filter((order) => order.status === 'cancelled');

  let grossCents = 0;
  let paidCents = 0;
  let unpaidCents = 0;
  let paidCount = 0;
  let unpaidCount = 0;
  let cashCents = 0;
  let cashCount = 0;
  let onlineCents = 0;
  let onlineCount = 0;
  let otherPaidCents = 0;
  let otherPaidCount = 0;
  let dineInCount = 0;
  let dineInCents = 0;
  let takeOutCount = 0;
  let takeOutCents = 0;
  let itemsSold = 0;
  let itemsCents = 0;

  const itemMap = new Map();
  const staffMap = new Map();
  const dailyMap = new Map();
  for (const date of dates) {
    dailyMap.set(date, { date, ordersCount: 0, grossCents: 0, paidCents: 0 });
  }

  for (const order of active) {
    const totalCents = order.totalCents;

    grossCents += totalCents;
    if (order.paymentStatus === 'paid') {
      paidCount += 1;
      paidCents += totalCents;
      if (order.paymentMethod === 'cash') {
        cashCents += totalCents;
        cashCount += 1;
      } else if (order.paymentMethod === 'online') {
        onlineCents += totalCents;
        onlineCount += 1;
      } else {
        // Defensive: legacy rows may be paid without a method. Keep the money
        // in the totals instead of silently dropping it from the split.
        otherPaidCents += totalCents;
        otherPaidCount += 1;
      }
    } else {
      unpaidCount += 1;
      unpaidCents += totalCents;
    }

    if (order.orderType === 'dine_in') {
      dineInCount += 1;
      dineInCents += totalCents;
    } else {
      takeOutCount += 1;
      takeOutCents += totalCents;
    }

    for (const item of order.items) {
      itemsSold += item.quantity;
      itemsCents += item.lineTotalCents;
      const entry = itemMap.get(item.name) || { name: item.name, quantity: 0, salesCents: 0 };
      entry.quantity += item.quantity;
      entry.salesCents += item.lineTotalCents;
      itemMap.set(item.name, entry);
    }

    const staffName = order.createdByName || 'Unknown';
    const staff = staffMap.get(staffName) || { name: staffName, ordersCount: 0, salesCents: 0 };
    staff.ordersCount += 1;
    staff.salesCents += totalCents;
    staffMap.set(staffName, staff);

    const localDate = toLocalDateStr(new Date(order.createdAt));
    const daily = dailyMap.get(localDate);
    if (daily) {
      daily.ordersCount += 1;
      daily.grossCents += totalCents;
      if (order.paymentStatus === 'paid') daily.paidCents += totalCents;
    }
  }

  const topItems = [...itemMap.values()]
    .sort((a, b) => b.quantity - a.quantity || b.salesCents - a.salesCents)
    .slice(0, TOP_ITEMS_LIMIT);
  const staff = [...staffMap.values()].sort((a, b) => b.salesCents - a.salesCents);

  return {
    summary: {
      ordersCount: active.length,
      paidCount,
      unpaidCount,
      grossCents,
      paidCents,
      unpaidCents,
      cashCents,
      cashCount,
      onlineCents,
      onlineCount,
      otherPaidCents,
      otherPaidCount,
      cancelledCount: cancelled.length,
      cancelledCents: cancelled.reduce((sum, order) => sum + order.totalCents, 0),
      avgOrderCents: active.length ? Math.round(grossCents / active.length) : 0,
      itemsSold,
      itemsCents,
    },
    orderTypes: {
      dineIn: { count: dineInCount, totalCents: dineInCents },
      takeOut: { count: takeOutCount, totalCents: takeOutCents },
    },
    daily: dates.map((date) => dailyMap.get(date)),
    topItems,
    staff,
  };
}

module.exports = {
  aggregateSales,
  fetchOrdersInRange,
  TOP_ITEMS_LIMIT,
  PAGE_SIZE,
  MAX_REPORT_ORDERS,
};
