// Kitchen display: live order board, first come first served.
//
// Layout: compact status toolbar + two independently scrolling boards
// (In Queue / Now Cooking) that fill the screen from tablet size up, so the
// cook never scrolls the page to see what is next.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables, onEvent, everyWhileVisible } from '../realtime.js';
import { typeBadge } from '../components.js';
import {
  esc,
  toast,
  toastThrottled,
  emptyState,
  fmtTime,
  elapsedLabel,
  minutesAgo,
  debounce,
  withButtonLoading,
  openModal,
  skeleton,
} from '../ui.js';

// Safety net: even if the live stream is down, the board stays current.
const FALLBACK_REFRESH_MS = 12000;

let orders = [];
let servedToday = [];
let rootEl = null;
let elapsedTimer = null;
let boardSignature = '';
let hasData = false;
let loadError = '';
let lastAlert = { id: '', at: 0 };

export async function mount(container) {
  rootEl = container;
  orders = [];
  servedToday = [];
  boardSignature = '';
  hasData = false;
  loadError = '';

  const onClick = (event) => handleClick(event);
  container.addEventListener('click', onClick);

  const cleanups = [
    () => container.removeEventListener('click', onClick),
    onTables(['orders'], debounce(() => refresh(true), 200)),
    onEvent((event) => {
      if (event.type !== 'order_created') return;
      // The same order can arrive from more than one broadcast path - alert once.
      const now = Date.now();
      if (lastAlert.id === event.order.id && now - lastAlert.at < 15000) return;
      lastAlert = { id: event.order.id, at: now };
      toast(`New order ${event.order.numberLabel} - ${event.order.customerName}`);
    }),
    everyWhileVisible(() => refresh(true), FALLBACK_REFRESH_MS),
  ];

  elapsedTimer = setInterval(updateElapsed, 30000);
  cleanups.push(() => clearInterval(elapsedTimer));

  renderSkeleton();
  await refresh(false);

  return () => cleanups.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refresh(quiet) {
  setBusy(true);
  try {
    const data = await api('/orders/kitchen');
    orders = data.orders || [];
    servedToday = data.servedToday || [];
    loadError = '';
    hasData = true;
    renderBoard();
  } catch (err) {
    if (!hasData) {
      loadError = err.message || 'Could not load the kitchen board.';
      renderError();
    } else {
      toastThrottled('kitchen-refresh', err.message, 'error', quiet ? 60000 : 4000);
    }
  } finally {
    setBusy(false);
  }
}

/**
 * Applies a saved order (from a start/serve response) straight onto the board.
 * The live stream and the fallback refresh remain the safety nets for
 * everything else - this only removes the wait for the button that was tapped.
 */
function applyOrder(updated) {
  if (!updated || !updated.id) return;
  const index = orders.findIndex((entry) => entry.id === updated.id);
  if (updated.status === 'served') {
    if (index >= 0) orders.splice(index, 1);
    servedToday = [updated, ...servedToday.filter((entry) => entry.id !== updated.id)];
  } else if (updated.status === 'cancelled') {
    if (index >= 0) orders.splice(index, 1);
  } else if (index >= 0) {
    orders[index] = updated;
  } else {
    orders.push(updated);
    orders.sort((a, b) => a.number - b.number);
  }
  renderBoard();
}

/** Cheap fingerprint: skip the DOM work when nothing actually changed. */
function computeSignature() {
  return JSON.stringify({
    orders: orders.map((o) => [
      o.id,
      o.status,
      o.paymentStatus,
      o.numberLabel,
      o.customerName,
      o.orderType,
      o.notes,
      o.items.map((i) => `${i.quantity}x${i.name}`).join(','),
    ]),
    served: servedToday.length,
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSkeleton() {
  rootEl.innerHTML = `
    <div class="flex flex-col gap-3 workfit" data-skeleton>
      <div class="flex flex-wrap items-center gap-2">
        ${skeleton('h-9 w-32')}
        ${skeleton('h-9 w-36')}
        ${skeleton('h-9 w-36')}
        <div class="ml-auto flex gap-2">${skeleton('h-9 w-32')}${skeleton('h-9 w-28')}</div>
      </div>
      <div class="load-bar rounded-full"></div>
      <div class="grid min-h-0 gap-3 md:grid-cols-2 md:grid-rows-1 md:flex-1">
        ${skeletonPane()}${skeletonPane()}
      </div>
    </div>`;
}

function skeletonPane() {
  const card = `
    <div class="rounded-2xl border border-stone-200 p-3.5">
      <div class="flex items-start justify-between gap-3">
        <div class="space-y-2">${skeleton('h-6 w-20')}${skeleton('h-4 w-28')}</div>
        ${skeleton('h-5 w-16')}
      </div>
      <div class="mt-3 space-y-2">${skeleton('h-4 w-3/4')}${skeleton('h-4 w-1/2')}</div>
      <div class="mt-3">${skeleton('h-10 w-full')}</div>
    </div>`;
  return `
    <section class="panel">
      <div class="panel-head">${skeleton('h-5 w-32')}${skeleton('h-6 w-9')}</div>
      <div class="space-y-3 p-3">${card}${card}${card}</div>
    </section>`;
}

function renderError() {
  rootEl.innerHTML = `
    <div class="panel p-8 text-center">
      <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-red-700">
        ${icon('alert', 'w-7 h-7')}
      </div>
      <p class="mt-3 text-lg font-extrabold">Could not load the kitchen board</p>
      <p class="mt-1 text-stone-600">${esc(loadError)}</p>
      <button type="button" data-action="retry" class="btn btn-md btn-primary mt-4">
        ${icon('refresh', 'w-5 h-5')} Try Again
      </button>
    </div>`;
}

function renderBoard() {
  if (!rootEl) return;
  const next = computeSignature();
  const board = rootEl.querySelector('[data-board]');
  if (board && next === boardSignature) return; // nothing changed - keep scroll and taps intact
  boardSignature = next;

  const queueScroll = scrollOf('queue');
  const cookingScroll = scrollOf('cooking');
  rootEl.innerHTML = boardHtml();
  setScrollOf('queue', queueScroll);
  setScrollOf('cooking', cookingScroll);
}

function scrollOf(key) {
  const el = rootEl && rootEl.querySelector(`[data-board="${key}"]`);
  return el ? el.scrollTop : 0;
}

function setScrollOf(key, value) {
  const el = rootEl && rootEl.querySelector(`[data-board="${key}"]`);
  if (el && value) el.scrollTop = value;
}

function boardHtml() {
  const queue = orders.filter((order) => order.status === 'pending');
  const cooking = orders.filter((order) => order.status === 'preparing');

  return `
    <div class="flex flex-col gap-3 workfit" data-board-root>
      ${toolbarHtml(queue, cooking)}
      <div class="grid min-h-0 gap-3 md:grid-cols-2 md:grid-rows-1 md:flex-1">
        ${paneHtml({
          key: 'queue',
          title: 'In Queue',
          iconName: 'clock',
          count: queue.length,
          badgeClass: 'bg-amber-100 text-amber-900',
          empty: emptyState('clock', 'Queue is clear', 'New orders appear here the moment the cashier saves them.'),
          body: queue
            .map((order, index) => cardHtml(order, { queue: true, isNext: index === 0 }))
            .join(''),
        })}
        ${paneHtml({
          key: 'cooking',
          title: 'Now Cooking',
          iconName: 'fire',
          count: cooking.length,
          badgeClass: 'bg-sky-100 text-sky-900',
          empty: emptyState('fire', 'Nothing cooking', 'Tap "Start Cooking" on an order in the queue.'),
          body: cooking.map((order) => cardHtml(order, { queue: false })).join(''),
        })}
      </div>
    </div>`;
}

function toolbarHtml(queue, cooking) {
  return `
    <div class="flex flex-wrap items-center gap-2">
      <div class="stat-chip">
        ${icon('clock', 'w-4 h-4 text-amber-600')}
        <span class="text-xs font-bold uppercase tracking-wide text-stone-500">In Queue</span>
        <span class="text-lg font-extrabold">${queue.length}</span>
      </div>
      <div class="stat-chip">
        ${icon('fire', 'w-4 h-4 text-sky-600')}
        <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Now Cooking</span>
        <span class="text-lg font-extrabold text-sky-700">${cooking.length}</span>
      </div>
      <div class="stat-chip">
        ${icon('check', 'w-4 h-4 text-emerald-600')}
        <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Served Today</span>
        <span class="text-lg font-extrabold text-emerald-700">${servedToday.length}</span>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <button type="button" data-action="served" class="btn btn-secondary btn-sm">
          ${icon('receipt', 'w-4 h-4')} Served
        </button>
        <button type="button" data-action="refresh" class="btn btn-ghost btn-sm">
          ${icon('refresh', 'w-4 h-4')} Refresh
        </button>
      </div>

      <div class="w-full">
        <div data-busy class="load-bar rounded-full opacity-0 transition-opacity duration-200"></div>
      </div>
    </div>`;
}

function paneHtml({ key, title, iconName, count, badgeClass, body, empty }) {
  return `
    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">${icon(iconName, 'w-4 h-4')} ${esc(title)}</h2>
        <span class="badge ${badgeClass}">${count}</span>
      </div>
      <div data-board="${key}" class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        ${count ? body : `<div class="rounded-2xl border border-dashed border-stone-200">${empty}</div>`}
      </div>
    </section>`;
}

function cardHtml(order, { queue, isNext = false }) {
  const isNew = minutesAgo(order.createdAt) < 2;
  const unpaid = order.paymentStatus !== 'paid';
  return `
    <article class="pop-in rounded-2xl border border-stone-200 bg-white p-3.5 shadow-sm ${
      isNext ? 'ring-2 ring-stone-900' : ''
    } ${isNew ? 'flash-new border-amber-400' : ''}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-2xl font-extrabold leading-none tracking-tight">${esc(order.numberLabel)}</p>
          <p class="mt-1 truncate text-sm font-bold text-stone-700">${esc(order.customerName)}</p>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
          ${isNext ? '<span class="badge bg-stone-900 text-white">NEXT UP</span>' : ''}
          ${isNew ? '<span class="badge bg-amber-400 text-stone-900">NEW</span>' : ''}
          ${unpaid ? '<span class="badge bg-red-100 text-red-900">UNPAID</span>' : ''}
        </div>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        ${typeBadge(order.orderType)}
        <span class="badge bg-stone-100 text-stone-600" data-elapsed="${esc(order.createdAt)}">${esc(
          elapsedLabel(order.createdAt)
        )}</span>
      </div>

      <ul class="mt-2.5 space-y-1">
        ${order.items
          .map(
            (item) => `<li class="flex items-baseline gap-2 text-lg font-semibold leading-snug">
              <span class="font-extrabold text-red-700">${item.quantity}x</span>
              <span>${esc(item.name)}</span>
            </li>`
          )
          .join('')}
      </ul>

      ${
        order.notes
          ? `<div class="mt-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
              <p class="text-xs font-bold uppercase tracking-wide text-amber-700">Notes</p>
              <p class="text-base font-semibold text-amber-900">${esc(order.notes)}</p>
            </div>`
          : ''
      }

      <div class="mt-3">
        ${
          queue
            ? `<button type="button" data-start="${order.id}" class="btn btn-md btn-primary w-full">
                ${icon('fire', 'w-5 h-5')} Start Cooking
              </button>`
            : `<button type="button" data-serve="${order.id}" class="btn btn-md btn-success w-full">
                ${icon('check', 'w-5 h-5')} Done &amp; Served
              </button>`
        }
      </div>
    </article>`;
}

function setBusy(value) {
  const bar = rootEl && rootEl.querySelector('[data-busy]');
  if (bar) bar.classList.toggle('opacity-0', !value);
}

// ---------------------------------------------------------------------------
// Served list
// ---------------------------------------------------------------------------

function openServedModal() {
  openModal({
    title: `Served today (${servedToday.length})`,
    size: 'lg',
    content: servedToday.length
      ? `<div class="overflow-x-auto">
          <table class="w-full">
            <thead class="bg-stone-50">
              <tr>
                <th class="th">Order</th>
                <th class="th">Customer</th>
                <th class="th">Type</th>
                <th class="th">Payment</th>
                <th class="th text-right">Served at</th>
              </tr>
            </thead>
            <tbody>
              ${servedToday
                .map(
                  (order) => `<tr class="border-b border-stone-100 last:border-0">
                    <td class="td font-extrabold">${esc(order.numberLabel)}</td>
                    <td class="td">${esc(order.customerName)}</td>
                    <td class="td">${typeBadge(order.orderType)}</td>
                    <td class="td">${
                      order.paymentStatus === 'paid'
                        ? '<span class="badge bg-emerald-100 text-emerald-900">Paid</span>'
                        : '<span class="badge bg-red-100 text-red-900">Unpaid</span>'
                    }</td>
                    <td class="td text-right">${esc(fmtTime(order.servedAt))}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>`
      : emptyState('check', 'Nothing served yet', 'Orders marked as served show up here.'),
  });
}

function updateElapsed() {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const iso = el.getAttribute('data-elapsed');
    if (iso) el.textContent = elapsedLabel(iso);
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleClick(event) {
  const startButton = event.target.closest('[data-start]');
  if (startButton) {
    const id = startButton.getAttribute('data-start');
    const order = orders.find((entry) => entry.id === id);
    await withButtonLoading(startButton, 'Starting...', async () => {
      try {
        const data = await api(`/orders/${id}/start`, { method: 'POST' });
        // Update the board from the response itself - the card moves to
        // "Now Cooking" the instant the server confirms, with no refetch.
        applyOrder(data && data.order);
        toast(order ? `${order.numberLabel} is now cooking.` : 'Order is now cooking.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return;
  }

  const serveButton = event.target.closest('[data-serve]');
  if (serveButton) {
    const id = serveButton.getAttribute('data-serve');
    const order = orders.find((entry) => entry.id === id);
    await withButtonLoading(serveButton, 'Serving...', async () => {
      try {
        const data = await api(`/orders/${id}/serve`, { method: 'POST' });
        applyOrder(data && data.order);
        toast(order ? `${order.numberLabel} served.` : 'Order served.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return;
  }

  if (event.target.closest('[data-action="served"]')) {
    openServedModal();
    return;
  }

  if (event.target.closest('[data-action="retry"]')) {
    hasData = false;
    boardSignature = '';
    renderSkeleton();
    refresh(false);
    return;
  }

  if (event.target.closest('[data-action="refresh"]')) {
    refresh(false);
  }
}
