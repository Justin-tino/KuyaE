// Admin: settings - the e-wallet QR code shown to cashiers on online payments.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables } from '../realtime.js';
import { state } from '../state.js';
import {
  esc,
  toast,
  pageLoader,
  emptyState,
  confirmDialog,
  withButtonLoading,
  debounce,
} from '../ui.js';

let rootEl = null;
let settings = null;
let loading = true;

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading settings...');
  const onClick = (event) => handleClick(event);
  const onChange = (event) => handleChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  const off = onTables(['settings'], debounce(() => load(true), 300));

  await load(false);

  return () => {
    off();
    container.removeEventListener('click', onClick);
    container.removeEventListener('change', onChange);
  };
}

async function load(quiet) {
  if (!quiet) {
    loading = true;
    render();
  }
  try {
    const data = await api('/settings');
    settings = data.settings;
    state.settings = data.settings; // keep the payment modal in sync
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
  if (loading) {
    rootEl.innerHTML = pageLoader('Loading settings...');
    return;
  }

  const qrUrl = settings && settings.qrCodeUrl;

  rootEl.innerHTML = `
    <div class="space-y-4">
      <div class="card p-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <h2 class="text-lg font-extrabold text-stone-900">E-Wallet QR Code</h2>
            <p class="mt-1 max-w-2xl text-sm font-semibold text-stone-500">
              When a cashier takes an online payment (GCash, bank or card) this QR code is shown first.
              The cashier lets the customer scan it, closes it, then records the reference number.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" data-action="upload" class="btn btn-md btn-primary shrink-0">
              ${icon('upload', 'w-5 h-5')} ${qrUrl ? 'Replace QR Code' : 'Upload QR Code'}
            </button>
            ${
              qrUrl
                ? `<button type="button" data-action="remove" class="btn btn-md btn-secondary shrink-0">${icon('trash', 'w-5 h-5')} Remove</button>`
                : ''
            }
          </div>
        </div>

        <div class="mt-5">
          ${
            qrUrl
              ? `<div class="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                  <img src="${esc(qrUrl)}" alt="E-wallet QR code"
                    class="h-56 w-56 rounded-2xl border border-stone-200 bg-white object-contain p-2">
                  <div class="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-600">
                    <p class="font-bold text-stone-700">This QR code is active.</p>
                    <p class="mt-1 max-w-sm">Every cashier sees it when taking an online payment. Upload a new image to replace it.</p>
                  </div>
                </div>`
              : emptyState(
                  'image',
                  'No QR code uploaded',
                  'Upload your GCash or e-wallet QR code so cashiers can show it during online payments.'
                )
          }
        </div>

        <input id="settings-qr-file" type="file" accept="image/jpeg,image/png,image/webp" class="hidden">
      </div>
    </div>`;
}

function handleClick(event) {
  if (event.target.closest('[data-action="upload"]')) {
    const input = rootEl.querySelector('#settings-qr-file');
    if (input) input.click();
    return;
  }
  if (event.target.closest('[data-action="remove"]')) {
    removeQr();
  }
}

async function handleChange(event) {
  if (event.target.id !== 'settings-qr-file') return;
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    toast('Only JPG, PNG or WebP images are allowed.', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('The image is too large. Maximum size is 5 MB.', 'error');
    return;
  }

  const button = rootEl.querySelector('[data-action="upload"]');
  try {
    await withButtonLoading(button, 'Uploading...', async () => {
      const formData = new FormData();
      formData.append('qr', file);
      const data = await api('/settings/qr', { method: 'POST', formData });
      settings = data.settings;
      state.settings = data.settings;
    });
    render();
    toast('QR code updated.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeQr() {
  const confirmed = await confirmDialog({
    title: 'Remove QR code?',
    message: 'Cashiers will no longer see a QR code when taking online payments.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await api('/settings/qr', { method: 'DELETE' });
    await load(true);
    toast('QR code removed.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}