// Defaults for the Pi Agent bridge. The phone and the PC must be on the same
// network. These are only the *defaults* — the app's setup screen lets you
// change host/port at runtime and remembers the choice.
export const DEFAULT_HOST = '192.168.1.39';
export const DEFAULT_PORT = 3080;

/** Build the ws:// URL for a host/port pair. */
export function wsUrl(host, port) {
  const h = String(host || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const p = String(port || '').trim() || '3080';
  return `ws://${h}:${p}/ws`;
}

/** HTTP base derived from the same host/port (bridge REST endpoints). */
export function httpUrl(host, port) {
  const h = String(host || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const p = String(port || '').trim() || '3080';
  return `http://${h}:${p}`;
}
