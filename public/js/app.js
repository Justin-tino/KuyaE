// App bootstrap, role-based navigation, routing, session handling.

import { api, setUnauthorizedHandler } from './api.js';
import { icon } from './icons.js';
import { state, roleHome, ROLE_LABELS } from './state.js';
import { connectEvents, disconnectEvents, onConnection, onEvent, onTables } from './realtime.js';
import {
  esc,
  money,
  toast,
  openModal,
  withButtonLoading,
  userPill,
  shortName,
  startClock,
  spinner,
  closeAllModals,
  confirmDialog,
  debounce,
} from './ui.js';
import { renderSetupPage, renderFirstAdminPage, renderLoginPage } from './views/auth.js';
import * as posView from './views/pos.js';
import * as pendingView from './views/pending.js';
import * as ordersView from './views/orders.js';
import * as kitchenView from './views/kitchen.js';
import * as dashboardView from './views/dashboard.js';
import * as menuView from './views/menu.js';
import * as usersView from './views/users.js';
import * as auditView from './views/audit.js';
import * as settingsView from './views/settings.js';
import * as reportsView from './views/reports.js';
import * as staffMealView from './views/staffMeal.js';
import * as staffMealsView from './views/staffMeals.js';
import { initChat } from './chat.js';

const NAV = [
  { route: '#/dashboard', label: 'Sales Dashboard', icon: 'dashboard', roles: ['admin'] },
  { route: '#/pos', label: 'New Order', icon: 'cart', roles: ['cashier'] },
  { route: '#/pending', label: 'Pending Payments', icon: 'clock', roles: ['cashier'] },
  { route: '#/orders', label: 'Orders', icon: 'receipt', roles: ['cashier', 'admin'] },
  { route: '#/kitchen', label: 'Kitchen', icon: 'fire', roles: ['kitchen'] },
  { route: '#/staff-meal', label: 'My Free Meal', icon: 'bowl', roles: ['cashier', 'kitchen'] },
  { route: '#/menu', label: 'Menu', icon: 'clipboard', roles: ['admin'] },
  { route: '#/users', label: 'Users', icon: 'users', roles: ['admin'] },
  { route: '#/staff-meals', label: 'Staff Meals', icon: 'users', roles: ['admin'] },
  { route: '#/audit', label: 'Audit Logs', icon: 'shield', roles: ['admin'] },
  { route: '#/settings', label: 'QR', icon: 'qr', roles: ['admin'] },
  { route: '#/reports', label: 'Sales Reports', icon: 'chart', roles: ['admin'] },
];

const ROUTES = {
  '#/dashboard': { title: 'Sales Dashboard', roles: ['admin'], view: dashboardView },
  '#/pos': { title: 'New Order', roles: ['cashier'], view: posView },
  '#/pending': { title: 'Pending Payments', roles: ['cashier'], view: pendingView },
  '#/orders': { title: 'Orders', roles: ['cashier', 'admin'], view: ordersView },
  '#/kitchen': { title: 'Kitchen', roles: ['kitchen'], view: kitchenView },
  '#/staff-meal': { title: 'My Free Meal', roles: ['cashier', 'kitchen'], view: staffMealView },
  '#/menu': { title: 'Menu', roles: ['admin'], view: menuView },
  '#/users': { title: 'Users', roles: ['admin'], view: usersView },
  '#/staff-meals': { title: 'Staff Meals', roles: ['admin'], view: staffMealsView },
  '#/audit': { title: 'Audit Logs', roles: ['admin'], view: auditView },
  '#/settings': { title: 'QR', roles: ['admin'], view: settingsView },
  '#/reports': { title: 'Sales Reports', roles: ['admin'], view: reportsView },
};

const app = document.getElementById('app');

let screen = null; // 'boot' | 'setup' | 'login' | 'shell'
let currentCleanup = null;
let mountToken = 0;
let stopClock = null;
let offSettingsEvents = null;
let offConnection = null;
let chatCleanup = null;

const CONN_STATUS_LABELS = {
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

/** Reflects the realtime stream health in the header pill. */
function updateConnectionPill(status) {
  const pill = document.getElementById('conn-status');
  if (!pill) return;
  pill.dataset.conn = status;
  const label = pill.querySelector('.conn-label');
  if (label) label.textContent = CONN_STATUS_LABELS[status] || status;
  pill.title =
    status === 'live'
      ? 'Live updates are on. Orders appear here instantly, without refreshing.'
      : 'Live updates are interrupted. The screen is refreshing on its own and will catch up.';
}

// ---------------------------------------------------------------------------
// Cashier: pending payment reminder
// ---------------------------------------------------------------------------

const PENDING_REMINDER_MS = 120000;
let pendingSummary = { count: 0, totalCents: 0 };
let pendingRetryAt = 0;
let pendingPollTimer = null;
let pendingRetryTimer = null;
let pendingOffTables = null;

function startPendingReminder() {
  stopPendingReminder();
  if (!state.user || state.user.role !== 'cashier') return;

  pendingOffTables = onTables(['orders'], debounce(() => refreshPendingSummary(), 1500));
  pendingPollTimer = setInterval(() => refreshPendingSummary(), PENDING_REMINDER_MS);
  refreshPendingSummary();
}

function stopPendingReminder() {
  if (pendingPollTimer) clearInterval(pendingPollTimer);
  if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
  if (pendingOffTables) pendingOffTables();
  pendingPollTimer = null;
  pendingRetryTimer = null;
  pendingOffTables = null;
  pendingSummary = { count: 0, totalCents: 0 };
  pendingRetryAt = 0;
  hidePendingNotice();
  updatePendingBadge(0);
}

async function refreshPendingSummary() {
  if (screen !== 'shell' || !state.user || state.user.role !== 'cashier') return;
  try {
    const data = await api('/orders/pending-summary', { silent: true });
    pendingSummary = { count: data.count || 0, totalCents: data.totalCents || 0 };
    updatePendingBadge(pendingSummary.count);
    syncPendingNotice();
  } catch {
    // The pending page itself reports errors; this background check stays quiet.
  }
}

function updatePendingBadge(count) {
  const badge = document.querySelector('[data-pending-badge]');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.remove('hidden');
    badge.classList.add('inline-flex');
  } else {
    badge.textContent = '';
    badge.classList.add('hidden');
    badge.classList.remove('inline-flex');
  }
}

/** Shows the sticky reminder unless it was dismissed, still on cooldown, or the cashier is already on the list. */
function syncPendingNotice() {
  if (!pendingSummary.count) {
    hidePendingNotice();
    pendingRetryAt = 0;
    if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
    return;
  }
  if (location.hash === '#/pending') {
    hidePendingNotice();
    return;
  }
  if (Date.now() < pendingRetryAt) return;
  showPendingNotice();
}

function showPendingNotice() {
  let el = document.getElementById('pending-payment-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pending-payment-notice';
    el.className =
      'pointer-events-auto flex w-full items-start gap-2 rounded-xl bg-red-700 px-3 py-2.5 text-sm font-semibold text-white shadow-lg slide-up';
    el.setAttribute('role', 'status');
    el.innerHTML = `
      <span class="shrink-0">${icon('alert', 'w-5 h-5')}</span>
      <div class="min-w-0 flex-1">
        <p class="font-extrabold leading-snug" data-notice-title></p>
        <p class="text-xs font-semibold text-red-100" data-notice-message></p>
      </div>
      <button type="button" data-notice-open class="shrink-0 rounded-lg bg-white px-2 py-1 text-xs font-extrabold text-red-700 transition-colors hover:bg-red-50">
        View
      </button>
      <button type="button" data-notice-close class="-mr-1 shrink-0 rounded-lg p-1 opacity-75 transition-opacity hover:bg-white/20 hover:opacity-100" aria-label="Dismiss pending payments reminder">
        ${icon('x', 'w-4 h-4')}
      </button>`;

    el.querySelector('[data-notice-open]').addEventListener('click', () => {
      hidePendingNotice();
      location.hash = '#/pending';
    });
    el.querySelector('[data-notice-close]').addEventListener('click', () => {
      // Dismissed on purpose: stay quiet, then remind again after 2 minutes.
      pendingRetryAt = Date.now() + PENDING_REMINDER_MS;
      hidePendingNotice();
      if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
      pendingRetryTimer = setTimeout(() => {
        pendingRetryTimer = null;
        syncPendingNotice();
      }, PENDING_REMINDER_MS);
    });

    const root = document.getElementById('toast-root');
    if (!root) return;
    root.prepend(el);
  }

  const title = el.querySelector('[data-notice-title]');
  const message = el.querySelector('[data-notice-message]');
  const count = pendingSummary.count;
  if (title) title.textContent = `${count} pending payment${count === 1 ? '' : 's'}`;
  if (message) {
    message.textContent = `${money(pendingSummary.totalCents)} to collect. Collect before the customer leaves.`;
  }
}

function hidePendingNotice() {
  const el = document.getElementById('pending-payment-notice');
  if (el) el.remove();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function renderBootScreen() {
  screen = 'boot';
  app.innerHTML = `
    <div class="flex min-app-height flex-col items-center justify-center gap-6 p-6">
      <img src="/images/logo.png" alt="Logo" class="h-28 w-28 object-contain">
      <div class="flex items-center gap-3 text-lg font-bold text-stone-500">
        ${spinner('w-7 h-7 text-red-700')}
        <span>Starting the POS...</span>
      </div>
      <p class="max-w-sm text-center text-sm text-stone-400">
        The first load after a break can take up to a minute on the free hosting plan.
      </p>
    </div>`;
}

function renderBootError(message) {
  screen = 'boot';
  app.innerHTML = `
    <div class="flex min-app-height items-center justify-center p-4">
      <div class="card w-full max-w-md p-8 text-center">
        <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-700">${icon('alert', 'w-8 h-8')}</div>
        <h1 class="mt-4 text-xl font-extrabold">Cannot start the system</h1>
        <p class="mt-2 text-stone-600">${esc(message)}</p>
        <button type="button" id="retry" class="btn btn-lg btn-primary mt-6 w-full">${icon('refresh', 'w-5 h-5')} Try Again</button>
      </div>
    </div>`;
  app.querySelector('#retry').addEventListener('click', () => window.location.reload());
}

/**
 * This app does not use a service worker. If an old one left behind by
 * another project is registered on this origin, it intercepts every request
 * (photo uploads included) and breaks them - so remove it and its caches.
 */
async function removeStaleServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      try {
        await registration.unregister();
      } catch {
        /* ignore */
      }
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key).catch(() => {})));
    }
    if (registrations.length) {
      console.warn('[app] Removed a stale service worker from this origin. Reload once more if anything looks cached.');
    }
  } catch {
    /* ignore */
  }
}

async function boot() {
  removeStaleServiceWorkers();
  renderBootScreen();
  let status;
  try {
    status = await api('/status', { silent: true });
  } catch (err) {
    renderBootError(err.message);
    return;
  }
  state.status = status;

  if (!status.configured || status.dbError) {
    screen = 'setup';
    renderSetupPage(app, status);
    return;
  }
  if (status.needsSetup) {
    screen = 'login';
    renderFirstAdminPage(app, status, (user) => enterApp(user));
    return;
  }

  let user = null;
  try {
    const data = await api('/auth/me', { silent: true });
    user = data.user;
  } catch {
    user = null;
  }

  if (user) enterApp(user);
  else showLogin();
}

function showLogin() {
  screen = 'login';
  stopPendingReminder();
  closeAllModals();
  if (stopClock) {
    stopClock();
    stopClock = null;
  }
  if (offSettingsEvents) {
    offSettingsEvents();
    offSettingsEvents = null;
  }
  if (offConnection) {
    offConnection();
    offConnection = null;
  }
  if (chatCleanup) {
    try {
      chatCleanup();
    } catch {
      /* ignore */
    }
    chatCleanup = null;
  }
  renderLoginPage(app, state.status, (user) => enterApp(user));
}

async function enterApp(user) {
  state.user = user;
  try {
    const data = await api('/settings');
    state.settings = data.settings;
    document.title = `${data.settings.restaurantName} - POS`;
  } catch {
    state.settings = state.settings || {
      restaurantName: (state.status && state.status.restaurantName) || 'Kuya E Tapsilogan',
      address: '',
      phone: '',
      receiptFooter: 'Thank you, come again!',
      qrCodeUrl: null,
      timezone: (state.status && state.status.timezone) || 'Asia/Manila',
    };
  }

  screen = 'shell';
  renderShell();
  chatCleanup = initChat();
  connectEvents();
  offConnection = onConnection(updateConnectionPill);
  stopClock = startClock();
  startPendingReminder();

  const home = roleHome(user.role);
  const target = ROUTES[location.hash] && ROUTES[location.hash].roles.includes(user.role) ? location.hash : home;
  if (location.hash !== target) location.hash = target;
  else mountView();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderShell() {
  const settings = state.settings || {};
  app.innerHTML = `
    <div class="app-height flex overflow-hidden">
      <aside id="sidebar" aria-label="Main menu"
        class="fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 -translate-x-full flex-col overflow-hidden border-r border-stone-200 bg-white lg:static lg:translate-x-0">
        <div class="flex h-full w-64 shrink-0 flex-col">
          <div class="flex items-center gap-3 border-b border-stone-200 px-5 py-4">
            <img src="/images/logo.png" alt="Logo" class="h-12 w-12 shrink-0 object-contain">
            <div class="min-w-0">
              <p id="shop-name" class="truncate text-lg font-extrabold leading-tight" title="${esc(settings.restaurantName || 'Tapsilogan')}">${esc(shortName(settings))}</p>
              <p class="text-xs font-bold uppercase tracking-wider text-stone-400">Point of Sale</p>
            </div>
          </div>
          <nav id="nav" class="flex-1 space-y-1 overflow-y-auto p-3"></nav>
          <div class="border-t border-stone-200 p-3">
            <button type="button" id="signout" class="navlink w-full text-left">
              ${icon('logout', 'w-6 h-6 shrink-0')}<span>Sign Out</span>
            </button>
          </div>
        </div>
      </aside>

      <div id="sidebar-backdrop" class="fixed inset-0 z-30 hidden bg-stone-900/50"></div>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="z-20 flex h-16 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4 sm:px-6">
          <button type="button" id="menu-toggle" class="btn btn-ghost btn-sm" aria-label="Show or hide the menu"
            aria-controls="sidebar" aria-expanded="true">
            ${icon('menu', 'w-6 h-6')}
          </button>
          <h1 id="page-title" class="truncate text-xl font-extrabold"></h1>
          <div class="ml-auto flex items-center gap-3 sm:gap-4">
            <span id="conn-status" class="conn-pill hidden" data-conn="offline">
              <span class="conn-dot"></span><span class="conn-label">Offline</span>
            </span>
            <button type="button" id="chat-button" class="btn btn-ghost btn-sm relative" aria-label="Messages" title="Messages">
              ${icon('message', 'w-6 h-6')}<span class="hidden font-bold sm:inline">Messages</span>
              <span id="chat-badge" class="absolute -right-0.5 -top-0.5 hidden h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-extrabold leading-none text-white shadow"></span>
            </button>
            <span data-clock class="hidden text-base font-semibold text-stone-500 md:inline"></span>
            <button type="button" id="account" class="btn btn-ghost btn-sm">
              ${icon('user', 'w-6 h-6')}<span class="hidden font-bold sm:inline">${esc(state.user.fullName)}</span>
            </button>
          </div>
        </header>
        <main id="view" class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"></main>
      </div>
    </div>`;

  renderNav();

  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const menuToggle = document.getElementById('menu-toggle');
  const wideScreen = window.matchMedia('(min-width: 1024px)');

  // Desktops start with the menu open beside the page; phones and tablets
  // start with it tucked away, where it opens over the page instead.
  let sidebarOpen = wideScreen.matches;

  // On wide screens the menu is a column of the page row: hiding it collapses
  // it to zero width so the header and the page take that space back. On
  // phones it slides off-screen, so the page is already full width there.
  function applySidebar() {
    const wide = wideScreen.matches;
    sidebar.classList.toggle('-translate-x-full', !sidebarOpen);
    sidebar.classList.toggle('sidebar-collapsed', wide && !sidebarOpen);
    backdrop.classList.toggle('hidden', wide || !sidebarOpen);
    // A hidden menu must not swallow taps or hold keyboard focus.
    sidebar.inert = !sidebarOpen;
    menuToggle.setAttribute('aria-expanded', String(sidebarOpen));
    menuToggle.setAttribute('aria-label', sidebarOpen ? 'Hide the menu' : 'Show the menu');
  }

  const setSidebar = (open) => {
    sidebarOpen = open;
    applySidebar();
  };

  applySidebar();
  menuToggle.addEventListener('click', () => setSidebar(!sidebarOpen));
  backdrop.addEventListener('click', () => setSidebar(false));
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('[data-nav]') && !wideScreen.matches) setSidebar(false);
  });
  // Crossing the breakpoint turns the menu into the other kind of menu, so
  // reset it to that layout's default instead of leaving it off-screen.
  wideScreen.addEventListener('change', (event) => setSidebar(event.matches));
  document.getElementById('signout').addEventListener('click', signOut);
  document.getElementById('account').addEventListener('click', openAccountModal);

  offSettingsEvents = onEvent(async (event) => {
    if (event.type === 'change' && event.table === 'settings') {
      try {
        const data = await api('/settings');
        state.settings = data.settings;
        const shopName = document.getElementById('shop-name');
        if (shopName) {
          shopName.textContent = shortName(data.settings);
          shopName.title = data.settings.restaurantName;
        }
        document.title = `${data.settings.restaurantName} - POS`;
      } catch {
        /* ignore */
      }
    }
  });
}

function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = NAV.filter((item) => item.roles.includes(state.user.role))
    .map(
      (item) =>
        `<a href="${item.route}" data-nav="${item.route}" class="navlink">
          ${icon(item.icon, 'w-6 h-6 shrink-0')}<span class="truncate">${esc(item.label)}</span>
          ${
            item.route === '#/pending'
              ? '<span data-pending-badge class="ml-auto hidden h-6 min-w-6 items-center justify-center rounded-full bg-white px-1.5 text-xs font-extrabold text-red-700 shadow-sm"></span>'
              : ''
          }
        </a>`
    )
    .join('');
  updateNavActive();
  updatePendingBadge(pendingSummary.count);
}

function updateNavActive() {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active = link.getAttribute('data-nav') === location.hash;
    link.classList.toggle('navlink-active', active);
  });
}

async function signOut() {
  const ok = await confirmDialog({
    title: 'Sign Out',
    message: 'Are you sure you want to sign out of the POS?',
    confirmLabel: 'Sign Out',
    danger: true,
  });
  if (!ok) return;

  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* ignore - cookie is cleared server side when possible */
  }
  state.user = null;
  disconnectEvents();
  if (offSettingsEvents) {
    offSettingsEvents();
    offSettingsEvents = null;
  }
  if (offConnection) {
    offConnection();
    offConnection = null;
  }
  if (currentCleanup) {
    try {
      currentCleanup();
    } catch {
      /* ignore */
    }
    currentCleanup = null;
  }
  history.replaceState(null, '', location.pathname);
  showLogin();
  toast('Signed out.', 'success');
}

function openAccountModal() {
  const user = state.user;
  const modal = openModal({
    title: 'My Account',
    size: 'sm',
    content: `
      <div class="space-y-4">
        ${userPill(user)}
        <dl class="space-y-2 rounded-xl border border-stone-200 px-4 py-3 text-sm">
          <div class="flex justify-between gap-3"><dt class="font-semibold text-stone-500">Username</dt><dd class="font-mono font-bold">${esc(user.username)}</dd></div>
          <div class="flex justify-between gap-3"><dt class="font-semibold text-stone-500">Role</dt><dd class="font-bold">${esc(ROLE_LABELS[user.role] || user.role)}</dd></div>
          <div class="flex justify-between gap-3"><dt class="font-semibold text-stone-500">Restaurant</dt><dd class="font-bold">${esc((state.settings && state.settings.restaurantName) || '')}</dd></div>
        </dl>
      </div>`,
    footer: `
      <button type="button" class="btn btn-lg btn-secondary" data-action="password">${icon('key', 'w-5 h-5')} Change Password</button>
      <button type="button" class="btn btn-lg btn-primary" data-action="close">Close</button>`,
  });
  modal.footer.querySelector('[data-action="close"]').addEventListener('click', () => modal.close());
  modal.footer.querySelector('[data-action="password"]').addEventListener('click', () => {
    modal.close();
    openChangePasswordModal();
  });
}

function openChangePasswordModal() {
  const modal = openModal({
    title: 'Change Password',
    size: 'sm',
    content: `
      <form id="password-form" class="space-y-4" novalidate>
        <div>
          <label class="label" for="current-password">Current password</label>
          <input id="current-password" type="password" class="input" autocomplete="current-password" required data-autofocus>
        </div>
        <div>
          <label class="label" for="new-password">New password</label>
          <input id="new-password" type="password" class="input" autocomplete="new-password" required>
          <p class="mt-1 text-sm text-stone-500">At least 8 characters, with a letter and a number.</p>
        </div>
        <div>
          <label class="label" for="confirm-password">Confirm new password</label>
          <input id="confirm-password" type="password" class="input" autocomplete="new-password" required>
        </div>
        <p class="hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-800" data-error></p>
      </form>`,
    footer: `
      <button type="button" class="btn btn-lg btn-secondary" data-action="cancel">Cancel</button>
      <button type="button" class="btn btn-lg btn-primary" data-action="save">Save Password</button>`,
  });

  const form = modal.body.querySelector('#password-form');
  const errorEl = modal.body.querySelector('[data-error]');
  const saveButton = modal.footer.querySelector('[data-action="save"]');
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => modal.close());

  saveButton.addEventListener('click', async () => {
    errorEl.classList.add('hidden');
    const currentPassword = form.querySelector('#current-password').value;
    const newPassword = form.querySelector('#new-password').value;
    const confirmPassword = form.querySelector('#confirm-password').value;
    if (!currentPassword) return showError('Enter your current password.');
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return showError('New password must be at least 8 characters and contain a letter and a number.');
    }
    if (newPassword !== confirmPassword) return showError('The two new passwords do not match.');

    await withButtonLoading(saveButton, 'Saving...', async () => {
      try {
        await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
        toast('Password changed. Other devices have been signed out.', 'success');
        modal.close();
      } catch (err) {
        showError(err.message);
      }
    });
  });

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function mountView() {
  if (screen !== 'shell') return;
  const route = ROUTES[location.hash];
  const viewEl = document.getElementById('view');
  if (!route || !viewEl) return;

  if (!route.roles.includes(state.user.role)) {
    location.hash = roleHome(state.user.role);
    return;
  }

  // Leaving a page should never keep its dialog (payment, order details, ...) on screen.
  closeAllModals();
  // Show/hide the cashier reminder as they move into or out of Pending Payments.
  syncPendingNotice();

  const token = ++mountToken;
  const title = document.getElementById('page-title');
  if (title) title.textContent = route.title;
  updateNavActive();

  if (currentCleanup) {
    try {
      currentCleanup();
    } catch {
      /* ignore */
    }
    currentCleanup = null;
  }
  viewEl.innerHTML = '';
  // The page area is its own scroll container now, so a new screen always
  // starts at the top instead of inheriting the previous page's position.
  viewEl.scrollTop = 0;

  try {
    const cleanup = await route.view.mount(viewEl);
    if (token !== mountToken) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    currentCleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    console.error(err);
    viewEl.innerHTML = `
      <div class="card p-8 text-center">
        <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-700">${icon('alert', 'w-8 h-8')}</div>
        <p class="mt-3 text-xl font-extrabold">Could not load this page</p>
        <p class="mt-1 text-stone-600">${esc(err.message)}</p>
        <button type="button" class="btn btn-lg btn-primary mt-5" data-reload>Reload</button>
      </div>`;
    const reloadButton = viewEl.querySelector('[data-reload]');
    if (reloadButton) reloadButton.addEventListener('click', () => window.location.reload());
  }
}

function renderRoute() {
  if (screen !== 'shell') return;
  if (!ROUTES[location.hash]) {
    location.hash = roleHome(state.user.role);
    return;
  }
  mountView();
}

// ---------------------------------------------------------------------------
// Global listeners
// ---------------------------------------------------------------------------

setUnauthorizedHandler(() => {
  if (screen !== 'shell') return;
  toast('Your session has expired. Please sign in again.', 'warning');
  state.user = null;
  disconnectEvents();
  if (currentCleanup) {
    try {
      currentCleanup();
    } catch {
      /* ignore */
    }
    currentCleanup = null;
  }
  history.replaceState(null, '', location.pathname);
  showLogin();
});

window.addEventListener('hashchange', renderRoute);

boot();
