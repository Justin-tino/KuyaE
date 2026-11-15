// Cashier: the order counter (menu catalogue, running order, payment, receipt).
//
// Tablet and up: catalogue and running order sit side by side and scroll
// independently, with the total and "Receive Order" pinned so the cashier can
// keep working while an order is in progress.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { onTables, everyWhileVisible } from '../realtime.js';
import { openPaymentModal, printReceipt, typeLabel } from '../components.js';
import {
  esc,
  money,
  toast,
  toastThrottled,
  emptyState,
  openModal,
  confirmDialog,
  renderPreservingFocus,
  debounce,
  skeleton,
} from '../ui.js';

// Keeps prices and availability honest even if the live stream drops.
const MENU_REFRESH_MS = 30000;

let menuItems = [];
let category = 'All';
let search = '';
let cart = new Map(); // id -> { item, qty }
let orderType = 'dine_in';
let customerName = '';
let nameTouched = false;
let notes = '';
let suggestedName = '';
let mountedUserId = null;
let rootEl = null;
let menuSignature = '';
let cartSignature = '';
let lastTotalCents = 0;
let hasData = false;

export async function mount(container) {
  rootEl = container;
  if (mountedUserId !== (state.user && state.user.id)) {
    mountedUserId = state.user && state.user.id;
    menuItems = [];
    category = 'All';
    search = '';
    cart = new Map();
    orderType = 'dine_in';
    customerName = '';
    nameTouched = false;
    notes = '';
    suggestedName = '';
    menuSignature = '';
    cartSignature = '';
    hasData = false;
  }

  const onClick = (event) => handleClick(event);
  const onInput = (event) => handleInput(event);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);

  const cleanups = [
    () => container.removeEventListener('click', onClick),
    () => container.removeEventListener('input', onInput),
    onTables(['menu_items'], debounce(() => loadMenu(true), 250)),
    everyWhileVisible(() => loadMenu(true), MENU_REFRESH_MS),
  ];

  renderSkeleton();
  await loadMenu(false);

  return () => cleanups.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadMenu(quiet) {
  try {
    const data = await api('/menu');
    menuItems = data.items || [];
    const byId = new Map(menuItems.map((item) => [item.id, item]));
    for (const [id, entry] of [...cart]) {
      const fresh = byId.get(id);
      if (!fresh) {
        cart.delete(id);
        if (quiet) toast(`${entry.item.name} was removed from the menu.`, 'warning');
      } else {
        entry.item = fresh;
      }
    }
    if (!hasData) await loadSuggestedName();
    hasData = true;
    renderAll();
  } catch (err) {
    hasData = true;
    toastThrottled('pos-menu', err.message, 'error', quiet ? 60000 : 4000);
  }
}

async function loadSuggestedName() {
  try {
    const data = await api('/orders/next-customer-name');
    suggestedName = data.name;
  } catch {
    suggestedName = 'Customer';
  }
  if (!nameTouched) customerName = suggestedName;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSkeleton() {
  const card = `
    <div class="overflow-hidden rounded-xl border border-stone-200 bg-white">
      ${skeleton('h-16 w-full skeleton-flat')}
      <div class="space-y-1.5 px-2 pb-2 pt-1.5">
        ${skeleton('h-3 w-3/4')}
        ${skeleton('h-3.5 w-1/2')}
      </div>
    </div>`;
  const cartLine = `
    <div class="space-y-2 border-b border-stone-100 py-2.5">
      <div class="flex justify-between gap-3">${skeleton('h-4 w-1/2')}${skeleton('h-4 w-16')}</div>
      ${skeleton('h-8 w-32')}
    </div>`;

  rootEl.innerHTML = `
    <div class="flex flex-col gap-2 workfit sm:gap-3 md:flex-row">
      <section class="panel min-h-0 flex-1">
        <div class="shrink-0 space-y-2 border-b border-stone-200 p-2 sm:space-y-2.5 sm:p-3">
          ${skeleton('h-10 w-full')}
          <div class="flex gap-2">${skeleton('h-9 w-16')}${skeleton('h-9 w-24')}${skeleton('h-9 w-20')}</div>
        </div>
        <div class="load-bar"></div>
        <div class="grid grid-cols-3 gap-2 p-2 sm:grid-cols-4 sm:gap-2.5 sm:p-2.5 md:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6">
          ${Array.from({ length: 12 }, () => card).join('')}
        </div>
      </section>
      <aside class="w-full shrink-0 md:w-[300px] xl:w-[340px] 2xl:w-[360px]">
        <div class="panel h-full">
          <div class="panel-head">
            ${skeleton('h-5 w-32')}
            ${skeleton('h-8 w-14')}
          </div>
          <div class="space-y-3 border-b border-stone-200 p-3">
            ${skeleton('h-11 w-full')}
            ${skeleton('h-12 w-full')}
          </div>
          <div class="p-3">${cartLine}${cartLine}${cartLine}</div>
        </div>
      </aside>
    </div>`;
}

function menuFingerprint() {
  return menuItems
    .map((item) => `${item.id}:${item.priceCents}:${item.isAvailable ? 1 : 0}:${item.name}:${item.category}:${item.imageUrl || ''}`)
    .join('|');
}

function cartFingerprint() {
  return [...cart.entries()]
    .map(([id, entry]) => `${id}:${entry.qty}:${entry.item.priceCents}:${entry.item.name}`)
    .join('|');
}

function renderAll() {
  if (!rootEl) return;
  const fingerprint = menuFingerprint();
  const isFresh = !rootEl.querySelector('#menu-grid');
  const gridScroll = scrollOf('menu-grid');

  if (isFresh) {
    renderPreservingFocus(rootEl, layoutHtml());
    renderCategoryChips();
    renderMenuGrid();
    renderCart();
  } else {
    // Background refresh: only touch what actually changed, so the catalogue
    // does not flicker and the running order keeps its scroll and focus.
    if (fingerprint !== menuSignature) {
      renderCategoryChips();
      renderMenuGrid();
    }
    if (cartFingerprint() !== cartSignature) renderCart();
  }

  setScrollOf('menu-grid', gridScroll);
  menuSignature = fingerprint;
}

function scrollOf(id) {
  const el = rootEl && rootEl.querySelector(`#${id}`);
  return el ? el.scrollTop : 0;
}

function setScrollOf(id, value) {
  const el = rootEl && rootEl.querySelector(`#${id}`);
  if (el && value) el.scrollTop = value;
}

function layoutHtml() {
  return `
    <div class="flex flex-col gap-2 workfit sm:gap-3 md:flex-row">
      <section class="panel min-h-0 min-w-0 flex-1">
        <div class="shrink-0 space-y-2 border-b border-stone-200 p-2 sm:space-y-2.5 sm:p-3">
          <div class="relative">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">${icon('search', 'w-4 h-4')}</span>
            <input id="menu-search" data-focus-key="menu-search" class="input h-10 pl-10 text-sm sm:h-11 sm:pl-11 sm:text-base" placeholder="Search the menu..." value="${esc(search)}" autocomplete="off">
          </div>
          <div class="flex items-center gap-2">
            <div id="category-chips" class="no-scrollbar flex flex-1 gap-1.5 overflow-x-auto"></div>
            <span id="menu-count" class="hidden shrink-0 text-xs font-bold uppercase tracking-wide text-stone-400 md:block"></span>
          </div>
        </div>
        <div id="menu-grid" class="grid min-h-0 content-start grid-cols-3 gap-2 overflow-y-auto p-2 sm:grid-cols-4 sm:gap-2.5 sm:p-2.5 md:flex-1 md:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6"></div>
      </section>

      <aside class="w-full shrink-0 md:w-[300px] xl:w-[340px] 2xl:w-[360px]">
        <div class="panel h-full">
          <div id="cart-panel" class="flex min-h-0 flex-1 flex-col"></div>
        </div>
      </aside>
    </div>`;
}

function renderCategoryChips() {
  const wrap = document.getElementById('category-chips');
  if (!wrap) return;
  const categories = ['All', ...new Set(menuItems.map((item) => item.category))];
  wrap.innerHTML = categories
    .map(
      (cat) =>
        `<button type="button" data-category="${esc(cat)}" class="chip h-9 px-3 text-xs sm:h-10 sm:text-sm ${cat === category ? 'chip-active' : ''}">${esc(cat)}</button>`
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

function renderMenuGrid() {
  const grid = document.getElementById('menu-grid');
  if (!grid) return;
  const items = filteredMenu();

  const count = document.getElementById('menu-count');
  if (count) count.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;

  if (!menuItems.length) {
    grid.innerHTML = `<div class="col-span-full">${emptyState(
      'bowl',
      'The menu is empty',
      'Ask the administrator to add menu items first.',
      '',
      { compact: true }
    )}</div>`;
    return;
  }
  if (!items.length) {
    grid.innerHTML = `<div class="col-span-full">${emptyState(
      'search',
      'No matching items',
      'Try a different search or category.',
      '',
      { compact: true }
    )}</div>`;
    return;
  }
  grid.innerHTML = items.map(menuCardHtml).join('');
  grid.querySelectorAll('img[data-menu-img]').forEach((img) => {
    // Broken or missing photo: fall back to the plate icon, never a blank tile.
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

function menuCardHtml(item) {
  const qty = cart.get(item.id)?.qty || 0;
  return `
    <button type="button" data-add="${item.id}" ${item.isAvailable ? '' : 'disabled'}
      class="group relative flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white text-left shadow-sm transition-all ${
        item.isAvailable ? 'hover:border-stone-300 hover:shadow active:scale-[0.98]' : 'cursor-not-allowed opacity-60'
      }">
      <div class="relative flex h-14 w-full items-center justify-center overflow-hidden bg-stone-50 p-1 sm:h-16">
        ${
          item.imageUrl
            ? `<img src="${esc(item.imageUrl)}" alt="" class="max-h-full max-w-full object-contain" data-menu-img>`
            : `<span class="text-stone-300">${icon('bowl', 'w-5 h-5')}</span>`
        }
        ${
          qty
            ? `<span data-qty-badge class="pop-in absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-700 px-1 text-[10px] font-extrabold text-white shadow sm:h-5 sm:min-w-5 sm:text-xs">${qty}</span>`
            : ''
        }
        ${
          !item.isAvailable
            ? '<span class="absolute inset-0 flex items-center justify-center bg-stone-900/55 px-0.5 text-center text-[10px] font-extrabold uppercase leading-tight tracking-wide text-white">Unavailable</span>'
            : ''
        }
      </div>
      <div class="flex flex-1 flex-col px-1.5 pb-1 pt-1 sm:px-2 sm:pb-1.5">
        <p class="line-clamp-2 text-[11px] font-bold leading-tight sm:text-xs">${esc(item.name)}</p>
        <p class="mt-auto pt-0.5 text-[13px] font-extrabold text-red-700 sm:text-sm">${money(item.priceCents)}</p>
      </div>
    </button>`;
}

// ---------------------------------------------------------------------------
// Running order
// ---------------------------------------------------------------------------

function totalCents() {
  let total = 0;
  for (const { item, qty } of cart.values()) total += item.priceCents * qty;
  return total;
}

function cartCount() {
  let count = 0;
  for (const { qty } of cart.values()) count += qty;
  return count;
}

function cartItemsHtml() {
  if (!cart.size) {
    return `<div class="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-stone-200 px-3 py-4 text-center">
      <span class="text-stone-300">${icon('cart', 'w-6 h-6')}</span>
      <p class="text-sm font-bold text-stone-600">No items yet</p>
      <p class="text-xs text-stone-500">Tap a menu item to add it to this order.</p>
    </div>`;
  }
  return [...cart.entries()]
    .map(
      ([id, { item, qty }]) => `
      <div class="flex flex-col gap-1 border-b border-stone-100 py-2 last:border-0">
        <div class="flex items-baseline justify-between gap-2">
          <p class="min-w-0 flex-1 truncate text-[13px] font-bold sm:text-sm">${esc(item.name)}</p>
          <p class="whitespace-nowrap text-[13px] font-extrabold sm:text-sm">${money(item.priceCents * qty)}</p>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-stone-500">${money(item.priceCents)} each</span>
          <div class="flex items-center gap-1">
            <button type="button" data-cart="dec" data-id="${id}" class="btn btn-secondary btn-sm h-8 w-8 px-0 sm:h-9 sm:w-9" aria-label="Less">${icon('minus', 'w-4 h-4')}</button>
            <span class="w-7 text-center text-xs font-extrabold sm:w-8 sm:text-sm">${qty}</span>
            <button type="button" data-cart="inc" data-id="${id}" class="btn btn-secondary btn-sm h-8 w-8 px-0 sm:h-9 sm:w-9" aria-label="More">${icon('plus', 'w-4 h-4')}</button>
            <button type="button" data-cart="remove" data-id="${id}" class="btn btn-ghost btn-sm h-8 w-8 px-0 text-red-700 sm:h-9 sm:w-9" aria-label="Remove">${icon('x', 'w-4 h-4')}</button>
          </div>
        </div>
      </div>`
    )
    .join('');
}

function cartPanelHtml() {
  const count = cartCount();
  const total = totalCents();
  const bump = total !== lastTotalCents ? 'bump' : '';
  lastTotalCents = total;

  return `
    <div class="panel-head">
      <div class="flex items-center gap-2">
        <h2 class="panel-title">Current Order</h2>
        ${count ? `<span class="badge bg-stone-900 px-2 py-0.5 text-[11px] text-white sm:text-xs">${count} item${count === 1 ? '' : 's'}</span>` : ''}
      </div>
      <button type="button" data-action="clear" class="btn btn-ghost btn-sm h-8 px-2 text-xs sm:h-9 sm:px-3 sm:text-sm" ${cart.size ? '' : 'disabled'}>Clear</button>
    </div>

    <div class="shrink-0 space-y-2 border-b border-stone-200 px-2.5 py-2 sm:space-y-2.5 sm:px-3 sm:py-2.5">
      <div>
        <label class="label" for="customer-name">Customer</label>
        <div class="flex gap-2">
          <input id="customer-name" data-input="customer" data-focus-key="customer" class="input h-10 text-sm sm:h-11 sm:text-base" value="${esc(customerName)}"
            placeholder="Customer name" autocomplete="off" maxlength="80">
          <button type="button" data-action="auto-name" class="btn btn-secondary btn-md h-10 shrink-0 px-2.5 sm:h-11 sm:px-3" title="Use the suggested name">
            ${icon('refresh', 'w-4 h-4')}
          </button>
        </div>
        <p class="mt-0.5 text-xs text-stone-500">Suggested: <span class="font-semibold text-stone-600">${esc(suggestedName || 'Customer')}</span></p>
      </div>
      <div>
        <p class="label">Order type</p>
        <div class="seg">
          <button type="button" data-type="dine_in" class="seg-btn h-9 text-xs sm:h-10 sm:text-sm ${orderType === 'dine_in' ? 'seg-btn-active' : ''}">Dine In</button>
          <button type="button" data-type="take_out" class="seg-btn h-9 text-xs sm:h-10 sm:text-sm ${orderType === 'take_out' ? 'seg-btn-active' : ''}">Take Out</button>
        </div>
      </div>
    </div>

    <div data-cart-items class="min-h-0 max-h-[42vh] overflow-y-auto px-2.5 py-0.5 sm:px-3 md:max-h-none md:flex-1">
      ${cartItemsHtml()}
    </div>

    <div class="shrink-0 space-y-2 border-t border-stone-200 px-2.5 py-2 sm:space-y-2.5 sm:px-3 sm:py-2.5">
      <div>
        <label class="label" for="order-notes">Notes</label>
        <input id="order-notes" data-input="notes" data-focus-key="notes" class="input h-10 text-sm sm:h-11 sm:text-base" value="${esc(notes)}"
          placeholder="e.g. extra rice, no onion" autocomplete="off" maxlength="300">
      </div>
      <div class="flex items-end justify-between">
        <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Total</span>
        <span class="text-xl font-extrabold sm:text-2xl ${bump}">${money(total)}</span>
      </div>
      <button type="button" data-action="receive" class="btn btn-lg btn-success h-11 w-full text-base sm:h-12" ${cart.size ? '' : 'disabled'}>
        ${icon('check', 'w-5 h-5')} Receive Order
      </button>
    </div>`;
}

function renderCart() {
  const panel = document.getElementById('cart-panel');
  if (!panel) return;
  const scroller = panel.querySelector('[data-cart-items]');
  const scrollTop = scroller ? scroller.scrollTop : 0;
  renderPreservingFocus(panel, cartPanelHtml());
  const nextScroller = panel.querySelector('[data-cart-items]');
  if (nextScroller) nextScroller.scrollTop = scrollTop;
  cartSignature = cartFingerprint();
}

function renderQtyBadges() {
  document.querySelectorAll('[data-add]').forEach((card) => {
    const imgWrap = card.querySelector('div.relative');
    if (!imgWrap) return;
    const id = card.getAttribute('data-add');
    const entry = cart.get(id);
    let badge = imgWrap.querySelector('[data-qty-badge]');
    if (!entry) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.setAttribute('data-qty-badge', '');
      badge.className =
        'pop-in absolute right-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-700 px-1 text-xs font-extrabold text-white shadow';
      imgWrap.appendChild(badge);
    }
    badge.textContent = String(entry.qty);
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function handleClick(event) {
  const addButton = event.target.closest('[data-add]');
  if (addButton && !addButton.disabled) {
    addToCart(addButton.getAttribute('data-add'));
    return;
  }

  const categoryButton = event.target.closest('[data-category]');
  if (categoryButton) {
    category = categoryButton.getAttribute('data-category');
    renderCategoryChips();
    const gridScroll = scrollOf('menu-grid');
    renderMenuGrid();
    setScrollOf('menu-grid', gridScroll);
    return;
  }

  const typeButton = event.target.closest('[data-type]');
  if (typeButton) {
    orderType = typeButton.getAttribute('data-type');
    renderCart();
    return;
  }

  const cartButton = event.target.closest('[data-cart]');
  if (cartButton) {
    const id = cartButton.getAttribute('data-id');
    const action = cartButton.getAttribute('data-cart');
    const entry = cart.get(id);
    if (!entry) return;
    if (action === 'inc') entry.qty = Math.min(99, entry.qty + 1);
    if (action === 'dec') {
      entry.qty -= 1;
      if (entry.qty <= 0) cart.delete(id);
    }
    if (action === 'remove') cart.delete(id);
    renderCart();
    renderQtyBadges();
    return;
  }

  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.getAttribute('data-action');

  if (action === 'auto-name') {
    nameTouched = false;
    customerName = suggestedName || 'Customer';
    renderCart();
    return;
  }
  if (action === 'clear') {
    clearCart();
    return;
  }
  if (action === 'receive') {
    receiveOrder();
  }
}

function handleInput(event) {
  const input = event.target;
  if (input.id === 'menu-search') {
    search = input.value;
    const gridScroll = scrollOf('menu-grid');
    renderMenuGrid();
    setScrollOf('menu-grid', gridScroll);
    return;
  }
  const field = input.getAttribute('data-input');
  if (field === 'customer') {
    customerName = input.value;
    nameTouched = input.value.trim() !== '';
    return;
  }
  if (field === 'notes') {
    notes = input.value;
  }
}

function addToCart(id) {
  const item = menuItems.find((entry) => entry.id === id);
  if (!item || !item.isAvailable) return;
  const entry = cart.get(id);
  if (entry) entry.qty = Math.min(99, entry.qty + 1);
  else cart.set(id, { item, qty: 1 });
  renderCart();
  renderQtyBadges();
}

async function clearCart() {
  if (!cart.size) return;
  const ok = await confirmDialog({
    title: 'Clear this order?',
    message: 'All items in the current order will be removed.',
    confirmLabel: 'Clear Order',
    danger: true,
  });
  if (!ok) return;
  cart = new Map();
  notes = '';
  renderCart();
  renderQtyBadges();
}

function receiveOrder() {
  if (!cart.size) return;
  const total = totalCents();
  openPaymentModal({
    mode: 'create',
    totalCents: total,
    submitLabel: 'Complete Order',
    onSubmit: async (paymentPayload) => {
      const items = [...cart.entries()].map(([id, entry]) => ({ menuItemId: id, quantity: entry.qty }));
      const data = await api('/orders', {
        method: 'POST',
        body: {
          customerName: customerName.trim(),
          orderType,
          notes: notes.trim(),
          items,
          payment: paymentPayload,
        },
      });
      resetOrder();
      showSuccessModal(data.order);
      loadMenu(true);
    },
  });
}

function resetOrder() {
  cart = new Map();
  notes = '';
  nameTouched = false;
  customerName = '';
  suggestedName = '';
  lastTotalCents = 0;
  loadSuggestedName().then(() => {
    renderCart();
    renderQtyBadges();
  });
}

function showSuccessModal(order) {
  const changeCents =
    order.paymentStatus === 'paid' && order.paymentMethod === 'cash' ? order.changeCents || 0 : null;

  const modal = openModal({
    title: 'Order Received',
    size: 'md',
    content: `
      <div class="space-y-4 text-center">
        <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          ${icon('check', 'w-8 h-8')}
        </div>
        <div>
          <p class="text-xs font-bold uppercase tracking-wide text-stone-500">Order number</p>
          <p class="text-5xl font-extrabold tracking-tight">${esc(order.numberLabel)}</p>
        </div>
        <p class="text-lg font-bold">${esc(order.customerName)} &middot; ${esc(typeLabel(order.orderType))}</p>
        <p class="text-base text-stone-600">Total: <span class="font-extrabold text-stone-900">${money(order.totalCents)}</span></p>
        ${
          changeCents !== null
            ? `<div class="mx-auto inline-flex flex-col rounded-2xl bg-stone-100 px-6 py-3">
                <span class="text-xs font-bold uppercase tracking-wide text-stone-500">Change to give</span>
                <span class="text-3xl font-extrabold text-emerald-700">${money(changeCents)}</span>
              </div>`
            : ''
        }
        ${
          order.paymentStatus === 'pending'
            ? `<div class="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 font-semibold text-amber-900">
                Saved as unpaid. Collect it any time under Pending Payments.
              </div>`
            : ''
        }
      </div>`,
    footer: `
      <button type="button" class="btn btn-lg btn-secondary" data-action="print">${icon('printer', 'w-5 h-5')} Print Receipt</button>
      <button type="button" class="btn btn-lg btn-primary" data-action="new">New Order</button>`,
  });

  modal.footer.querySelector('[data-action="print"]').addEventListener('click', () => printReceipt(order));
  modal.footer.querySelector('[data-action="new"]').addEventListener('click', () => modal.close());
}
