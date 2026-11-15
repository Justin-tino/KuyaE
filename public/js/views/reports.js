// Admin: sales reports with PDF download.

import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { downloadSalesReportPdf } from '../components.js';
import {
  esc,
  money,
  toast,
  pageLoader,
  fmtDayLabel,
  fmtDateTime,
  todayLocalStr,
  renderPreservingFocus,
} from '../ui.js';

let range = { from: todayLocalStr(), to: todayLocalStr() };
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
          <div class="flex flex-wrap items-end gap-3">
            <div>
              <label class="label" for="report-from">From</label>
              <input id="report-from" type="date" class="input" value="${esc(range.from)}">
            </div>
            <div>
              <label class="label" for="report-to">To</label>
              <input id="report-to" type="date" class="input" value="${esc(range.to)}">
            </div>
          </div>
          <div class="flex flex-wrap items-end gap-3">
            <button type="button" data-action="download" class="btn btn-md btn-primary" ${!report || loading ? 'disabled' : ''}>
              ${icon('download', 'w-5 h-5')} Download as PDF
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
          <p class="text-2xl font-extrabold">Kuya E</p>
          <p class="text-sm text-stone-500">${esc(s.address || '')}${s.address && s.phone ? ' | ' : ''}${esc(s.phone || '')}</p>
        </div>
        <div class="ml-auto text-right">
          <p class="text-lg font-extrabold uppercase tracking-wide">Sales Report</p>
          <p class="text-sm font-semibold text-stone-500">${esc(rangeText())}</p>
          <p class="text-xs text-stone-400">Generated ${esc(fmtDateTime(report.generatedAt))}</p>
        </div>
      </div>

      <div class="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
        ${box('Gross Sales', money(sum.grossCents), `${sum.ordersCount} orders`)}
        ${box(
          'Collected',
          money(sum.paidCents),
          `${sum.paidCount != null ? sum.paidCount : sum.cashCount + sum.onlineCount + (sum.otherPaidCount || 0)} paid orders`
        )}
        ${box(
          'Uncollected',
          money(sum.unpaidCents),
          `${sum.unpaidCount != null ? `${sum.unpaidCount} ` : ''}unpaid orders`
        )}
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
                ${
                  sum.itemsSold
                    ? `<tr class="bg-stone-50">
                        <td colspan="2" class="td font-bold">All items</td>
                        <td class="td text-right font-bold">${sum.itemsSold}</td>
                        <td class="td text-right font-bold">${money(sum.itemsCents != null ? sum.itemsCents : sum.grossCents)}</td>
                      </tr>`
                    : ''
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
        Gross sales include unpaid orders. Collected is the paid portion of these orders.
      </p>
    </div>`;
}

function handleClick(event) {
  if (event.target.closest('[data-action="download"]')) {
    if (report) downloadSalesReportPdf(report);
  }
}

function handleChange(event) {
  if (event.target.id === 'report-from') {
    range.from = event.target.value || todayLocalStr();
    if (range.to < range.from) range.to = range.from;
    load(false);
  }
  if (event.target.id === 'report-to') {
    range.to = event.target.value || todayLocalStr();
    if (range.to < range.from) range.from = range.to;
    load(false);
  }
}
