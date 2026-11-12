// Admin: audit logs.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables } from '../realtime.js';
import {
  esc,
  toast,
  fmtDateTime,
  todayLocalStr,
  addDays,
  openModal,
  debounce,
  pageLoader,
  emptyState,
} from '../ui.js';

const ACTION_LABELS = {
  login_success: 'Signed in',
  login_failed: 'Failed sign-in',
  login_locked: 'Sign-in blocked',
  logout: 'Signed out',
  setup_first_admin: 'Created first admin',
  password_change: 'Changed own password',
  menu_create: 'Added menu item',
  menu_update: 'Updated menu item',
  menu_delete: 'Deleted menu item',
  user_create: 'Created user',
  user_update: 'Updated user',
  user_delete: 'Deleted user',
  order_create: 'Received order',
  order_paid: 'Recorded payment',
  order_start: 'Started cooking',
  order_serve: 'Marked served',
  order_cancel: 'Cancelled order',
  settings_update: 'Updated settings',
};

const ACTION_TONES = {
  login_failed: 'bg-red-100 text-red-900',
  login_locked: 'bg-red-100 text-red-900',
  order_cancel: 'bg-amber-100 text-amber-900',
  user_delete: 'bg-amber-100 text-amber-900',
  menu_delete: 'bg-amber-100 text-amber-900',
  login_success: 'bg-emerald-100 text-emerald-900',
  order_paid: 'bg-emerald-100 text-emerald-900',
  order_serve: 'bg-emerald-100 text-emerald-900',
};

const filters = {
  from: addDays(todayLocalStr(), -6),
  to: todayLocalStr(),
  userId: '',
  action: '',
};

let logs = [];
let total = 0;
let limit = 50;
let loading = true;
let users = [];
let rootEl = null;

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading audit logs...');
  const onClick = (event) => handleClick(event);
  const onInput = (event) => handleInput(event);
  const onChange = (event) => handleChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  const off = onTables(['audit_logs'], debounce(() => load(true), 800));

  try {
    const data = await api('/users');
    users = data.users || [];
  } catch {
    users = [];
  }
  await load(false);

  return () => {
    off();
    container.removeEventListener('click', onClick);
    container.removeEventListener('input', onInput);
    container.removeEventListener('change', onChange);
  };
}

async function load(quiet) {
  if (!quiet) {
    loading = true;
    render();
  }
  try {
    const params = new URLSearchParams({
      from: filters.from,
      to: filters.to,
      limit: String(limit),
      offset: '0',
    });
    if (filters.userId) params.set('userId', filters.userId);
    if (filters.action.trim()) params.set('action', filters.action.trim());
    const data = await api(`/audit?${params.toString()}`);
    logs = data.logs || [];
    total = data.total || 0;
    loading = false;
    render(quiet);
  } catch (err) {
    loading = false;
    render(true);
    toast(err.message, 'error');
  }
}

function detailSummary(log) {
  const d = log.details || {};
  const bits = [];
  if (d.orderNumber !== undefined) bits.push('Order #' + String(d.orderNumber).padStart(3, '0'));
  if (d.customerName) bits.push(d.customerName);
  if (d.name) bits.push(d.name);
  if (d.fullName) bits.push(d.fullName);
  if (d.username && d.username !== log.username) bits.push('@' + d.username);
  if (d.attemptedUsername) bits.push('as "' + d.attemptedUsername + '"');
  if (d.method) bits.push(d.method);
  if (d.totalCents !== undefined) bits.push('PHP ' + (d.totalCents / 100).toFixed(2));
  if (d.reason) bits.push('"' + d.reason + '"');
  if (d.reason === undefined && d.reasonText) bits.push('"' + d.reasonText + '"');
  if (Array.isArray(d.changed)) bits.push('changed: ' + d.changed.join(', '));
  if (Array.isArray(d.items)) bits.push(d.items.join(', '));
  return bits.join(' - ');
}

function render(quiet) {
  if (!rootEl) return;
  const html = `
    <div class="space-y-4">
      <div class="card p-4">
        <div class="grid gap-3 lg:grid-cols-5">
          <div>
            <label class="label" for="audit-from">From</label>
            <input id="audit-from" type="date" class="input" value="${esc(filters.from)}">
          </div>
          <div>
            <label class="label" for="audit-to">To</label>
            <input id="audit-to" type="date" class="input" value="${esc(filters.to)}">
          </div>
          <div>
            <label class="label" for="audit-user">User</label>
            <select id="audit-user" class="input">
              <option value="">All users</option>
              ${users
                .map(
                  (user) =>
                    `<option value="${user.id}" ${filters.userId === user.id ? 'selected' : ''}>${esc(user.fullName)} (${esc(user.username)})</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="lg:col-span-2">
            <label class="label" for="audit-action">Action contains</label>
            <div class="flex gap-2">
              <input id="audit-action" data-focus-key="audit-action" class="input" placeholder="e.g. login, order, menu" value="${esc(filters.action)}">
              <button type="button" data-action="refresh" class="btn btn-md btn-secondary shrink-0">${icon('refresh', 'w-5 h-5')}</button>
            </div>
          </div>
        </div>
        <p class="mt-3 text-sm font-semibold text-stone-500">
          Every sign-in, order, payment, menu and user change is recorded here. Newest first.
        </p>
      </div>

      <div class="card overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-5 py-3">
          <p class="font-bold text-stone-600">${loading ? 'Loading...' : `${total} entr${total === 1 ? 'y' : 'ies'}`}</p>
          <p class="text-sm font-semibold text-stone-500">Showing ${logs.length} of ${total}</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[820px]">
            <thead class="bg-stone-50">
              <tr>
                <th class="th">Time</th>
                <th class="th">User</th>
                <th class="th">Action</th>
                <th class="th">Details</th>
              </tr>
            </thead>
            <tbody>
              ${
                loading
                  ? `<tr><td colspan="4"><div class="flex items-center justify-center gap-3 py-10 text-stone-500"><span class="spinner w-6 h-6 text-red-700"></span><span class="font-semibold">Loading audit logs...</span></div></td></tr>`
                  : logs.length
                  ? logs
                      .map(
                        (log) => `<tr class="cursor-pointer border-b border-stone-100 hover:bg-stone-50 last:border-0" data-log="${log.id}">
                          <td class="td whitespace-nowrap text-sm text-stone-600">${esc(fmtDateTime(log.createdAt))}</td>
                          <td class="td font-semibold">${esc(log.username || 'Unknown')}</td>
                          <td class="td"><span class="badge ${ACTION_TONES[log.action] || 'bg-stone-100 text-stone-700'}">${esc(ACTION_LABELS[log.action] || log.action)}</span></td>
                          <td class="td max-w-[420px] truncate text-stone-600">${esc(detailSummary(log))}</td>
                        </tr>`
                      )
                      .join('')
                  : `<tr><td colspan="4">${emptyState('shield', 'No audit entries', 'Nothing was recorded in this period.')}</td></tr>`
              }
            </tbody>
          </table>
        </div>
        ${
          logs.length < total
            ? `<div class="border-t border-stone-200 p-4 text-center">
                <button type="button" data-action="more" class="btn btn-md btn-secondary">Load more entries</button>
              </div>`
            : ''
        }
      </div>
    </div>`;

  if (quiet) rootEl.innerHTML = html;
  else rootEl.innerHTML = html;
}

function handleClick(event) {
  if (event.target.closest('[data-action="refresh"]')) {
    load(false);
    return;
  }
  if (event.target.closest('[data-action="more"]')) {
    limit += 50;
    load(false);
    return;
  }
  const row = event.target.closest('[data-log]');
  if (row) {
    const log = logs.find((entry) => String(entry.id) === row.getAttribute('data-log'));
    if (log) showLog(log);
  }
}

let debouncedAction = null;

function handleInput(event) {
  if (event.target.id === 'audit-action') {
    filters.action = event.target.value;
    if (!debouncedAction) debouncedAction = debounce(() => load(true), 450);
    debouncedAction();
  }
}

function handleChange(event) {
  if (event.target.id === 'audit-from') {
    filters.from = event.target.value || todayLocalStr();
    limit = 50;
    load(false);
  }
  if (event.target.id === 'audit-to') {
    filters.to = event.target.value || todayLocalStr();
    limit = 50;
    load(false);
  }
  if (event.target.id === 'audit-user') {
    filters.userId = event.target.value;
    limit = 50;
    load(false);
  }
}

function showLog(log) {
  const modal = openModal({
    title: 'Audit Entry',
    size: 'md',
    content: `
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-xl border border-stone-200 px-4 py-3">
            <p class="text-xs font-bold uppercase tracking-wide text-stone-500">Action</p>
            <p class="font-bold">${esc(ACTION_LABELS[log.action] || log.action)}</p>
            <p class="text-xs font-mono text-stone-400">${esc(log.action)}</p>
          </div>
          <div class="rounded-xl border border-stone-200 px-4 py-3">
            <p class="text-xs font-bold uppercase tracking-wide text-stone-500">User</p>
            <p class="font-bold">${esc(log.username || 'Unknown')}</p>
          </div>
          <div class="rounded-xl border border-stone-200 px-4 py-3">
            <p class="text-xs font-bold uppercase tracking-wide text-stone-500">Time</p>
            <p class="font-semibold">${esc(fmtDateTime(log.createdAt))}</p>
          </div>
          <div class="rounded-xl border border-stone-200 px-4 py-3">
            <p class="text-xs font-bold uppercase tracking-wide text-stone-500">Entity</p>
            <p class="font-semibold">${esc(log.entity || '-')} ${log.entityId ? `<span class="text-xs text-stone-400">(${esc(log.entityId)})</span>` : ''}</p>
          </div>
        </div>
        <div>
          <p class="label">Details</p>
          <pre class="max-h-72 overflow-auto rounded-xl bg-stone-900 p-4 text-sm text-stone-100">${esc(
            JSON.stringify(log.details || {}, null, 2)
          )}</pre>
        </div>
      </div>`,
    footer: `<button type="button" class="btn btn-lg btn-primary" data-action="close">Close</button>`,
  });
  modal.footer.querySelector('[data-action="close"]').addEventListener('click', () => modal.close());
}
