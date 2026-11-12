// Admin: manage staff accounts.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { state, ROLE_LABELS } from '../state.js';
import {
  esc,
  toast,
  fmtDateTime,
  openModal,
  confirmDialog,
  withButtonLoading,
  pageLoader,
  emptyState,
} from '../ui.js';

let users = [];
let rootEl = null;
let loading = true;

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading users...');
  const onClick = (event) => handleClick(event);
  container.addEventListener('click', onClick);
  await load(false);
  return () => container.removeEventListener('click', onClick);
}

async function load(quiet) {
  if (!quiet) {
    loading = true;
    render();
  }
  try {
    const data = await api('/users');
    users = data.users || [];
    loading = false;
    render();
  } catch (err) {
    loading = false;
    render();
    toast(err.message, 'error');
  }
}

function render() {
  if (!rootEl) return;
  const roleTone = {
    admin: 'bg-stone-900 text-white',
    cashier: 'bg-indigo-100 text-indigo-900',
    kitchen: 'bg-orange-100 text-orange-900',
  };

  rootEl.innerHTML = `
    <div class="space-y-4">
      <div class="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p class="text-xl font-extrabold">Staff Accounts</p>
          <p class="text-sm font-semibold text-stone-500">Admins can do everything. Cashiers take orders and payments. Kitchen staff cook and serve.</p>
        </div>
        <button type="button" data-action="add" class="btn btn-md btn-primary">${icon('userPlus', 'w-5 h-5')} Add User</button>
      </div>

      <div class="card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[720px]">
            <thead class="bg-stone-50">
              <tr>
                <th class="th">Name</th>
                <th class="th">Username</th>
                <th class="th">Role</th>
                <th class="th">Status</th>
                <th class="th">Last sign-in</th>
                <th class="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                loading
                  ? `<tr><td colspan="6"><div class="flex items-center justify-center gap-3 py-10 text-stone-500"><span class="spinner w-6 h-6 text-red-700"></span><span class="font-semibold">Loading users...</span></div></td></tr>`
                  : users.length
                  ? users.map(rowHtml).join('')
                  : `<tr><td colspan="6">${emptyState('users', 'No users yet', 'Add your first staff account.')}</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  function rowHtml(user) {
    const isSelf = state.user && state.user.id === user.id;
    return `<tr class="border-b border-stone-100 last:border-0">
      <td class="td">
        <p class="font-bold">${esc(user.fullName)} ${isSelf ? '<span class="ml-1 text-sm font-semibold text-stone-400">(you)</span>' : ''}</p>
      </td>
      <td class="td font-mono text-sm">${esc(user.username)}</td>
      <td class="td"><span class="badge ${roleTone[user.role] || 'bg-stone-200 text-stone-700'}">${esc(ROLE_LABELS[user.role] || user.role)}</span></td>
      <td class="td">${user.isActive ? '<span class="badge bg-emerald-100 text-emerald-900">Active</span>' : '<span class="badge bg-stone-200 text-stone-600">Disabled</span>'}</td>
      <td class="td text-sm text-stone-600">${user.lastLoginAt ? esc(fmtDateTime(user.lastLoginAt)) : 'Never'}</td>
      <td class="td">
        <div class="flex justify-end gap-2">
          <button type="button" data-edit="${user.id}" class="btn btn-secondary btn-sm">${icon('pencil', 'w-4 h-4')} Edit</button>
          <button type="button" data-toggle="${user.id}" class="btn btn-ghost btn-sm" ${isSelf ? 'disabled title="You cannot disable your own account"' : ''}>
            ${user.isActive ? 'Disable' : 'Enable'}
          </button>
          <button type="button" data-delete="${user.id}" class="btn btn-ghost btn-sm text-red-700" ${isSelf ? 'disabled title="You cannot delete your own account"' : ''} title="Delete">${icon('trash', 'w-5 h-5')}</button>
        </div>
      </td>
    </tr>`;
  }
}

function handleClick(event) {
  if (event.target.closest('[data-action="add"]')) {
    openUserForm(null);
    return;
  }
  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    const user = users.find((entry) => entry.id === editButton.getAttribute('data-edit'));
    if (user) openUserForm(user);
    return;
  }
  const toggleButton = event.target.closest('[data-toggle]');
  if (toggleButton && !toggleButton.disabled) {
    const user = users.find((entry) => entry.id === toggleButton.getAttribute('data-toggle'));
    if (user) toggleUser(user);
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton && !deleteButton.disabled) {
    const user = users.find((entry) => entry.id === deleteButton.getAttribute('data-delete'));
    if (user) deleteUser(user);
  }
}

async function toggleUser(user) {
  const nextActive = !user.isActive;
  const ok = await confirmDialog({
    title: nextActive ? 'Enable this account?' : 'Disable this account?',
    message: nextActive
      ? `${user.fullName} will be able to sign in again.`
      : `${user.fullName} will be signed out and will not be able to sign in until re-enabled.`,
    confirmLabel: nextActive ? 'Enable Account' : 'Disable Account',
    danger: !nextActive,
  });
  if (!ok) return;
  try {
    await api(`/users/${user.id}`, { method: 'PATCH', body: { isActive: nextActive } });
    toast(nextActive ? 'Account enabled.' : 'Account disabled.', 'success');
    load(true);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteUser(user) {
  const ok = await confirmDialog({
    title: 'Delete this account?',
    message: `${user.fullName} (${user.username}) will be permanently removed. Their past orders and audit logs are kept.`,
    confirmLabel: 'Delete Account',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/users/${user.id}`, { method: 'DELETE' });
    toast('Account deleted.', 'success');
    load(true);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openUserForm(user) {
  const editing = Boolean(user);
  const modal = openModal({
    title: editing ? 'Edit User' : 'Add User',
    size: 'md',
    content: `
      <form id="user-form" class="space-y-4" novalidate>
        <div>
          <label class="label" for="user-fullname">Full name</label>
          <input id="user-fullname" name="fullName" class="input input-lg" required maxlength="80" value="${esc(user ? user.fullName : '')}" placeholder="e.g. Juan Dela Cruz">
        </div>
        <div>
          <label class="label" for="user-username">Username</label>
          <input id="user-username" name="username" class="input" required maxlength="30" autocapitalize="none" spellcheck="false" value="${esc(user ? user.username : '')}" placeholder="e.g. juan">
        </div>
        <div>
          <label class="label" for="user-role">Role</label>
          <select id="user-role" name="role" class="input">
            <option value="cashier" ${user && user.role === 'cashier' ? 'selected' : ''}>Cashier - takes orders and payments</option>
            <option value="kitchen" ${user && user.role === 'kitchen' ? 'selected' : ''}>Kitchen - sees orders to cook</option>
            <option value="admin" ${user && user.role === 'admin' ? 'selected' : ''}>Admin - full access</option>
          </select>
        </div>
        <div>
          <label class="label" for="user-password">${editing ? 'Set new password (optional)' : 'Password'}</label>
          <input id="user-password" name="password" type="password" class="input" autocomplete="new-password" ${editing ? '' : 'required'} placeholder="${editing ? 'Leave blank to keep the current password' : 'At least 8 characters'}">
          <p class="mt-1 text-sm text-stone-500">At least 8 characters, with a letter and a number.</p>
        </div>
        ${
          editing
            ? `<label class="flex cursor-pointer items-center gap-3 rounded-xl border border-stone-200 px-4 py-3">
                <input type="checkbox" name="isActive" class="h-6 w-6 accent-emerald-600" ${user.isActive ? 'checked' : ''} ${state.user && state.user.id === user.id ? 'disabled' : ''}>
                <span class="font-bold">Account is active</span>
              </label>`
            : ''
        }
        <p class="hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-800" data-error></p>
      </form>`,
    footer: `
      <button type="button" class="btn btn-lg btn-secondary" data-action="cancel">Cancel</button>
      <button type="button" class="btn btn-lg btn-primary" data-action="save">${editing ? 'Save Changes' : 'Create User'}</button>`,
  });

  const form = modal.body.querySelector('#user-form');
  const errorEl = modal.body.querySelector('[data-error]');
  const saveButton = modal.footer.querySelector('[data-action="save"]');
  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  };

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => modal.close());

  saveButton.addEventListener('click', async () => {
    errorEl.classList.add('hidden');
    const fullName = form.fullName.value.trim();
    const username = form.username.value.trim();
    const role = form.role.value;
    const password = form.password.value;
    if (fullName.length < 2) return showError('Please enter the full name.');
    if (username.length < 3) return showError('Username must be at least 3 characters.');
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) return showError('Username can only contain letters, numbers, dots, dashes and underscores.');
    if (!editing && password.length < 8) return showError('Password must be at least 8 characters.');
    if (password && (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))) {
      return showError('Password must be at least 8 characters and contain a letter and a number.');
    }

    await withButtonLoading(saveButton, 'Saving...', async () => {
      try {
        if (editing) {
          const body = { fullName, username, role };
          if (password) body.newPassword = password;
          if (form.isActive) body.isActive = form.isActive.checked;
          await api(`/users/${user.id}`, { method: 'PATCH', body });
          toast('User updated.', 'success');
        } else {
          await api('/users', { method: 'POST', body: { fullName, username, role, password } });
          toast('User created.', 'success');
        }
        modal.close();
        load(true);
      } catch (err) {
        showError(err.message);
      }
    });
  });

  setTimeout(() => form.fullName.focus(), 60);
}
