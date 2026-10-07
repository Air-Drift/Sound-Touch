// Hearing the buttons. Every speaker announces what it is doing on a
// websocket on port 8080 (subprotocol "gabbo"); a preset button shows up as
// a nowSelectionUpdated carrying the button's number.
import { element, elements } from './xml.mjs';

const RETRY = 5_000;
// The connection is replaced now and then: a speaker that lost power leaves
// a socket that looks open and never says anything again.
const RENEW = 10 * 60_000;
const REPEAT = 1_500;

const watching = new Map();

// The button number in a notification, or 0 when it is about something else.
export function pressed(message) {
  const update = element(message, 'nowSelectionUpdated');
  if (!update) return 0;
  const slot = Number(elements(update.inner, 'preset')[0]?.attrs.id);
  return slot >= 1 && slot <= 6 ? slot : 0;
}

function connect(watch) {
  if (watch.stopped) return;
  let socket;
  try {
    socket = new WebSocket(`ws://${watch.ip}:8080`, 'gabbo');
  } catch {
    watch.timer = setTimeout(() => connect(watch), RETRY);
    return;
  }
  socket.addEventListener('open', () => {
    // The new connection takes over before the old one is let go, so no
    // press falls between them.
    const old = watch.socket;
    watch.socket = socket;
    watch.connectedAt = new Date().toISOString();
    old?.close();
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => connect(watch), RENEW);
  });
  socket.addEventListener('message', (event) => {
    if (socket !== watch.socket || typeof event.data !== 'string') return;
    const slot = pressed(event.data);
    if (!slot) return;
    const now = Date.now();
    if (slot === watch.last?.slot && now - watch.last.at < REPEAT) return;
    watch.last = { slot, at: now };
    watch.onPress(slot);
  });
  const lost = () => {
    if (socket === watch.socket) watch.socket = null;
    else if (watch.socket) return;
    clearTimeout(watch.timer);
    if (!watch.stopped) watch.timer = setTimeout(() => connect(watch), RETRY);
  };
  socket.addEventListener('close', lost);
  socket.addEventListener('error', lost);
}

export function watch(speaker, onPress) {
  const current = watching.get(speaker.id);
  if (current && current.ip === speaker.ip) {
    current.onPress = onPress;
    return;
  }
  unwatch(speaker.id);
  const entry = { ip: speaker.ip, onPress, socket: null, timer: null, stopped: false, last: null, connectedAt: null };
  watching.set(speaker.id, entry);
  connect(entry);
}

export function unwatch(id) {
  const entry = watching.get(id);
  if (!entry) return;
  entry.stopped = true;
  clearTimeout(entry.timer);
  entry.socket?.close();
  watching.delete(id);
}

// Drops the connection and makes a new one, for when a speaker has been away.
export function renew(id) {
  const entry = watching.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  connect(entry);
}

export const listening = (id) => watching.get(id)?.socket?.readyState === WebSocket.OPEN;
export const stopAll = () => [...watching.keys()].forEach(unwatch);
