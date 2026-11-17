// Cashier & kitchen: claim the one free staff meal of the day.
//
// Staff meals are stored in their own tables, never in orders. They are always
// zero cost and can never change sales, reports or order numbers.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables, everyWhileVisible } from '../realtime.js';
import {
  esc,
  toast,
  toastThrottled,
  emptyState,
  fmtDayLabel,
  fmtDate,
  fmtTime,
  debounce,
  withButtonLoading,
  renderPreservingFocus,
  skeleton,
} from '../ui.js';

// Keeps the menu fresh if the live stream drops.
const REFRESH_MS = 30000;

let rootEl = null;
let menuItems = [];
let meals = [];
let todayMeal = null;
let todayStr = '';
let category = 'All';
let search = '';
let cart = new Map();
let notes = '';
let hasData = false;
let loading = true;

export async function mount(container) {
  rootEl = container;
  resetState();

  const onClick = (event) => handleClick(event);
  const onInput = (event) => handleInput(event);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);

  const cleanups = [
    () => container.removeEventListener('click', onClick),
    () => container.removeEventListener('input', onInput),
    onTables(['menu_items', 'staff_meals'], debounce(() => load(true), 300)),
    everyWhileVisible(() => load(true), REFRESH_MS),
  ];

  renderSkeleton();
  await load(false);

  return () => cleanups.forEach((fn) => fn());
}

function resetState() {
  menuItems = [];
  meals = [];
  todayMeal = null;
  todayStr = '';
  category = 'All';
  search = '';
  cart = new Map();
  notes = '';
  hasData = false;
  loading = true;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function load(quiet) {
  try {
    const [menuData, mealData] = await Promise.all([
      api('/menu?available=true'),
      api('/staff-meals'),
    ]);
    menuItems = menuData.items || [];
    meals = mealData.meals || [];
    todayMeal = mealData.todayMeal || null;
    todayStr = mealData.today || todayStr;

    // Drop anything that became unavailable while the page was open.
    const byId = new Map(menuItems.map((item) => [item.id, item]));
    for (const [id, entry] of [...cart]) {
      const fresh = byId.get(id);
      if (!fresh) cart.delete(id);
      else entry.item = fresh;
    }

    hasData = true;
    loading = false;
    renderAll(quiet);
  } catch (err) {
    loading = false;
    if (!hasData) renderError(err.message);
    else toastThrottled('staff-meal-refresh', err.message, 'error', quiet ? 60000 : 4000);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSkeleton() {
  rootEl.innerHTML = `
    <div class="space-y-4">
      <div class="card p-4">
        <div class="flex items-center gap-3">
          ${skeleton('h-11 w-11 rounded-xl')}
          <div class="space-y-2">${skeleton('h-5 w-48')}${skeleton('h-4 w-72')}</div>
        </div>
      </div>
      <div class="grid gap-4 xl:grid-cols-3">
        <div class="card xl:col-span-2">
          <div class="space-y-2 border-b border-stone-200 p-3">${skeleton('h-11 w-full')}${skeleton('h-9 w-64')}</div>
          <div class="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
            ${Array.from({ length: 8 }, () => `<div class="rounded-xl border border-stone-200 p-2">${skeleton('h-20 w-full')}${skeleton('h-4 w-3/4 mt-2')}</div>`).join('')}
          </div>
        </div>
        <div class="card space-y-3 p-4">${skeleton('h-5 w-32')}${skeleton('h-16 w-full')}${skeleton('h-11 w-full')}</div>
      </div>
    </div>`;
}

function renderError(message) {
  rootEl.innerHTML = `
    <div class="panel p-8 text-center">
      <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-red-700">
        ${icon('alert', 'w-7 h-7')}
      </div>
      <p class="mt-3 text-lg font-extrabold">Could not load the free meal page</p>
      <p class="mt-1 text-stone-600">${esc(message)}</p>
      <button type="button" data-action="retry" class="btn btn-md btn-primary mt-4">
        ${icon('refresh', 'w-5 h-5')} Try Again
      </button>
    </div>`;
}

function renderAll(quiet) {
  if (!rootEl) return;
  if (loading && !hasData) {
    renderSkeleton();
    return;
  }
  const scrollTop = rootEl.scrollTop;
  const markup = html();
  if (quiet) renderPreservingFocus(rootEl, markup);
  else rootEl.innerHTML = markup;
  if (scrollTop) rootEl.scrollTop = scrollTop;
  bindImageFallbacks();
}

function html() {
  return `
    <div class="space-y-4">
      ${headerHtml()}
      ${todayMeal ? claimedHtml() : pickerHtml()}
      ${historyHtml()}
    </div>`;
}

function headerHtml() {
  const dateLabel = todayStr ? `${fmtDayLabel(todayStr)}, ${todayStr.slice(0, 4)}` : 'Today';
  return `
    <div class="card p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
            ${icon('bowl', 'w-6 h-6')}
          </span>
          <div class="min-w-0">
            <h2 class="text-xl font-extrabold leading-tight">Free Staff Meal</h2>
            <p class="text-sm text-stone-600">One free meal per employee per day. Free meals never affect sales.</p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="badge bg-stone-100 text-stone-700">${esc(dateLabel)}</span>
          ${
            todayMeal
              ? '<span class="badge bg-emerald-100 text-emerald-900">Claimed today</span>'
              : '<span class="badge bg-amber-100 text-amber-900">Available today</span>'
          }
        </div>
      </div>
    </div>`;
}

function pickerHtml() {
  return `
    <div class="grid gap-4 xl:grid-cols-3">
      <section class="card overflow-hidden xl:col-span-2">
        <div class="space-y-2 border-b border-stone-200 p-3">
          <div class="relative">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">${icon('search', 'w-4 h-4')}</span>
            <input id="staff-meal-search" data-focus-key="staff-meal-search" class="input pl-10" placeholder="Search the menu..." value="${esc(search)}" autocomplete="off">
          </div>
          <div class="no-scrollbar flex gap-1.5 overflow-x-auto">${categoryChipsHtml()}</div>
        </div>
        <div class="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
          ${menuGridHtml()}
        </div>
      </section>

      <aside class="card p-4 xl:sticky xl:top-4 xl:self-start">
        ${cartHtml()}
      </aside>
    </div>`;
}

function categoryChipsHtml() {
  const categories = ['All', ...new Set(menuItems.map((item) => item.category))];
  return categories
    .map(
      (cat) =>
        `<button type="button" data-category="${esc(cat)}" class="chip h-9 px-3 text-xs ${
          cat === category ? 'chip-active' : ''
        }">${esc(cat)}</button>`
    )
    .join('');
}

function filteredMenu() {
  const q = search.trim().toLowerCase();
  return menuItems.filter((item) => {
    if (category !== 'All' && item.category !== category) return false;
    if (!q) return true;
    return item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q);
  });
}

function menuGridHtml() {
  if (!menuItems.length) {
    return `<div class="col-span-full">${emptyState(
      'bowl',
      'The menu is empty',
      'Ask the administrator to add menu items first.',
      '',
      { compact: true }
    )}</div>`;
  }
  const items = filteredMenu();
  if (!items.length) {
    return `<div class="col-span-full">${emptyState(
      'search',
      'No matching items',
      'Try a different search or category.',
      '',
      { compact: true }
    )}</div>`;
  }
  return items.map(menuCardHtml).join('');
}

function menuCardHtml(item) {
  const qty = cart.get(item.id)?.qty || 0;
  return `
    <button type="button" data-add="${item.id}"
      class="group relative flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white text-left shadow-sm transition-all hover:border-stone-300 hover:shadow active:scale-[0.98]">
      <div class="relative flex h-20 w-full items-center justify-center overflow-hidden bg-stone-50 p-1">
        ${
          item.imageUrl
            ? `<img src="${esc(item.imageUrl)}" alt="" class="max-h-full max-w-full object-contain" data-menu-img>`
            : `<span class="text-stone-300">${icon('bowl', 'w-6 h-6')}</span>`
        }
        ${
          qty
            ? `<span class="pop-in absolute right-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1 text-xs font-extrabold text-white shadow">${qty}</span>`
            : ''
        }
      </div>
      <div class="flex flex-1 flex-col px-2 pb-2 pt-1.5">
        <p class="line-clamp-2 text-sm font-bold leading-tight">${esc(item.name)}</p>
        <p class="mt-auto pt-1 text-[11px] font-extrabold uppercase tracking-wide text-emerald-700">Free</p>
      </div>
    </button>`;
}

function cartCount() {
  let count = 0;
  for (const { qty } of cart.values()) count += qty;
  return count;
}

function cartLineHtml([id, { item, qty }]) {
  return `
    <div class="rounded-xl border border-stone-200 px-3 py-2">
      <div class="flex items-start justify-between gap-2">
        <p class="min-w-0 flex-1 text-sm font-bold">${esc(item.name)}</p>
        <span class="shrink-0 text-[11px] font-extrabold uppercase tracking-wide text-emerald-700">Free</span>
      </div>
      <div class="mt-1.5 flex items-center justify-between">
        <span class="text-xs text-stone-500">${qty} serving${qty === 1 ? '' : 's'}</span>
        <div class="flex items-center gap-1">
          <button type="button" data-cart="dec" data-id="${id}" class="btn btn-secondary btn-sm h-8 w-8 px-0" aria-label="Less">${icon('minus', 'w-4 h-4')}</button>
          <span class="w-7 text-center text-sm font-extrabold">${qty}</span>
          <button type="button" data-cart="inc" data-id="${id}" class="btn btn-secondary btn-sm h-8 w-8 px-0" aria-label="More">${icon('plus', 'w-4 h-4')}</button>
          <button type="button" data-cart="remove" data-id="${id}" class="btn btn-ghost btn-sm h-8 w-8 px-0 text-red-700" aria-label="Remove">${icon('x', 'w-4 h-4')}</button>
        </div>
      </div>
    </div>`;
}

function cartHtml() {
  const count = cartCount();
  return `
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-sm font-extrabold uppercase tracking-wide text-stone-600">My Free Meal</h3>
      ${count ? `<span class="badge bg-stone-900 text-white">${count} item${count === 1 ? '' : 's'}</span>` : ''}
    </div>

    <div class="mt-3 space-y-2">
      ${
        cart.size
          ? [...cart.entries()].map(cartLineHtml).join('')
          : `<div class="rounded-xl border border-dashed border-stone-200 px-3 py-5 text-center">
              <span class="inline-block text-stone-300">${icon('bowl', 'w-7 h-7')}</span>
              <p class="mt-1 text-sm font-bold text-stone-600">No items yet</p>
              <p class="text-xs text-stone-500">Tap a menu item to add it.</p>
            </div>`
      }
    </div>

    <div class="mt-3">
      <label class="label" for="staff-meal-notes">Notes (optional)</label>
      <input id="staff-meal-notes" data-input="notes" data-focus-key="staff-meal-notes" class="input" maxlength="200"
        value="${esc(notes)}" placeholder="e.g. extra rice, no onion" autocomplete="off">
    </div>

    <div class="mt-3 flex items-center justify-between rounded-xl bg-emerald-50 px-3 py-2.5 text-emerald-900">
      <span class="text-xs font-bold uppercase tracking-wide">Total</span>
      <span class="text-xl font-extrabold">FREE</span>
    </div>

    <button type="button" data-action="claim" class="btn btn-lg btn-success mt-3 w-full" ${cart.size ? '' : 'disabled'}>
      ${icon('check', 'w-5 h-5')} Claim Free Meal
    </button>
    <p class="mt-2 text-center text-xs font-semibold text-stone-500">One free meal per day. This will not appear in sales.</p>`;
}

function claimedHtml() {
  return `
    <div class="card p-5">
      <div class="flex items-start gap-3">
        <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
          ${icon('check', 'w-7 h-7')}
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="text-xl font-extrabold">You already claimed your free meal today</h3>
          <p class="text-sm text-stone-600">
            ${esc(fmtDayLabel(todayMeal.mealDate))} at ${esc(fmtTime(todayMeal.createdAt))}.
            Your next free meal unlocks tomorrow.
          </p>

          <div class="mt-3 overflow-hidden rounded-xl border border-stone-200">
            <ul class="divide-y divide-stone-100">
              ${todayMeal.items
                .map(
                  (item) => `<li class="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span class="text-sm font-semibold">${esc(item.name)}</span>
                    <span class="badge bg-stone-100 text-stone-700">${item.quantity}x</span>
                  </li>`
                )
                .join('')}
            </ul>
          </div>

          ${
            todayMeal.notes
              ? `<p class="mt-2 rounded-xl bg-stone-50 px-3 py-2 text-sm text-stone-600">Notes: ${esc(todayMeal.notes)}</p>`
              : ''
          }
        </div>
      </div>
    </div>`;
}

function historyHtml() {
  return `
    <div class="card overflow-hidden">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
        <div>
          <h3 class="font-extrabold">My meal history</h3>
          <p class="text-xs text-stone-500">Free meals are recorded separately from customer orders.</p>
        </div>
        <span class="badge bg-stone-100 text-stone-700">${meals.length}</span>
      </div>
      ${
        meals.length
          ? `<div class="overflow-x-auto">
              <table class="w-full min-w-[560px]">
                <thead class="bg-stone-50">
                  <tr>
                    <th class="th">Date</th>
                    <th class="th">Meal</th>
                    <th class="th">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  ${meals
                    .map(
                      (meal) => `<tr class="border-b border-stone-100 last:border-0">
                        <td class="td whitespace-nowrap">
                          <p class="font-bold">${esc(fmtDate(meal.mealDate))}</p>
                          <p class="text-xs text-stone-500">${esc(fmtTime(meal.createdAt))}</p>
                        </td>
                        <td class="td">
                          <div class="flex flex-wrap gap-1.5">
                            ${meal.items
                              .map(
                                (item) =>
                                  `<span class="badge bg-stone-100 text-stone-700">${item.quantity}x ${esc(item.name)}</span>`
                              )
                              .join('')}
                          </div>
                        </td>
                        <td class="td max-w-[260px] truncate text-stone-600">${esc(meal.notes || '-')}</td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
              </table>
            </div>`
          : emptyState('bowl', 'No free meals yet', 'Claim your first free meal above.', '', { compact: true })
      }
    </div>`;
}

function bindImageFallbacks() {
  if (!rootEl) return;
  rootEl.querySelectorAll('img[data-menu-img]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const wrap = img.parentElement;
        img.remove();
        if (wrap && !wrap.querySelector('[data-menu-fallback]')) {
          const fallback = document.createElement('span');
          fallback.setAttribute('data-menu-fallback', '');
          fallback.className = 'text-stone-300';
          fallback.innerHTML = icon('bowl', 'w-6 h-6');
          wrap.prepend(fallback);
        }
      },
      { once: true }
    );
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function handleClick(event) {
  const addButton = event.target.closest('[data-add]');
  if (addButton) {
    addToCart(addButton.getAttribute('data-add'));
    return;
  }

  const categoryButton = event.target.closest('[data-category]');
  if (categoryButton) {
    category = categoryButton.getAttribute('data-category');
    renderAll(true);
    return;
  }

  const cartButton = event.target.closest('[data-cart]');
  if (cartButton) {
    const id = cartButton.getAttribute('data-id');
    const action = cartButton.getAttribute('data-cart');
    const entry = cart.get(id);
    if (!entry) return;
    if (action === 'inc') entry.qty = Math.min(20, entry.qty + 1);
    if (action === 'dec') {
      entry.qty -= 1;
      if (entry.qty <= 0) cart.delete(id);
    }
    if (action === 'remove') cart.delete(id);
    renderAll(true);
    return;
  }

  if (event.target.closest('[data-action="claim"]')) {
    claimMeal(event.target.closest('[data-action="claim"]'));
    return;
  }

  if (event.target.closest('[data-action="retry"]')) {
    hasData = false;
    loading = true;
    renderSkeleton();
    load(false);
  }
}

function handleInput(event) {
  const input = event.target;
  if (input.id === 'staff-meal-search') {
    search = input.value;
    renderAll(true);
    return;
  }
  if (input.getAttribute('data-input') === 'notes') {
    notes = input.value;
  }
}

function addToCart(id) {
  const item = menuItems.find((entry) => entry.id === id);
  if (!item) return;
  const entry = cart.get(id);
  if (entry) entry.qty = Math.min(20, entry.qty + 1);
  else cart.set(id, { item, qty: 1 });
  renderAll(true);
}

async function claimMeal(button) {
  if (!cart.size || todayMeal) return;
  await withButtonLoading(button, 'Claiming...', async () => {
    try {
      const items = [...cart.entries()].map(([id, entry]) => ({
        menuItemId: id,
        quantity: entry.qty,
      }));
      const data = await api('/staff-meals', {
        method: 'POST',
        body: { items, notes: notes.trim() },
      });
      todayMeal = data.meal;
      meals = [data.meal, ...meals.filter((meal) => meal.id !== data.meal.id)];
      cart = new Map();
      notes = '';
      toast('Free meal claimed. Enjoy!', 'success');
      renderAll(false);
    } catch (err) {
      toast(err.message, 'error');
      if (/already claimed/i.test(err.message)) load(true);
    }
  });
}
