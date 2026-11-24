// Talks to the server. Every write carries a unique request key so a retry
// (double tap, reconnect) can never create a second record.
import { toast } from './ui.js';

const KEY = 'alaan.queue';
export const state = { online: navigator.onLine, boot: null, user: null, catalogCache: null };

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

let inflight = 0;
const setBusy = on => { inflight += on ? 1 : -1; document.documentElement.classList.toggle('busy', inflight > 0); };

// ---- Connection state -------------------------------------------------------
// slow:      a request has been waiting more than 2.5 s ("Slow connection…")
// reachable: false after a request could not reach the store server (brownout, router off,
//            no internet / Wi-Fi) — even when the phone still says it is "online"
// manual:    the user chose "Go to offline mode": sales/orders, attendance and stock are saved
//            on this device right away (Pending sync) instead of waiting for a dead connection
const MODE_KEY = 'alaan.offlineMode';
export const net = {
  slow: 0, reachable: true, manual: (() => { try { return localStorage.getItem(MODE_KEY) === '1'; } catch { return false; } })(), checkedAt: 0,
};
const emitNet = () => window.dispatchEvent(new CustomEvent('alaan:net'));
/** True whenever writes should be saved on the device instead of sent. */
export const isOffline = () => net.manual || !navigator.onLine || !net.reachable;
export function setOfflineMode(on) {
  net.manual = !!on; try { on ? localStorage.setItem(MODE_KEY, '1') : localStorage.removeItem(MODE_KEY); } catch { /* blocked */ }
  emitNet(); if (!on) { checkServer().then(ok => { if (ok) queue.sync(); }); }
}
const markReachable = ok => {
  if (ok === net.reachable) return;
  net.reachable = ok; emitNet();
  if (ok && !net.manual) { queue.sync(); window.dispatchEvent(new CustomEvent('alaan:online')); }
};
/** Quick check whether the store server answers (4 s). */
export async function checkServer() {
  if (!navigator.onLine) { markReachable(false); return false; }
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
  try { const r = await fetch('/api/branding', { cache: 'no-store', signal: ctl.signal }); net.checkedAt = Date.now(); markReachable(r.ok); return r.ok; }
  catch { net.checkedAt = Date.now(); markReachable(false); return false; }
  finally { clearTimeout(t); }
}
// While the server is unreachable (or in offline mode), check again every 12 s.
setInterval(() => { if (state.user && (!net.reachable || net.manual) && navigator.onLine) checkServer(); }, 12_000);

const TIMEOUT = { GET: 15_000, POST: 20_000 };
async function request(method, url, body, { timeout } = {}) {
  setBusy(true);
  const ctl = new AbortController();
  const limit = timeout ?? TIMEOUT[method] ?? 20_000;
  let slowOn = false;
  const slowTimer = setTimeout(() => { slowOn = true; net.slow++; emitNet(); }, 2500);
  const killTimer = setTimeout(() => ctl.abort(), limit);
  try {
    let res;
    try {
      res = await fetch(url, {
        method, credentials: 'same-origin', signal: ctl.signal,
        headers: body ? { 'Content-Type': 'application/json', 'X-Alaan': '1' } : { 'X-Alaan': '1' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      // No answer at all (brownout, no Wi-Fi/internet) or it took too long.
      markReachable(false);
      const error = new Error(ctl.signal.aborted ? 'The connection is too slow — the server did not answer in time.' : 'Cannot reach the store server (no internet or brownout).');
      error.name = 'TypeError'; error.network = true; error.cause = cause;
      throw error;
    }
    markReachable(true);
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const error = new Error(data.error || 'Request failed.');
      error.status = res.status; error.payload = data;
      if (res.status === 401 && state.user) { state.user = null; window.dispatchEvent(new CustomEvent('alaan:signout')); }
      throw error;
    }
    return data;
  } finally {
    clearTimeout(slowTimer); clearTimeout(killTimer);
    if (slowOn) { net.slow = Math.max(0, net.slow - 1); emitNet(); }
    setBusy(false);
  }
}

// Last good copy of the screens needed on a prepared device without connection (no valid IDs, no staff files).
const CACHE = 'alaan.cache';
const CACHEABLE = new Set(['me', 'bootstrap', 'attendance', 'materials', 'catalog', 'customers', 'suppliers', 'offline']);
const cacheAll = () => { try { return JSON.parse(localStorage.getItem(CACHE) || '{}'); } catch { return {}; } };
export const offlineCache = {
  get: url => cacheAll()[url],
  put(url, data) { if (state.user?.role === 'admin' && url.startsWith('/api/attendance')) return; try { const all = cacheAll(); all[url] = { at: Date.now(), data }; localStorage.setItem(CACHE, JSON.stringify(all)); } catch { /* storage full */ } },
  clear() { try { localStorage.removeItem(CACHE); } catch { /* blocked */ } },
};
async function cachedGet(name, params) {
  const url = '/api/' + name + (params ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))) : '');
  if (isOffline() && CACHEABLE.has(name)) { const hit = offlineCache.get(url); if (hit) { state.fromCache = true; return { ...hit.data, _cachedAt: hit.at }; } }
  try { const data = await request('GET', url, null, isOffline() ? { timeout: 5000 } : {}); if (CACHEABLE.has(name)) offlineCache.put(url, data); state.fromCache = false; return data; }
  catch (error) {
    const hit = CACHEABLE.has(name) && (error.name === 'TypeError' || error.status === undefined) ? offlineCache.get(url) : null;
    if (hit) { state.fromCache = true; return { ...hit.data, _cachedAt: hit.at }; }
    throw error;
  }
}
// Actions that a non-admin can record offline; they go to the Admin approval inbox on reconnect.
// (order.create is NOT here: a saved order is sent straight to the Cashier queue when the
// connection returns — it moves no stock or money, and the server checks the prices again.)
const INBOX = new Set(['attendance.clock', 'sale.checkout', 'stock.in', 'stock.out', 'count.submit']);
export const api = {
  get: cachedGet,
  login: (username, password) => request('POST', '/api/login', { username, password }),
  logout: () => { offlineCache.clear(); return request('POST', '/api/logout', {}); },
  password: (current, password) => request('POST', '/api/password', { current, password }),
  /** Run a write action. Queues it when offline (for the actions that allow it). */
  async action(action, fields = {}, { offlineOk = false } = {}) {
    const body = { action, key: uid(), ...fields };
    if (offlineOk && isOffline()) { queue.push(body); return { queued: true }; }
    try { return await request('POST', '/api/action', body); }
    catch (error) {
      if (offlineOk && (error.network || error.name === 'TypeError' || error.status === undefined)) { queue.push(body); return { queued: true }; }
      throw error;
    }
  },
};

// ---- Offline queue (stored on this device until synced) ----------------
let syncing = false;
export const queue = {
  all() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } },
  save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full or blocked */ } window.dispatchEvent(new CustomEvent('alaan:queue')); },
  push(entry) { const list = queue.all(); list.push({ ...entry, occurred: entry.occurred || new Date().toISOString(), userId: state.user?.id }); queue.save(list); toast('Saved on this device · Pending sync', 'warn'); },
  remove(key) { queue.save(queue.all().filter(e => e.key !== key)); },
  async sync() {
    const list = queue.all();
    if (!list.length || !navigator.onLine || net.manual || syncing) return { done: 0, failed: 0 };
    syncing = true; window.dispatchEvent(new CustomEvent('alaan:queue'));
    try {
    let done = 0, failed = 0;
    for (const entry of list) {
      if (entry.userId && state.user && entry.userId !== state.user.id) { entry.error = 'Sign in as the account that recorded this entry.'; failed++; continue; }
      const toInbox = INBOX.has(entry.action) && state.user && state.user.role !== 'admin';
      try { await request('POST', toInbox ? '/api/offline' : '/api/action', entry); queue.remove(entry.key); done++; }
      catch (error) { if (error.status && error.status !== 401) { entry.error = error.message; failed++; } else break; }
    }
    if (failed) queue.save(queue.all().map(e => ({ ...e, error: list.find(l => l.key === e.key)?.error })));
    if (done) toast(state.user?.role === 'admin' ? `Synced ${done} offline ${done === 1 ? 'entry' : 'entries'}` : `Uploaded ${done} offline ${done === 1 ? 'entry' : 'entries'} · Pending Admin approval`, 'ok');
    if (done) window.dispatchEvent(new CustomEvent('alaan:synced'));
    return { done, failed };
    } finally { syncing = false; window.dispatchEvent(new CustomEvent('alaan:queue')); }
  },
  get syncing() { return syncing; },
};
window.addEventListener('online', () => { state.online = true; state.fromCache = false; checkServer().then(ok => { if (ok) queue.sync(); }); window.dispatchEvent(new CustomEvent('alaan:online')); emitNet(); });
window.addEventListener('offline', () => { state.online = false; window.dispatchEvent(new CustomEvent('alaan:online')); emitNet(); });
// Retry uploads periodically while there is something waiting (covers flaky connections).
setInterval(() => { if (navigator.onLine && net.reachable && !net.manual && state.user && queue.all().length) queue.sync(); }, 45_000);
