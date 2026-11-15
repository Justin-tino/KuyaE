// Setup, first-admin onboarding, and sign-in screens.
//
// Shared look: soft light background with red corner waves and a faint chef
// hat watermark, and a floating white card with a red wave along its bottom.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { esc, shortName, toast, withButtonLoading } from '../ui.js';

const appName = (status) => shortName(status);

const GRADIENT_BTN =
  'rounded-full bg-gradient-to-b from-red-600 to-red-700 text-white shadow-lg shadow-red-700/30 transition-all hover:from-red-700 hover:to-red-800 active:from-red-800 active:to-red-900';

/** Corner decorations: red waves, soft grey blob, chef hat watermark. */
function backgroundDecor() {
  return `
    <div class="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div class="absolute -bottom-24 -left-20 h-80 w-80 rounded-full bg-stone-200/70 blur-3xl"></div>
      <svg class="absolute -right-10 -top-8 h-64 w-64 rotate-6 sm:h-96 sm:w-96" viewBox="0 0 200 200" fill="none"
        stroke="#e7e5e4" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M58 118C40 118 26 104 30 88 20 70 34 52 52 56 54 34 76 22 96 30 112 16 140 22 146 42 166 44 178 62 170 80 180 96 168 116 148 118Z"/>
        <path d="M64 118h76v22a10 10 0 0 1-10 10h-56a10 10 0 0 1-10-10z"/>
        <path d="M28 40l12 12M44 22l8 14M14 62l15 5"/>
      </svg>
      <svg class="absolute left-0 top-0 h-36 w-[70%] sm:h-56 sm:w-[52%]" viewBox="0 0 600 260" preserveAspectRatio="none">
        <path d="M0 0h600c-96 34-206 12-300 66C206 122 96 118 0 196Z" fill="#dc2626"/>
      </svg>
      <svg class="absolute bottom-0 right-0 h-40 w-[78%] sm:h-60 sm:w-[58%]" viewBox="0 0 600 240" preserveAspectRatio="none">
        <path d="M600 240H120c104-38 190-30 262-84 62-46 138-56 218-40Z" fill="#ef4444" opacity=".85"/>
        <path d="M600 240H250c104-30 196-14 268-62 46-32 76-42 82-44Z" fill="#dc2626"/>
      </svg>
    </div>`;
}

/** Red wave hugging the bottom edge of the white card. */
function cardWave() {
  return `
    <svg class="pointer-events-none absolute inset-x-0 bottom-0 h-14 w-full sm:h-16" viewBox="0 0 400 64" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 64V34c56-20 118 10 200-2 78-12 138-22 200-6v38Z" fill="#ef4444" opacity=".8"/>
      <path d="M0 64V46c62-16 124 8 204-2 74-10 132-16 196-4v24Z" fill="#dc2626"/>
    </svg>`;
}

function pageShell(cardWidth, innerHtml) {
  return `
    <div class="min-app-height relative flex items-center justify-center bg-stone-100 p-4 sm:p-6">
      ${backgroundDecor()}
      <div class="relative z-10 w-full ${cardWidth} overflow-hidden rounded-3xl border border-stone-200/60 bg-white shadow-2xl shadow-stone-900/10">
        ${cardWave()}
        <div class="auth-body relative">${innerHtml}</div>
      </div>
    </div>`;
}

function brandHeader(status, subtitle) {
  return `
    <div class="text-center">
      <div class="flex items-center justify-center gap-3">
        <span class="h-0.5 w-10 rounded-full bg-red-600 sm:w-14"></span>
        <img src="/images/logo.png" alt="" class="auth-logo object-contain">
        <span class="h-0.5 w-10 rounded-full bg-red-600 sm:w-14"></span>
      </div>
      <h1 class="auth-title font-extrabold tracking-tight text-stone-900">${esc(appName(status))}</h1>
      ${subtitle ? `<p class="mt-1 text-lg text-stone-500">${esc(subtitle)}</p>` : ''}
      <span class="mx-auto mt-3 block h-1 w-14 rounded-full bg-red-600"></span>
    </div>`;
}

/** Label with a small icon, matching the sign-in design. */
function fieldLabel(id, iconName, text) {
  return `
    <label class="mb-1.5 flex items-center gap-2 text-sm font-bold text-stone-800" for="${id}">
      ${icon(iconName, 'w-4 h-4 text-stone-600')} ${esc(text)}
    </label>`;
}

// ---------------------------------------------------------------------------
// Setup required (Supabase not configured)
// ---------------------------------------------------------------------------

export function renderSetupPage(container, status) {
  const missing = (status && status.missing) || [];
  const needsEnv = !status || !status.configured;
  const dbMessage = status && status.dbMessage;

  const steps = needsEnv
    ? `
        <li class="flex gap-4">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-900 font-bold text-white">1</span>
          <div>
            <p class="font-bold">Create a Supabase project</p>
            <p class="text-stone-600">Sign in at supabase.com, create a project, then open the SQL Editor.</p>
          </div>
        </li>
        <li class="flex gap-4">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-900 font-bold text-white">2</span>
          <div>
            <p class="font-bold">Run the database setup file</p>
            <p class="text-stone-600">Paste the whole contents of <code class="rounded bg-stone-200 px-1.5 py-0.5 font-mono text-sm">supabase/setup.sql</code> into the SQL Editor and click Run. It creates the tables, security rules, realtime and the menu photo bucket.</p>
          </div>
        </li>
        <li class="flex gap-4">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-900 font-bold text-white">3</span>
          <div>
            <p class="font-bold">Add the environment variables</p>
            <p class="text-stone-600">In Render (or your <code class="rounded bg-stone-200 px-1.5 py-0.5 font-mono text-sm">.env</code> file when testing locally):</p>
            <ul class="mt-2 space-y-1 font-mono text-sm">
              ${(missing.length ? missing : ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET'])
                .map(
                  (name) =>
                    `<li class="flex items-center gap-2"><span class="inline-block h-2 w-2 rounded-full bg-red-600"></span>${esc(name)}</li>`
                )
                .join('')}
            </ul>
            <p class="mt-2 text-sm text-stone-500">Find the Project URL and secret key under Project Settings &gt; API Keys. Generate SESSION_SECRET with a long random string.</p>
          </div>
        </li>
        <li class="flex gap-4">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-900 font-bold text-white">4</span>
          <div>
            <p class="font-bold">Restart the app</p>
            <p class="text-stone-600">Redeploy on Render (or restart locally). This page will then ask you to create the first admin account.</p>
          </div>
        </li>`
    : `
        <li class="flex gap-4">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-900 font-bold text-white">1</span>
          <div>
            <p class="font-bold">Open the Supabase SQL Editor</p>
            <p class="text-stone-600">In your Supabase project, click <span class="font-semibold">SQL Editor</span> in the left menu.</p>
          </div>
        </li>
        <li class="flex gap-4">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-900 font-bold text-white">2</span>
          <div>
            <p class="font-bold">Paste and run the setup file</p>
            <p class="text-stone-600">Open <code class="rounded bg-stone-200 px-1.5 py-0.5 font-mono text-sm">supabase/setup.sql</code>, copy everything, paste it into the editor and click <span class="font-semibold">Run</span>.</p>
          </div>
        </li>
        <li class="flex gap-4">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-900 font-bold text-white">3</span>
          <div>
            <p class="font-bold">Come back and click Check again</p>
            <p class="text-stone-600">No restart is needed. The app will then ask you to create the first admin account.</p>
          </div>
        </li>`;

  container.innerHTML = pageShell(
    'max-w-3xl',
    `
      ${brandHeader(status, 'Point of Sale')}
      <div class="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-900">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 shrink-0">${icon('alert', 'w-7 h-7')}</span>
          <div>
            <p class="text-xl font-extrabold">Setup required</p>
            <p class="mt-1 font-semibold">${
              needsEnv ? 'The system is not connected to Supabase yet.' : 'Supabase is connected, but the database tables are not created yet.'
            }</p>
            ${dbMessage ? `<p class="mt-2 text-sm font-semibold">${esc(dbMessage)}</p>` : ''}
          </div>
        </div>
      </div>

      <h2 class="mt-8 text-xl font-extrabold">${needsEnv ? 'How to finish the setup' : 'One step left'}</h2>
      <ol class="mt-4 space-y-5">${steps}</ol>

      <div class="mt-8 flex flex-wrap items-center gap-3">
        <button type="button" class="btn btn-lg ${GRADIENT_BTN}" id="recheck">${icon('refresh', 'w-5 h-5')} Check again</button>
        <span class="text-sm font-semibold text-stone-500">The full guide is in README.md</span>
      </div>`
  );

  container.querySelector('#recheck').addEventListener('click', () => window.location.reload());
}

// ---------------------------------------------------------------------------
// First admin account
// ---------------------------------------------------------------------------

export function renderFirstAdminPage(container, status, onDone) {
  container.innerHTML = pageShell(
    'max-w-lg',
    `
      ${brandHeader(status, 'Create the first administrator account')}
      <p class="mb-6 mt-6 rounded-xl bg-stone-100 px-4 py-3 text-stone-600">
        This screen only appears once, while there are no accounts yet. The first account is always an Admin.
      </p>
      <form id="setup-form" class="space-y-4" novalidate>
        <div>
          ${fieldLabel('fullName', 'user', 'Full name')}
          <input id="fullName" name="fullName" class="input input-lg" autocomplete="name" required placeholder="e.g. Maria Santos">
        </div>
        <div>
          ${fieldLabel('username', 'user', 'Username')}
          <input id="username" name="username" class="input input-lg" autocomplete="username" autocapitalize="none"
            spellcheck="false" required placeholder="e.g. admin">
          <p class="mt-1 text-sm text-stone-500">Letters, numbers, dots, dashes and underscores only.</p>
        </div>
        <div>
          ${fieldLabel('password', 'lock', 'Password')}
          <input id="password" name="password" type="password" class="input input-lg" autocomplete="new-password" required placeholder="At least 8 characters">
          <p class="mt-1 text-sm text-stone-500">Must contain at least one letter and one number.</p>
        </div>
        <div>
          ${fieldLabel('confirm', 'lock', 'Confirm password')}
          <input id="confirm" name="confirm" type="password" class="input input-lg" autocomplete="new-password" required>
        </div>
        <p class="hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800" data-error></p>
        <button type="submit" class="btn btn-lg w-full ${GRADIENT_BTN}">${icon('shield', 'w-5 h-5')} Create Admin Account</button>
      </form>`
  );

  const form = container.querySelector('#setup-form');
  const errorEl = container.querySelector('[data-error]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.classList.add('hidden');
    const fullName = form.fullName.value.trim();
    const username = form.username.value.trim();
    const password = form.password.value;
    const confirm = form.confirm.value;

    if (fullName.length < 2) return showError('Please enter your full name.');
    if (username.length < 3) return showError('Username must be at least 3 characters.');
    if (password.length < 8) return showError('Password must be at least 8 characters.');
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      return showError('Password must contain at least one letter and one number.');
    if (password !== confirm) return showError('The two passwords do not match.');

    const button = form.querySelector('button[type="submit"]');
    await withButtonLoading(button, 'Creating account...', async () => {
      try {
        const data = await api('/setup/first-admin', { method: 'POST', body: { fullName, username, password } });
        toast('Admin account created. Welcome!', 'success');
        onDone(data.user);
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
// Sign in
// ---------------------------------------------------------------------------

export function renderLoginPage(container, status, onLoggedIn) {
  container.innerHTML = pageShell(
    'max-w-md',
    `
      ${brandHeader(status, 'Sign in to continue')}

      <form id="login-form" class="auth-form" novalidate>
        <div>
          ${fieldLabel('username', 'user', 'Username')}
          <input id="username" name="username" class="input input-lg" autocomplete="username" autocapitalize="none"
            spellcheck="false" required placeholder="Your username">
        </div>
        <div>
          ${fieldLabel('password', 'lock', 'Password')}
          <div class="relative">
            <input id="password" name="password" type="password" class="input input-lg pr-12"
              autocomplete="current-password" required placeholder="Your password">
            <button type="button" data-toggle-password
              class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
              aria-label="Show password">
              ${icon('eyeOff', 'w-5 h-5')}
            </button>
          </div>
        </div>
        <p class="hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800" data-error></p>
        <button type="submit" data-submit class="btn btn-lg w-full ${GRADIENT_BTN}">
          ${icon('login', 'w-5 h-5')} Sign In
        </button>
      </form>

      <div class="auth-foot flex items-center justify-center gap-3">
        <span class="h-px w-8 shrink-0 rounded-full bg-red-600/60"></span>
        <p class="text-center text-sm text-stone-600">Forgot your password? Ask the administrator to reset it.</p>
        <span class="h-px w-8 shrink-0 rounded-full bg-red-600/60"></span>
      </div>`
  );

  const form = container.querySelector('#login-form');
  const errorEl = container.querySelector('[data-error]');
  const submitButton = container.querySelector('[data-submit]');
  const passwordInput = container.querySelector('#password');
  const toggleButton = container.querySelector('[data-toggle-password]');

  // Show / hide password.
  toggleButton.addEventListener('click', () => {
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    toggleButton.innerHTML = icon(isHidden ? 'eye' : 'eyeOff', 'w-5 h-5');
    toggleButton.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    passwordInput.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.classList.add('hidden');
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) {
      showError('Please enter your username and password.');
      return;
    }
    await withButtonLoading(submitButton, 'Signing in...', async () => {
      try {
        const data = await api('/auth/login', { method: 'POST', body: { username, password } });
        onLoggedIn(data.user);
      } catch (err) {
        showError(err.message);
        submitButton.disabled = false;
      }
    });
  });

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  setTimeout(() => form.username.focus(), 80);
}
