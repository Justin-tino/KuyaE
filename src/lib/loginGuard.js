'use strict';

/**
 * Per-account sign-in protection (on top of the per-IP rate limiter).
 * After 6 failed attempts the username is locked for 15 minutes.
 * In-memory: fine for a single restaurant on one server.
 */

const MAX_FAILURES = 6;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

const attempts = new Map(); // username -> { failures: [timestamps], lockedUntil }

function checkLock(username) {
  const entry = attempts.get(username);
  if (!entry) return { locked: false, retryInMinutes: 0 };
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return {
      locked: true,
      retryInMinutes: Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 60000)),
    };
  }
  return { locked: false, retryInMinutes: 0 };
}

function recordFailure(username) {
  const now = Date.now();
  const entry = attempts.get(username) || { failures: [], lockedUntil: 0 };
  entry.failures = entry.failures.filter((t) => now - t < WINDOW_MS);
  entry.failures.push(now);
  if (entry.failures.length >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
    entry.failures = [];
  }
  attempts.set(username, entry);
}

function recordSuccess(username) {
  attempts.delete(username);
}

// Housekeeping.
setInterval(() => {
  const now = Date.now();
  for (const [username, entry] of attempts) {
    entry.failures = entry.failures.filter((t) => now - t < WINDOW_MS);
    if (!entry.failures.length && entry.lockedUntil < now) attempts.delete(username);
  }
}, 10 * 60 * 1000).unref();

module.exports = { checkLock, recordFailure, recordSuccess };
