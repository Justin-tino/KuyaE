// API client. Adds the custom header required by the server's CSRF check and
// handles session expiry (401) globally.

import { state } from './state.js';

let onUnauthorized = null;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(path, options = {}) {
  const { method = 'GET', body, formData, silent = false } = options;
  const fetchOptions = {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'kuyae-pos' },
  };
  if (formData) {
    fetchOptions.body = formData;
  } else if (body !== undefined) {
    fetchOptions.headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch('/api' + path, fetchOptions);
  } catch {
    throw new Error('Cannot reach the server. Please check the internet connection.');
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (response.status === 401) {
    state.user = null;
    if (!silent && onUnauthorized) onUnauthorized();
    throw new Error((data && data.error) || 'Your session has expired. Please sign in again.');
  }
  if (!response.ok) {
    throw new Error((data && data.error) || `Request failed (${response.status}).`);
  }
  return data;
}
