// Admin: sales dashboard.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { onTables } from '../realtime.js';
import { printSalesReport, statusBadge, paymentBadge, openOrderDetailsModal } from '../components.js';
import {
  esc,
  money,
  toast,
  pageLoader,
  fmtDayLabel,
  fmtTime,
  fmtDateTime,
  todayLocalStr,
  addDays,
  debounce,
  renderPreservingFocus,
} from '../ui.js';

const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7days', 'Last 7 Days'],
  ['month', 'This Month'],
];

let range = { from: todayLocalStr(), to: todayLocalStr(), preset: 'today' };
let report = null;
let week = null;
let loading = true;
let rootEl = null;

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading sales...');
  const onClick = (event) => handleClick(event);
  const onChange = (event) => handleChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  const off = onTables(['orders'], debounce(() => load(true), 600));
  await load(false);
  return () => {
    off();
    container.removeEventListener('click', onClick);
    container.removeEventListener('change', onChange);
  };
}

function applyPreset(preset) {
  const today = todayLocalStr();
  if (preset === 'today') range = { from: today, to: today, preset };
  else if (preset === 'yesterday') {
    const yesterday = addDays(today, -1);
    range = { from: yesterday, to: yesterday, preset };
  } else if (preset === '7days') range = { from: addDays(today, -6), to: today, preset };
  else if (preset === 'month') range = { from: today.slice(0, 7) + '-01', to: today, preset };
  load(false);
}

async function load(quiet) {
  if (!quiet) {
    loading = true;
    render();
  }
  try {
    const [main, weekData] = await Promise.all([
      api(`/reports/sales?from=${range.from}&to=${range.to}`),
      api(`/reports/sales?from=${addDays(todayLocalStr(), -6)}&to=${todayLocalStr()}`),
    ]);
    report = main;
    week = weekData;
    loading = false;
    render(quiet);
  } catch (err) {
    loading = false;
    render(true);
    toast(err.message, 'error');
  }
}

function statCard(label, value, sub, tone = 'text-stone-900') {
  return `<div class="card p-5">
    <p class="text-sm font-bold uppercase tracking-wide text-stone-500">${esc(label)}</p>
    <p class="mt-1 text-3xl font-extrabold ${tone}">${value}</p>
    ${sub ? `<p class="mt-1 text-sm font-semibold text-stone-500">${esc(sub)}</p>` : ''}
  </div>`;
}

function render(quiet) {
  if (!rootEl) return;

  const html = `
    <div class="space-y-5">
      <div class="card p-4">
        <div class="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div class="flex flex-wrap gap-2">
            ${PRESETS.map(
              ([value, label]) =>
                `<button type="button" data-preset="${value}" class="chip ${range.preset === value ? 'chip-active' : ''}">${label}</button>`
            ).join('')}
          </div>
          <div class="flex flex-wrap items-end gap-3">
            <div>
              <label class="label" for="dash-from">From</label>
              <input id="dash-from" type="date" class="input" value="${esc(range.from)}">
            </div>
            <div>
              <label class="label" for="dash-to">To</label>
              <input id="dash-to" type="date" class="input" value="${esc(range.to)}">
            </div>
            <button type="button" data-action="refresh" class="btn btn-md btn-secondary">${icon('refresh', 'w-5 h-5')} Refresh</button>
            <button type="button" data-action="print" class="btn btn-md btn-primary">${icon('printer', 'w-5 h-5')} Print Report</button>
          </div>
        </div>
      </div>

      ${
        loading || !report
          ? `<div class="card">${pageLoader('Loading sales...')}</div>`
          : `
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          ${statCard('Gross Sales', money(report.summary.grossCents), `${report.summary.ordersCount} orders`)}
          ${statCard('Collected', money(report.summary.paidCents), 'Paid orders', 'text-emerald-700')}
          ${statCard('Uncollected', money(report.summary.unpaidCents), 'Unpaid orders', 'text-red-700')}
          ${statCard('Average Order', money(report.summary.avgOrderCents), `${report.summary.itemsSold} items sold`)}
        </div>

        <div class="grid gap-5 xl:grid-cols-3">
          <div class="card p-5 xl:col-span-2">
            <div class="mb-4 flex items-center justify-between">
              <h2 class="text-lg font-extrabold">Last 7 Days</h2>
              <span class="text-sm font-semibold text-stone-500">Gross sales per day</span>
            </div>
            <div class="flex items-end gap-2 sm:gap-3">
              ${weekChartHtml()}
            </div>
          </div>

          <div class="card p-5">
            <h2 class="mb-4 text-lg font-extrabold">Payment Methods</h2>
            <div class="space-y-3">
              ${paymentRow('Cash', report.summary.cashCount, report.summary.cashCents)}
              ${paymentRow('Online', report.summary.onlineCount, report.summary.onlineCents)}
              ${paymentRow('Unpaid', null, report.summary.unpaidCents, 'text-red-700')}
            </div>
            <div class="mt-5 border-t border-stone-200 pt-4">
              <h3 class="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">Order Types</h3>
              <div class="space-y-2">
                ${paymentRow('Dine In', report.orderTypes.dineIn.count, report.orderTypes.dineIn.totalCents)}
                ${paymentRow('Take Out', report.orderTypes.takeOut.count, report.orderTypes.takeOut.totalCents)}
              </div>
            </div>
          </div>
        </div>

        <div class="grid gap-5 xl:grid-cols-2">
          <div class="card overflow-hidden">
            <div class="border-b border-stone-200 px-5 py-4">
              <h2 class="text-lg font-extrabold">Top Items</h2>
              <p class="text-sm font-semibold text-stone-500">${esc(rangeLabel())}</p>
            </div>
            ${
              report.topItems.length
                ? `<table class="w-full">
                    <thead class="bg-stone-50"><tr><th class="th">Item</th><th class="th text-right">Qty</th><th class="th text-right">Sales</th></tr></thead>
                    <tbody>
                      ${report.topItems
                        .slice(0, 8)
                        .map(
                          (item) => `<tr class="border-b border-stone-100 last:border-0">
                            <td class="td font-semibold">${esc(item.name)}</td>
                            <td class="td text-right">${item.quantity}</td>
                            <td class="td text-right font-bold">${money(item.salesCents)}</td>
                          </tr>`
                        )
                        .join('')}
                    </tbody>
                  </table>`
                : `<p class="px-5 py-10 text-center font-semibold text-stone-500">No items sold in this period.</p>`
            }
          </div>

          <div class="card overflow-hidden">
            <div class="flex items-center justify-between border-b border-stone-200 px-5 py-4">
              <h2 class="text-lg font-extrabold">Recent Orders</h2>
              <span class="text-sm font-semibold text-stone-500">Latest 8</span>
            </div>
            ${
              report.orders.length
                ? `<table class="w-full">
                    <thead class="bg-stone-50"><tr><th class="th">Order</th><th class="th">Customer</th><th class="th">Status</th><th class="th text-right">Total</th></tr></thead>
                    <tbody>
                      ${report.orders
                        .slice()
                        .reverse()
                        .slice(0, 8)
                        .map(
                          (order) => `<tr class="cursor-pointer border-b border-stone-100 hover:bg-stone-50 last:border-0" data-order="${order.id}">
                            <td class="td font-extrabold">${esc(order.numberLabel)}<span class="ml-2 text-sm font-semibold text-stone-500">${esc(fmtTime(order.createdAt))}</span></td>
                            <td class="td">${esc(order.customerName)}</td>
                            <td class="td"><div class="flex flex-wrap gap-1">${paymentBadge(order)}</div></td>
                            <td class="td text-right font-bold">${money(order.totalCents)}</td>
                          </tr>`
                        )
                        .join('')}
                    </tbody>
                  </table>`
                : `<p class="px-5 py-10 text-center font-semibold text-stone-500">No orders in this period.</p>`
            }
          </div>
        </div>

        <p class="text-center text-sm font-semibold text-stone-500">
          Updated ${esc(fmtDateTime(report.generatedAt))} - ${esc(state.settings ? state.settings.timezone : 'Asia/Manila')}
        </p>`
      }
    </div>`;

  if (quiet) renderPreservingFocus(rootEl, html);
  else rootEl.innerHTML = html;
}

function weekChartHtml() {
  if (!week || !week.daily.length) return '';
  const max = Math.max(...week.daily.map((day) => day.grossCents), 1);
  return week.daily
    .map((day) => {
      const height = Math.max(3, Math.round((day.grossCents / max) * 100));
      return `<div class="flex flex-1 flex-col items-center gap-1.5">
        <div class="flex h-36 w-full items-end">
          <div class="w-full rounded-t-lg bg-red-600/80" style="height:${height}%" title="${esc(money(day.grossCents))}"></div>
        </div>
        <p class="text-xs font-bold text-stone-500">${esc(fmtDayLabel(day.date))}</p>
        <p class="hidden text-xs font-semibold text-stone-700 sm:block">${esc(money(day.grossCents))}</p>
      </div>`;
    })
    .join('');
}

function paymentRow(label, count, cents, tone = 'text-stone-900') {
  return `<div class="flex items-center justify-between gap-3">
    <span class="font-semibold text-stone-600">${esc(label)}${count !== null && count !== undefined ? ` <span class="text-sm text-stone-400">(${count})</span>` : ''}</span>
    <span class="font-extrabold ${tone}">${money(cents)}</span>
  </div>`;
}

function rangeLabel() {
  if (range.from === range.to) return fmtDayLabel(range.from) + ', ' + range.from.slice(0, 4);
  return `${fmtDayLabel(range.from)} to ${fmtDayLabel(range.to)}`;
}

function handleClick(event) {
  const presetButton = event.target.closest('[data-preset]');
  if (presetButton) {
    applyPreset(presetButton.getAttribute('data-preset'));
    return;
  }
  if (event.target.closest('[data-action="refresh"]')) {
    load(false);
    return;
  }
  if (event.target.closest('[data-action="print"]')) {
    if (report) printSalesReport(report);
    return;
  }
  const orderRow = event.target.closest('[data-order]');
  if (orderRow && report) {
    const order = report.orders.find((entry) => entry.id === orderRow.getAttribute('data-order'));
    if (order) openOrderDetailsModal(order, { canManage: true, onChanged: () => load(true) });
  }
}

function handleChange(event) {
  if (event.target.id === 'dash-from') {
    range.from = event.target.value || todayLocalStr();
    range.preset = 'custom';
    load(false);
  }
  if (event.target.id === 'dash-to') {
    range.to = event.target.value || todayLocalStr();
    range.preset = 'custom';
    load(false);
  }
}
