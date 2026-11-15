// Admin: menu management (with photo upload to Supabase Storage).

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables } from '../realtime.js';
import {
  esc,
  money,
  toast,
  pageLoader,
  emptyState,
  openModal,
  confirmDialog,
  withButtonLoading,
  renderPreservingFocus,
  debounce,
} from '../ui.js';

const CATEGORY_SUGGESTIONS = ['Tapsilog', 'Silog Meals', 'Rice Meals', 'Add-ons', 'Drinks', 'Desserts'];

let items = [];
let search = '';
let categoryFilter = 'All';
let rootEl = null;
let loading = true;

const MAX_PHOTO_EDGE = 800; // menu photos are shown small - 800px is plenty
const SMALL_FILE_BYTES = 300 * 1024; // files this small are uploaded untouched

/**
 * Shrinks large photos in the browser before uploading (long edge 800px,
 * JPEG). A 5 MB phone photo becomes a couple hundred KB, so saving is quick
 * even on a slow connection. Falls back to the original file on any problem.
 */
async function shrinkImage(file) {
  if (file.size <= SMALL_FILE_BYTES || typeof createImageBitmap !== 'function') return file;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; // flatten transparency for JPEG
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    if (bitmap && bitmap.close) bitmap.close();
    return file;
  }
}

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading menu...');
  const onClick = (event) => handleClick(event);
  const onInput = (event) => handleInput(event);
  const onChange = (event) => handleChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  const off = onTables(['menu_items'], debounce(() => load(true), 300));
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
    const data = await api('/menu');
    items = data.items || [];
    loading = false;
    render(quiet);
  } catch (err) {
    loading = false;
    render(true);
    toast(err.message, 'error');
  }
}

function filteredItems() {
  const q = search.trim().toLowerCase();
  return items.filter((item) => {
    if (categoryFilter !== 'All' && item.category !== categoryFilter) return false;
    if (!q) return true;
    return item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q);
  });
}

function render(quiet) {
  if (!rootEl) return;
  const categories = [...new Set(items.map((item) => item.category))];
  const visible = filteredItems();

  const html = `
    <div class="space-y-4">
      <div class="card p-4">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div class="min-w-0 flex-1">
            <label class="label" for="menu-admin-search">Search</label>
            <div class="relative">
              <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-stone-400">${icon('search', 'w-5 h-5')}</span>
              <input id="menu-admin-search" data-focus-key="menu-admin-search" class="input pl-12" placeholder="Search menu items" value="${esc(search)}" autocomplete="off">
            </div>
          </div>
          <div class="w-full lg:w-56">
            <label class="label" for="menu-category-filter">Category</label>
            <select id="menu-category-filter" class="input">
              <option value="All">All categories</option>
              ${categories.map((cat) => `<option value="${esc(cat)}" ${cat === categoryFilter ? 'selected' : ''}>${esc(cat)}</option>`).join('')}
            </select>
          </div>
          <button type="button" data-action="add" class="btn btn-md btn-primary">${icon('plus', 'w-5 h-5')} Add Menu Item</button>
        </div>
      </div>

      ${
        loading
          ? `<div class="card">${pageLoader('Loading menu...')}</div>`
          : visible.length
          ? `<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">${visible.map(cardHtml).join('')}</div>`
          : `<div class="card">${emptyState(
              'clipboard',
              items.length ? 'No matching items' : 'No menu items yet',
              items.length ? 'Try another search or category.' : 'Add your first menu item to start taking orders.',
              items.length
                ? ''
                : `<button type="button" data-action="add" class="btn btn-lg btn-primary">${icon('plus', 'w-5 h-5')} Add Menu Item</button>`
            )}</div>`
      }
    </div>`;

  if (quiet) renderPreservingFocus(rootEl, html);
  else rootEl.innerHTML = html;

  rootEl.querySelectorAll('img[data-menu-img]').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

function cardHtml(item) {
  return `
    <div class="card overflow-hidden">
      <div class="relative flex h-40 items-center justify-center bg-stone-100 text-stone-300">
        ${icon('bowl', 'w-12 h-12')}
        ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" class="absolute inset-0 h-full w-full object-cover" data-menu-img>` : ''}
        ${
          !item.isAvailable
            ? '<span class="absolute inset-0 flex items-center justify-center bg-stone-900/55 text-sm font-extrabold uppercase tracking-wide text-white">Unavailable</span>'
            : ''
        }
      </div>
      <div class="space-y-3 p-4">
        <div>
          <p class="text-lg font-bold leading-tight">${esc(item.name)}</p>
          <p class="text-sm font-semibold text-stone-500">${esc(item.category)}</p>
          <p class="mt-1 text-2xl font-extrabold text-red-700">${money(item.priceCents)}</p>
        </div>
        ${item.description ? `<p class="line-clamp-2 text-sm text-stone-600">${esc(item.description)}</p>` : ''}

        <label class="flex cursor-pointer select-none items-center gap-3">
          <span class="relative inline-block h-7 w-12 shrink-0">
            <input type="checkbox" class="peer sr-only" data-availability="${item.id}" ${item.isAvailable ? 'checked' : ''}>
            <span class="absolute inset-0 rounded-full bg-stone-300 transition-colors peer-checked:bg-emerald-500"></span>
            <span class="absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5"></span>
          </span>
          <span class="text-sm font-bold ${item.isAvailable ? 'text-emerald-700' : 'text-stone-500'}">
            ${item.isAvailable ? 'Available' : 'Unavailable'}
          </span>
        </label>

        <div class="flex gap-2">
          <button type="button" data-edit="${item.id}" class="btn btn-secondary btn-md flex-1">${icon('pencil', 'w-4 h-4')} Edit</button>
          <button type="button" data-delete="${item.id}" class="btn btn-ghost btn-md text-red-700" title="Delete">${icon('trash', 'w-5 h-5')}</button>
        </div>
      </div>
    </div>`;
}

function handleClick(event) {
  if (event.target.closest('[data-action="add"]')) {
    openMenuForm(null);
    return;
  }
  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    const item = items.find((entry) => entry.id === editButton.getAttribute('data-edit'));
    if (item) openMenuForm(item);
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    const item = items.find((entry) => entry.id === deleteButton.getAttribute('data-delete'));
    if (item) deleteItem(item);
  }
}

function handleInput(event) {
  if (event.target.id === 'menu-admin-search') {
    search = event.target.value;
    render(true);
  }
}

function handleChange(event) {
  if (event.target.id === 'menu-category-filter') {
    categoryFilter = event.target.value;
    render(true);
    return;
  }
  const availability = event.target.closest('[data-availability]');
  if (availability) {
    toggleAvailability(availability.getAttribute('data-availability'), availability.checked);
  }
}

async function toggleAvailability(id, isAvailable) {
  try {
    await api(`/menu/${id}`, { method: 'PATCH', body: { isAvailable } });
    toast(isAvailable ? 'Item is now available.' : 'Item marked as unavailable.', 'success');
    load(true);
  } catch (err) {
    toast(err.message, 'error');
    load(true);
  }
}

async function deleteItem(item) {
  const ok = await confirmDialog({
    title: 'Delete this menu item?',
    message: `"${item.name}" will be removed from the menu. Past orders keep their own copy of the name and price.`,
    confirmLabel: 'Delete Item',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/menu/${item.id}`, { method: 'DELETE' });
    toast('Menu item deleted.', 'success');
    load(true);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openMenuForm(item) {
  const editing = Boolean(item);
  let selectedFile = null;
  let removePhoto = false;

  const modal = openModal({
    title: editing ? 'Edit Menu Item' : 'Add Menu Item',
    size: 'lg',
    content: `
      <form id="menu-form" class="space-y-4" novalidate>
        <div>
          <p class="label">Photo</p>
          <div class="flex flex-wrap items-start gap-4">
            <div class="relative flex h-36 w-36 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-stone-200 bg-stone-100 text-stone-300" data-preview>
              ${item && item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" class="h-full w-full object-cover">` : icon('camera', 'w-10 h-10')}
            </div>
            <div class="space-y-2">
              <label class="btn btn-secondary btn-md cursor-pointer">
                ${icon('camera', 'w-5 h-5')} Choose photo
                <input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" data-file>
              </label>
              <button type="button" class="btn btn-ghost btn-sm text-red-700" data-remove-photo>${icon('trash', 'w-4 h-4')} Remove photo</button>
              <p class="text-xs font-semibold text-stone-500">JPG, PNG or WebP. Maximum 5 MB. Large photos are resized automatically so saving stays fast.</p>
            </div>
          </div>
        </div>

        <div>
          <label class="label" for="menu-name">Name</label>
          <input id="menu-name" name="name" class="input input-lg" required maxlength="80" value="${esc(item ? item.name : '')}" placeholder="e.g. Beef Tapsilog">
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label" for="menu-category">Category</label>
            <input id="menu-category" name="category" class="input" required maxlength="40" list="category-options" value="${esc(item ? item.category : 'Tapsilog')}">
            <datalist id="category-options">
              ${[...new Set([...CATEGORY_SUGGESTIONS, ...items.map((entry) => entry.category)])]
                .map((cat) => `<option value="${esc(cat)}"></option>`)
                .join('')}
            </datalist>
          </div>
          <div>
            <label class="label" for="menu-price">Price (PHP)</label>
            <input id="menu-price" name="price" type="number" step="0.01" min="0.01" max="1000000" class="input" required
              value="${item ? (item.priceCents / 100).toFixed(2) : ''}" placeholder="0.00">
          </div>
        </div>

        <div>
          <label class="label" for="menu-description">Description (optional)</label>
          <textarea id="menu-description" name="description" class="textarea" rows="2" maxlength="300" placeholder="Short description shown to the cashier">${esc(item ? item.description : '')}</textarea>
        </div>

        <label class="flex cursor-pointer items-center gap-3 rounded-xl border border-stone-200 px-4 py-3">
          <input type="checkbox" name="isAvailable" class="h-6 w-6 accent-emerald-600" ${!item || item.isAvailable ? 'checked' : ''}>
          <span class="font-bold">Available for ordering</span>
        </label>

        <p class="hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-800" data-error></p>
      </form>`,
    footer: `
      <button type="button" class="btn btn-lg btn-secondary" data-action="cancel">Cancel</button>
      <button type="button" class="btn btn-lg btn-primary" data-action="save">${editing ? 'Save Changes' : 'Add Item'}</button>`,
  });

  const form = modal.body.querySelector('#menu-form');
  const preview = modal.body.querySelector('[data-preview]');
  const fileInput = modal.body.querySelector('[data-file]');
  const errorEl = modal.body.querySelector('[data-error]');
  const saveButton = modal.footer.querySelector('[data-action="save"]');

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  };

  let previewUrl = null;

  function setPreview(url) {
    if (url) {
      preview.innerHTML = `<img src="${esc(url)}" alt="" class="h-full w-full object-cover">`;
    } else {
      preview.innerHTML = icon('camera', 'w-10 h-10');
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      showError('Only JPG, PNG or WebP photos are allowed.');
      fileInput.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showError('The photo is too large. Maximum size is 5 MB.');
      fileInput.value = '';
      return;
    }
    errorEl.classList.add('hidden');
    removePhoto = false;
    setPreview(null);
    // Resize big photos in the browser so the upload is small and fast.
    selectedFile = await shrinkImage(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(selectedFile);
    setPreview(previewUrl);
  });

  modal.body.querySelector('[data-remove-photo]').addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    removePhoto = true;
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    setPreview(null);
  });

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => modal.close());

  saveButton.addEventListener('click', async () => {
    errorEl.classList.add('hidden');
    const name = form.name.value.trim();
    const category = form.category.value.trim() || 'Meals';
    const price = parseFloat(form.price.value);
    if (!name) return showError('Please enter the menu name.');
    if (!Number.isFinite(price) || price <= 0) return showError('Please enter a valid price.');

    const formData = new FormData(form);
    formData.set('name', name);
    formData.set('category', category);
    formData.set('price', price.toFixed(2));
    formData.set('description', form.description.value.trim());
    formData.set('isAvailable', form.isAvailable.checked ? 'true' : 'false');
    if (selectedFile) formData.append('image', selectedFile);
    if (removePhoto) formData.append('removeImage', 'true');

    await withButtonLoading(saveButton, 'Saving...', async () => {
      try {
        if (editing) {
          await api(`/menu/${item.id}`, { method: 'PATCH', formData });
          toast('Menu item updated.', 'success');
        } else {
          await api('/menu', { method: 'POST', formData });
          toast('Menu item added.', 'success');
        }
        modal.close();
        load(true);
      } catch (err) {
        showError(err.message);
      }
    });
  });

  setTimeout(() => form.name.focus(), 60);
}
