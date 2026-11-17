'use strict';

const express = require('express');
const { z } = require('zod');
const { getClient, friendlyDbError } = require('../supabase');
const { auditLog } = require('../lib/audit');
const {
  cleanText,
  firstZodError,
  toCents,
  fromCents,
  escapeLike,
} = require('../lib/helpers');
const { serializeStaffMeal, STAFF_MEAL_SELECT } = require('../lib/serialize');
const { todayStr, isValidDateStr, daysBetween } = require('../lib/tz');
const { requireAuth, requireRole } = require('../middleware/auth');
const { publishChange } = require('../realtime');

const router = express.Router();

function parseRangeQuery(query) {
  const fromDate = isValidDateStr(query.from) ? query.from : todayStr();
  const toDate = isValidDateStr(query.to) ? query.to : fromDate;
  const span = daysBetween(fromDate, toDate);
  if (span < 0) return { error: 'The start date must come before the end date.' };
  if (span > 92) return { error: 'Please choose a range of 92 days or fewer.' };
  return { fromDate, toDate };
}

/**
 * GET /api/staff-meals
 *   Admin: every staff meal in the chosen date range (read-only).
 *   Cashier/kitchen: only their own meals, plus the meal they claimed today.
 */
router.get('/', requireAuth, requireRole('cashier', 'kitchen', 'admin'), async (req, res, next) => {
  try {
    const sb = getClient();

    if (req.user.role === 'admin') {
      const range = parseRangeQuery(req.query);
      if (range.error) return res.status(400).json({ error: range.error });

      let query = sb
        .from('staff_meals')
        .select(STAFF_MEAL_SELECT)
        .gte('meal_date', range.fromDate)
        .lte('meal_date', range.toDate)
        .order('created_at', { ascending: false })
        .limit(1000);

      if (req.query.role === 'cashier' || req.query.role === 'kitchen') {
        query = query.eq('staff_role', req.query.role);
      }
      const search = cleanText(req.query.search, 80);
      if (search) query = query.ilike('staff_name', `%${escapeLike(search)}%`);

      const { data, error } = await query;
      if (error) return res.status(503).json({ error: friendlyDbError(error) });

      const meals = (data || []).map(serializeStaffMeal);
      return res.json({
        range: { from: range.fromDate, to: range.toDate },
        meals,
        summary: {
          totalMeals: meals.length,
          cashierMeals: meals.filter((meal) => meal.staffRole === 'cashier').length,
          kitchenMeals: meals.filter((meal) => meal.staffRole === 'kitchen').length,
          uniqueStaff: new Set(meals.map((meal) => meal.staffName)).size,
          itemsCount: meals.reduce((sum, meal) => sum + meal.itemsCount, 0),
        },
      });
    }

    const { data, error } = await sb
      .from('staff_meals')
      .select(STAFF_MEAL_SELECT)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(60);
    if (error) return res.status(503).json({ error: friendlyDbError(error) });

    const meals = (data || []).map(serializeStaffMeal);
    const today = todayStr();
    return res.json({
      meals,
      todayMeal: meals.find((meal) => meal.mealDate === today) || null,
      today,
    });
  } catch (err) {
    return next(err);
  }
});

const claimSchema = z.object({
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid('Invalid menu item'),
        quantity: z.coerce.number().int('Quantity must be a whole number').min(1).max(20),
      })
    )
    .min(1, 'Choose at least one menu item.')
    .max(20, 'Too many different items in one meal.'),
  notes: z.string().trim().max(200, 'Notes are too long.').optional().default(''),
});

/**
 * POST /api/staff-meals - cashier/kitchen claim their one free meal today.
 * The meal is stored separately from orders and is always zero cost.
 */
router.post('/', requireAuth, requireRole('cashier', 'kitchen'), async (req, res, next) => {
  try {
    const parsed = claimSchema.safeParse({
      items: req.body && req.body.items,
      notes: cleanText(req.body && req.body.notes, 200),
    });
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });
    const body = parsed.data;

    // Merge repeated taps on the same menu item into one line.
    const merged = new Map();
    for (const item of body.items) {
      const total = Math.min(20, (merged.get(item.menuItemId) || 0) + item.quantity);
      merged.set(item.menuItemId, total);
    }
    const itemsPayload = [...merged.entries()].map(([menuItemId, quantity]) => ({
      menuItemId,
      quantity,
    }));

    const sb = getClient();
    const mealDate = todayStr();

    const { data: existing, error: existingError } = await sb
      .from('staff_meals')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('meal_date', mealDate)
      .maybeSingle();
    if (existingError) return res.status(503).json({ error: friendlyDbError(existingError) });
    if (existing) {
      return res.status(409).json({ error: 'You have already claimed your free meal today.' });
    }

    const { data: menuRows, error: menuError } = await sb
      .from('menu_items')
      .select('id, name, price, is_available')
      .in('id', itemsPayload.map((item) => item.menuItemId));
    if (menuError) return res.status(503).json({ error: friendlyDbError(menuError) });

    const menuById = new Map((menuRows || []).map((row) => [row.id, row]));
    for (const item of itemsPayload) {
      const menu = menuById.get(item.menuItemId);
      if (!menu) {
        return res.status(400).json({ error: 'A menu item in this meal no longer exists.' });
      }
      if (!menu.is_available) {
        return res.status(400).json({ error: `"${menu.name}" is not available right now.` });
      }
    }

    const { data: meal, error: mealError } = await sb
      .from('staff_meals')
      .insert({
        user_id: req.user.id,
        staff_name: req.user.fullName,
        staff_role: req.user.role,
        meal_date: mealDate,
        notes: body.notes || null,
      })
      .select('*')
      .single();
    if (mealError) {
      if (mealError.code === '23505' || /duplicate/i.test(String(mealError.message || ''))) {
        return res.status(409).json({ error: 'You have already claimed your free meal today.' });
      }
      return res.status(500).json({ error: friendlyDbError(mealError) });
    }

    const itemRows = itemsPayload.map((item, index) => {
      const menu = menuById.get(item.menuItemId);
      return {
        staff_meal_id: meal.id,
        menu_item_id: menu.id,
        item_name: menu.name,
        quantity: item.quantity,
        // Reference value only - staff meals are never charged or reported.
        unit_price: menu.price,
        line_total: fromCents(toCents(menu.price) * item.quantity),
        line_no: index,
      };
    });

    const { error: itemsError } = await sb.from('staff_meal_items').insert(itemRows);
    if (itemsError) {
      await sb.from('staff_meals').delete().eq('id', meal.id);
      return res.status(500).json({ error: friendlyDbError(itemsError) });
    }

    const { data: full, error: fullError } = await sb
      .from('staff_meals')
      .select(STAFF_MEAL_SELECT)
      .eq('id', meal.id)
      .single();
    if (fullError) return res.status(500).json({ error: friendlyDbError(fullError) });

    const serialized = serializeStaffMeal(full);
    auditLog(req, 'staff_meal_create', 'staff_meal', serialized.id, {
      staffName: serialized.staffName,
      staffRole: serialized.staffRole,
      mealDate: serialized.mealDate,
      items: serialized.items.map((item) => `${item.quantity}x ${item.name}`),
      notes: serialized.notes || null,
    });
    publishChange('staff_meals', 'INSERT');
    return res.status(201).json({ meal: serialized });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
