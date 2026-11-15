// Shared UI components: badges, payment modal, order details, printouts.

import { api } from './api.js';
import { icon } from './icons.js';
import { state } from './state.js';
import { salesReportPdfBlob } from './pdf.js';
import {
  esc,
  money,
  fmtDateTime,
  openModal,
  closeAllModals,
  toast,
  withButtonLoading,
  reasonDialog,
  confirmDialog,
} from './ui.js';

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function statusBadge(status) {
  const map = {
    pending: ['Waiting', 'bg-amber-100 text-amber-900'],
    preparing: ['Cooking', 'bg-sky-100 text-sky-900'],
    served: ['Served', 'bg-emerald-100 text-emerald-900'],
    cancelled: ['Cancelled', 'bg-stone-200 text-stone-700'],
  };
  const [label, cls] = map[status] || [status, 'bg-stone-200 text-stone-700'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

export function paymentBadge(order) {
  if (order.status === 'cancelled') return '<span class="badge bg-stone-200 text-stone-700">Cancelled</span>';
  if (order.paymentStatus === 'paid') {
    const method =
      order.paymentMethod === 'cash' ? 'Cash' : order.paymentMethod === 'online' ? 'Online' : '';
    return `<span class="badge bg-emerald-100 text-emerald-900">Paid${method ? ' - ' + method : ''}</span>`;
  }
  return '<span class="badge bg-red-100 text-red-900">Unpaid</span>';
}

export function typeBadge(orderType) {
  return orderType === 'dine_in'
    ? '<span class="badge bg-indigo-100 text-indigo-900">Dine In</span>'
    : '<span class="badge bg-orange-100 text-orange-900">Take Out</span>';
}

export function typeLabel(orderType) {
  return orderType === 'dine_in' ? 'Dine In' : 'Take Out';
}

// ---------------------------------------------------------------------------
// Payment modal
// ---------------------------------------------------------------------------

/**
 * mode: 'create' -> choose Pay Now / Pay Later
 *       'pay'    -> settle an existing unpaid order
 * onSubmit(payload) must return a promise; the modal closes when it resolves.
 */
export function openPaymentModal({ mode = 'create', totalCents = 0, onSubmit, submitLabel }) {
  const ui = { choice: 'paid', method: 'cash', cash: '', reference: '', error: '' };

  const modal = openModal({
    title: mode === 'create' ? 'Receive Payment' : 'Mark Order as Paid',
    size: 'md',
    footer: `
      <button type="button" class="btn btn-lg btn-secondary" data-action="cancel">Cancel</button>
      <button type="button" class="btn btn-lg btn-success" data-action="confirm">
        ${esc(submitLabel || (mode === 'create' ? 'Complete Order' : 'Mark as Paid'))}
      </button>`,
  });

  function cashValues() {
    const cashCents = Math.round((parseFloat(ui.cash || '0') || 0) * 100);
    return { cashCents, diff: cashCents - totalCents, hasCash: ui.cash !== '' && !Number.isNaN(parseFloat(ui.cash)) };
  }

  function changeBoxHtml() {
    const { diff, hasCash } = cashValues();
    if (!hasCash) {
      return `<div class="flex items-center justify-between rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-stone-500">
        <span class="font-bold">Change</span>
        <span class="text-base font-bold">Enter cash received</span>
      </div>`;
    }
    const good = diff >= 0;
    return `<div class="flex items-center justify-between rounded-2xl border px-4 py-3 ${
      good ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-red-300 bg-red-50 text-red-900'
    }">
      <span class="text-base font-bold">${good ? 'Change' : 'Short by'}</span>
      <span class="text-2xl font-extrabold">${money(Math.abs(diff))}</span>
    </div>`;
  }

  function methodCard(value, label, iconName, hint) {
    const active = ui.method === value;
    return `<button type="button" data-action="method" data-method="${value}"
      class="flex flex-col items-center gap-0.5 rounded-2xl border-2 px-3 py-3 transition-colors ${
        active ? 'border-red-700 bg-red-50 text-red-800' : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50'
      }">
      ${icon(iconName, 'w-6 h-6')}
      <span class="text-base font-bold">${esc(label)}</span>
      <span class="text-xs font-semibold text-stone-500">${esc(hint)}</span>
    </button>`;
  }

  function choiceCard(value, label, iconName, hint) {
    const active = ui.choice === value;
    return `<button type="button" data-action="choice" data-choice="${value}"
      class="flex flex-col items-center gap-0.5 rounded-2xl border-2 px-3 py-3 transition-colors ${
        active ? 'border-red-700 bg-red-50 text-red-800' : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50'
      }">
      ${icon(iconName, 'w-6 h-6')}
      <span class="text-base font-bold">${esc(label)}</span>
      <span class="text-xs font-semibold text-stone-500">${esc(hint)}</span>
    </button>`;
  }

  function render() {
    const { diff, hasCash } = cashValues();
    modal.setBody(`
      <div class="space-y-4">
        <div class="flex items-center justify-between rounded-2xl bg-stone-100 px-4 py-3">
          <span class="text-base font-bold text-stone-600">Total to pay</span>
          <span class="text-2xl font-extrabold text-stone-900">${money(totalCents)}</span>
        </div>

        ${
          mode === 'create'
            ? `<div class="grid grid-cols-2 gap-3">
                ${choiceCard('paid', 'Pay Now', 'check', 'Collect payment')}
                ${choiceCard('pending', 'Pay Later', 'clock', 'Save as unpaid')}
              </div>`
            : ''
        }

        ${
          ui.choice === 'paid'
            ? `<div>
                <p class="label">Payment method</p>
                <div class="grid grid-cols-2 gap-3">
                  ${methodCard('cash', 'Cash', 'cash', 'Cash received')}
                  ${methodCard('online', 'Online', 'phone', 'GCash / bank / card')}
                </div>
              </div>
              ${
                ui.method === 'cash'
                  ? `<div class="space-y-3">
                      <label class="label" for="pay-cash">Cash received</label>
                      <input id="pay-cash" data-input="cash" data-focus-key="pay-cash" type="number" inputmode="decimal"
                        step="0.01" min="0" value="${esc(ui.cash)}"
                        class="input input-lg text-right text-2xl font-bold" placeholder="0.00">
                      <div class="flex flex-wrap gap-2">
                        ${[
                          ['Exact', totalCents / 100],
                          ['100', 100],
                          ['200', 200],
                          ['500', 500],
                          ['1000', 1000],
                        ]
                          .map(
                            ([label, amount]) =>
                              `<button type="button" class="chip" data-action="amount" data-amount="${amount}">${
                                label === 'Exact' ? 'Exact' : money(Math.round(amount * 100))
                              }</button>`
                          )
                          .join('')}
                      </div>
                      <div data-box="change">${changeBoxHtml()}</div>
                    </div>`
                  : `<div class="space-y-3">
                      <label class="label" for="pay-ref">Reference number (optional)</label>
                      <input id="pay-ref" data-input="reference" data-focus-key="pay-ref" type="text" maxlength="60"
                        value="${esc(ui.reference)}" class="input input-lg" placeholder="e.g. GCash reference">
                      <div class="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sky-900">
                        <p class="font-semibold">Check your online wallet or bank app first.</p>
                        <p class="text-sm">Only mark as paid once the money is confirmed received.</p>
                      </div>
                    </div>`
              }`
            : `<div class="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 text-amber-900">
                <p class="text-lg font-bold">This order will be saved as UNPAID.</p>
                <p class="mt-1">You can settle it anytime under Pending Payments.</p>
              </div>`
        }

        ${
          ui.error
            ? `<div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-800">${esc(ui.error)}</div>`
            : ''
        }
      </div>`);

    // Keep the change box fresh without losing the caret.
    if (ui.choice === 'paid' && ui.method === 'cash' && hasCash) {
      const box = modal.body.querySelector('[data-box="change"]');
      if (box) box.innerHTML = changeBoxHtml();
    }
    void diff;
  }

  function fail(message) {
    ui.error = message;
    render();
  }

  modal.root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'cancel') {
      modal.close();
      return;
    }
    if (action === 'choice') {
      ui.choice = target.getAttribute('data-choice');
      ui.error = '';
      render();
      return;
    }
    if (action === 'method') {
      ui.method = target.getAttribute('data-method');
      ui.error = '';
      render();
      return;
    }
    if (action === 'amount') {
      const amount = Number(target.getAttribute('data-amount'));
      ui.cash = amount.toFixed(2);
      ui.error = '';
      render();
      const input = modal.body.querySelector('[data-input="cash"]');
      if (input) input.focus();
      return;
    }
    if (action === 'confirm') {
      submit(target);
    }
  });

  modal.root.addEventListener('input', (event) => {
    const input = event.target.closest('[data-input]');
    if (!input) return;
    const field = input.getAttribute('data-input');
    if (field === 'cash') {
      ui.cash = input.value;
      const box = modal.body.querySelector('[data-box="change"]');
      if (box) box.innerHTML = changeBoxHtml();
    } else if (field === 'reference') {
      ui.reference = input.value;
    }
  });

  async function submit(button) {
    ui.error = '';
    const { cashCents } = cashValues();
    let payload;
    if (ui.choice === 'paid') {
      if (ui.method === 'cash') {
        if (ui.cash === '' || Number.isNaN(parseFloat(ui.cash))) {
          fail('Enter the cash received from the customer.');
          return;
        }
        if (cashCents < totalCents) {
          fail('Cash received is less than the total.');
          return;
        }
        payload = { status: 'paid', method: 'cash', cashReceived: cashCents / 100, reference: '' };
      } else {
        payload = { status: 'paid', method: 'online', cashReceived: null, reference: ui.reference.trim() };
      }
    } else {
      payload = { status: 'pending', method: null, cashReceived: null, reference: '' };
    }

    await withButtonLoading(button, 'Saving...', async () => {
      try {
        await onSubmit(payload);
        modal.close();
      } catch (err) {
        fail(err.message || 'Could not save the payment.');
      }
    });
  }

  render();
  setTimeout(() => {
    const input = modal.body.querySelector('[data-input="cash"]');
    if (input) input.focus();
  }, 60);
  return modal;
}

// ---------------------------------------------------------------------------
// Order details
// ---------------------------------------------------------------------------

export function itemsListHtml(order) {
  return `
    <table class="w-full">
      <thead>
        <tr class="border-b border-stone-200">
          <th class="th">Item</th>
          <th class="th text-center">Qty</th>
          <th class="th text-right">Price</th>
          <th class="th text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${order.items
          .map(
            (item) => `
          <tr class="border-b border-stone-100 last:border-0">
            <td class="td font-semibold">${esc(item.name)}</td>
            <td class="td text-center">${item.quantity}</td>
            <td class="td text-right whitespace-nowrap">${money(item.unitPriceCents)}</td>
            <td class="td text-right font-bold whitespace-nowrap">${money(item.lineTotalCents)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function paymentInfoHtml(order) {
  if (order.paymentStatus === 'paid') {
    return `
      <div class="space-y-2 rounded-xl bg-emerald-50 px-4 py-3 text-emerald-900">
        <div class="flex items-center justify-between"><span class="font-semibold">Status</span><span class="font-bold">Paid</span></div>
        <div class="flex items-center justify-between"><span class="font-semibold">Method</span><span class="font-bold">${
          order.paymentMethod === 'cash' ? 'Cash' : order.paymentMethod === 'online' ? 'Online' : '-'
        }</span></div>
        ${
          order.paymentMethod === 'cash' && order.cashReceivedCents !== null
            ? `<div class="flex items-center justify-between"><span class="font-semibold">Cash received</span><span class="font-bold">${money(
                order.cashReceivedCents
              )}</span></div>
               <div class="flex items-center justify-between"><span class="font-semibold">Change</span><span class="font-bold">${money(
                 order.changeCents || 0
               )}</span></div>`
            : ''
        }
        ${order.reference ? `<div class="flex items-center justify-between gap-4"><span class="font-semibold">Reference</span><span class="font-bold break-all text-right">${esc(order.reference)}</span></div>` : ''}
        ${
          order.paidAt
            ? `<div class="flex items-center justify-between"><span class="font-semibold">Paid at</span><span class="font-bold">${esc(
                fmtDateTime(order.paidAt)
              )}</span></div>`
            : ''
        }
        ${order.paidByName ? `<div class="flex items-center justify-between"><span class="font-semibold">Received by</span><span class="font-bold">${esc(order.paidByName)}</span></div>` : ''}
      </div>`;
  }
  return `
    <div class="rounded-xl bg-red-50 px-4 py-3 text-red-900">
      <p class="text-lg font-bold">Unpaid</p>
      <p class="text-sm">Collect ${money(order.totalCents)} from the customer.</p>
    </div>`;
}

export function openOrderDetailsModal(order, { canManage = false, onChanged } = {}) {
  const canPay = canManage && order.paymentStatus === 'pending' && order.status !== 'cancelled';
  const canCancel = canManage && ['pending', 'preparing'].includes(order.status);

  const modal = openModal({
    title: `Order ${order.numberLabel}`,
    size: 'lg',
    content: `
      <div class="space-y-5">
        <div class="flex flex-wrap items-center gap-2">
          ${statusBadge(order.status)}
          ${paymentBadge(order)}
          ${typeBadge(order.orderType)}
          <span class="text-stone-500 font-semibold">${esc(fmtDateTime(order.createdAt))}</span>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-xl border border-stone-200 px-4 py-3">
            <p class="text-sm font-bold uppercase tracking-wide text-stone-500">Customer</p>
            <p class="text-lg font-bold">${esc(order.customerName)}</p>
          </div>
          <div class="rounded-xl border border-stone-200 px-4 py-3">
            <p class="text-sm font-bold uppercase tracking-wide text-stone-500">Received by</p>
            <p class="text-lg font-bold">${esc(order.createdByName || '-')}</p>
          </div>
        </div>

        ${order.notes ? `<div class="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"><p class="text-sm font-bold uppercase tracking-wide">Notes</p><p class="text-lg font-semibold">${esc(order.notes)}</p></div>` : ''}
        ${order.status === 'cancelled' ? `<div class="rounded-xl border border-stone-300 bg-stone-100 px-4 py-3"><p class="text-sm font-bold uppercase tracking-wide text-stone-500">Cancellation reason</p><p class="font-semibold">${esc(order.cancelReason || 'No reason recorded')}</p></div>` : ''}

        <div class="rounded-xl border border-stone-200">
          ${itemsListHtml(order)}
        </div>

        <div class="flex items-center justify-between rounded-xl bg-stone-100 px-5 py-4">
          <span class="text-lg font-bold">Total</span>
          <span class="text-3xl font-extrabold">${money(order.totalCents)}</span>
        </div>

        ${paymentInfoHtml(order)}

        <div class="grid gap-2 text-sm text-stone-600 sm:grid-cols-2">
          <p><span class="font-semibold">Received:</span> ${esc(fmtDateTime(order.createdAt))}</p>
          ${order.startedAt ? `<p><span class="font-semibold">Cooking started:</span> ${esc(fmtDateTime(order.startedAt))}</p>` : ''}
          ${order.servedAt ? `<p><span class="font-semibold">Served:</span> ${esc(fmtDateTime(order.servedAt))}${order.servedByName ? ' by ' + esc(order.servedByName) : ''}</p>` : ''}
          ${order.cancelledAt ? `<p><span class="font-semibold">Cancelled:</span> ${esc(fmtDateTime(order.cancelledAt))}</p>` : ''}
        </div>
      </div>`,
    footer: `
      <button type="button" class="btn btn-lg btn-secondary" data-action="print">${icon('printer', 'w-5 h-5')} Print Receipt</button>
      ${canPay ? `<button type="button" class="btn btn-lg btn-success" data-action="pay">${icon('cash', 'w-5 h-5')} Mark as Paid</button>` : ''}
      ${canCancel ? `<button type="button" class="btn btn-lg btn-danger" data-action="cancel-order">${icon('ban', 'w-5 h-5')} Cancel Order</button>` : ''}
      <button type="button" class="btn btn-lg btn-primary" data-action="close">Close</button>`,
  });

  modal.footer.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');

    if (action === 'close') {
      modal.close();
      return;
    }
    if (action === 'print') {
      printReceipt(order);
      return;
    }
    if (action === 'pay') {
      openPaymentModal({
        mode: 'pay',
        totalCents: order.totalCents,
        onSubmit: async (payload) => {
          await api(`/orders/${order.id}/pay`, { method: 'POST', body: payload });
          toast('Payment recorded.', 'success');
          modal.close();
          if (onChanged) onChanged();
        },
      });
      return;
    }
    if (action === 'cancel-order') {
      const reason = await reasonDialog({
        title: `Cancel order ${order.numberLabel}?`,
        message: 'The kitchen will stop preparing this order. This cannot be undone.',
        label: 'Reason for cancelling',
        confirmLabel: 'Cancel Order',
      });
      if (!reason) return;
      try {
        await api(`/orders/${order.id}/cancel`, { method: 'POST', body: { reason } });
        toast('Order cancelled.', 'success');
        modal.close();
        if (onChanged) onChanged();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  return modal;
}

// ---------------------------------------------------------------------------
// Printing & PDF downloads
// ---------------------------------------------------------------------------

export function printHtmlDocument(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  const doPrint = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (err) {
      console.error('[print]', err);
    }
    setTimeout(() => frame.remove(), 90000);
  };
  if (doc.readyState === 'complete') setTimeout(doPrint, 350);
  else frame.onload = () => setTimeout(doPrint, 350);
}

function settingsHeader(settings) {
  const s = settings || {};
  return `
    <div class="center"><img src="/images/logo.png" alt="" class="logo"></div>
    <div class="center shop-name">${esc(s.restaurantName || 'Tapsilogan')}</div>
    ${s.address ? `<div class="center small">${esc(s.address)}</div>` : ''}
    ${s.phone ? `<div class="center small">${esc(s.phone)}</div>` : ''}`;
}

export function receiptHtml(order, settings) {
  const s = settings || {};
  const items = order.items
    .map(
      (item) => `
      <tr><td colspan="2" class="item-name">${esc(item.name)}</td></tr>
      <tr>
        <td class="qty">${item.quantity} x ${money(item.unitPriceCents)}</td>
        <td class="right">${money(item.lineTotalCents)}</td>
      </tr>`
    )
    .join('');

  const paymentBlock =
    order.paymentStatus === 'paid'
      ? `
      <div class="row"><span>Payment</span><span class="bold">PAID - ${esc(
        order.paymentMethod === 'cash' ? 'CASH' : 'ONLINE'
      )}</span></div>
      ${
        order.paymentMethod === 'cash' && order.cashReceivedCents !== null
          ? `<div class="row"><span>Cash</span><span>${money(order.cashReceivedCents)}</span></div>
             <div class="row"><span>Change</span><span>${money(order.changeCents || 0)}</span></div>`
          : ''
      }
      ${order.reference ? `<div class="row"><span>Ref</span><span>${esc(order.reference)}</span></div>` : ''}`
      : `
      <div class="unpaid center bold">*** UNPAID ***</div>
      <div class="center small">Please settle at the counter.</div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Receipt ${esc(order.numberLabel)}</title>
<style>
  @page { size: 80mm auto; margin: 3mm; }
  * { box-sizing: border-box; }
  body { width: 74mm; margin: 0 auto; font-family: "Segoe UI", Arial, sans-serif; font-size: 11.5px; color: #000; }
  .center { text-align: center; }
  .small { font-size: 10px; }
  .bold { font-weight: 700; }
  .logo { max-width: 18mm; max-height: 18mm; margin-bottom: 2mm; }
  .shop-name { font-size: 15px; font-weight: 800; letter-spacing: .3px; }
  .sep { border-top: 1px dashed #000; margin: 2.5mm 0; }
  .row { display: flex; justify-content: space-between; gap: 4mm; padding: .4mm 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: .3mm 0; vertical-align: top; }
  .item-name { font-weight: 700; padding-top: 1.2mm; }
  .qty { padding-left: 2.5mm; }
  .right { text-align: right; }
  .total-row { display: flex; justify-content: space-between; font-size: 15px; font-weight: 800; padding: 1mm 0; }
  .unpaid { border: 1px solid #000; padding: 1.5mm; margin: 1.5mm 0; font-size: 13px; }
  .footer { margin-top: 3mm; font-size: 10.5px; text-align: center; }
  .order-no { font-size: 20px; font-weight: 800; text-align: center; margin: 1mm 0; }
</style></head>
<body>
  ${settingsHeader(s)}
  <div class="sep"></div>
  <div class="order-no">ORDER ${esc(order.numberLabel)}</div>
  <div class="row"><span>Customer</span><span class="bold">${esc(order.customerName)}</span></div>
  <div class="row"><span>Type</span><span class="bold">${order.orderType === 'dine_in' ? 'DINE IN' : 'TAKE OUT'}</span></div>
  <div class="row"><span>Date</span><span>${esc(fmtDateTime(order.createdAt))}</span></div>
  <div class="row"><span>Cashier</span><span>${esc(order.createdByName || '-')}</span></div>
  <div class="sep"></div>
  <table>
    <tbody>${items}</tbody>
  </table>
  <div class="sep"></div>
  <div class="total-row"><span>TOTAL</span><span>${money(order.totalCents)}</span></div>
  <div class="sep"></div>
  ${paymentBlock}
  ${order.notes ? `<div class="sep"></div><div><span class="bold">Notes:</span> ${esc(order.notes)}</div>` : ''}
  <div class="sep"></div>
  <div class="footer">${esc(s.receiptFooter || 'Thank you, come again!')}</div>
  <div class="footer small">This receipt is generated by the POS.</div>
</body></html>`;
}

export function printReceipt(order) {
  printHtmlDocument(receiptHtml(order, state.settings));
}

/** Build the sales report PDF and hand it to the browser as a download. */
export async function downloadSalesReportPdf(data) {
  try {
    const blob = await salesReportPdfBlob(data, state.settings);
    const range = data.range || {};
    const name =
      !range.from || (range.from === range.to)
        ? `sales-report-${range.from || 'report'}.pdf`
        : `sales-report-${range.from}_to_${range.to}.pdf`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Sales report downloaded as PDF.', 'success');
  } catch (err) {
    console.error('PDF generation failed:', err);
    toast(err && err.message ? err.message : 'Could not generate the PDF.', 'error');
  }
}

// Re-exported for views that need a quick confirmation.
export { confirmDialog, closeAllModals };
