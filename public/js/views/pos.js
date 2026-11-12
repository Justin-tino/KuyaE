// Cashier: receive an order (menu, cart, payment, receipt).

import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { onTables } from '../realtime.js';
import { openPaymentModal, printReceipt, typeLabel } from '../components.js';
import {
  esc,
  money,
  toast,
  pageLoader,
  emptyState,
  openModal,
  confirmDialog,
  renderPreservingFocus,
  debounce,
} from '../ui.js';

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
  }

  container.innerHTML = pageLoader('Loading menu...');
  const cleanups = [];
  cleanups.push(onTables(['menu_items'], debounce(() => loadMenu(true), 250)));

  const onClick = (event) => handleClick(event);
  const onInput = (event) => handleInput(event);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);

  await loadMenu(false);

  return () => {
    cleanups.forEach((fn) => fn());
    container.removeEventListener('click', onClick);
    container.removeEventListener('input', onInput);
  };
}

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
    if (!quiet) await loadSuggestedName();
    renderAll();
  } catch (err) {
    toast(err.message, 'error');
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

function renderAll() {
  if (!rootEl) return;
  renderPreservingFocus(rootEl, layoutHtml());
  renderMenuGrid();
  renderCategoryChips();
  renderCart();
}

function layoutHtml() {
  return `
    <div class="flex flex-col gap-4 xl:flex-row xl:items-start">
      <section class="min-w-0 flex-1">
        <div class="card mb-4 p-4">
          <div class="flex flex-col gap-3">
            <div class="relative">
              <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-stone-400">${icon('search', 'w-5 h-5')}</span>
              <input id="menu-search" data-focus-key="menu-search" class="input pl-12" placeholder="Search the menu..." value="${esc(search)}" autocomplete="off">
            </div>
            <div id="category-chips" class="no-scrollbar flex gap-2 overflow-x-auto pb-1"></div>
          </div>
        </div>
        <div id="menu-grid" class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 2xl:grid-cols-4"></div>
      </section>

      <aside class="w-full shrink-0 xl:w-[380px]">
        <div class="card xl:sticky xl:top-20">
          <div id="cart-panel"></div>
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
        `<button type="button" data-category="${esc(cat)}" class="chip ${cat === category ? 'chip-active' : ''}">${esc(cat)}</button>`
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
  if (!menuItems.length) {
    grid.innerHTML = `<div class="col-span-full">${emptyState(
      'bowl',
      'The menu is empty',
      'Ask the administrator to add menu items first.'
    )}</div>`;
    return;
  }
  if (!items.length) {
    grid.innerHTML = `<div class="col-span-full">${emptyState('search', 'No matching items', 'Try a different search or category.')}</div>`;
    return;
  }
  grid.innerHTML = items.map(menuCardHtml).join('');
  grid.querySelectorAll('img[data-menu-img]').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

function menuCardHtml(item) {
  const qty = cart.get(item.id)?.qty || 0;
  return `
    <button type="button" data-add="${item.id}" ${item.isAvailable ? '' : 'disabled'}
      class="group relative overflow-hidden rounded-2xl border border-stone-200 bg-white text-left shadow-sm transition-shadow ${
        item.isAvailable ? 'hover:shadow-md active:scale-[0.99]' : 'cursor-not-allowed opacity-60'
      }">
      <div class="relative flex h-32 w-full items-center justify-center bg-stone-100 text-stone-300">
        ${icon('bowl', 'w-10 h-10')}
        ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" class="absolute inset-0 h-full w-full object-cover" data-menu-img>` : ''}
        ${qty ? `<span class="absolute right-2 top-2 flex h-8 min-w-8 items-center justify-center rounded-full bg-red-700 px-2 text-base font-extrabold text-white">${qty}</span>` : ''}
        ${!item.isAvailable ? `<span class="absolute inset-0 flex items-center justify-center bg-stone-900/55 text-sm font-extrabold uppercase tracking-wide text-white">Unavailable</span>` : ''}
      </div>
      <div class="p-3">
        <p class="line-clamp-2 text-lg font-bold leading-tight">${esc(item.name)}</p>
        <p class="mt-0.5 text-sm text-stone-500">${esc(item.category)}</p>
        <p class="mt-1 text-xl font-extrabold text-red-700">${money(item.priceCents)}</p>
      </div>
    </button>`;
}

function totalCents() {
  let total = 0;
  for (const { item, qty } of cart.values()) total += item.priceCents * qty;
  return total;
}

function cartItemsHtml() {
  if (!cart.size) {
    return `<div class="py-10 text-center text-stone-500">
      <p class="text-lg font-semibold">No items yet</p>
      <p class="text-sm">Tap a menu item to add it.</p>
    </div>`;
  }
  return [...cart.entries()]
    .map(
      ([id, { item, qty }]) => `
      <div class="border-b border-stone-100 py-3 last:border-0">
        <div class="flex justify-between gap-3">
          <p class="font-bold leading-tight">${esc(item.name)}</p>
          <p class="whitespace-nowrap font-extrabold">${money(item.priceCents * qty)}</p>
        </div>
        <div class="mt-2 flex items-center justify-between">
          <span class="text-sm text-stone-500">${money(item.priceCents)} each</span>
          <div class="flex items-center gap-2">
            <button type="button" data-cart="dec" data-id="${id}" class="btn btn-secondary btn-sm w-10 px-0" aria-label="Less">${icon('minus', 'w-4 h-4')}</button>
            <span class="w-8 text-center text-lg font-extrabold">${qty}</span>
            <button type="button" data-cart="inc" data-id="${id}" class="btn btn-secondary btn-sm w-10 px-0" aria-label="More">${icon('plus', 'w-4 h-4')}</button>
            <button type="button" data-cart="remove" data-id="${id}" class="btn btn-ghost btn-sm w-10 px-0 text-red-700" aria-label="Remove">${icon('x', 'w-4 h-4')}</button>
          </div>
        </div>
      </div>`
    )
    .join('');
}

function cartPanelHtml() {
  return `
    <div class="flex items-center justify-between border-b border-stone-200 px-5 py-4">
      <h2 class="text-xl font-extrabold">Current Order</h2>
      <button type="button" data-action="clear" class="btn btn-ghost btn-sm" ${cart.size ? '' : 'disabled'}>Clear</button>
    </div>

    <div class="space-y-4 border-b border-stone-200 px-5 py-4">
      <div>
        <label class="label" for="customer-name">Customer name</label>
        <div class="flex gap-2">
          <input id="customer-name" data-input="customer" data-focus-key="customer" class="input" value="${esc(customerName)}"
            placeholder="Customer name" autocomplete="off" maxlength="80">
          <button type="button" data-action="auto-name" class="btn btn-secondary btn-md shrink-0" title="Use the auto-generated name">
            ${icon('refresh', 'w-5 h-5')}<span class="hidden sm:inline">Auto</span>
          </button>
        </div>
        <p class="mt-1 text-sm text-stone-500">Auto name: <span class="font-semibold">${esc(suggestedName || 'Customer')}</span></p>
      </div>
      <div>
        <p class="label">Order type</p>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" data-type="dine_in" class="btn btn-md ${orderType === 'dine_in' ? 'btn-primary' : 'btn-secondary'}">Dine In</button>
          <button type="button" data-type="take_out" class="btn btn-md ${orderType === 'take_out' ? 'btn-primary' : 'btn-secondary'}">Take Out</button>
        </div>
      </div>
    </div>

    <div class="max-h-[38vh] overflow-y-auto px-5 py-2">
      ${cartItemsHtml()}
    </div>

    <div class="space-y-3 border-t border-stone-200 px-5 py-4">
      <div>
        <label class="label" for="order-notes">Notes (optional)</label>
        <input id="order-notes" data-input="notes" data-focus-key="notes" class="input" value="${esc(notes)}"
          placeholder="e.g. extra rice, no onion" autocomplete="off" maxlength="300">
      </div>
      <div class="flex items-center justify-between">
        <span class="text-lg font-bold text-stone-600">Total</span>
        <span class="text-3xl font-extrabold">${money(totalCents())}</span>
      </div>
      <button type="button" data-action="receive" class="btn btn-lg btn-success w-full" ${cart.size ? '' : 'disabled'}>
        ${icon('check', 'w-6 h-6')} Receive Order
      </button>
    </div>`;
}

function renderCart() {
  const panel = document.getElementById('cart-panel');
  if (panel) renderPreservingFocus(panel, cartPanelHtml());
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
        'absolute right-2 top-2 flex h-8 min-w-8 items-center justify-center rounded-full bg-red-700 px-2 text-base font-extrabold text-white';
      imgWrap.appendChild(badge);
    }
    badge.textContent = String(entry.qty);
  });
}

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
    renderMenuGrid();
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
    renderMenuGrid();
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
  renderMenuGrid();
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
  loadSuggestedName().then(() => {
    renderCart();
    renderMenuGrid();
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
        <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          ${icon('check', 'w-9 h-9')}
        </div>
        <div>
          <p class="text-lg font-semibold text-stone-500">Order number</p>
          <p class="text-6xl font-extrabold tracking-tight">${esc(order.numberLabel)}</p>
        </div>
        <p class="text-xl font-bold">${esc(order.customerName)} &middot; ${esc(typeLabel(order.orderType))}</p>
        <p class="text-lg text-stone-600">Total: <span class="font-extrabold text-stone-900">${money(order.totalCents)}</span></p>
        ${
          changeCents !== null
            ? `<div class="mx-auto inline-flex flex-col rounded-2xl bg-stone-100 px-6 py-4">
                <span class="text-sm font-bold uppercase tracking-wide text-stone-500">Change to give</span>
                <span class="text-4xl font-extrabold text-emerald-700">${money(changeCents)}</span>
              </div>`
            : ''
        }
        ${
          order.paymentStatus === 'pending'
            ? `<div class="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 font-semibold text-amber-900">
                Saved as unpaid. Collect it from Pending Payments.
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
