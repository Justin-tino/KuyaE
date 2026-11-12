'use strict';

const { config } = require('../config');

/**
 * Small timezone helper. The POS runs on Philippine time (config.timezone)
 * so "today" always means today in the restaurant, not in UTC.
 */

function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour === '24' ? '0' : parts.hour, 10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );
  return asUTC - date.getTime();
}

/** Convert 'YYYY-MM-DD' (restaurant local date) to the UTC Date of local midnight. */
function zonedStartOfDay(dateStr, timeZone = config.timezone) {
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let offset = tzOffsetMs(new Date(utcGuess), timeZone);
  let ts = utcGuess - offset;
  offset = tzOffsetMs(new Date(ts), timeZone);
  ts = utcGuess - offset;
  return new Date(ts);
}

/** Local calendar date string for a Date, in the restaurant timezone. */
function toLocalDateStr(date, timeZone = config.timezone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(date); // en-CA gives YYYY-MM-DD
}

function todayStr(timeZone = config.timezone) {
  return toLocalDateStr(new Date(), timeZone);
}

function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Inclusive range of local dates -> UTC ISO instants.
 * Returns { fromIso, toIso } where fromIso <= created_at < toIso.
 */
function dayRange(fromDate, toDate, timeZone = config.timezone) {
  const from = zonedStartOfDay(fromDate, timeZone);
  const to = zonedStartOfDay(addDaysStr(toDate, 1), timeZone);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10) === s;
}

function daysBetween(fromDate, toDate) {
  const a = Date.UTC(...fromDate.split('-').map((n, i) => (i === 1 ? parseInt(n, 10) - 1 : parseInt(n, 10))));
  const b = Date.UTC(...toDate.split('-').map((n, i) => (i === 1 ? parseInt(n, 10) - 1 : parseInt(n, 10))));
  return Math.round((b - a) / 86400000);
}

function eachDateStr(fromDate, toDate) {
  const dates = [];
  let cur = fromDate;
  let guard = 0;
  while (cur <= toDate && guard < 400) {
    dates.push(cur);
    cur = addDaysStr(cur, 1);
    guard += 1;
  }
  return dates;
}

module.exports = {
  tzOffsetMs,
  zonedStartOfDay,
  toLocalDateStr,
  todayStr,
  addDaysStr,
  dayRange,
  isValidDateStr,
  daysBetween,
  eachDateStr,
};
