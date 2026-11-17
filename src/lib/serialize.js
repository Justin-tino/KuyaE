'use strict';

const { toCents } = require('./helpers');

/** API shape for a menu item (money in cents). */
function serializeMenuItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    category: row.category,
    priceCents: toCents(row.price),
    imageUrl: row.image_url || null,
    imagePath: row.image_path || null,
    isAvailable: row.is_available !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** API shape for an order including items and staff names. */
function serializeOrder(row) {
  if (!row) return null;
  const items = (row.items || row.order_items || [])
    .slice()
    .sort((a, b) => (a.line_no || 0) - (b.line_no || 0))
    .map((i) => ({
      id: i.id,
      menuItemId: i.menu_item_id,
      name: i.item_name,
      unitPriceCents: toCents(i.unit_price),
      quantity: i.quantity,
      lineTotalCents: toCents(i.line_total),
    }));
  return {
    id: row.id,
    number: row.order_number,
    numberLabel: `#${String(row.order_number).padStart(3, '0')}`,
    customerName: row.customer_name,
    orderType: row.order_type,
    notes: row.notes || '',
    status: row.status,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method || null,
    subtotalCents: toCents(row.subtotal),
    totalCents: toCents(row.total),
    cashReceivedCents: row.cash_received === null || row.cash_received === undefined ? null : toCents(row.cash_received),
    changeCents: row.change_amount === null || row.change_amount === undefined ? null : toCents(row.change_amount),
    reference: row.reference_number || '',
    cancelReason: row.cancel_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || null,
    servedAt: row.served_at || null,
    paidAt: row.paid_at || null,
    cancelledAt: row.cancelled_at || null,
    createdByName: (row.creator && row.creator.full_name) || null,
    servedByName: (row.server && row.server.full_name) || null,
    paidByName: (row.cashier && row.cashier.full_name) || null,
    items,
  };
}

/**
 * API shape for a free staff meal. Money is always zero: the stored price is
 * only kept as a menu reference value and is never charged or reported.
 */
function serializeStaffMeal(row) {
  if (!row) return null;
  const items = (row.items || row.staff_meal_items || [])
    .slice()
    .sort((a, b) => (a.line_no || 0) - (b.line_no || 0))
    .map((i) => ({
      id: i.id,
      menuItemId: i.menu_item_id,
      name: i.item_name,
      quantity: i.quantity,
      unitPriceCents: 0,
      lineTotalCents: 0,
      menuPriceCents: toCents(i.unit_price),
      menuValueCents: toCents(i.line_total),
    }));
  const user = row.user || null;
  return {
    id: row.id,
    userId: row.user_id,
    staffName: row.staff_name || (user && user.full_name) || 'Unknown',
    staffRole: row.staff_role || (user && user.role) || '',
    mealDate: row.meal_date,
    notes: row.notes || '',
    createdAt: row.created_at,
    items,
    itemsCount: items.reduce((sum, item) => sum + item.quantity, 0),
    menuValueCents: items.reduce((sum, item) => sum + item.menuValueCents, 0),
    totalCents: 0,
  };
}

function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active !== false,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeSettings(row) {
  return {
    restaurantName: (row && row.restaurant_name) || 'Kuya E',
    address: (row && row.address) || '',
    phone: (row && row.phone) || '',
    receiptFooter: (row && row.receipt_footer) || 'Thank you, come again!',
    qrCodeUrl: (row && row.qr_code_url) || null,
    timezone: null, // filled by the route from config
  };
}

function serializeAuditLog(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    details: row.details,
    createdAt: row.created_at,
  };
}

const ORDER_SELECT =
  '*, items:order_items(id, menu_item_id, item_name, unit_price, quantity, line_total, line_no), ' +
  'creator:users!orders_created_by_fkey(full_name), ' +
  'server:users!orders_served_by_fkey(full_name), ' +
  'cashier:users!orders_paid_by_fkey(full_name)';

const STAFF_MEAL_SELECT =
  '*, items:staff_meal_items(id, menu_item_id, item_name, quantity, unit_price, line_total, line_no), ' +
  'user:users!staff_meals_user_id_fkey(full_name, username, role)';

module.exports = {
  serializeMenuItem,
  serializeOrder,
  serializeStaffMeal,
  serializeUser,
  serializeSettings,
  serializeAuditLog,
  ORDER_SELECT,
  STAFF_MEAL_SELECT,
};
