// Admin: restaurant settings (used on receipts and reports).

import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { esc, toast, withButtonLoading } from '../ui.js';

let rootEl = null;

export function mount(container) {
  rootEl = container;
  const settings = state.settings || {};

  container.innerHTML = `
    <div class="grid gap-5 xl:grid-cols-3">
      <div class="card p-5 xl:col-span-2">
        <h2 class="text-xl font-extrabold">Restaurant Details</h2>
        <p class="mt-1 text-sm font-semibold text-stone-500">These appear on printed receipts and sales reports.</p>

        <form id="settings-form" class="mt-5 space-y-4" novalidate>
          <div>
            <label class="label" for="settings-name">Restaurant name</label>
            <input id="settings-name" name="restaurantName" class="input input-lg" required maxlength="80" value="${esc(settings.restaurantName || '')}">
          </div>
          <div>
            <label class="label" for="settings-address">Address</label>
            <input id="settings-address" name="address" class="input" maxlength="160" value="${esc(settings.address || '')}" placeholder="e.g. 123 Main St, Barangay San Jose">
          </div>
          <div>
            <label class="label" for="settings-phone">Phone</label>
            <input id="settings-phone" name="phone" class="input" maxlength="40" value="${esc(settings.phone || '')}" placeholder="e.g. 0917 123 4567">
          </div>
          <div>
            <label class="label" for="settings-footer">Receipt footer message</label>
            <input id="settings-footer" name="receiptFooter" class="input" maxlength="160" value="${esc(settings.receiptFooter || '')}" placeholder="e.g. Thank you, come again!">
          </div>
          <p class="hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-800" data-error></p>
          <button type="submit" class="btn btn-lg btn-primary">${icon('check', 'w-5 h-5')} Save Settings</button>
        </form>
      </div>

      <div class="space-y-5">
        <div class="card p-5">
          <h3 class="flex items-center gap-2 text-lg font-extrabold">${icon('info', 'w-5 h-5')} System</h3>
          <dl class="mt-3 space-y-2 text-sm">
            <div class="flex justify-between gap-3"><dt class="font-semibold text-stone-500">Timezone</dt><dd class="font-bold">${esc(settings.timezone || 'Asia/Manila')}</dd></div>
            <div class="flex justify-between gap-3"><dt class="font-semibold text-stone-500">Currency</dt><dd class="font-bold">Philippine Peso (PHP)</dd></div>
            <div class="flex justify-between gap-3"><dt class="font-semibold text-stone-500">Photo storage</dt><dd class="font-bold">Supabase bucket</dd></div>
            <div class="flex justify-between gap-3"><dt class="font-semibold text-stone-500">Signed in as</dt><dd class="font-bold">${esc(state.user ? state.user.fullName : '')}</dd></div>
          </dl>
          <p class="mt-4 text-xs text-stone-500">
            Menu photos are stored in your Supabase Storage bucket and served from there. The timezone is set with the TIMEZONE environment variable.
          </p>
        </div>

        <div class="card p-5">
          <h3 class="flex items-center gap-2 text-lg font-extrabold">${icon('shield', 'w-5 h-5')} Security</h3>
          <ul class="mt-3 space-y-2 text-sm text-stone-600">
            <li class="flex gap-2"><span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400"></span>Passwords are hashed with bcrypt and never stored as plain text.</li>
            <li class="flex gap-2"><span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400"></span>The database is only reachable by the server, never by the browser.</li>
            <li class="flex gap-2"><span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400"></span>Every sensitive action is written to the Audit Logs.</li>
            <li class="flex gap-2"><span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400"></span>Sign-in attempts are rate limited and locked after repeated failures.</li>
          </ul>
        </div>
      </div>
    </div>`;

  const form = container.querySelector('#settings-form');
  const errorEl = container.querySelector('[data-error]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.classList.add('hidden');
    const body = {
      restaurantName: form.restaurantName.value.trim(),
      address: form.address.value.trim(),
      phone: form.phone.value.trim(),
      receiptFooter: form.receiptFooter.value.trim(),
    };
    if (!body.restaurantName) {
      errorEl.textContent = 'Restaurant name is required.';
      errorEl.classList.remove('hidden');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    await withButtonLoading(button, 'Saving...', async () => {
      try {
        const data = await api('/settings', { method: 'PATCH', body });
        state.settings = data.settings;
        document.title = `${data.settings.restaurantName} - POS`;
        toast('Settings saved.', 'success');
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
      }
    });
  });
}
