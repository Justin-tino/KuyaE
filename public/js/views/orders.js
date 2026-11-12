// Cashier/Admin: order history for the day.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables } from '../realtime.js';
import { openOrderDetailsModal, printReceipt, statusBadge, paymentBadge, typeBadge } from '../components.js';
import {
  esc,
  money,
  toast,
  fmtTime,
  todayLocalStr,
  renderPreservingFocus,
  debounce,
  emptyState,
  tableLoadingRow,
  pageLoader,
} from '../ui.js';

const filters = {
  date: todayLocalStr(),
  status: '',
  payment: '',
  search: '',
};

let orders = [];
let total = 0;
let loading = true;
let rootEl = null;

const STATUS_CHIPS = [
  ['', 'All'],
  ['pending', 'Waiting'],
  ['preparing', 'Cooking'],
  ['served', 'Served'],
  ['cancelled', 'Cancelled'],
];

const PAYMENT_CHIPS = [
  ['', 'All payments'],
  ['paid', 'Paid'],
  ['pending', 'Unpaid'],
];

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading orders...');
  const onClick = (event) => handleClick(event);
  const onInput = (event) => handleInput(event);
  const onChange = (event) => handleChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  const off = onTables(['orders'], debounce(() => refresh(true), 300));
  await refresh(false);
  return () => {
    off();
    container.removeEventListener('click', onClick);
    container.removeEventListener('input', onInput);
    container.removeEventListener('change', onChange);
  };
}

async function refresh(quiet) {
  if (!quiet) {
    loading = true;
    render();
  }
  try {
    const params = new URLSearchParams();
    params.set('from', filters.date);
    params.set('to', filters.date);
    if (filters.status) params.set('status', filters.status);
    if (filters.payment) params.set('payment', filters.payment);
    if (filters.search.trim()) params.set('search', filters.search.trim());
    const data = await api(`/orders?${params.toString()}`);
    orders = data.orders || [];
    total = data.total || 0;
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
        <div class="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div class="w-full lg:w-56">
            <label class="label" for="order-date">Date</label>
            <input id="order-date" type="date" class="input" value="${esc(filters.date)}">
          </div>
          <div class="min-w-0 flex-1">
            <label class="label" for="order-search">Search</label>
            <div class="relative">
              <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-stone-400">${icon('search', 'w-5 h-5')}</span>
              <input id="order-search" data-focus-key="order-search" class="input pl-12" placeholder="Customer name or order number" value="${esc(filters.search)}" autocomplete="off">
            </div>
          </div>
          <button type="button" data-action="refresh" class="btn btn-md btn-secondary">${icon('refresh', 'w-5 h-5')} Refresh</button>
        </div>

        <div class="mt-4 flex flex-wrap gap-2">
          ${STATUS_CHIPS.map(
            ([value, label]) =>
              `<button type="button" data-status="${value}" class="chip ${filters.status === value ? 'chip-active' : ''}">${label}</button>`
          ).join('')}
          <span class="mx-1 hidden w-px bg-stone-200 sm:block"></span>
          ${PAYMENT_CHIPS.map(
            ([value, label]) =>
              `<button type="button" data-payment="${value}" class="chip ${filters.payment === value ? 'chip-active' : ''}">${label}</button>`
          ).join('')}
        </div>
      </div>

      <div class="card overflow-hidden">
        <div class="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <p class="font-bold text-stone-600">${loading ? 'Loading orders...' : `${total} order${total === 1 ? '' : 's'} found`}</p>
          <p class="text-sm font-semibold text-stone-500">Newest first</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px]">
            <thead class="bg-stone-50">
              <tr>
                <th class="th">Order</th>
                <th class="th">Customer</th>
                <th class="th">Type</th>
                <th class="th">Payment</th>
                <th class="th">Status</th>
                <th class="th text-right">Total</th>
                <th class="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                loading
                  ? tableLoadingRow(7, 'Loading orders...')
                  : orders.length
                  ? orders.map(rowHtml).join('')
                  : `<tr><td colspan="7">${emptyState('receipt', 'No orders found', 'Try another date or clear the filters.')}</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  if (quiet) {
    // Preserve what the user is typing while live updates come in.
    renderPreservingFocus(rootEl, html);
  } else {
    rootEl.innerHTML = html;
  }
}

function rowHtml(order) {
  return `
    <tr class="cursor-pointer border-b border-stone-100 hover:bg-stone-50" data-view="${order.id}">
      <td class="td font-extrabold">${esc(order.numberLabel)}</td>
      <td class="td">
        <p class="font-semibold">${esc(order.customerName)}</p>
        <p class="text-sm text-stone-500">${esc(fmtTime(order.createdAt))}</p>
      </td>
      <td class="td">${typeBadge(order.orderType)}</td>
      <td class="td">${paymentBadge(order)}</td>
      <td class="td">${statusBadge(order.status)}</td>
      <td class="td whitespace-nowrap text-right font-extrabold">${money(order.totalCents)}</td>
      <td class="td">
        <div class="flex justify-end gap-2">
          <button type="button" data-print="${order.id}" class="btn btn-ghost btn-sm" title="Print receipt">${icon('printer', 'w-5 h-5')}</button>
          <button type="button" data-view="${order.id}" class="btn btn-secondary btn-sm">View</button>
        </div>
      </td>
    </tr>`;
}

function handleClick(event) {
  const printButton = event.target.closest('[data-print]');
  if (printButton) {
    const order = orders.find((entry) => entry.id === printButton.getAttribute('data-print'));
    if (order) printReceipt(order);
    return;
  }

  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    const order = orders.find((entry) => entry.id === viewButton.getAttribute('data-view'));
    if (!order) return;
    openOrderDetailsModal(order, { canManage: true, onChanged: () => refresh(true) });
    return;
  }

  const statusButton = event.target.closest('[data-status]');
  if (statusButton) {
    filters.status = statusButton.getAttribute('data-status');
    refresh(false);
    return;
  }

  const paymentButton = event.target.closest('[data-payment]');
  if (paymentButton) {
    filters.payment = paymentButton.getAttribute('data-payment');
    refresh(false);
    return;
  }

  const actionButton = event.target.closest('[data-action="refresh"]');
  if (actionButton) refresh(false);
}

function handleInput(event) {
  if (event.target.id === 'order-search') {
    filters.search = event.target.value;
    debouncedSearch();
  }
}

const debouncedSearch = debounce(() => refresh(true), 350);

function handleChange(event) {
  if (event.target.id === 'order-date') {
    filters.date = event.target.value || todayLocalStr();
    refresh(false);
  }
}
