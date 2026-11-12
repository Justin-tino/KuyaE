// Cashier: pending payments - settle unpaid orders anytime.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables } from '../realtime.js';
import { openPaymentModal, openOrderDetailsModal, typeBadge, statusBadge } from '../components.js';
import { esc, money, toast, pageLoader, emptyState, fmtDateTime, elapsedLabel, debounce } from '../ui.js';

let orders = [];
let totalUnpaidCents = 0;
let rootEl = null;

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading pending payments...');
  const onClick = (event) => handleClick(event);
  container.addEventListener('click', onClick);
  const off = onTables(['orders'], debounce(() => refresh(true), 250));
  await refresh(false);
  return () => {
    off();
    container.removeEventListener('click', onClick);
  };
}

async function refresh(quiet) {
  try {
    const data = await api('/orders/pending-payments');
    orders = data.orders || [];
    totalUnpaidCents = data.totalUnpaidCents || 0;
    render(quiet);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function render(quiet) {
  if (!rootEl) return;
  const html = `
    <div class="space-y-4">
      <div class="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p class="text-sm font-bold uppercase tracking-wide text-stone-500">Unpaid orders</p>
          <p class="text-3xl font-extrabold">${orders.length}</p>
        </div>
        <div class="text-right">
          <p class="text-sm font-bold uppercase tracking-wide text-stone-500">Total to collect</p>
          <p class="text-3xl font-extrabold text-red-700">${money(totalUnpaidCents)}</p>
        </div>
        <p class="w-full text-sm font-semibold text-stone-500 sm:w-auto">
          Oldest order first. Tap "Mark as Paid" once the customer pays.
        </p>
      </div>

      ${
        orders.length
          ? `<div class="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">${orders.map(cardHtml).join('')}</div>`
          : `<div class="card">${emptyState(
              'check',
              'No pending payments',
              'All orders are fully paid. New unpaid orders will appear here automatically.'
            )}</div>`
      }
    </div>`;

  if (quiet) {
    rootEl.innerHTML = html;
  } else {
    rootEl.innerHTML = html;
  }
}

function cardHtml(order) {
  return `
    <div class="card flex flex-col gap-3 p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-3xl font-extrabold">${esc(order.numberLabel)}</p>
          <p class="text-lg font-bold">${esc(order.customerName)}</p>
        </div>
        <div class="text-right">
          <p class="text-2xl font-extrabold text-red-700">${money(order.totalCents)}</p>
          <p class="text-sm font-semibold text-stone-500">${esc(elapsedLabel(order.createdAt))}</p>
        </div>
      </div>
      <div class="flex flex-wrap gap-2">${typeBadge(order.orderType)}${statusBadge(order.status)}</div>
      <p class="text-sm text-stone-500">Ordered ${esc(fmtDateTime(order.createdAt))}</p>
      <div class="mt-auto flex gap-2 pt-2">
        <button type="button" data-pay="${order.id}" class="btn btn-md btn-success flex-1">
          ${icon('cash', 'w-5 h-5')} Mark as Paid
        </button>
        <button type="button" data-view="${order.id}" class="btn btn-md btn-secondary">Details</button>
      </div>
    </div>`;
}

function handleClick(event) {
  const payButton = event.target.closest('[data-pay]');
  if (payButton) {
    const order = orders.find((entry) => entry.id === payButton.getAttribute('data-pay'));
    if (!order) return;
    openPaymentModal({
      mode: 'pay',
      totalCents: order.totalCents,
      onSubmit: async (payload) => {
        await api(`/orders/${order.id}/pay`, { method: 'POST', body: payload });
        toast(`Payment recorded for ${order.numberLabel}.`, 'success');
        refresh(true);
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
