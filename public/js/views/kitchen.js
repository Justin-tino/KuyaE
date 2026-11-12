// Kitchen: first come, first served order board.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables, onEvent } from '../realtime.js';
import { statusBadge, typeBadge, typeLabel } from '../components.js';
import {
  esc,
  money,
  toast,
  pageLoader,
  emptyState,
  fmtTime,
  elapsedLabel,
  minutesAgo,
  debounce,
  withButtonLoading,
} from '../ui.js';

let orders = [];
let servedToday = [];
let rootEl = null;
let elapsedTimer = null;

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading kitchen orders...');

  const onClick = (event) => handleClick(event);
  container.addEventListener('click', onClick);
  const offTables = onTables(['orders'], debounce(() => refresh(true), 250));
  const offEvent = onEvent((event) => {
    if (event.type === 'order_created') {
      toast(`New order ${event.order.numberLabel} - ${event.order.customerName}`, 'info', 6000);
    }
  });
  elapsedTimer = setInterval(updateElapsed, 30000);

  await refresh(false);

  return () => {
    offTables();
    offEvent();
    container.removeEventListener('click', onClick);
    clearInterval(elapsedTimer);
  };
}

async function refresh(quiet) {
  try {
    const data = await api('/orders/kitchen');
    orders = data.orders || [];
    servedToday = data.servedToday || [];
    render(quiet);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function render(quiet) {
  if (!rootEl) return;
  const queue = orders.filter((order) => order.status === 'pending');
  const cooking = orders.filter((order) => order.status === 'preparing');

  const html = `
    <div class="space-y-4">
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="card p-4">
          <p class="text-sm font-bold uppercase tracking-wide text-stone-500">In Queue</p>
          <p class="text-4xl font-extrabold">${queue.length}</p>
        </div>
        <div class="card p-4">
          <p class="text-sm font-bold uppercase tracking-wide text-stone-500">Now Cooking</p>
          <p class="text-4xl font-extrabold text-sky-700">${cooking.length}</p>
        </div>
        <div class="card p-4">
          <p class="text-sm font-bold uppercase tracking-wide text-stone-500">Served Today</p>
          <p class="text-4xl font-extrabold text-emerald-700">${servedToday.length}</p>
        </div>
      </div>

      <div class="rounded-2xl border border-stone-200 bg-white px-5 py-3 text-stone-600">
        <span class="font-bold">First come, first served.</span>
        Cook and serve the oldest order first - it is marked NEXT UP.
      </div>

      <div class="grid gap-5 xl:grid-cols-2">
        <section>
          <h2 class="mb-3 flex items-center gap-2 text-xl font-extrabold text-stone-700">
            ${icon('clock', 'w-6 h-6')} In Queue (${queue.length})
          </h2>
          <div class="space-y-3">
            ${
              queue.length
                ? queue.map((order, index) => cardHtml(order, { queue: true, isNext: index === 0 })).join('')
                : `<div class="card">${emptyState('clock', 'Queue is clear', 'New orders from the cashier will appear here instantly.')}</div>`
            }
          </div>
        </section>

        <section>
          <h2 class="mb-3 flex items-center gap-2 text-xl font-extrabold text-stone-700">
            ${icon('fire', 'w-6 h-6')} Now Cooking (${cooking.length})
          </h2>
          <div class="space-y-3">
            ${
              cooking.length
                ? cooking.map((order) => cardHtml(order, { queue: false })).join('')
                : `<div class="card">${emptyState('fire', 'Nothing cooking', 'Tap "Start Cooking" on an order in the queue.')}</div>`
            }
          </div>
        </section>
      </div>

      ${
        servedToday.length
          ? `<details class="card overflow-hidden">
              <summary class="cursor-pointer select-none px-5 py-4 text-lg font-bold text-stone-700">Served today (${servedToday.length})</summary>
              <div class="border-t border-stone-200">
                <table class="w-full">
                  <thead class="bg-stone-50">
                    <tr><th class="th">Order</th><th class="th">Customer</th><th class="th">Type</th><th class="th">Payment</th><th class="th text-right">Served at</th></tr>
                  </thead>
                  <tbody>
                    ${servedToday
                      .map(
                        (order) => `<tr class="border-b border-stone-100 last:border-0">
                          <td class="td font-extrabold">${esc(order.numberLabel)}</td>
                          <td class="td">${esc(order.customerName)}</td>
                          <td class="td">${typeBadge(order.orderType)}</td>
                          <td class="td">${order.paymentStatus === 'paid' ? '<span class="badge bg-emerald-100 text-emerald-900">Paid</span>' : '<span class="badge bg-red-100 text-red-900">Unpaid</span>'}</td>
                          <td class="td text-right">${esc(fmtTime(order.servedAt))}</td>
                        </tr>`
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            </details>`
          : ''
      }
    </div>`;

  if (quiet) rootEl.innerHTML = html;
  else rootEl.innerHTML = html;
}

function cardHtml(order, { queue, isNext = false }) {
  const isNew = minutesAgo(order.createdAt) < 2;
  return `
    <div class="card p-5 ${isNew ? 'flash-new border-amber-400' : ''}">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-4xl font-extrabold tracking-tight">${esc(order.numberLabel)}</p>
          <p class="mt-1 text-lg font-bold">${esc(order.customerName)}</p>
        </div>
        <div class="flex flex-col items-end gap-1">
          ${isNext ? '<span class="badge bg-stone-900 text-white">NEXT UP</span>' : ''}
          ${isNew ? '<span class="badge bg-amber-400 text-stone-900">NEW</span>' : ''}
          ${
            order.paymentStatus === 'paid'
              ? '<span class="badge bg-emerald-100 text-emerald-900">PAID</span>'
              : '<span class="badge bg-red-100 text-red-900">UNPAID</span>'
          }
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        ${typeBadge(order.orderType)}
        ${statusBadge(order.status)}
        <span class="badge bg-stone-100 text-stone-600" data-elapsed="${esc(order.createdAt)}">${esc(elapsedLabel(order.createdAt))}</span>
      </div>

      <ul class="mt-4 space-y-1.5">
        ${order.items
          .map(
            (item) => `<li class="flex items-baseline gap-2 text-xl font-semibold">
              <span class="font-extrabold text-red-700">${item.quantity}x</span>
              <span>${esc(item.name)}</span>
            </li>`
          )
          .join('')}
      </ul>

      ${
        order.notes
          ? `<div class="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
              <p class="text-xs font-bold uppercase tracking-wide text-amber-700">Notes</p>
              <p class="text-lg font-semibold text-amber-900">${esc(order.notes)}</p>
            </div>`
          : ''
      }

      <div class="mt-4">
        ${
          queue
            ? `<button type="button" data-start="${order.id}" class="btn btn-lg btn-primary w-full">
                ${icon('fire', 'w-5 h-5')} Start Cooking
              </button>`
            : `<button type="button" data-serve="${order.id}" class="btn btn-lg btn-success w-full">
                ${icon('check', 'w-6 h-6')} Done &amp; Served
              </button>`
        }
      </div>
    </div>`;
}

function updateElapsed() {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const iso = el.getAttribute('data-elapsed');
    if (iso) el.textContent = elapsedLabel(iso);
  });
}

async function handleClick(event) {
  const startButton = event.target.closest('[data-start]');
  if (startButton) {
    const order = orders.find((entry) => entry.id === startButton.getAttribute('data-start'));
    await withButtonLoading(startButton, 'Starting...', async () => {
      try {
        await api(`/orders/${startButton.getAttribute('data-start')}/start`, { method: 'POST' });
        toast(order ? `${order.numberLabel} is now cooking.` : 'Order is now cooking.', 'success');
        refresh(true);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return;
  }

  const serveButton = event.target.closest('[data-serve]');
  if (serveButton) {
    const order = orders.find((entry) => entry.id === serveButton.getAttribute('data-serve'));
    await withButtonLoading(serveButton, 'Serving...', async () => {
      try {
        await api(`/orders/${serveButton.getAttribute('data-serve')}/serve`, { method: 'POST' });
        toast(order ? `${order.numberLabel} served.` : 'Order served.', 'success');
        refresh(true);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
}
