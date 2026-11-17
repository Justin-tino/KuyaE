// Admin: read-only list of free staff meals claimed by cashier and kitchen.
//
// These records live outside public.orders, so they never affect the sales
// dashboard, reports, top items or order numbers.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables, everyWhileVisible } from '../realtime.js';
import {
  esc,
  toast,
  fmtDateTime,
  fmtDayLabel,
  todayLocalStr,
  debounce,
  emptyState,
  tableLoadingRow,
  renderPreservingFocus,
} from '../ui.js';

const REFRESH_MS = 30000;

const filters = {
  from: todayLocalStr(),
  to: todayLocalStr(),
  role: '',
  search: '',
};

let meals = [];
let summary = {};
let loading = true;
let rootEl = null;

const ROLE_CHIPS = [
  ['', 'All staff'],
  ['cashier', 'Cashier'],
  ['kitchen', 'Kitchen'],
];

export async function mount(container) {
  rootEl = container;
  const onClick = (event) => handleClick(event);
  const onInput = (event) => handleInput(event);
  const onChange = (event) => handleChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  const off = onTables(['staff_meals'], debounce(() => load(true), 400));
  const timer = everyWhileVisible(() => load(true), REFRESH_MS);
  await load(false);

  return () => {
    off();
    timer();
    container.removeEventListener('click', onClick);
    container.removeEventListener('input', onInput);
    container.removeEventListener('change', onChange);
  };
}

async function load(quiet) {
  if (!quiet) {
    loading = true;
    render();
  }
  try {
    const params = new URLSearchParams({ from: filters.from, to: filters.to });
    if (filters.role) params.set('role', filters.role);
    if (filters.search.trim()) params.set('search', filters.search.trim());
    const data = await api(`/staff-meals?${params.toString()}`);
    meals = data.meals || [];
    summary = data.summary || {};
    loading = false;
    render(quiet);
  } catch (err) {
    loading = false;
    render(true);
    toast(err.message, 'error');
  }
}

function render(quiet) {
  if (!rootEl) return;
  const html = `
    <div class="space-y-4">
      <div class="card p-4">
        <div class="grid gap-3 lg:grid-cols-5">
          <div>
            <label class="label" for="staff-meals-from">From</label>
            <input id="staff-meals-from" type="date" class="input" value="${esc(filters.from)}">
          </div>
          <div>
            <label class="label" for="staff-meals-to">To</label>
            <input id="staff-meals-to" type="date" class="input" value="${esc(filters.to)}">
          </div>
          <div>
            <label class="label" for="staff-meals-role">Role</label>
            <select id="staff-meals-role" class="input">
              ${ROLE_CHIPS.map(
                ([value, label]) =>
                  `<option value="${value}" ${filters.role === value ? 'selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </div>
          <div class="lg:col-span-2">
            <label class="label" for="staff-meals-search">Search staff</label>
            <div class="flex gap-2">
              <div class="relative min-w-0 flex-1">
                <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">${icon('search', 'w-5 h-5')}</span>
                <input id="staff-meals-search" data-focus-key="staff-meals-search" class="input pl-10"
                  placeholder="Staff name" value="${esc(filters.search)}" autocomplete="off">
              </div>
              <button type="button" data-action="refresh" class="btn btn-md btn-secondary shrink-0" title="Refresh">
                ${icon('refresh', 'w-5 h-5')}
              </button>
            </div>
          </div>
        </div>
        <p class="mt-3 text-sm font-semibold text-stone-500">
          Free meals claimed by cashier and kitchen staff. These are recorded separately and never affect sales.
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <div class="stat-chip">
          ${icon('users', 'w-4 h-4 text-stone-500')}
          <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Meals</span>
          <span class="text-lg font-extrabold">${summary.totalMeals || 0}</span>
        </div>
        <div class="stat-chip">
          ${icon('cart', 'w-4 h-4 text-indigo-600')}
          <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Cashier</span>
          <span class="text-lg font-extrabold text-indigo-700">${summary.cashierMeals || 0}</span>
        </div>
        <div class="stat-chip">
          ${icon('fire', 'w-4 h-4 text-sky-600')}
          <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Kitchen</span>
          <span class="text-lg font-extrabold text-sky-700">${summary.kitchenMeals || 0}</span>
        </div>
        <div class="stat-chip">
          ${icon('user', 'w-4 h-4 text-emerald-600')}
          <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Unique staff</span>
          <span class="text-lg font-extrabold text-emerald-700">${summary.uniqueStaff || 0}</span>
        </div>
        <div class="stat-chip">
          ${icon('bowl', 'w-4 h-4 text-amber-600')}
          <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Items</span>
          <span class="text-lg font-extrabold text-amber-700">${summary.itemsCount || 0}</span>
        </div>
      </div>

      <div class="card overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-5 py-3">
          <p class="font-bold text-stone-600">
            ${loading ? 'Loading staff meals...' : `${meals.length} meal${meals.length === 1 ? '' : 's'} found`}
          </p>
          <p class="text-sm font-semibold text-stone-500">${esc(rangeLabel())} - newest first</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[820px]">
            <thead class="bg-stone-50">
              <tr>
                <th class="th">Date &amp; time</th>
                <th class="th">Staff</th>
                <th class="th">Role</th>
                <th class="th">Meal</th>
                <th class="th">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${
                loading
                  ? tableLoadingRow(5, 'Loading staff meals...')
                  : meals.length
                  ? meals.map(rowHtml).join('')
                  : `<tr><td colspan="5">${emptyState(
                      'bowl',
                      'No staff meals found',
                      'No cashier or kitchen staff claimed a free meal in this period.'
                    )}</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  if (quiet) renderPreservingFocus(rootEl, html);
  else rootEl.innerHTML = html;
}

function rowHtml(meal) {
  return `
    <tr class="border-b border-stone-100 last:border-0">
      <td class="td whitespace-nowrap">
        <p class="font-bold">${esc(fmtDateTime(meal.createdAt))}</p>
        <p class="text-xs text-stone-500">${esc(meal.mealDate || '')}</p>
      </td>
      <td class="td font-semibold">${esc(meal.staffName)}</td>
      <td class="td">${roleBadge(meal.staffRole)}</td>
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
    </tr>`;
}

function roleBadge(role) {
  return role === 'kitchen'
    ? '<span class="badge bg-sky-100 text-sky-900">Kitchen</span>'
    : '<span class="badge bg-indigo-100 text-indigo-900">Cashier</span>';
}

function rangeLabel() {
  if (filters.from === filters.to) return fmtDayLabel(filters.from) + ', ' + filters.from.slice(0, 4);
  return `${fmtDayLabel(filters.from)}, ${filters.from.slice(0, 4)} to ${fmtDayLabel(filters.to)}, ${filters.to.slice(0, 4)}`;
}

function handleClick(event) {
  if (event.target.closest('[data-action="refresh"]')) {
    load(false);
  }
}

function handleInput(event) {
  if (event.target.id === 'staff-meals-search') {
    filters.search = event.target.value;
    debouncedSearch();
  }
}

const debouncedSearch = debounce(() => load(true), 400);

function handleChange(event) {
  if (event.target.id === 'staff-meals-from') {
    filters.from = event.target.value || todayLocalStr();
    if (filters.to < filters.from) filters.to = filters.from;
    load(false);
  }
  if (event.target.id === 'staff-meals-to') {
    filters.to = event.target.value || todayLocalStr();
    if (filters.to < filters.from) filters.from = filters.to;
    load(false);
  }
  if (event.target.id === 'staff-meals-role') {
    filters.role = event.target.value;
    load(false);
  }
}
