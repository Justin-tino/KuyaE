// Kitchen display: live order board, first come first served.
//
// Layout: compact status toolbar + two boards (In Queue / Now Cooking) that
// fill the screen from tablet size up, so the cook never scrolls the page.
//
// Queue cards stay minimal - number, customer, paid/pending, a button that
// opens the full order, and the "Cook" button. Cooking cards show only the
// number and customer with a tick box; the whole batch is served with the
// button under the board once every order is ticked, so a plate is never
// served twice or skipped.

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
// Orders the cook has ticked off in "Now Cooking" - kept here until the whole
// batch is ticked and the "Served" button is pressed.
let cookChecked = new Set();

export async function mount(container) {
  rootEl = container;
  orders = [];
  servedToday = [];
  boardSignature = '';
  hasData = false;
  loadError = '';
  cookChecked = new Set();

  const onClick = (event) => handleClick(event);
  const onChange = (event) => handleCheckChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);

  const cleanups = [
    () => container.removeEventListener('click', onClick),
    () => container.removeEventListener('change', onChange),
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
    pruneChecked();
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
  pruneChecked();
  renderBoard();
}

/** Drops ticks for orders that stopped cooking (served or cancelled). */
function pruneChecked() {
  const stillCooking = new Set(orders.filter((order) => order.status === 'preparing').map((order) => order.id));
  for (const id of [...cookChecked]) {
    if (!stillCooking.has(id)) cookChecked.delete(id);
  }
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
    <div class="flex flex-col gap-2 workfit sm:gap-3" data-skeleton>
      <div class="flex flex-wrap items-center gap-2">
        ${skeleton('h-9 w-32')}
        ${skeleton('h-9 w-36')}
        ${skeleton('h-9 w-36')}
        <div class="ml-auto flex gap-2">${skeleton('h-9 w-32')}${skeleton('h-9 w-28')}</div>
      </div>
      <div class="load-bar rounded-full"></div>
      <div class="grid min-h-0 gap-2 sm:gap-3 md:grid-cols-2 md:grid-rows-1 md:flex-1">
        ${skeletonPane()}${skeletonPane()}
      </div>
    </div>`;
}

function skeletonPane() {
  const card = `
    <div class="rounded-2xl border border-stone-200 p-2.5 sm:p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="space-y-2">${skeleton('h-6 w-20')}${skeleton('h-4 w-28')}</div>
        ${skeleton('h-5 w-16')}
      </div>
      <div class="mt-3 space-y-2">${skeleton('h-9 w-full')}</div>
    </div>`;
  return `
    <section class="panel">
      <div class="panel-head">${skeleton('h-5 w-32')}${skeleton('h-6 w-9')}</div>
      <div class="grid gap-2 p-2 sm:gap-2.5 sm:p-2.5 md:grid-cols-2">${card}${card}${card}${card}</div>
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
    <div class="flex flex-col gap-2 workfit sm:gap-3" data-board-root>
      ${toolbarHtml(queue, cooking)}
      <div class="grid min-h-0 gap-2 sm:gap-3 md:grid-cols-2 md:grid-rows-1 md:flex-1">
        ${paneHtml({
          key: 'queue',
          title: 'In Queue',
          iconName: 'clock',
          count: queue.length,
          badgeClass: 'bg-amber-100 text-amber-900',
          empty: emptyState('clock', 'Queue is clear', 'New orders appear here the moment the cashier saves them.', '', {
            compact: true,
          }),
          body: queue.map((order, index) => queueCardHtml(order, index === 0)).join(''),
        })}
        ${paneHtml({
          key: 'cooking',
          title: 'Now Cooking',
          iconName: 'fire',
          count: cooking.length,
          badgeClass: 'bg-sky-100 text-sky-900',
          empty: emptyState('fire', 'Nothing cooking', 'Tap "Cook" on an order in the queue.', '', { compact: true }),
          body: cooking.map((order) => cookingCardHtml(order)).join(''),
          footer: cooking.length ? serveFooterHtml(cooking) : '',
        })}
      </div>
    </div>`;
}

function toolbarHtml(queue, cooking) {
  return `
    <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
      <div class="stat-chip">
        ${icon('clock', 'w-4 h-4 text-amber-600')}
        <span class="text-[11px] font-bold uppercase tracking-wide text-stone-500 sm:text-xs">In Queue</span>
        <span class="text-base font-extrabold sm:text-lg">${queue.length}</span>
      </div>
      <div class="stat-chip">
        ${icon('fire', 'w-4 h-4 text-sky-600')}
        <span class="text-[11px] font-bold uppercase tracking-wide text-stone-500 sm:text-xs">Now Cooking</span>
        <span class="text-base font-extrabold text-sky-700 sm:text-lg">${cooking.length}</span>
      </div>
      <div class="stat-chip">
        ${icon('check', 'w-4 h-4 text-emerald-600')}
        <span class="text-[11px] font-bold uppercase tracking-wide text-stone-500 sm:text-xs">Served Today</span>
        <span class="text-base font-extrabold text-emerald-700 sm:text-lg">${servedToday.length}</span>
      </div>

      <div class="ml-auto flex items-center gap-1.5 sm:gap-2">
        <button type="button" data-action="served" class="btn btn-secondary btn-sm h-9 px-2.5 text-xs sm:h-10 sm:px-3 sm:text-sm">
          ${icon('receipt', 'w-4 h-4')} Served
        </button>
        <button type="button" data-action="refresh" class="btn btn-ghost btn-sm h-9 px-2.5 text-xs sm:h-10 sm:px-3 sm:text-sm">
          ${icon('refresh', 'w-4 h-4')} Refresh
        </button>
      </div>

      <div class="w-full">
        <div data-busy class="load-bar rounded-full opacity-0 transition-opacity duration-200"></div>
      </div>
    </div>`;
}

function paneHtml({ key, title, iconName, count, badgeClass, body, empty, footer = '' }) {
  return `
    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">${icon(iconName, 'w-4 h-4')} ${esc(title)}</h2>
        <span class="badge ${badgeClass} px-2 py-0.5 text-[11px] sm:text-xs">${count}</span>
      </div>
      <div data-board="${key}" class="min-h-0 flex-1 overflow-y-auto p-2 sm:p-2.5">
        ${
          count
            ? `<div class="grid grid-cols-1 gap-2 sm:gap-2.5 md:grid-cols-2">${body}</div>`
            : `<div class="rounded-xl border border-dashed border-stone-200">${empty}</div>`
        }
      </div>
      ${footer}
    </section>`;
}

/**
 * Queue card: only what the cook needs to decide - order number, customer,
 * paid/pending - plus the button that opens the full order and "Cook".
 */
function queueCardHtml(order, isNext) {
  const isNew = minutesAgo(order.createdAt) < 2;
  const paid = order.paymentStatus === 'paid';
  return `
    <article class="pop-in flex flex-col rounded-2xl border border-stone-200 bg-white p-2.5 shadow-sm sm:p-3 ${
      isNext ? 'ring-2 ring-stone-900' : ''
    } ${isNew ? 'flash-new border-amber-400' : ''}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-xl font-extrabold leading-none tracking-tight sm:text-2xl">${esc(order.numberLabel)}</p>
          <p class="mt-0.5 truncate text-xs font-bold text-stone-700 sm:text-sm">${esc(order.customerName)}</p>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
          ${isNext ? '<span class="badge bg-stone-900 px-1.5 py-0.5 text-[10px] text-white sm:text-[11px]">NEXT UP</span>' : ''}
          ${isNew ? '<span class="badge bg-amber-400 px-1.5 py-0.5 text-[10px] text-stone-900 sm:text-[11px]">NEW</span>' : ''}
        </div>
      </div>

      <div class="mt-1.5 flex flex-wrap items-center gap-1">
        ${
          paid
            ? '<span class="badge bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-900 sm:text-[11px]">PAID</span>'
            : '<span class="badge bg-red-100 px-1.5 py-0.5 text-[10px] text-red-900 sm:text-[11px]">PENDING</span>'
        }
        ${typeBadge(order.orderType)}
        <span class="badge bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-600 sm:text-[11px]" data-elapsed="${esc(
          order.createdAt
        )}">${esc(elapsedLabel(order.createdAt))}</span>
      </div>

      <div class="mt-2 flex flex-col gap-1.5">
        <button type="button" data-details="${order.id}" class="btn btn-secondary btn-md h-9 w-full text-[11px] sm:h-10">
          ${icon('receipt', 'h-3.5 w-3.5 sm:h-4 sm:w-4')} View Order
        </button>
        <button type="button" data-start="${order.id}" class="btn btn-md btn-primary h-9 w-full text-[11px] sm:h-10">
          ${icon('fire', 'h-3.5 w-3.5 sm:h-4 sm:w-4')} Cook
        </button>
      </div>
    </article>`;
}

/** Cooking card: number and customer only, with a tick box for the batch serve. */
function cookingCardHtml(order) {
  const checked = cookChecked.has(order.id);
  return `
    <article class="pop-in rounded-2xl border p-2.5 shadow-sm transition-colors sm:p-3 ${
      checked ? 'border-emerald-400 bg-emerald-50' : 'border-stone-200 bg-white'
    }">
      <label class="flex cursor-pointer items-start gap-2.5">
        <input type="checkbox" data-check="${order.id}" ${checked ? 'checked' : ''}
          class="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-stone-300 accent-emerald-600">
        <span class="min-w-0">
          <span class="block text-xl font-extrabold leading-none tracking-tight sm:text-2xl">${esc(order.numberLabel)}</span>
          <span class="mt-0.5 block truncate text-xs font-bold text-stone-700 sm:text-sm">${esc(order.customerName)}</span>
        </span>
      </label>
    </article>`;
}

/** Batch serve footer: the button unlocks only when every order is ticked. */
function serveFooterHtml(cooking) {
  const ticked = cooking.filter((order) => cookChecked.has(order.id)).length;
  const ready = cooking.length > 0 && ticked === cooking.length;
  return `
    <div data-serve-footer class="shrink-0 space-y-1 border-t border-stone-200 p-2 sm:p-2.5">
      <button type="button" data-action="serve-checked" class="btn btn-md btn-success h-10 w-full text-sm sm:h-11 sm:text-base" ${
        ready ? '' : 'disabled'
      }>
        ${icon('check', 'h-4 w-4 sm:h-5 sm:w-5')} Served${cooking.length > 1 ? ` (${ticked}/${cooking.length})` : ''}
      </button>
      <p class="text-center text-[11px] text-stone-500 sm:text-xs">
        ${
          ready
            ? 'All ticked - tap Served to finish.'
            : 'Tick each order when its plate is ready, then tap Served.'
        }
      </p>
    </div>`;
}

function setBusy(value) {
  const bar = rootEl && rootEl.querySelector('[data-busy]');
  if (bar) bar.classList.toggle('opacity-0', !value);
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

/** Full order for one queue card - the list the cook works from. */
function openOrderModal(order) {
  openModal({
    title: `Order ${order.numberLabel}`,
    size: 'md',
    content: `
      <div class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          ${
            order.paymentStatus === 'paid'
              ? '<span class="badge bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">PAID</span>'
              : '<span class="badge bg-red-100 px-2 py-0.5 text-xs text-red-900">PENDING</span>'
          }
          ${typeBadge(order.orderType)}
          <span class="text-xs font-semibold text-stone-500">${esc(elapsedLabel(order.createdAt))}</span>
        </div>

        <div class="rounded-xl border border-stone-200 px-4 py-3">
          <p class="text-xs font-bold uppercase tracking-wide text-stone-500">Customer</p>
          <p class="text-lg font-extrabold">${esc(order.customerName)}</p>
        </div>

        <div class="overflow-hidden rounded-xl border border-stone-200">
          <ul class="divide-y divide-stone-100">
            ${order.items
              .map(
                (item) => `<li class="flex items-baseline gap-3 px-4 py-3">
                  <span class="text-lg font-extrabold text-red-700">${item.quantity}x</span>
                  <span class="text-base font-semibold sm:text-lg">${esc(item.name)}</span>
                </li>`
              )
              .join('')}
          </ul>
        </div>

        ${
          order.notes
            ? `<div class="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
                <p class="text-xs font-bold uppercase tracking-wide text-amber-700">Notes</p>
                <p class="text-base font-semibold text-amber-900">${esc(order.notes)}</p>
              </div>`
            : ''
        }
      </div>`,
    footer: `
      <button type="button" class="btn btn-lg btn-primary" data-action="close">Close</button>`,
  });
}

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

/** Ticking a cooking order only updates the card and the Served button. */
function handleCheckChange(event) {
  const box = event.target.closest('[data-check]');
  if (!box) return;
  const id = box.getAttribute('data-check');
  if (box.checked) cookChecked.add(id);
  else cookChecked.delete(id);

  const card = box.closest('article');
  if (card) {
    card.classList.toggle('border-emerald-400', box.checked);
    card.classList.toggle('bg-emerald-50', box.checked);
    card.classList.toggle('border-stone-200', !box.checked);
    card.classList.toggle('bg-white', !box.checked);
  }
  updateServeFooter();
}

function updateServeFooter() {
  const wrap = rootEl && rootEl.querySelector('[data-serve-footer]');
  if (!wrap) return;
  const cooking = orders.filter((order) => order.status === 'preparing');
  wrap.outerHTML = cooking.length ? serveFooterHtml(cooking) : '';
}

async function handleClick(event) {
  const detailsButton = event.target.closest('[data-details]');
  if (detailsButton) {
    const order = orders.find((entry) => entry.id === detailsButton.getAttribute('data-details'));
    if (order) openOrderModal(order);
    return;
  }

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

  const serveButton = event.target.closest('[data-action="serve-checked"]');
  if (serveButton) {
    const cooking = orders.filter((order) => order.status === 'preparing' && cookChecked.has(order.id));
    if (!cooking.length) return;
    await withButtonLoading(serveButton, 'Serving...', async () => {
      let served = 0;
      for (const order of cooking) {
        try {
          const data = await api(`/orders/${order.id}/serve`, { method: 'POST' });
          applyOrder(data && data.order);
          served += 1;
        } catch (err) {
          toast(`${order.numberLabel}: ${err.message}`, 'error');
        }
      }
      if (served) toast(`${served} order${served === 1 ? '' : 's'} served.`, 'success');
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
