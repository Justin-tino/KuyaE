// Admin: printable sales reports + CSV export.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { printSalesReport } from '../components.js';
import {
  esc,
  money,
  toast,
  pageLoader,
  fmtDayLabel,
  fmtDateTime,
  todayLocalStr,
  addDays,
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
let loading = true;
let rootEl = null;

export async function mount(container) {
  rootEl = container;
  container.innerHTML = pageLoader('Loading report...');
  const onClick = (event) => handleClick(event);
  const onChange = (event) => handleChange(event);
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  await load(false);
  return () => {
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
    const data = await api(`/reports/sales?from=${range.from}&to=${range.to}`);
    report = data;
    loading = false;
    render(quiet);
  } catch (err) {
    loading = false;
    render(true);
    toast(err.message, 'error');
  }
}

function rangeText() {
  if (range.from === range.to) return fmtDayLabel(range.from) + ', ' + range.from.slice(0, 4);
  return `${fmtDayLabel(range.from)}, ${range.from.slice(0, 4)} to ${fmtDayLabel(range.to)}, ${range.to.slice(0, 4)}`;
}

function render(quiet) {
  if (!rootEl) return;

  const html = `
    <div class="space-y-4">
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
              <label class="label" for="report-from">From</label>
              <input id="report-from" type="date" class="input" value="${esc(range.from)}">
            </div>
            <div>
              <label class="label" for="report-to">To</label>
              <input id="report-to" type="date" class="input" value="${esc(range.to)}">
            </div>
            <button type="button" data-action="print" class="btn btn-md btn-primary" ${!report || loading ? 'disabled' : ''}>
              ${icon('printer', 'w-5 h-5')} Print Report
            </button>
            <button type="button" data-action="csv" class="btn btn-md btn-secondary" ${!report || loading ? 'disabled' : ''}>
              ${icon('download', 'w-5 h-5')} Export CSV
            </button>
          </div>
        </div>
      </div>

      ${
        loading || !report
          ? `<div class="card">${pageLoader('Preparing report...')}</div>`
          : reportCardHtml()
      }
    </div>`;

  if (quiet) renderPreservingFocus(rootEl, html);
  else rootEl.innerHTML = html;
}

function reportCardHtml() {
  const s = state.settings || {};
  const sum = report.summary;

  const box = (label, value, sub = '') => `
    <div class="rounded-xl border border-stone-200 px-4 py-3">
      <p class="text-xs font-bold uppercase tracking-wide text-stone-500">${esc(label)}</p>
      <p class="mt-1 text-2xl font-extrabold">${value}</p>
      ${sub ? `<p class="text-xs font-semibold text-stone-500">${esc(sub)}</p>` : ''}
    </div>`;

  return `
    <div class="card p-5 sm:p-8">
      <div class="flex flex-wrap items-center gap-4 border-b-2 border-red-700 pb-4">
        <img src="/images/logo.png" alt="" class="h-14 w-14 object-contain">
        <div>
          <p class="text-2xl font-extrabold">${esc(s.restaurantName || 'Tapsilogan')}</p>
          <p class="text-sm text-stone-500">${esc(s.address || '')}${s.address && s.phone ? ' | ' : ''}${esc(s.phone || '')}</p>
        </div>
        <div class="ml-auto text-right">
          <p class="text-lg font-extrabold uppercase tracking-wide">Sales Report</p>
          <p class="text-sm font-semibold text-stone-500">${esc(rangeText())}</p>
          <p class="text-xs text-stone-400">Generated ${esc(fmtDateTime(report.generatedAt))}</p>
        </div>
      </div>

      <div class="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        ${box('Gross Sales', money(sum.grossCents), `${sum.ordersCount} orders`)}
        ${box('Collected', money(sum.paidCents), `${sum.cashCount + sum.onlineCount} paid orders`)}
        ${box('Uncollected', money(sum.unpaidCents), 'unpaid orders')}
        ${box('Average Order', money(sum.avgOrderCents), `${sum.itemsSold} items sold`)}
      </div>

      <div class="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        ${box('Cash', money(sum.cashCents), `${sum.cashCount} orders`)}
        ${box('Online', money(sum.onlineCents), `${sum.onlineCount} orders`)}
        ${box('Dine In', money(report.orderTypes.dineIn.totalCents), `${report.orderTypes.dineIn.count} orders`)}
        ${box('Take Out', money(report.orderTypes.takeOut.totalCents), `${report.orderTypes.takeOut.count} orders`)}
      </div>

      <div class="mt-6 grid gap-6 xl:grid-cols-2">
        <div>
          <h3 class="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">Daily Breakdown</h3>
          <div class="overflow-x-auto rounded-xl border border-stone-200">
            <table class="w-full">
              <thead class="bg-stone-50"><tr><th class="th">Date</th><th class="th text-right">Orders</th><th class="th text-right">Gross</th><th class="th text-right">Collected</th></tr></thead>
              <tbody>
                ${report.daily
                  .map(
                    (day) => `<tr class="border-b border-stone-100 last:border-0">
                      <td class="td">${esc(fmtDayLabel(day.date))}, ${esc(day.date.slice(0, 4))}</td>
                      <td class="td text-right">${day.ordersCount}</td>
                      <td class="td text-right font-semibold">${money(day.grossCents)}</td>
                      <td class="td text-right">${money(day.paidCents)}</td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">Top Items</h3>
          <div class="overflow-x-auto rounded-xl border border-stone-200">
            <table class="w-full">
              <thead class="bg-stone-50"><tr><th class="th">#</th><th class="th">Item</th><th class="th text-right">Qty</th><th class="th text-right">Sales</th></tr></thead>
              <tbody>
                ${
                  report.topItems.length
                    ? report.topItems
                        .map(
                          (item, index) => `<tr class="border-b border-stone-100 last:border-0">
                            <td class="td text-stone-400">${index + 1}</td>
                            <td class="td font-semibold">${esc(item.name)}</td>
                            <td class="td text-right">${item.quantity}</td>
                            <td class="td text-right font-bold">${money(item.salesCents)}</td>
                          </tr>`
                        )
                        .join('')
                    : '<tr><td colspan="4" class="td text-center text-stone-500">No items sold.</td></tr>'
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="mt-6">
        <h3 class="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">Staff Performance</h3>
        <div class="overflow-x-auto rounded-xl border border-stone-200">
          <table class="w-full">
            <thead class="bg-stone-50"><tr><th class="th">Staff</th><th class="th text-right">Orders</th><th class="th text-right">Sales</th></tr></thead>
            <tbody>
              ${
                report.staff.length
                  ? report.staff
                      .map(
                        (member) => `<tr class="border-b border-stone-100 last:border-0">
                          <td class="td font-semibold">${esc(member.name)}</td>
                          <td class="td text-right">${member.ordersCount}</td>
                          <td class="td text-right font-bold">${money(member.salesCents)}</td>
                        </tr>`
                      )
                      .join('')
                  : '<tr><td colspan="3" class="td text-center text-stone-500">No data.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>

      <p class="mt-5 text-xs text-stone-500">
        Cancelled orders are excluded from sales totals (${sum.cancelledCount} cancelled, ${money(sum.cancelledCents)}).
        Gross sales include unpaid orders. Collected is money actually received.
      </p>
    </div>`;
}

function handleClick(event) {
  const presetButton = event.target.closest('[data-preset]');
  if (presetButton) {
    applyPreset(presetButton.getAttribute('data-preset'));
    return;
  }
  if (event.target.closest('[data-action="print"]')) {
    if (report) printSalesReport(report);
    return;
  }
  if (event.target.closest('[data-action="csv"]')) {
    exportCsv();
  }
}

function handleChange(event) {
  if (event.target.id === 'report-from') {
    range.from = event.target.value || todayLocalStr();
    range.preset = 'custom';
    load(false);
  }
  if (event.target.id === 'report-to') {
    range.to = event.target.value || todayLocalStr();
    range.preset = 'custom';
    load(false);
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function exportCsv() {
  if (!report) return;
  const header = [
    'Order',
    'Date',
    'Time',
    'Customer',
    'Type',
    'Status',
    'Payment',
    'Method',
    'Total',
    'Cash Received',
    'Change',
    'Cashier',
  ];
  const rows = report.orders.map((order) => {
    const created = new Date(order.createdAt);
    return [
      order.numberLabel,
      new Intl.DateTimeFormat('en-CA', { timeZone: state.settings.timezone || 'Asia/Manila' }).format(created),
      new Intl.DateTimeFormat('en-PH', {
        timeZone: state.settings.timezone || 'Asia/Manila',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(created),
      order.customerName,
      order.orderType === 'dine_in' ? 'Dine In' : 'Take Out',
      order.status,
      order.paymentStatus,
      order.paymentMethod || '',
      (order.totalCents / 100).toFixed(2),
      order.cashReceivedCents === null ? '' : (order.cashReceivedCents / 100).toFixed(2),
      order.changeCents === null ? '' : (order.changeCents / 100).toFixed(2),
      order.createdByName || '',
    ];
  });

  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sales-${range.from}-to-${range.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('CSV file downloaded.', 'success');
}
