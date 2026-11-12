// Setup, first-admin onboarding, and sign-in screens.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast, withButtonLoading, spinner } from '../ui.js';

const appName = (status) => (status && status.restaurantName) || 'Kuya E Tapsilogan';

function brandHeader(status, subtitle) {
  return `
    <div class="mb-6 flex flex-col items-center gap-2 text-center">
      <img src="/images/logo.png" alt="Logo" class="h-24 w-24 object-contain">
      <h1 class="text-3xl font-extrabold tracking-tight">${esc(appName(status))}</h1>
      ${subtitle ? `<p class="text-stone-500 font-semibold">${esc(subtitle)}</p>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Setup required (Supabase not configured)
// ---------------------------------------------------------------------------

export function renderSetupPage(container, status) {
  const missing = (status && status.missing) || [];
  container.innerHTML = `
    <div class="flex min-h-screen items-center justify-center bg-stone-100 p-4 sm:p-8">
      <div class="card w-full max-w-3xl p-6 sm:p-10">
        ${brandHeader(status, 'Point of Sale')}
        <div class="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-900">
          <div class="flex items-start gap-3">
            <span class="mt-0.5 shrink-0">${icon('alert', 'w-7 h-7')}</span>
            <div>
              <p class="text-xl font-extrabold">Setup required</p>
              <p class="mt-1 font-semibold">The system is not connected to Supabase yet.</p>
              ${status && status.dbMessage ? `<p class="mt-2 text-sm font-semibold">${esc(status.dbMessage)}</p>` : ''}
            </div>
          </div>
        </div>

        <h2 class="mt-8 text-xl font-extrabold">How to finish the setup</h2>
        <ol class="mt-4 space-y-5">
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
              <p class="mt-2 text-sm text-stone-500">Find the Project URL and service_role key under Project Settings &gt; API. Generate SESSION_SECRET with a long random string.</p>
            </div>
          </li>
          <li class="flex gap-4">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-900 font-bold text-white">4</span>
            <div>
              <p class="font-bold">Restart the app</p>
              <p class="text-stone-600">Redeploy on Render (or restart locally). This page will then ask you to create the first admin account.</p>
            </div>
          </li>
        </ol>

        <div class="mt-8 flex flex-wrap items-center gap-3">
          <button type="button" class="btn btn-lg btn-primary" id="recheck">${icon('refresh', 'w-5 h-5')} Check again</button>
          <span class="text-sm font-semibold text-stone-500">The full guide is in README.md</span>
        </div>
      </div>
    </div>`;

  container.querySelector('#recheck').addEventListener('click', () => window.location.reload());
}

// ---------------------------------------------------------------------------
// First admin account
// ---------------------------------------------------------------------------

export function renderFirstAdminPage(container, status, onDone) {
  container.innerHTML = `
    <div class="flex min-h-screen items-center justify-center bg-stone-100 p-4 sm:p-8">
      <div class="card w-full max-w-lg p-6 sm:p-8">
        ${brandHeader(status, 'Create the first administrator account')}
        <p class="mb-6 rounded-xl bg-stone-100 px-4 py-3 text-stone-600">
          This screen only appears once, while there are no accounts yet. The first account is always an Admin.
        </p>
        <form id="setup-form" class="space-y-4" novalidate>
          <div>
            <label class="label" for="fullName">Full name</label>
            <input id="fullName" name="fullName" class="input input-lg" autocomplete="name" required placeholder="e.g. Maria Santos">
          </div>
          <div>
            <label class="label" for="username">Username</label>
            <input id="username" name="username" class="input input-lg" autocomplete="username" required placeholder="e.g. admin">
            <p class="mt-1 text-sm text-stone-500">Letters, numbers, dots, dashes and underscores only.</p>
          </div>
          <div>
            <label class="label" for="password">Password</label>
            <input id="password" name="password" type="password" class="input input-lg" autocomplete="new-password" required placeholder="At least 8 characters">
            <p class="mt-1 text-sm text-stone-500">Must contain at least one letter and one number.</p>
          </div>
          <div>
            <label class="label" for="confirm">Confirm password</label>
            <input id="confirm" name="confirm" type="password" class="input input-lg" autocomplete="new-password" required>
          </div>
          <p class="hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-800" data-error></p>
          <button type="submit" class="btn btn-lg btn-primary w-full">${icon('shield', 'w-5 h-5')} Create Admin Account</button>
        </form>
      </div>
    </div>`;

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
  container.innerHTML = `
    <div class="flex min-h-screen items-center justify-center bg-stone-100 p-4 sm:p-8">
      <div class="card w-full max-w-md p-6 sm:p-8">
        ${brandHeader(status, 'Sign in to continue')}
        <form id="login-form" class="space-y-4" novalidate>
          <div>
            <label class="label" for="username">Username</label>
            <input id="username" name="username" class="input input-lg" autocomplete="username" autocapitalize="none"
              spellcheck="false" required placeholder="Your username">
          </div>
          <div>
            <label class="label" for="password">Password</label>
            <input id="password" name="password" type="password" class="input input-lg" autocomplete="current-password" required placeholder="Your password">
          </div>
          <p class="hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-800" data-error></p>
          <button type="submit" class="btn btn-lg btn-primary w-full" data-submit>Sign In</button>
        </form>
        <p class="mt-6 text-center text-sm text-stone-500">
          Forgot your password? Ask the administrator to reset it.
        </p>
      </div>
    </div>`;

  const form = container.querySelector('#login-form');
  const errorEl = container.querySelector('[data-error]');
  const submitButton = container.querySelector('[data-submit]');

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
