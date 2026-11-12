// App bootstrap, role-based navigation, routing, session handling.

import { api, setUnauthorizedHandler } from './api.js';
import { icon } from './icons.js';
import { state, roleHome, ROLE_LABELS } from './state.js';
import { connectEvents, disconnectEvents, onConnection, onEvent } from './realtime.js';
import {
  esc,
  toast,
  openModal,
  withButtonLoading,
  connectionPill,
  userPill,
  startClock,
  spinner,
  closeAllModals,
  confirmDialog,
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
import * as reportsView from './views/reports.js';
import * as settingsView from './views/settings.js';

const NAV = [
  { route: '#/dashboard', label: 'Sales Dashboard', icon: 'dashboard', roles: ['admin'] },
  { route: '#/pos', label: 'New Order', icon: 'cart', roles: ['cashier', 'admin'] },
  { route: '#/pending', label: 'Pending Payments', icon: 'clock', roles: ['cashier', 'admin'] },
  { route: '#/orders', label: 'Orders', icon: 'receipt', roles: ['cashier', 'admin'] },
  { route: '#/kitchen', label: 'Kitchen', icon: 'fire', roles: ['kitchen', 'admin'] },
  { route: '#/menu', label: 'Menu', icon: 'clipboard', roles: ['admin'] },
  { route: '#/users', label: 'Users', icon: 'users', roles: ['admin'] },
  { route: '#/audit', label: 'Audit Logs', icon: 'shield', roles: ['admin'] },
  { route: '#/reports', label: 'Sales Reports', icon: 'chart', roles: ['admin'] },
  { route: '#/settings', label: 'Settings', icon: 'settings', roles: ['admin'] },
];

const ROUTES = {
  '#/dashboard': { title: 'Sales Dashboard', roles: ['admin'], view: dashboardView },
  '#/pos': { title: 'New Order', roles: ['cashier', 'admin'], view: posView },
  '#/pending': { title: 'Pending Payments', roles: ['cashier', 'admin'], view: pendingView },
  '#/orders': { title: 'Orders', roles: ['cashier', 'admin'], view: ordersView },
  '#/kitchen': { title: 'Kitchen', roles: ['kitchen', 'admin'], view: kitchenView },
  '#/menu': { title: 'Menu', roles: ['admin'], view: menuView },
  '#/users': { title: 'Users', roles: ['admin'], view: usersView },
  '#/audit': { title: 'Audit Logs', roles: ['admin'], view: auditView },
  '#/reports': { title: 'Sales Reports', roles: ['admin'], view: reportsView },
  '#/settings': { title: 'Settings', roles: ['admin'], view: settingsView },
};

const app = document.getElementById('app');

let screen = null; // 'boot' | 'setup' | 'login' | 'shell'
let currentCleanup = null;
let mountToken = 0;
let stopClock = null;
let offSettingsEvents = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function renderBootScreen() {
  screen = 'boot';
  app.innerHTML = `
    <div class="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
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
    <div class="flex min-h-screen items-center justify-center p-4">
      <div class="card w-full max-w-md p-8 text-center">
        <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-700">${icon('alert', 'w-8 h-8')}</div>
        <h1 class="mt-4 text-xl font-extrabold">Cannot start the system</h1>
        <p class="mt-2 text-stone-600">${esc(message)}</p>
        <button type="button" id="retry" class="btn btn-lg btn-primary mt-6 w-full">${icon('refresh', 'w-5 h-5')} Try Again</button>
      </div>
    </div>`;
  app.querySelector('#retry').addEventListener('click', () => window.location.reload());
}

async function boot() {
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
  closeAllModals();
  if (stopClock) {
    stopClock();
    stopClock = null;
  }
  if (offSettingsEvents) {
    offSettingsEvents();
    offSettingsEvents = null;
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
      timezone: (state.status && state.status.timezone) || 'Asia/Manila',
    };
  }

  screen = 'shell';
  renderShell();
  connectEvents();
  stopClock = startClock();

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
    <div class="flex min-h-screen">
      <aside id="sidebar"
        class="fixed inset-y-0 left-0 z-40 flex w-64 -translate-x-full flex-col border-r border-stone-200 bg-white transition-transform duration-200 lg:static lg:translate-x-0">
        <div class="flex items-center gap-3 border-b border-stone-200 px-5 py-4">
          <img src="/images/logo.png" alt="Logo" class="h-12 w-12 shrink-0 object-contain">
          <div class="min-w-0">
            <p id="shop-name" class="truncate text-lg font-extrabold leading-tight">${esc(settings.restaurantName || 'Tapsilogan')}</p>
            <p class="text-xs font-bold uppercase tracking-wider text-stone-400">Point of Sale</p>
          </div>
        </div>
        <nav id="nav" class="flex-1 space-y-1 overflow-y-auto p-3"></nav>
        <div class="border-t border-stone-200 p-3">
          <button type="button" id="signout" class="navlink w-full text-left">
            ${icon('logout', 'w-6 h-6 shrink-0')}<span>Sign Out</span>
          </button>
        </div>
      </aside>

      <div id="sidebar-backdrop" class="fixed inset-0 z-30 hidden bg-stone-900/50 lg:hidden"></div>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-stone-200 bg-white px-4 sm:px-6">
          <button type="button" id="menu-toggle" class="btn btn-ghost btn-sm lg:hidden" aria-label="Open menu">
            ${icon('menu', 'w-6 h-6')}
          </button>
          <h1 id="page-title" class="truncate text-xl font-extrabold"></h1>
          <div class="ml-auto flex items-center gap-3 sm:gap-4">
            <span id="live-pill" class="hidden sm:inline-flex"></span>
            <span data-clock class="hidden text-base font-semibold text-stone-500 md:inline"></span>
            <button type="button" id="account" class="btn btn-ghost btn-sm">
              ${icon('user', 'w-6 h-6')}<span class="hidden font-bold sm:inline">${esc(state.user.fullName)}</span>
            </button>
          </div>
        </header>
        <main id="view" class="flex-1 p-4 sm:p-6"></main>
      </div>
    </div>`;

  renderNav();
  setLivePill(sseStatus);

  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');

  const openSidebar = () => {
    sidebar.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
  };
  const closeSidebar = () => {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
  };

  document.getElementById('menu-toggle').addEventListener('click', openSidebar);
  backdrop.addEventListener('click', closeSidebar);
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('[data-nav]')) closeSidebar();
  });
  document.getElementById('signout').addEventListener('click', signOut);
  document.getElementById('account').addEventListener('click', openAccountModal);

  offSettingsEvents = onEvent(async (event) => {
    if (event.type === 'change' && event.table === 'settings') {
      try {
        const data = await api('/settings');
        state.settings = data.settings;
        const shopName = document.getElementById('shop-name');
        if (shopName) shopName.textContent = data.settings.restaurantName;
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
        </a>`
    )
    .join('');
  updateNavActive();
}

function updateNavActive() {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active = link.getAttribute('data-nav') === location.hash;
    link.classList.toggle('navlink-active', active);
  });
}

function setLivePill(status) {
  const pill = document.getElementById('live-pill');
  if (!pill) return;
  pill.innerHTML = connectionPill(status === 'live');
}

// Track SSE status on the pill (realtime pill reflects the live connection).
let sseStatus = 'offline';
onConnection((status) => {
  sseStatus = status;
  setLivePill(status);
});

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
