// Cashier: pending payments - settle unpaid orders any time.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables, everyWhileVisible } from '../realtime.js';
import { openPaymentModal, openOrderDetailsModal, typeBadge, statusBadge } from '../components.js';
import {
  esc,
  money,
  toast,
  toastThrottled,
  emptyState,
  fmtDateTime,
  elapsedLabel,
  debounce,
  skeleton,
} from '../ui.js';

const FALLBACK_REFRESH_MS = 20000;

let orders = [];
let totalUnpaidCents = 0;
let rootEl = null;
let signature = '';
let hasData = false;

export async function mount(container) {
  rootEl = container;
  signature = '';
  hasData = false;

  const onClick = (event) => handleClick(event);
  container.addEventListener('click', onClick);

  const cleanups = [
    () => container.removeEventListener('click', onClick),
    onTables(['orders'], debounce(() => refresh(true), 250)),
    everyWhileVisible(() => refresh(true), FALLBACK_REFRESH_MS),
  ];

  renderSkeleton();
  await refresh(false);

  return () => cleanups.forEach((fn) => fn());
}

async function refresh(quiet) {
  try {
    const data = await api('/orders/pending-payments');
    orders = data.orders || [];
    totalUnpaidCents = data.totalUnpaidCents || 0;
    hasData = true;
    render();
  } catch (err) {
    if (!hasData) {
      rootEl.innerHTML = `
        <div class="panel p-8 text-center">
          <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-red-700">
            ${icon('alert', 'w-7 h-7')}
          </div>
          <p class="mt-3 text-lg font-extrabold">Could not load pending payments</p>
          <p class="mt-1 text-stone-600">${esc(err.message)}</p>
          <button type="button" data-retry class="btn btn-md btn-primary mt-4">
            ${icon('refresh', 'w-5 h-5')} Try Again
          </button>
        </div>`;
    } else {
      toastThrottled('pending-refresh', err.message, 'error', quiet ? 60000 : 4000);
    }
  }
}

function renderSkeleton() {
  const card = `
    <div class="panel gap-3 p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="space-y-2">${skeleton('h-6 w-20')}${skeleton('h-4 w-28')}</div>
        ${skeleton('h-6 w-24')}
      </div>
      <div class="flex gap-2">${skeleton('h-6 w-20')}${skeleton('h-6 w-24')}</div>
      ${skeleton('h-4 w-2/3')}
      <div class="flex gap-2">${skeleton('h-11 flex-1')}${skeleton('h-11 w-24')}</div>
    </div>`;

  rootEl.innerHTML = `
    <div class="space-y-3">
      <div class="panel p-4">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="space-y-2">${skeleton('h-4 w-28')}${skeleton('h-8 w-16')}</div>
          <div class="space-y-2">${skeleton('h-4 w-32')}${skeleton('h-8 w-24')}</div>
        </div>
      </div>
      <div class="load-bar rounded-full"></div>
      <div class="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">${card}${card}${card}</div>
    </div>`;
}

function computeSignature() {
  return JSON.stringify(orders.map((o) => [o.id, o.status, o.paymentStatus, o.totalCents, o.customerName]));
}

function render() {
  if (!rootEl) return;
  const next = computeSignature();
  if (hasData && rootEl.querySelector('[data-list]') && next === signature) return;
  signature = next;
  rootEl.innerHTML = html();
}

function html() {
  return `
    <div class="space-y-3">
      <div class="panel shrink-0">
        <div class="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
          <div class="flex items-center gap-2">
            ${icon('clock', 'w-4 h-4 text-amber-600')}
            <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Unpaid orders</span>
            <span class="text-2xl font-extrabold">${orders.length}</span>
          </div>
          <div class="flex items-center gap-2">
            ${icon('cash', 'w-4 h-4 text-red-700')}
            <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Total to collect</span>
            <span class="text-2xl font-extrabold text-red-700">${money(totalUnpaidCents)}</span>
          </div>
          <p class="ml-auto hidden text-xs font-semibold text-stone-500 lg:block">
            Oldest order first. Collect the payment, then mark the order as paid.
          </p>
        </div>
      </div>

      ${
        orders.length
          ? `<div data-list class="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">${orders.map(cardHtml).join('')}</div>`
          : `<div data-list class="panel">${emptyState(
              'check',
              'No pending payments',
              'All orders are fully paid. Unpaid orders appear here automatically.'
            )}</div>`
      }
    </div>`;
}

function cardHtml(order) {
  return `
    <div class="panel gap-3 p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-2xl font-extrabold leading-none tracking-tight">${esc(order.numberLabel)}</p>
          <p class="mt-1 truncate text-sm font-bold text-stone-700">${esc(order.customerName)}</p>
        </div>
        <div class="text-right">
          <p class="text-xl font-extrabold text-red-700">${money(order.totalCents)}</p>
          <p class="text-xs font-semibold text-stone-500">${esc(elapsedLabel(order.createdAt))}</p>
        </div>
      </div>

      <div class="flex flex-wrap gap-1.5">${typeBadge(order.orderType)}${statusBadge(order.status)}</div>

      <p class="text-xs text-stone-500">Ordered ${esc(fmtDateTime(order.createdAt))}</p>

      <div class="mt-auto flex gap-2 pt-1">
        <button type="button" data-pay="${order.id}" class="btn btn-md btn-success flex-1">
          ${icon('cash', 'w-5 h-5')} Mark as Paid
        </button>
        <button type="button" data-view="${order.id}" class="btn btn-md btn-secondary">Details</button>
      </div>
    </div>`;
}

function handleClick(event) {
  if (event.target.closest('[data-retry]')) {
    renderSkeleton();
    refresh(false);
    return;
  }

  const payButton = event.target.closest('[data-pay]');
  if (payButton) {
    const order = orders.find((entry) => entry.id === payButton.getAttribute('data-pay'));
    if (!order) return;
    openPaymentModal({
      mode: 'pay',
      totalCents: order.totalCents,
      onSubmit: async (payload) => {
        const data = await api(`/orders/${order.id}/pay`, { method: 'POST', body: payload });
        const updated = data && data.order ? data.order : null;
        if (updated) {
          // Paid: drop it from the list and adjust the header total at once -
          // the live stream re-checks in the background.
          orders = orders.filter((entry) => entry.id !== updated.id);
          totalUnpaidCents = Math.max(0, totalUnpaidCents - updated.totalCents);
          render();
        } else {
          refresh(true);
        }
        toast(`Payment recorded for ${order.numberLabel}.`, 'success');
      },
    });
    return;
  }

  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    const order = orders.find((entry) => entry.id === viewButton.getAttribute('data-view'));
    if (!order) return;
    openOrderDetailsModal(order, { canManage: true, onChanged: () => refresh(true) });
  }
}
