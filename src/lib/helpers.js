'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** '12.50' | 12.5 -> 1250 (integer cents; avoids floating point drift) */
function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

/** 1250 -> '12.50' (string, sent to Postgres numeric columns) */
function fromCents(cents) {
  return (Math.round(cents) / 100).toFixed(2);
}

function clampInt(value, min, max, fallback) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function escapeLike(value) {
  return String(value).replace(/[%_\\,()]/g, ' ').trim();
}

/** Reads zod-style parse errors into one friendly sentence. */
function firstZodError(error) {
  if (!error || !error.errors || !error.errors.length) return 'Invalid request.';
  const issue = error.errors[0];
  const path = issue.path && issue.path.length ? issue.path.join('.') : '';
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Strip characters that have no business in names/usernames etc. */
function cleanText(value, maxLen) {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

module.exports = { isUuid, toCents, fromCents, clampInt, escapeLike, firstZodError, cleanText };
