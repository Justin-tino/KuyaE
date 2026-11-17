// Shared UI helpers: formatting, toasts, modals, loading states.

import { icon } from './icons.js';
import { state, timezone } from './state.js';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const moneyFormatter = new Intl.NumberFormat('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function money(cents) {
  return '\u20B1' + moneyFormatter.format((Number(cents) || 0) / 100);
}

export function numberLabel(n) {
  return '#' + String(n).padStart(3, '0');
}

function fmt(value, options) {
  if (!value) return '-';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-PH', { timeZone: timezone(), ...options }).format(date);
}

export function fmtTime(iso) {
  return fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function fmtDate(iso) {
  return fmt(iso, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso) {
  return fmt(iso, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

export function fmtDayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

export function todayLocalStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date()
  );
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function minutesAgo(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export function elapsedLabel(iso) {
  const mins = minutesAgo(iso);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m ago` : `${hours}h ago`;
}

export function debounce(fn, ms = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Loading pieces
// ---------------------------------------------------------------------------

export function spinner(cls = 'w-5 h-5') {
  return `<span class="spinner ${cls}" aria-hidden="true"></span>`;
}

export function buttonLoading(label = 'Please wait...') {
  return `${spinner('w-5 h-5')}<span>${esc(label)}</span>`;
}

export function pageLoader(label = 'Loading...') {
  return `
    <div class="flex flex-col items-center justify-center gap-4 py-24 text-stone-500 fade-in">
      ${spinner('w-10 h-10 text-red-700')}
      <p class="text-lg font-semibold">${esc(label)}</p>
    </div>`;
}

/** Grey shimmering placeholder block used while data loads. */
export function skeleton(cls = 'h-4 w-full') {
  return `<div class="skeleton ${cls}" aria-hidden="true"></div>`;
}

export function emptyState(iconName, title, hint = '', actionHtml = '', options = {}) {
  const compact = Boolean(options.compact);
  return `
    <div class="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center ${
      compact ? 'gap-2 px-4 py-8' : ''
    }">
      <div class="flex h-16 w-16 items-center justify-center rounded-2xl bg-stone-200 text-stone-500 ${
        compact ? 'h-11 w-11 rounded-xl' : ''
      }">${icon(iconName, compact ? 'w-6 h-6' : 'w-8 h-8')}</div>
      <p class="font-bold text-stone-700 ${compact ? 'text-base' : 'text-xl'}">${esc(title)}</p>
      ${hint ? `<p class="max-w-md text-stone-500 ${compact ? 'text-sm' : ''}">${esc(hint)}</p>` : ''}
      ${actionHtml ? `<div class="mt-2">${actionHtml}</div>` : ''}
    </div>`;
}

export function tableLoadingRow(cols, label = 'Loading...') {
  return `<tr><td colspan="${cols}"><div class="flex items-center justify-center gap-3 py-10 text-stone-500">${spinner(
    'w-6 h-6 text-red-700'
  )}<span class="font-semibold">${esc(label)}</span></div></td></tr>`;
}

/** Re-render innerHTML while keeping focus and caret in place. */
export function renderPreservingFocus(root, html) {
  const active = document.activeElement;
  let key = null;
  let selStart = null;
  let selEnd = null;
  if (active && root.contains(active)) {
    key = active.getAttribute('data-focus-key');
    if (typeof active.selectionStart === 'number') {
      selStart = active.selectionStart;
      selEnd = active.selectionEnd;
    }
  }
  root.innerHTML = html;
  if (key) {
    const el = root.querySelector(`[data-focus-key="${key}"]`);
    if (el) {
      el.focus();
      if (selStart !== null && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(selStart, selEnd);
        } catch {
          /* ignore (input types without selection support) */
        }
      }
    }
  }
}

/** Wrap a button in a busy state while a promise runs. */
export async function withButtonLoading(button, label, fn) {
  if (!button) return fn();
  const original = button.innerHTML;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.innerHTML = buttonLoading(label);
  try {
    return await fn();
  } finally {
    button.innerHTML = original;
    button.disabled = wasDisabled;
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const TOAST_STYLES = {
  success: { cls: 'bg-emerald-600 text-white', iconName: 'check' },
  error: { cls: 'bg-red-700 text-white', iconName: 'ban' },
  warning: { cls: 'bg-amber-500 text-white', iconName: 'alert' },
  info: { cls: 'bg-stone-800 text-white', iconName: 'info' },
};

/**
 * Small notification, bottom of the screen. Auto-dismisses quickly (2s by
 * default) and can be dismissed immediately with its X button.
 */
export function toast(message, type = 'info', ms = 2000) {
  const root = document.getElementById('toast-root');
  if (!root) return null;
  const style = TOAST_STYLES[type] || TOAST_STYLES.info;
  const el = document.createElement('div');
  el.className = `pointer-events-auto flex w-auto max-w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold shadow-lg slide-up ${style.cls}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span class="shrink-0">${icon(style.iconName, 'w-4 h-4')}</span>
    <span class="min-w-0 flex-1 leading-snug">${esc(message)}</span>
    <button type="button" data-toast-close class="-mr-1 shrink-0 rounded-lg p-1 opacity-70 transition-opacity hover:bg-white/20 hover:opacity-100" aria-label="Dismiss notification">
      ${icon('x', 'w-4 h-4')}
    </button>`;
  root.appendChild(el);

  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    el.style.transition = 'opacity .18s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  };

  el.querySelector('[data-toast-close]').addEventListener('click', dismiss);
  setTimeout(dismiss, ms);
  return el;
}

const toastGate = new Map();

/** Same as toast(), but at most one per key per interval (for refresh loops). */
export function toastThrottled(key, message, type = 'error', ms = 60000) {
  const last = toastGate.get(key) || 0;
  if (Date.now() - last < ms) return null;
  toastGate.set(key, Date.now());
  return toast(message, type);
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

const modalStack = [];
let escListenerBound = false;

function bindEscListener() {
  if (escListenerBound) return;
  escListenerBound = true;
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !modalStack.length) return;
    const top = modalStack[modalStack.length - 1];
    if (top.closable) {
      event.preventDefault();
      top.close();
    }
  });
}

const MODAL_SIZES = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

/**
 * Open a modal. Returns a controller:
 * { root, body, footer, close(), setTitle(), setBody(), onClose(fn) }
 */
export function openModal({ title = '', content = '', footer = '', size = 'md', closable = true } = {}) {
  bindEscListener();

  const root = document.createElement('div');
  root.className =
    'fixed inset-0 z-50 flex items-center justify-center bg-stone-900/60 p-3 sm:p-6 fade-in';
  root.innerHTML = `
    <div class="card flex max-h-[94vh] w-full flex-col slide-up ${MODAL_SIZES[size] || MODAL_SIZES.md}" role="dialog" aria-modal="true">
      <div class="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-stone-200 px-6">
        <h2 class="modal-title truncate text-xl font-bold">${esc(title)}</h2>
        ${
          closable
            ? `<button type="button" class="btn btn-ghost btn-sm" data-modal-close aria-label="Close">${icon('x', 'w-5 h-5')}</button>`
            : ''
        }
      </div>
      <div class="modal-body flex-1 overflow-y-auto px-6 py-5"></div>
      ${footer ? '<div class="modal-footer flex shrink-0 flex-wrap justify-end gap-3 border-t border-stone-200 px-6 py-4"></div>' : ''}
    </div>`;

  const body = root.querySelector('.modal-body');
  const footerEl = root.querySelector('.modal-footer');
  const titleEl = root.querySelector('.modal-title');

  if (content instanceof HTMLElement) body.appendChild(content);
  else if (content) body.innerHTML = content;
  if (footer instanceof HTMLElement) footerEl.appendChild(footer);
  else if (footer) footerEl.innerHTML = footer;

  const closeCallbacks = [];
  let closed = false;

  const controller = {
    root,
    body,
    footer: footerEl,
    closable,
    close() {
      if (closed) return;
      closed = true;
      root.remove();
      const idx = modalStack.indexOf(controller);
      if (idx !== -1) modalStack.splice(idx, 1);
      if (!modalStack.length) document.body.style.overflow = '';
      for (const cb of closeCallbacks) {
        try {
          cb();
        } catch (err) {
          console.error(err);
        }
      }
    },
    onClose(fn) {
      closeCallbacks.push(fn);
    },
    setTitle(text) {
      titleEl.textContent = text;
    },
    setBody(html) {
      body.innerHTML = html;
    },
    setFooter(html) {
      if (!footerEl) return;
      footerEl.innerHTML = html;
    },
  };

  root.querySelector('[data-modal-close]')?.addEventListener('click', () => controller.close());
  root.addEventListener('mousedown', (event) => {
    if (event.target === root && controller.closable) controller.close();
  });

  document.getElementById('modal-root').appendChild(root);
  modalStack.push(controller);
  document.body.style.overflow = 'hidden';

  setTimeout(() => {
    const autofocus = body.querySelector('[data-autofocus]');
    if (autofocus) autofocus.focus();
  }, 30);

  return controller;
}

export function closeAllModals() {
  while (modalStack.length) modalStack[modalStack.length - 1].close();
}

/** Yes/no confirmation. Returns true when confirmed. */
export function confirmDialog({ title = 'Please confirm', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      size: 'sm',
      content: `<p class="text-lg leading-relaxed text-stone-700">${esc(message)}</p>`,
      footer: `
        <button type="button" class="btn btn-lg btn-secondary" data-cancel>${esc(cancelLabel)}</button>
        <button type="button" class="btn btn-lg ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>`,
    });
    modal.footer.querySelector('[data-cancel]').addEventListener('click', () => {
      settled = true;
      resolve(false);
      modal.close();
    });
    modal.footer.querySelector('[data-confirm]').addEventListener('click', () => {
      settled = true;
      resolve(true);
      modal.close();
    });
    modal.onClose(() => {
      if (!settled) resolve(false);
    });
    setTimeout(() => modal.footer.querySelector('[data-confirm]').focus(), 40);
  });
}

/** Small prompt with a textarea (used for cancel reasons). */
export function reasonDialog({ title, message, label = 'Reason', confirmLabel = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      size: 'sm',
      content: `
        ${message ? `<p class="mb-4 text-stone-600">${esc(message)}</p>` : ''}
        <label class="label" for="reason-input">${esc(label)}</label>
        <textarea id="reason-input" data-autofocus class="textarea" rows="3" maxlength="200" placeholder="Type the reason here..."></textarea>
        <p class="mt-2 hidden text-sm font-semibold text-red-700" data-error></p>`,
      footer: `
        <button type="button" class="btn btn-lg btn-secondary" data-cancel>Keep Order</button>
        <button type="button" class="btn btn-lg ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>`,
    });
    const input = modal.body.querySelector('#reason-input');
    const errorEl = modal.body.querySelector('[data-error]');
    const submit = () => {
      const value = input.value.trim();
      if (value.length < 3) {
        errorEl.textContent = 'Please type at least a few words.';
        errorEl.classList.remove('hidden');
        input.focus();
        return;
      }
      settled = true;
      resolve(value);
      modal.close();
    };
    modal.footer.querySelector('[data-cancel]').addEventListener('click', () => {
      settled = true;
      resolve(null);
      modal.close();
    });
    modal.footer.querySelector('[data-confirm]').addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submit();
    });
    modal.onClose(() => {
      if (!settled) resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Common snippets
// ---------------------------------------------------------------------------

export function userPill(user) {
  const roleLabels = { admin: 'Admin', cashier: 'Cashier', kitchen: 'Kitchen' };
  return `
    <div class="flex items-center gap-3">
      <div class="flex h-11 w-11 items-center justify-center rounded-full bg-red-700 text-lg font-bold text-white">
        ${esc((user.fullName || user.username || '?').charAt(0).toUpperCase())}
      </div>
      <div class="leading-tight">
        <p class="font-bold">${esc(user.fullName || user.username)}</p>
        <p class="text-sm text-stone-500">${esc(roleLabels[user.role] || user.role)}</p>
      </div>
    </div>`;
}

/**
 * Compact brand name for tight spots (sidebar, small headers) and the
 * sign-in screen: the first two words of the restaurant name, so a longer
 * name still shows as a compact brand.
 * The full name stays on receipts and reports.
 */
export function shortName(settings) {
  const full = ((settings && settings.restaurantName) || 'Kuya E').trim();
  const words = full.split(/\s+/);
  return words.length > 2 ? words.slice(0, 2).join(' ') : full;
}

export function currentClockHtml() {
  return `<span class="text-lg font-semibold text-stone-600" data-clock>${esc(clockText())}</span>`;
}

function clockText() {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: timezone(),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    month: 'short',
    day: 'numeric',
  }).format(new Date());
}

/** Starts the header clock. Returns a stop function. */
export function startClock() {
  const el = document.querySelector('[data-clock]');
  if (!el) return () => {};
  const timer = setInterval(() => {
    el.textContent = clockText();
  }, 15000);
  return () => clearInterval(timer);
}
