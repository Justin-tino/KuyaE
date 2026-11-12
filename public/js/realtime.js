// Live updates: one Server-Sent Events connection per browser tab.

const eventHandlers = new Set();
const statusHandlers = new Set();

let source = null;
let status = 'offline'; // 'live' | 'reconnecting' | 'offline'
let retryTimer = null;

export function connectEvents() {
  if (source) return;
  open();
}

export function disconnectEvents() {
  if (source) {
    source.close();
    source = null;
  }
  clearTimeout(retryTimer);
  setStatus('offline');
}

function open() {
  try {
    source = new EventSource('/api/events');
  } catch {
    scheduleReopen();
    return;
  }

  source.onopen = () => setStatus('live');

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
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    for (const handler of [...eventHandlers]) {
      try {
        handler(data);
      } catch (err) {
        console.error('[realtime] handler error', err);
      }
    }
  };
}

function scheduleReopen() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!source) open();
  }, 5000);
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

/** Subscribe to changes of specific tables ('orders', 'menu_items', ...). */
export function onTables(tables, handler) {
  return onEvent((event) => {
    if (event.type === 'change' && tables.includes(event.table)) handler(event);
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
