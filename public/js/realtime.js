// Live updates: one Server-Sent Events connection per browser tab.
//
// The stream is watched closely because a silent connection (tablet asleep,
// Wi-Fi switch, proxy drop) used to leave screens stale until a manual
// refresh. Now the client:
//   - treats the server heartbeat as proof of life,
//   - forces a reconnect when the stream goes quiet,
//   - re-syncs every open screen right after (re)connecting, and
//   - re-syncs when the tab comes back to the foreground.

const HEARTBEAT_GRACE_MS = 45000; // server pings every 15s
const WATCHDOG_MS = 10000;

const eventHandlers = new Set();
const statusHandlers = new Set();

let source = null;
let status = 'offline'; // 'live' | 'reconnecting' | 'offline'
let retryTimer = null;
let watchdogTimer = null;
let lastActivityAt = 0;
let visibilityBound = false;

export function connectEvents() {
  if (source) return;
  bindVisibility();
  startWatchdog();
  open();
}

export function disconnectEvents() {
  if (source) {
    source.close();
    source = null;
  }
  clearTimeout(retryTimer);
  stopWatchdog();
  setStatus('offline');
}

/** Refetch trigger: tells every open screen that something may have changed. */
export function resync(reason = 'manual') {
  emit({ type: 'change', table: '*', eventType: 'SYNC', reason });
}

function open() {
  try {
    source = new EventSource('/api/events');
  } catch {
    scheduleReopen();
    return;
  }

  source.onopen = () => {
    lastActivityAt = Date.now();
    const wasDown = status !== 'live';
    setStatus('live');
    // Anything that happened while we were away is picked up by re-fetching.
    if (wasDown) resync('reconnect');
  };

  source.onerror = () => {
    setStatus('reconnecting');
    // EventSource reconnects on its own; if it gave up (CLOSED), recreate it.
    if (!source || source.readyState === EventSource.CLOSED) {
      if (source) {
        source.close();
        source = null;
      }
      scheduleReopen();
    }
  };

  source.onmessage = (event) => {
    lastActivityAt = Date.now();
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data && data.type === 'ping') return;
    emit(data);
  };
}

function emit(data) {
  for (const handler of [...eventHandlers]) {
    try {
      handler(data);
    } catch (err) {
      console.error('[realtime] handler error', err);
    }
  }
}

/** Drops a half-open stream so the browser opens a fresh one. */
function recycle() {
  if (source) {
    try {
      source.close();
    } catch {
      /* ignore */
    }
    source = null;
  }
  open();
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (status !== 'live') return;
    if (Date.now() - lastActivityAt > HEARTBEAT_GRACE_MS) {
      lastActivityAt = Date.now();
      recycle();
    }
  }, WATCHDOG_MS);
}

function stopWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

function bindVisibility() {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Coming back from sleep: refresh at once, and reopen a dead stream.
    resync('visible');
    if (status !== 'live' || Date.now() - lastActivityAt > HEARTBEAT_GRACE_MS) {
      lastActivityAt = Date.now();
      recycle();
    }
  });
}

function scheduleReopen() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!source) {
      lastActivityAt = Date.now();
      open();
    }
  }, 4000);
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  for (const handler of statusHandlers) {
    try {
      handler(next);
    } catch {
      /* ignore */
    }
  }
}

/** Subscribe to every event. Returns an unsubscribe function. */
export function onEvent(handler) {
  eventHandlers.add(handler);
  return () => eventHandlers.delete(handler);
}

/**
 * Subscribe to changes of specific tables ('orders', 'menu_items', ...).
 * The '*' resync event (sent after a reconnect) also reaches the handler.
 */
export function onTables(tables, handler) {
  return onEvent((event) => {
    if (event.type !== 'change') return;
    if (event.table === '*' || tables.includes(event.table)) handler(event);
  });
}

/** Connection status changes: 'live' | 'reconnecting' | 'offline'. */
export function onConnection(handler) {
  statusHandlers.add(handler);
  handler(status);
  return () => statusHandlers.delete(handler);
}

export function connectionStatus() {
  return status;
}

/** Runs a refresh on a timer, but only while the tab is visible. */
export function everyWhileVisible(fn, ms) {
  const timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    try {
      fn();
    } catch (err) {
      console.error('[realtime] refresh failed', err);
    }
  }, ms);
  return () => clearInterval(timer);
}
