// Admin: sales dashboard (total sales, sales chart, top performing foods, payment split).

import { api } from '../api.js';
import { icon } from '../icons.js';
import { onTables } from '../realtime.js';
import {
  esc,
  money,
  toast,
  pageLoader,
  fmtDayLabel,
  fmtTime,
  todayLocalStr,
  addDays,
  debounce,
  renderPreservingFocus,
  emptyState,
} from '../ui.js';

let range = { from: todayLocalStr(), to: todayLocalStr() };
let preset = 'today';
let report = null;
// Free staff meals for today (admin view only; never part of sales).
let staffMeals = null;
// Summary of the equal-length period right before the selected range.
let previous = null;
let loading = true;
let rootEl = null;
let loadSeq = 0;
// null = automatic: daily bars within one month, monthly bars across months.
let chartMode = null;

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
];

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading sales...');
  const onClick = (event) => handleClick(event);
  const onChange = (event) => handleChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  const off = onTables(['orders', 'staff_meals'], debounce(() => load(true), 600));
  await load(false);
  return () => {
    off();
    container.removeEventListener('click', onClick);
    container.removeEventListener('change', onChange);
  };
}

function dayCount(fromStr, toStr) {
  const from = new Date(`${fromStr}T00:00:00Z`).getTime();
  const to = new Date(`${toStr}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

async function load(quiet) {
  const seq = ++loadSeq;
  if (!quiet) {
    loading = true;
    render();
  }
  const days = dayCount(range.from, range.to);
  try {
    const today = todayLocalStr();
    const [data, prevData, staffMealData] = await Promise.all([
      api(`/reports/sales?from=${range.from}&to=${range.to}`),
      // Comparison period: the same number of days right before the range.
      api(`/reports/sales?from=${addDays(range.from, -days)}&to=${addDays(range.from, -1)}`).catch(() => null),
      // Free staff meals are shown for today only and never mixed into sales.
      api(`/staff-meals?from=${today}&to=${today}`).catch(() => null),
    ]);
    if (seq !== loadSeq) return;
    report = data;
    previous = prevData ? prevData.summary : null;
    staffMeals = staffMealData;
    loading = false;
    render(quiet);
  } catch (err) {
    if (seq !== loadSeq) return;
    loading = false;
    render(true);
    toast(err.message, 'error');
  }
}

function presetRange(key) {
  const today = todayLocalStr();
  if (key === 'today') return { from: today, to: today };
  const days = key === '7d' ? 7 : key === '30d' ? 30 : 90;
  return { from: addDays(today, -(days - 1)), to: today };
}

function resolvedChartMode() {
  if (chartMode === 'daily' || chartMode === 'monthly') return chartMode;
  return range.from.slice(0, 7) === range.to.slice(0, 7) ? 'daily' : 'monthly';
}

/** Compact peso label for chart axes: PHP2.5k, PHP1.25k, PHP340. */
function pesoShort(cents) {
  const value = (Number(cents) || 0) / 100;
  if (value >= 1000000) return '\u20B1' + (Math.round((value / 1000000) * 10) / 10) + 'M';
  if (value >= 1000) {
    const k = Math.round((value / 1000) * 100) / 100;
    return '\u20B1' + (k >= 100 ? Math.round(k) : k) + 'k';
  }
  return (
    '\u20B1' +
    value.toLocaleString('en-PH', {
      minimumFractionDigits: 0,
      maximumFractionDigits: value < 100 ? 2 : 0,
    })
  );
}

/** Round a chart maximum up to a clean 1 / 2 / 2.5 / 5 / 10 step. */
function niceMax(maxCents) {
  if (maxCents <= 0) return 10000;
  const pesos = maxCents / 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(pesos)));
  const scaled = pesos / magnitude;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return nice * magnitude * 100;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, 1))
  );
}

/** Bars (one per day or per month) that back the sales chart. */
function chartSeries(mode) {
  const daily = (report && report.daily) || [];
  if (mode === 'daily') {
    return daily.map((d) => ({
      key: d.date,
      label: fmtDayLabel(d.date),
      fullLabel: `${fmtDayLabel(d.date)}, ${d.date.slice(0, 4)}`,
      cents: d.grossCents,
      ordersCount: d.ordersCount,
      paidCents: d.paidCents || 0,
    }));
  }
  const months = new Map();
  for (const d of daily) {
    const key = d.date.slice(0, 7);
    const entry = months.get(key) || { key, grossCents: 0, ordersCount: 0, paidCents: 0 };
    entry.grossCents += d.grossCents;
    entry.ordersCount += d.ordersCount;
    entry.paidCents += d.paidCents || 0;
    months.set(key, entry);
  }
  return [...months.values()].map((m) => ({
    key: m.key,
    label: monthLabel(m.key),
    fullLabel: monthLabel(m.key),
    cents: m.grossCents,
    ordersCount: m.ordersCount,
    paidCents: m.paidCents,
  }));
}

/** Screen-reader label for a bar column (the hover card itself is hidden). */
function barAriaLabel(bar, mode) {
  const unit = mode === 'daily' ? 'day' : 'month';
  return `${bar.fullLabel}: total sales ${money(bar.cents)}, ${bar.ordersCount} ${
    bar.ordersCount === 1 ? 'order' : 'orders'
  }, ${money(bar.paidCents)} paid`;
}

/**
 * Detail card shown over a bar as soon as it is hovered or focused: the day's
 * (or month's) total sales, orders and share of the period.
 */
function barTipHtml(bar, index, count, mode, totalCents, totalOrders, pct) {
  const sharePct = totalCents > 0 ? Math.round((bar.cents / totalCents) * 100) : 0;
  const avgOrderCents = bar.ordersCount > 0 ? Math.round(bar.cents / bar.ordersCount) : 0;
  const row = (label, value, tone = 'text-stone-800') => `
    <div class="flex items-center justify-between gap-4">
      <dt class="text-[11px] font-semibold text-stone-500">${esc(label)}</dt>
      <dd class="text-xs font-bold tabular-nums ${tone}">${value}</dd>
    </div>`;

  // Edge bars hug the side they would otherwise overflow, so the card never
  // spills outside the chart.
  const posCls = index === 0 ? 'left-0' : index === count - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2';
  const arrowCls =
    index === 0 ? 'left-3.5' : index === count - 1 ? 'right-3.5' : 'left-1/2 -translate-x-1/2';

  // aria-hidden: the bar's own aria-label already carries the same figures,
  // so this visual card is not announced a second time.
  // Hover (and keyboard focus) only: the moment the pointer leaves the bar,
  // or the bar loses focus, the card fades out.
  return `<div class="pointer-events-none absolute z-30 w-52 max-w-[calc(100vw-2.5rem)] opacity-0 transition-opacity duration-150 group-hover/bar:opacity-100 group-focus-visible/bar:opacity-100 ${posCls}" style="bottom:calc(${pct}% + 12px)" aria-hidden="true">
    <div class="rounded-xl border border-stone-200 bg-white p-3 shadow-xl">
      <div class="flex items-center justify-between gap-2">
        <p class="truncate text-[10px] font-bold uppercase tracking-wider text-stone-500">${esc(bar.fullLabel)}</p>
        <span class="shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-700">${mode === 'daily' ? 'Day' : 'Month'}</span>
      </div>
      <p class="mt-1 text-lg font-extrabold leading-tight tabular-nums text-stone-900">${money(bar.cents)}</p>
      <p class="text-[10px] font-semibold text-stone-400">Total sales</p>
      <dl class="mt-2 space-y-1.5 border-t border-stone-100 pt-2">
        ${row('Orders', bar.ordersCount)}
        ${row('Paid', money(bar.paidCents))}
        ${row('Avg / order', bar.ordersCount ? money(avgOrderCents) : '-')}
        ${row('Share of period', `${sharePct}%`)}
      </dl>
      <p class="mt-2 border-t border-stone-100 pt-1.5 text-[10px] font-medium text-stone-400">Total sales ${money(
        totalCents
      )} &middot; ${totalOrders} ${totalOrders === 1 ? 'order' : 'orders'} this period</p>
    </div>
    <span class="absolute -bottom-1 h-2.5 w-2.5 rotate-45 border-b border-r border-stone-200 bg-white ${arrowCls}"></span>
  </div>`;
}

function toolbarHtml() {
  // Presets live in a single segmented track so their height (and the date
  // range beside them) always matches the refresh button exactly.
  const chipOn = 'bg-white text-red-700 shadow-sm ring-1 ring-stone-200';
  const chipOff = 'text-stone-600 hover:text-stone-900';
  return `
    <div class="card p-3">
      <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div class="flex flex-wrap items-center gap-2.5">
          <div class="inline-flex h-11 items-center gap-1 rounded-xl bg-stone-100 p-1" role="group" aria-label="Quick date ranges">
            ${PRESETS.map(
              (p) =>
                `<button type="button" data-range="${p.key}" aria-pressed="${
                  preset === p.key
                }" class="inline-flex h-9 items-center whitespace-nowrap rounded-lg px-3 text-sm font-bold transition-colors ${
                  preset === p.key ? chipOn : chipOff
                }">${esc(p.label)}</button>`
            ).join('')}
          </div>
          <div class="date-range">
            <label class="sr-only" for="dash-from">From date</label>
            <input id="dash-from" type="date" class="date-input" value="${esc(range.from)}">
            <span class="shrink-0 px-1 text-xs font-semibold text-stone-400" aria-hidden="true">&ndash;</span>
            <label class="sr-only" for="dash-to">To date</label>
            <input id="dash-to" type="date" class="date-input" value="${esc(range.to)}">
          </div>
        </div>
        <button type="button" data-action="refresh" class="btn btn-secondary h-11 w-full self-stretch px-4 text-sm sm:w-auto sm:self-start xl:self-center">
          ${icon('refresh', 'h-4 w-4')} Refresh
        </button>
      </div>
    </div>`;
}

function deltaBadgeHtml() {
  if (!previous || !report) return '';
  const cur = report.summary.grossCents;
  const prev = previous.grossCents;
  if (prev <= 0) {
    return cur > 0
      ? `<span class="inline-flex items-center rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold text-stone-500">No prior sales</span>`
      : '';
  }
  const pct = ((cur - prev) / prev) * 100;
  const up = pct >= 0;
  const days = dayCount(range.from, range.to);
  const label = days === 1 ? 'vs previous day' : `vs previous ${days} days`;
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
    up ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
  }">${up ? '\u2191' : '\u2193'} ${Math.abs(pct).toFixed(1)}%</span>
    <span class="text-[11px] font-semibold text-stone-400">${esc(label)}</span>`;
}

function paymentRow(label, dotCls, count, cents, sharePct, tone = 'text-stone-900') {
  return `<div class="flex items-center gap-2.5">
    <span class="h-2 w-2 shrink-0 rounded-full ${dotCls}"></span>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold text-stone-700">${esc(label)}</p>
      <p class="text-[11px] font-medium text-stone-400">${count} ${count === 1 ? 'order' : 'orders'}</p>
    </div>
    <div class="shrink-0 text-right">
      <p class="text-sm font-extrabold tabular-nums ${tone}">${money(cents)}</p>
      <p class="text-[11px] font-semibold text-stone-400">${sharePct}%</p>
    </div>
  </div>`;
}

/** Full range with years, e.g. "Nov 1, 2026 - Nov 14, 2026". */
function fullRangeLabel() {
  if (range.from === range.to) return `${fmtDayLabel(range.from)}, ${range.from.slice(0, 4)}`;
  return `${fmtDayLabel(range.from)}, ${range.from.slice(0, 4)} - ${fmtDayLabel(range.to)}, ${range.to.slice(0, 4)}`;
}

/**
 * Integer percentages that always add up to 100 (largest-remainder method),
 * so the payment split never shows a 99% or 101% total.
 */
function percentLabels(values) {
  const total = values.reduce((sum, value) => sum + Math.max(0, value || 0), 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((value) => (Math.max(0, value || 0) / total) * 100);
  const labels = raw.map(Math.floor);
  const remaining = 100 - labels.reduce((sum, value) => sum + value, 0);
  const byFraction = raw
    .map((value, index) => ({ index, fraction: value - labels[index] }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < remaining; i += 1) labels[byFraction[i % byFraction.length].index] += 1;
  return labels;
}

/**
 * Hero total-sales card with the sales chart, beside a slim sidebar that
 * stacks the top performing foods above the payment-method split.
 */
function summaryHtml() {
  const sum = report.summary;
  const cashCount = sum.cashCount || 0;
  const onlineCount = sum.onlineCount || 0;
  const otherPaidCount = sum.otherPaidCount || 0;
  const paidCount = sum.paidCount != null ? sum.paidCount : cashCount + onlineCount + otherPaidCount;
  const unpaidCount =
    sum.unpaidCount != null ? sum.unpaidCount : Math.max(0, (sum.ordersCount || 0) - paidCount);

  const parts = [
    { label: 'Cash', color: 'bg-emerald-500', count: cashCount, cents: sum.cashCents || 0, tone: 'text-stone-900' },
    { label: 'Online', color: 'bg-sky-500', count: onlineCount, cents: sum.onlineCents || 0, tone: 'text-stone-900' },
    ...(otherPaidCount > 0
      ? [
          {
            label: 'Other paid',
            color: 'bg-stone-500',
            count: otherPaidCount,
            cents: sum.otherPaidCents || 0,
            tone: 'text-stone-900',
          },
        ]
      : []),
    { label: 'Unpaid', color: 'bg-red-500', count: unpaidCount, cents: sum.unpaidCents || 0, tone: 'text-red-700' },
  ];
  const partsTotal = parts.reduce((total, part) => total + part.cents, 0);
  const labels = percentLabels(parts.map((part) => part.cents));

  // Exact widths (not rounded) so the stacked bar is always completely filled.
  const barHtml = parts
    .map(
      (part) =>
        `<div class="${part.color}" style="width:${partsTotal > 0 ? (part.cents / partsTotal) * 100 : 0}%" title="${esc(
          part.label
        )} ${esc(money(part.cents))}"></div>`
    )
    .join('');
  const rowsHtml = parts
    .map((part, index) => paymentRow(part.label, part.color, part.count, part.cents, labels[index], part.tone))
    .join('');

  return `
    <div class="grid gap-5 xl:grid-cols-3">
      <div class="card relative flex flex-col xl:col-span-2">
        <div class="flex flex-wrap items-start justify-between gap-3 p-5">
          <div class="min-w-0">
            <p class="text-xs font-bold uppercase tracking-wider text-stone-500">Total Sales</p>
            <p class="mt-2.5 text-4xl font-extrabold tracking-tight text-stone-900">${money(sum.grossCents)}</p>
            <p class="mt-1.5 text-sm font-medium text-stone-500">${sum.ordersCount} orders &middot; ${sum.itemsSold} items sold</p>
            <p class="mt-1 text-xs font-semibold text-stone-400">${esc(fullRangeLabel())}</p>
          </div>
          <div class="flex flex-col items-end gap-1.5 text-right">${deltaBadgeHtml()}</div>
        </div>
        <div class="mt-auto">${salesChartHtml()}</div>
      </div>

      <div class="flex min-h-0 flex-col gap-5">
        ${topItemsHtml()}

        <div class="card shrink-0 p-4">
          <div class="flex items-center gap-2.5">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-red-50 text-red-700">${icon('cash', 'w-4 h-4')}</span>
            <div>
              <h2 class="text-sm font-extrabold leading-tight">Payment Method</h2>
              <p class="text-[11px] font-medium text-stone-500">Split of total sales</p>
            </div>
          </div>
          <div class="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-stone-100">${barHtml}</div>
          <div class="mt-3 space-y-3">${rowsHtml}</div>
        </div>
      </div>
    </div>`;
}

function chartStat(label, value) {
  return `<div class="min-w-0">
    <p class="text-[10px] font-bold uppercase tracking-wider text-stone-400">${esc(label)}</p>
    <p class="mt-0.5 truncate text-sm font-bold text-stone-800">${esc(value)}</p>
  </div>`;
}

/**
 * Sales chart that sits inside the Total Sales card: daily or monthly bars,
 * with one detail card per bar that opens on hover or keyboard focus.
 */
function salesChartHtml() {
  const mode = resolvedChartMode();
  const bars = chartSeries(mode);
  const unit = mode === 'daily' ? 'day' : 'month';

  const head = `
    <div class="flex flex-wrap items-center justify-between gap-3 border-y border-stone-200 px-5 py-3.5">
      <div class="flex items-center gap-2.5">
        <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-red-50 text-red-700">${icon('chart', 'w-5 h-5')}</span>
        <div>
          <h2 class="text-base font-extrabold leading-tight">Sales Overview</h2>
          <p class="text-xs font-medium text-stone-500">Sales per ${unit} &middot; ${esc(
    rangeLabel()
  )} &middot; hover a bar for details</p>
        </div>
      </div>
      <div class="seg w-40">
        <button type="button" data-chart-mode="daily" data-focus-key="chart-mode-daily" class="seg-btn ${
          mode === 'daily' ? 'seg-btn-active' : ''
        }">Daily</button>
        <button type="button" data-chart-mode="monthly" data-focus-key="chart-mode-monthly" class="seg-btn ${
          mode === 'monthly' ? 'seg-btn-active' : ''
        }">Monthly</button>
      </div>
    </div>`;

  const totalCents = bars.reduce((sum, bar) => sum + bar.cents, 0);
  const totalOrders = bars.reduce((sum, bar) => sum + bar.ordersCount, 0);
  if (!bars.length || totalCents <= 0) {
    return `${head}<p class="px-5 py-16 text-center font-semibold text-stone-500">No sales recorded in this period.</p>`;
  }

  const maxBar = bars.reduce((peak, bar) => Math.max(peak, bar.cents), 0);
  const scaleMax = niceMax(maxBar);
  const pctOf = (cents) => Math.max(0, Math.round((cents / scaleMax) * 1000) / 10);
  const showValueLabels = bars.length <= 14;
  const step = Math.max(1, Math.ceil(bars.length / 12));

  const columns = bars
    .map((bar, index) => {
      const p = pctOf(bar.cents);
      // Labels sit above short bars and flip inside tall ones so they never
      // escape the chart frame; the hover card takes their place once shown.
      const valueLabel =
        !showValueLabels || bar.cents <= 0
          ? ''
          : p >= 88
            ? `<div class="pointer-events-none absolute inset-x-0 top-1.5 text-center text-[11px] font-bold text-white transition-opacity group-hover/bar:opacity-0 group-focus-visible/bar:opacity-0">${esc(pesoShort(bar.cents))}</div>`
            : `<div class="pointer-events-none absolute inset-x-0 text-center text-[11px] font-bold text-stone-700 transition-opacity group-hover/bar:opacity-0 group-focus-visible/bar:opacity-0" style="bottom:calc(${p}% + 4px)">${esc(pesoShort(bar.cents))}</div>`;
      const barDiv =
        bar.cents > 0
          ? `<div class="absolute bottom-0 left-1/2 w-[86%] max-w-[42px] -translate-x-1/2 rounded-t-md bg-red-700 transition-colors group-hover/bar:bg-red-600" style="height:${p}%"></div>`
          : `<div class="absolute bottom-0 left-1/2 w-[86%] max-w-[42px] -translate-x-1/2 rounded-full bg-stone-300" style="height:3px"></div>`;
      const tip = barTipHtml(bar, index, bars.length, mode, totalCents, totalOrders, p);
      return `<div class="group/bar relative h-full min-w-0 flex-1 rounded-lg transition-colors hover:bg-red-50" tabindex="0" role="img" aria-label="${esc(
        barAriaLabel(bar, mode)
      )}">${barDiv}${valueLabel}${tip}</div>`;
    })
    .join('');

  const xLabels = bars
    .map((bar, index) => {
      const showLabel = index % step === 0 || index === bars.length - 1;
      return `<div class="min-w-0 flex-1 truncate text-center text-[11px] font-medium text-stone-500">${esc(showLabel ? bar.label : '')}</div>`;
    })
    .join('');

  const activeBars = bars.filter((bar) => bar.cents > 0).length;
  const bestBar = bars.reduce((best, bar) => (bar.cents > best.cents ? bar : best), bars[0]);

  const stats = `
    <div class="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-stone-100 bg-stone-50/60 px-5 py-3.5 sm:grid-cols-2">
      ${chartStat(`Best ${unit}`, `${bestBar.label} \u00B7 ${money(bestBar.cents)}`)}
      ${chartStat(`Active ${unit}s`, `${activeBars} of ${bars.length}`)}
    </div>`;

  return `${head}
    <div class="px-5 pb-5 pt-6" role="img" aria-label="Bar chart of sales per ${unit}">
      <div class="flex">
        <div class="flex w-14 shrink-0 flex-col justify-between pr-2 text-right text-[10px] font-semibold text-stone-400" style="height:240px">
          <span>${esc(pesoShort(scaleMax))}</span>
          <span>${esc(pesoShort(scaleMax / 2))}</span>
          <span>&#8369;0</span>
        </div>
        <div class="relative min-w-0 flex-1" style="height:240px">
          <div class="absolute inset-x-0 top-0 h-px bg-stone-100"></div>
          <div class="absolute inset-x-0 top-1/2 h-px bg-stone-100"></div>
          <div class="absolute inset-x-0 bottom-0 h-px bg-stone-300"></div>
          <div class="flex h-full items-end gap-[3px]">${columns}</div>
        </div>
      </div>
      <div class="mt-3 flex gap-[3px] pl-14">${xLabels}</div>
    </div>
    ${stats}`;
}

/**
 * Top performing foods: a compact ranked list for the right-hand sidebar.
 * Bars are scaled by sales (not rank) so a pricier item is not shown short.
 */
function topItemsHtml() {
  const items = (report.topItems || []).slice(0, 6);
  const head = `
    <div class="flex items-center gap-2.5 border-b border-stone-200 px-4 py-3">
      <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600">${icon('fire', 'w-4 h-4')}</span>
      <div class="min-w-0">
        <h2 class="text-sm font-extrabold leading-tight">Top performing foods</h2>
        <p class="truncate text-[11px] font-medium text-stone-500">Ranked by quantity sold &middot; ${esc(rangeLabel())}</p>
      </div>
    </div>`;

  if (!items.length) {
    return `<div class="card flex flex-col overflow-hidden">${head}<p class="px-4 py-10 text-center text-sm font-semibold text-stone-500">No items sold in this period.</p></div>`;
  }

  const topSales = Math.max(1, ...items.map((item) => item.salesCents || 0));
  const rows = items
    .map((item, index) => {
      const barPct = Math.max(4, Math.round((item.salesCents / topSales) * 100));
      const badgeCls =
        index === 0 ? 'bg-red-700 text-white' : index < 3 ? 'bg-stone-200 text-stone-700' : 'bg-stone-100 text-stone-400';
      return `<li class="flex items-center gap-2.5 px-4 py-2.5">
        <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${badgeCls}">${index + 1}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-2">
            <p class="truncate text-sm font-semibold text-stone-900">${esc(item.name)}</p>
            <p class="shrink-0 text-xs font-bold tabular-nums text-stone-900">${money(item.salesCents)}</p>
          </div>
          <div class="mt-1 flex items-center gap-2">
            <div class="h-1.5 min-w-0 flex-1 rounded-full bg-stone-100"><div class="h-full rounded-full bg-red-600" style="width:${barPct}%"></div></div>
            <p class="shrink-0 text-[11px] font-semibold text-stone-400">${item.quantity} sold</p>
          </div>
        </div>
      </li>`;
    })
    .join('');

  return `<div class="card flex min-h-0 flex-1 flex-col overflow-hidden">
    ${head}
    <ul class="min-h-0 flex-1 divide-y divide-stone-100 overflow-y-auto no-scrollbar">${rows}</ul>
  </div>`;
}

/**
 * Admin-only read-only card: who from the cashier and kitchen teams claimed a
 * free meal today. The amounts are never part of sales, so only counts and
 * dishes are shown here.
 */
function staffMealsHtml() {
  const head = `
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-5 py-3.5">
      <div class="flex items-center gap-2.5">
        <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-stone-100 text-stone-700">${icon('users', 'w-5 h-5')}</span>
        <div>
          <h2 class="text-base font-extrabold leading-tight">Staff meals today</h2>
          <p class="text-xs font-medium text-stone-500">Free meals claimed by cashier and kitchen staff &middot; not counted as sales</p>
        </div>
      </div>
      <a href="#/staff-meals" class="btn btn-secondary btn-sm">
        View all ${icon('arrowRight', 'w-4 h-4')}
      </a>
    </div>`;

  if (!staffMeals) {
    return `<div class="card overflow-hidden">${head}<p class="px-5 py-6 text-center text-sm font-semibold text-stone-500">Could not load staff meals.</p></div>`;
  }

  const meals = staffMeals.meals || [];
  const summary = staffMeals.summary || {};
  const shown = meals.slice(0, 6);
  const stat = (label, value, tone) => `
    <div class="rounded-xl border border-stone-200 px-3 py-2">
      <p class="text-[10px] font-bold uppercase tracking-wider text-stone-400">${esc(label)}</p>
      <p class="mt-0.5 text-xl font-extrabold ${tone}">${value}</p>
    </div>`;

  const rows = shown
    .map(
      (meal) => `<li class="flex flex-wrap items-center gap-2 px-5 py-2.5">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-bold">${esc(meal.staffName)}</p>
          <p class="text-xs font-semibold text-stone-500">
            ${meal.staffRole === 'kitchen' ? 'Kitchen' : 'Cashier'} &middot; ${esc(fmtTime(meal.createdAt))}
          </p>
        </div>
        <div class="flex flex-wrap justify-end gap-1.5">
          ${meal.items
            .map(
              (item) =>
                `<span class="badge bg-stone-100 text-stone-700">${item.quantity}x ${esc(item.name)}</span>`
            )
            .join('')}
        </div>
      </li>`
    )
    .join('');

  return `<div class="card overflow-hidden">
    ${head}
    <div class="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
      ${stat('Meals', summary.totalMeals || 0, 'text-stone-900')}
      ${stat('Cashier', summary.cashierMeals || 0, 'text-indigo-700')}
      ${stat('Kitchen', summary.kitchenMeals || 0, 'text-sky-700')}
      ${stat('Unique staff', summary.uniqueStaff || 0, 'text-emerald-700')}
    </div>
    ${
      shown.length
        ? `<ul class="divide-y divide-stone-100 border-t border-stone-100">${rows}</ul>
           ${
             meals.length > shown.length
               ? `<p class="border-t border-stone-100 px-5 py-2 text-center text-xs font-semibold text-stone-500">+${meals.length - shown.length} more today &middot; open Staff Meals for the full list</p>`
               : ''
           }`
        : `<div class="border-t border-stone-100">${emptyState(
            'bowl',
            'No staff meals today',
            'Cashier and kitchen staff have not claimed a free meal yet.',
            '',
            { compact: true }
          )}</div>`
    }
  </div>`;
}

function render(quiet) {
  if (!rootEl) return;

  const html = `
    <div class="space-y-5">
      ${toolbarHtml()}
      ${
        loading || !report
          ? `<div class="card">${pageLoader('Loading sales...')}</div>`
          : `${summaryHtml()}${staffMealsHtml()}`
      }
    </div>`;

  if (quiet) renderPreservingFocus(rootEl, html);
  else rootEl.innerHTML = html;
}

function rangeLabel() {
  if (range.from === range.to) return fmtDayLabel(range.from) + ', ' + range.from.slice(0, 4);
  return `${fmtDayLabel(range.from)} to ${fmtDayLabel(range.to)}`;
}

function handleClick(event) {
  const modeBtn = event.target.closest('[data-chart-mode]');
  if (modeBtn) {
    chartMode = modeBtn.getAttribute('data-chart-mode');
    // Quiet re-render keeps the pressed toggle focused (data-focus-key).
    render(true);
    return;
  }
  const presetBtn = event.target.closest('[data-range]');
  if (presetBtn) {
    preset = presetBtn.getAttribute('data-range');
    range = presetRange(preset);
    chartMode = null;
    load(false);
    return;
  }
  if (event.target.closest('[data-action="refresh"]')) {
    load(false);
    return;
  }
}

function handleChange(event) {
  if (event.target.id === 'dash-from') {
    range.from = event.target.value || todayLocalStr();
    if (range.to < range.from) range.to = range.from;
    preset = null;
    chartMode = null;
    load(false);
  }
  if (event.target.id === 'dash-to') {
    range.to = event.target.value || todayLocalStr();
    if (range.to < range.from) range.from = range.to;
    preset = null;
    chartMode = null;
    load(false);
  }
}
