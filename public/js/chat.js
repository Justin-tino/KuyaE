// Private chat between an admin and a kitchen/cashier staff member.
// Opened from the message button in the header. Conversations are deleted by
// the server 24 hours after their last message.

import { api } from './api.js';
import { icon } from './icons.js';
import { state, ROLE_LABELS } from './state.js';
import { onTables } from './realtime.js';
import {
  esc,
  toast,
  openModal,
  spinner,
  emptyState,
  debounce,
  elapsedLabel,
  fmtTime,
  fmtDate,
} from './ui.js';

const POLL_MS = 30000;
const LIVE_DEBOUNCE_MS = 400;
const MAX_BODY_LENGTH = 2000;

let buttonEl = null;
let badgeEl = null;
let offTables = null;
let pollTimer = null;
let cleanupListeners = null;

let modal = null;
let view = 'list'; // 'list' | 'thread' | 'compose'
let threads = [];
let recipients = null;
let activeThread = null;
let messages = [];
let listLoading = false;
let threadLoading = false;
let sending = false;
let requestSeq = 0;

function isAdmin() {
  return Boolean(state.user && state.user.role === 'admin');
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role || 'Staff';
}

function initialsOf(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

/** "Auto-deletes in 5h 20m" / "Expired". */
function expiryLabel(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'Expired - deleting now';
  const mins = Math.ceil(ms / 60000);
  if (mins < 1) return 'Auto-deletes in less than a minute';
  if (mins < 60) return `Auto-deletes in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return `Auto-deletes in ${hours}h${rest ? ` ${rest}m` : ''}`;
}

function previewText(thread) {
  const last = thread.lastMessage;
  if (!last || !last.body) return 'No messages yet';
  const prefix = last.senderId === state.user.id ? 'You: ' : '';
  return prefix + String(last.body).replace(/\s+/g, ' ');
}

function setBadge(count) {
  if (!badgeEl) return;
  const n = Number(count) || 0;
  if (buttonEl) {
    const label = n > 0 ? `Messages (${n} unread)` : 'Messages';
    buttonEl.setAttribute('aria-label', label);
    buttonEl.title = label;
  }
  if (n > 0) {
    badgeEl.textContent = n > 99 ? '99+' : String(n);
    badgeEl.classList.remove('hidden');
    badgeEl.classList.add('inline-flex');
  } else {
    badgeEl.textContent = '';
    badgeEl.classList.add('hidden');
    badgeEl.classList.remove('inline-flex');
  }
}

async function refreshUnread() {
  try {
    const data = await api('/messages/unread', { silent: true });
    setBadge(data.unread || 0);
  } catch {
    // Background badge checks stay quiet; the chat modal reports real errors.
  }
}

/** Wire the header button, live updates and the fallback poll. */
export function initChat() {
  buttonEl = document.getElementById('chat-button');
  badgeEl = document.getElementById('chat-badge');
  if (!buttonEl) return () => {};

  const onClick = () => openChat();
  buttonEl.addEventListener('click', onClick);

  const refreshLive = debounce(async () => {
    refreshUnread();
    if (!modal) return;
    if (view === 'thread' && activeThread) loadThread(activeThread.id, true);
    else if (view === 'list') loadThreads(true);
  }, LIVE_DEBOUNCE_MS);

  offTables = onTables(['messages', 'conversations'], refreshLive);
  pollTimer = setInterval(() => {
    refreshUnread();
    if (modal && view === 'thread' && activeThread) loadThread(activeThread.id, true);
  }, POLL_MS);

  refreshUnread();

  return () => {
    buttonEl.removeEventListener('click', onClick);
    if (offTables) offTables();
    if (pollTimer) clearInterval(pollTimer);
    if (cleanupListeners) cleanupListeners();
    if (modal) modal.close();
    buttonEl = null;
    badgeEl = null;
    offTables = null;
    pollTimer = null;
    cleanupListeners = null;
    modal = null;
    view = 'list';
    threads = [];
    recipients = null;
    activeThread = null;
    messages = [];
  };
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

function openChat() {
  if (modal) {
    modal.close();
    return;
  }

  view = 'list';
  threads = [];
  recipients = null;
  activeThread = null;
  messages = [];

  modal = openModal({
    title: 'Messages',
    size: 'md',
    content: `<div class="flex h-[58vh] max-h-[540px] min-h-[300px] flex-col">${pageSpinner(
      'Loading messages...'
    )}</div>`,
  });

  const root = modal.root;
  const onClick = (event) => handleClick(event);
  const onKeydown = (event) => handleKeydown(event);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  const removeListeners = () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeydown);
  };
  cleanupListeners = removeListeners;

  modal.onClose(() => {
    removeListeners();
    cleanupListeners = null;
    modal = null;
    view = 'list';
    activeThread = null;
    messages = [];
  });

  loadThreads(false);
}

function pageSpinner(label) {
  return `<div class="flex flex-1 flex-col items-center justify-center gap-3 text-stone-500">${spinner(
    'w-8 h-8 text-red-700'
  )}<p class="font-semibold">${esc(label)}</p></div>`;
}

function chatShell(inner) {
  return `<div class="flex h-[58vh] max-h-[540px] min-h-[300px] flex-col">${inner}</div>`;
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

async function loadThreads(quiet) {
  if (!quiet) {
    listLoading = true;
    renderList();
  }
  try {
    const data = await api('/messages/threads', { silent: quiet });
    threads = data.threads || [];
  } catch (err) {
    if (!quiet) toast(err.message, 'error');
  } finally {
    listLoading = false;
    if (modal && view === 'list') renderList();
  }
}

function renderList() {
  if (!modal) return;
  modal.setTitle('Messages');

  let body;
  if (listLoading) {
    body = pageSpinner('Loading messages...');
  } else if (!threads.length) {
    body = emptyState(
      'message',
      isAdmin() ? 'No conversations yet' : 'No messages yet',
      isAdmin()
        ? 'Tap New Message to start a private chat with a cashier or kitchen staff member.'
        : 'The admin can message you here. Replies stay private and are deleted 24 hours after the last message.',
      '',
      { compact: true }
    );
  } else {
    body = `<div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">${threads
      .map(threadRow)
      .join('')}</div>`;
  }

  modal.setBody(
    chatShell(`
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 pb-3">
        <p class="flex items-center gap-1.5 text-xs font-semibold text-stone-500">
          ${icon('clock', 'w-4 h-4 shrink-0')} Chats delete 24 hours after the last message.
        </p>
        ${
          isAdmin()
            ? `<button type="button" data-chat-action="new" class="btn btn-sm btn-primary">${icon(
                'plus',
                'w-4 h-4'
              )} New Message</button>`
            : ''
        }
      </div>
      ${body}`)
  );
}

function threadRow(thread) {
  const other = thread.other || { fullName: 'Unknown', role: '' };
  const unread = Number(thread.unread) || 0;
  return `<button type="button" data-thread-id="${esc(thread.id)}"
      class="flex w-full items-start gap-3 rounded-xl border border-stone-200 px-3 py-3 text-left transition-colors hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300">
      <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-sm font-extrabold text-red-700">${esc(
        initialsOf(other.fullName)
      )}</span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2">
          <span class="truncate font-bold text-stone-800">${esc(other.fullName || 'Unknown')}</span>
          <span class="badge bg-stone-100 text-stone-600">${esc(roleLabel(other.role))}</span>
          <span class="ml-auto shrink-0 text-xs font-semibold text-stone-400">${esc(
            elapsedLabel(thread.lastMessageAt)
          )}</span>
        </span>
        <span class="mt-0.5 flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-sm text-stone-500">${esc(previewText(thread))}</span>
          ${
            unread
              ? `<span class="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-extrabold text-white">${
                  unread > 9 ? '9+' : unread
                }</span>`
              : ''
          }
        </span>
        <span class="mt-1 block text-[11px] font-semibold text-amber-700">${esc(expiryLabel(thread.expiresAt))}</span>
      </span>
    </button>`;
}

function updateThreadPreview(thread) {
  if (!thread) return;
  const index = threads.findIndex((item) => item.id === thread.id);
  if (index === -1) threads.unshift(thread);
  else threads[index] = thread;
  threads.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

async function openThread(id) {
  view = 'thread';
  activeThread = threads.find((item) => item.id === id) || null;
  messages = [];
  threadLoading = true;
  requestSeq += 1;
  renderThread();

  await loadThread(id, false);
}

async function loadThread(id, quiet) {
  const seq = ++requestSeq;
  try {
    const data = await api(`/messages/threads/${id}`, { silent: quiet });
    if (seq !== requestSeq || !modal || view !== 'thread') return;
    activeThread = data.thread;
    messages = data.messages || [];
    threadLoading = false;
    renderThreadMeta();
    renderMessages({ scroll: quiet ? 'keep' : 'bottom' });
    refreshUnread();
  } catch (err) {
    if (seq !== requestSeq) return;
    threadLoading = false;
    if (!modal) return;
    // A quiet background refresh must not kick anyone out of the chat because
    // of a temporary network hiccup. Expired/deleted conversations do.
    if (quiet && !/expired|not found/i.test(err.message)) return;
    toast(err.message, 'error');
    view = 'list';
    activeThread = null;
    messages = [];
    loadThreads(false);
  }
}

function renderThread() {
  if (!modal) return;
  const other = (activeThread && activeThread.other) || { fullName: 'Conversation', role: '' };
  modal.setTitle('Messages');
  modal.setBody(
    chatShell(`
      <div class="flex shrink-0 items-center gap-2 border-b border-stone-200 pb-3">
        <button type="button" data-chat-action="back" class="btn btn-ghost btn-sm" aria-label="Back to messages">
          ${icon('arrowLeft', 'w-5 h-5')}
        </button>
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-sm font-extrabold text-red-700">${esc(
          initialsOf(other.fullName)
        )}</span>
        <div class="min-w-0 flex-1">
          <p class="truncate font-bold text-stone-800">${esc(other.fullName || 'Conversation')}</p>
          <p class="text-xs font-semibold text-stone-500" data-chat-expiry>${
            activeThread ? esc(expiryLabel(activeThread.expiresAt)) : ''
          }</p>
        </div>
        <span class="badge bg-stone-100 text-stone-600">${esc(roleLabel(other.role))}</span>
      </div>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto py-3 pr-1" data-chat-messages>
        ${threadLoading ? pageSpinner('Loading conversation...') : messagesHtml()}
      </div>
      <form class="shrink-0 border-t border-stone-200 pt-3" data-chat-form>
        <div class="flex items-end gap-2">
          <textarea data-chat-body class="textarea min-h-[46px] flex-1 resize-none" rows="2" maxlength="${MAX_BODY_LENGTH}"
            placeholder="Type a reply..." aria-label="Message"></textarea>
          <button type="button" data-chat-action="send-thread" class="btn btn-md btn-primary shrink-0" aria-label="Send message">
            ${icon('send', 'w-5 h-5')}
          </button>
        </div>
        <p class="mt-1 hidden text-sm font-semibold text-red-700" data-chat-error></p>
      </form>`)
  );

  if (!threadLoading) scrollMessagesToBottom();
  const input = modal.body.querySelector('[data-chat-body]');
  if (input) input.focus();
}

function renderThreadMeta() {
  if (!modal || !activeThread) return;
  const expiry = modal.body.querySelector('[data-chat-expiry]');
  if (expiry) expiry.textContent = expiryLabel(activeThread.expiresAt);
}

function renderMessages({ scroll = 'keep' } = {}) {
  if (!modal) return;
  const list = modal.body.querySelector('[data-chat-messages]');
  if (!list) return;

  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.innerHTML = threadLoading ? pageSpinner('Loading conversation...') : messagesHtml();
  if (scroll === 'bottom' || (scroll === 'keep' && nearBottom)) scrollMessagesToBottom();
}

function scrollMessagesToBottom() {
  if (!modal) return;
  const list = modal.body.querySelector('[data-chat-messages]');
  if (!list) return;
  requestAnimationFrame(() => {
    list.scrollTop = list.scrollHeight;
  });
}

function messagesHtml() {
  if (!messages.length) {
    return emptyState('message', 'No messages yet', 'Type below to start the conversation.', '', {
      compact: true,
    });
  }

  let lastDay = null;
  const parts = [];
  for (const message of messages) {
    const day = fmtDate(message.createdAt);
    if (day !== lastDay) {
      lastDay = day;
      parts.push(
        `<p class="text-center text-[11px] font-bold uppercase tracking-wide text-stone-400">${esc(day)}</p>`
      );
    }
    const mine = message.senderId === state.user.id;
    parts.push(`
      <div class="flex ${mine ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[85%]">
          <div class="whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm font-medium ${
            mine ? 'rounded-br-md bg-red-700 text-white' : 'rounded-bl-md bg-stone-100 text-stone-800'
          }">${esc(message.body)}</div>
          <p class="mt-1 text-[11px] font-semibold text-stone-400 ${mine ? 'text-right' : ''}">${esc(
            fmtTime(message.createdAt)
          )}</p>
        </div>
      </div>`);
  }
  return parts.join('');
}

async function sendReply() {
  if (!modal || !activeThread || sending) return;
  const input = modal.body.querySelector('[data-chat-body]');
  if (!input) return;
  const body = String(input.value || '').trim();
  if (!body) {
    input.focus();
    return;
  }

  sending = true;
  clearError();
  const sendButton = modal.body.querySelector('[data-chat-action="send-thread"]');
  if (sendButton) sendButton.disabled = true;
  try {
    const data = await api(`/messages/threads/${activeThread.id}/messages`, {
      method: 'POST',
      body: { body },
    });
    input.value = '';
    activeThread = data.thread;
    if (!messages.some((message) => message.id === data.message.id)) messages.push(data.message);
    renderThreadMeta();
    renderMessages({ scroll: 'bottom' });
    updateThreadPreview(data.thread);
    refreshUnread();
    input.focus();
  } catch (err) {
    showError(err.message);
  } finally {
    sending = false;
    if (sendButton) sendButton.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// New message (admin)
// ---------------------------------------------------------------------------

async function openCompose() {
  view = 'compose';
  renderCompose();
  if (recipients !== null) return;

  try {
    const data = await api('/users');
    recipients = (data.users || []).filter((user) => user.role !== 'admin' && user.isActive !== false);
  } catch (err) {
    recipients = [];
    toast(err.message, 'error');
  }
  if (modal && view === 'compose') renderCompose();
}

function renderCompose() {
  if (!modal) return;
  modal.setTitle('New Message');

  const header = `
    <div class="flex shrink-0 items-center gap-2 border-b border-stone-200 pb-3">
      <button type="button" data-chat-action="back" class="btn btn-ghost btn-sm" aria-label="Back to messages">
        ${icon('arrowLeft', 'w-5 h-5')}
      </button>
      <div class="min-w-0 flex-1">
        <p class="font-bold text-stone-800">New Message</p>
        <p class="text-xs font-semibold text-stone-500">The chat stays private between you and the receiver.</p>
      </div>
    </div>`;

  if (recipients === null) {
    modal.setBody(chatShell(`${header}<div class="flex flex-1 items-center justify-center">${pageSpinner(
      'Loading staff...'
    )}</div>`));
    return;
  }

  if (!recipients.length) {
    modal.setBody(
      chatShell(`${header}<div class="flex flex-1 items-center justify-center">${emptyState(
        'users',
        'No staff to message',
        'Create an active cashier or kitchen account in the Users page first.',
        '',
        { compact: true }
      )}</div>`)
    );
    return;
  }

  const cashiers = recipients.filter((user) => user.role === 'cashier');
  const kitchen = recipients.filter((user) => user.role === 'kitchen');
  const options = (list) =>
    list
      .map(
        (user) =>
          `<option value="${esc(user.id)}">${esc(user.fullName)} (${esc(user.username)})</option>`
      )
      .join('');

  modal.setBody(
    chatShell(`
      ${header}
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto py-3 pr-1">
        <div>
          <label class="label" for="chat-recipient">Send to</label>
          <select id="chat-recipient" data-chat-recipient class="input" data-autofocus>
            <option value="">Choose a staff member...</option>
            ${cashiers.length ? `<optgroup label="Cashier">${options(cashiers)}</optgroup>` : ''}
            ${kitchen.length ? `<optgroup label="Kitchen">${options(kitchen)}</optgroup>` : ''}
          </select>
        </div>
        <div>
          <label class="label" for="chat-new-body">Message</label>
          <textarea id="chat-new-body" data-chat-new-body class="textarea" rows="6" maxlength="${MAX_BODY_LENGTH}"
            placeholder="Type your message..."></textarea>
        </div>
        <p class="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          ${icon('clock', 'w-4 h-4 shrink-0')} This conversation is saved for 24 hours after the last message, then deleted automatically.
        </p>
        <p class="hidden text-sm font-semibold text-red-700" data-chat-error></p>
      </div>
      <div class="flex shrink-0 justify-end border-t border-stone-200 pt-3">
        <button type="button" data-chat-action="send-new" class="btn btn-md btn-primary">
          ${icon('send', 'w-5 h-5')} Send Message
        </button>
      </div>`)
  );

  const select = modal.body.querySelector('[data-chat-recipient]');
  if (select) select.focus();
}

async function sendNew() {
  if (!modal || sending) return;
  const select = modal.body.querySelector('[data-chat-recipient]');
  const input = modal.body.querySelector('[data-chat-new-body]');
  if (!select || !input) return;

  const staffId = select.value;
  const body = String(input.value || '').trim();
  if (!staffId) {
    showError('Choose who to message.');
    select.focus();
    return;
  }
  if (!body) {
    showError('Type a message first.');
    input.focus();
    return;
  }

  sending = true;
  clearError();
  const sendButton = modal.body.querySelector('[data-chat-action="send-new"]');
  if (sendButton) sendButton.disabled = true;
  try {
    const data = await api('/messages/threads', { method: 'POST', body: { staffId, body } });
    toast('Message sent.', 'success');
    view = 'thread';
    activeThread = data.thread;
    messages = [data.message];
    threadLoading = false;
    updateThreadPreview(data.thread);
    renderThread();
    renderThreadMeta();
    renderMessages({ scroll: 'bottom' });
    refreshUnread();
    const replyBox = modal.body.querySelector('[data-chat-body]');
    if (replyBox) replyBox.focus();
  } catch (err) {
    showError(err.message);
  } finally {
    sending = false;
    if (sendButton) sendButton.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Shared handlers
// ---------------------------------------------------------------------------

function showError(message) {
  if (!modal) return;
  const el = modal.body.querySelector('[data-chat-error]');
  if (!el) {
    toast(message, 'error');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearError() {
  if (!modal) return;
  const el = modal.body.querySelector('[data-chat-error]');
  if (el) {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function backToList() {
  view = 'list';
  activeThread = null;
  messages = [];
  renderList();
  loadThreads(true);
}

function handleClick(event) {
  if (!modal) return;
  if (event.target.closest('[data-chat-action="new"]')) {
    openCompose();
    return;
  }
  if (event.target.closest('[data-chat-action="back"]')) {
    backToList();
    return;
  }
  if (event.target.closest('[data-chat-action="send-thread"]')) {
    sendReply();
    return;
  }
  if (event.target.closest('[data-chat-action="send-new"]')) {
    sendNew();
    return;
  }
  const row = event.target.closest('[data-thread-id]');
  if (row) openThread(row.getAttribute('data-thread-id'));
}

function handleKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  const target = event.target;
  if (target.matches('[data-chat-body]')) {
    event.preventDefault();
    sendReply();
  } else if (target.matches('[data-chat-new-body]')) {
    event.preventDefault();
    sendNew();
  }
}
