// App shell: sign-in, navigation, theme, notifications, routing.
import { lang, LANGS, rememberLang, switchLanguage, showLoading } from './i18n.js'; // first: Filipino text from the very first paint
import { api, state, queue, offlineCache, net, setOfflineMode, checkServer } from './api.js';
import { h, $, $$, clear, toast, modal, drawer, busy, errorOf, initials, roleName, titleOf, greeting, ago, isPhone, reduced, input, field, showError, empty , monthPH, todayPH } from './ui.js';
import { icon } from './icons.js';
import { applyBrand } from './brand.js';
import { sound } from './sound.js';
import { pages } from './pages/index.js';

const app = $('#app');
const route = { path: '', params: [], query: new URLSearchParams(), el: null };

let navTip = null, tipMuteUntil = 0; // rail tooltip (declared first: setTheme may run at start-up)
// Light/dark switch restored exactly as in v2.7.2: circular reveal from the button (~0.95 s,
// View Transitions), a fade where that is not supported, and the "Dark mode on" label.
export function setTheme(next, origin) { hideNavTip?.(); tipMuteUntil = Date.now() + 1500;
  const root = document.documentElement;
  const apply = () => { root.classList.add('theme-switching'); root.dataset.theme = next; try { localStorage.setItem('alaan.theme', next); } catch { /* blocked */ } void root.offsetHeight; };
  const done = () => requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  if (reduced()) { apply(); done(); return; }
  const r = origin?.getBoundingClientRect?.();
  const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : innerHeight / 2;
  root.style.setProperty('--tx', x + 'px'); root.style.setProperty('--ty', y + 'px');
  root.style.setProperty('--tr', Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 'px');
  if (document.startViewTransition) { const vt = document.startViewTransition(apply); vt.finished.finally(done); }
  else { apply(); const f = h('div.theme-fade'); document.body.append(f); setTimeout(() => f.remove(), 820); done(); }
  document.querySelector('.theme-toast')?.remove();
  const label = h('div.theme-toast', icon(next === 'dark' ? 'moon' : 'sun', 'sm'), next === 'dark' ? 'Dark mode on' : 'Light mode on'); document.body.append(label); setTimeout(() => label.remove(), 1700);
  if (origin) origin.animate([{ transform: 'rotate(-40deg) scale(.8)' }, { transform: 'none' }], { duration: 800, easing: 'cubic-bezier(.2,.9,.3,1.3)' });
}
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

// ---- Navigation model ----------------------------------------------------
const NAV = [
  { id: 'dashboard', label: 'Overview', icon: 'home' },
  { id: 'pos', label: 'POS', icon: 'cart' },
  { id: 'orders', label: 'Orders', icon: 'send' },
  { id: 'inventory', label: 'Inventory', icon: 'boxes' },
  { id: 'materials', label: 'Catalog', icon: 'box' },
  { id: 'sales', label: 'Sales', icon: 'receipt' },
  { id: 'utang', label: 'Utang', icon: 'wallet' },
  { id: 'cash', label: 'Cash drawer', icon: 'banknote' },
  { id: 'summary', label: 'Tawad summary', icon: 'chart' },
  { id: 'attendance', label: 'Attendance', icon: 'clock' },
  { id: 'expenses', label: 'Expenses', icon: 'coins' },
  { id: 'reports', label: 'Reports', icon: 'chart' },
  { id: 'staff', label: 'Staff', icon: 'users' },
  { id: 'sync', label: 'Sync inbox', icon: 'refresh' },
  { id: 'settings', label: 'Store', icon: 'settings' },
];
// Each role gets its own portal: its own menu, labels and the four items on the phone's bottom bar.
//   Sales Clerk  → builds orders with the customer and sends them to the Cashier.
//   Cashier      → receives payment for the queue, walk-in sales, utang payments, cash drawer.
//   Stock Clerk  → inventory, deliveries, counts.
const PORTALS = {
  admin: { items: ['dashboard', 'pos', 'inventory', 'sales', 'utang', 'summary', 'attendance', 'expenses', 'reports', 'staff', 'sync', 'settings'], primary: ['dashboard', 'pos', 'inventory', 'sales'], labels: {} },
  cashier: { items: ['dashboard', 'orders', 'cash', 'attendance', 'summary', 'sales', 'expenses', 'utang'], primary: ['dashboard', 'orders', 'cash', 'attendance'], labels: { orders: 'Queue', cash: 'Drawer', expenses: 'My expenses' }, icons: { orders: 'bell' } },
  clerk: { items: ['dashboard', 'pos', 'orders', 'materials', 'utang', 'attendance'], primary: ['dashboard', 'pos', 'orders', 'materials'], labels: { pos: 'New order', orders: 'My orders' }, icons: { pos: 'plus' } },
  stock: { items: ['dashboard', 'inventory', 'attendance'], primary: ['dashboard', 'inventory', 'attendance'], labels: {} },
  both: { items: ['dashboard', 'pos', 'orders', 'inventory', 'utang', 'attendance'], primary: ['dashboard', 'pos', 'orders', 'inventory'], labels: { pos: 'New order', orders: 'My orders' }, icons: { pos: 'plus' } },
  attendance: { items: ['attendance'], primary: ['attendance'], labels: {} },
};
export const portalOf = user => user.role === 'admin' ? 'admin' : user.role === 'cashier' ? 'cashier' : user.role === 'sales' ? 'clerk' : user.role === 'stock' ? 'stock' : user.role === 'sales+stock' ? 'both' : 'attendance';
const ATTENDANCE_PAGES = new Set(['attendance', 'profile']);
const navFor = user => { const P = PORTALS[portalOf(user)]; return P.items.map(id => { const n = NAV.find(x => x.id === id); return { ...n, label: P.labels[id] || n.label, icon: P.icons?.[id] || n.icon, primary: P.primary.includes(id) }; }); };
const can = (item, user) => navFor(user).some(n => n.id === item.id);

// ---- Router --------------------------------------------------------------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  return { page: segments[0] || 'dashboard', params: segments.slice(1), query: new URLSearchParams(queryPart || '') };
}
export const go = (path) => { location.hash = path.startsWith('#') ? path : '#/' + path.replace(/^\//, ''); };
let renderToken = 0;
const loader = { el: null, n: 0, show() { this.n++; if (!this.el) { this.el = h('div.loadbar', h('i')); document.body.append(this.el); } this.el.classList.add('on'); }, hide() { this.n = Math.max(0, this.n - 1); if (!this.n && this.el) { this.el.classList.add('done'); setTimeout(() => { if (!this.n) this.el.classList.remove('on', 'done'); }, 350); } } };
export { loader };
// Scroll reveal: anything added below the fold animates in when scrolled into view.
const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }, { rootMargin: '0px 0px -8% 0px', threshold: .12 }) : null;
function watchReveal(root) {
  if (!io) return;
  const mark = el => { if (!(el instanceof Element)) return; const targets = el.matches('.card, .product, .kpi, .timeline__item, .cal') ? [el] : [...el.querySelectorAll('.card, .product, .kpi, .timeline__item')]; for (const t of targets) { if (t.classList.contains('reveal') || t.closest('.modal, .drawer')) continue; const r = t.getBoundingClientRect(); if (r.top > innerHeight) { t.classList.add('reveal'); io.observe(t); } } };
  new MutationObserver(muts => { for (const m of muts) m.addedNodes.forEach(mark); }).observe(root, { childList: true, subtree: true });
}
async function renderRoute() {
  if (!state.user) return;
  const { page, params, query } = parseHash();
  const item = NAV.find(n => n.id === page) || (page === 'materials' ? NAV.find(n => n.id === 'materials') : null);
  const home = state.user.role === 'attendance' ? 'attendance' : 'dashboard';
  const allowedPage = pages[page] && (state.user.role === 'attendance' ? ATTENDANCE_PAGES.has(page) : (page === 'profile' || page === 'notifications' || (page === 'materials' && state.user.role !== 'cashier') || page === 'sales' || !item || can(item, state.user)));
  if (!allowedPage) { go(home); return; }
  applyBrand(state.boot?.brandColor); // drops an unsaved colour preview from Store Profile
  const token = ++renderToken;
  const main = $('main.page');
  highlightNav(page);
  // Replace the old view immediately so a slow page can never leave a second page or nav state
  // floating over the destination. The destination's own skeleton keeps loading clear.
  for (const stale of main.querySelectorAll('.view.leaving')) stale.remove();
  const old = main.querySelector('.view');
  if (old) old.remove();
  const view = h('div.view.pending');
  main.append(view);
  loader.show();
  const work = pages[page]({ el: view, params, query, user: state.user, boot: state.boot, refresh: renderRoute })
    .catch(error => { if (error.status === 401) return; console.error(error); if (view.isConnected) clear(view).append(h('div.card', empty(errorOf(error), 'alert'))); });
  await Promise.race([work, new Promise(r => setTimeout(r, 140))]);
  if (token !== renderToken) { view.remove(); loader.hide(); return; }
  window.scrollTo({ top: 0, behavior: 'instant' });
  view.classList.remove('pending');
  await work; loader.hide();
}
function highlightNav(page) {
  const current = page === 'materials' && !navFor(state.user).some(n => n.id === 'materials') ? 'inventory' : page;
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === current));
  const pills = $('.topbar .pills'); if (pills) placeIndicator(pills);
  // Laptop side menu: keep the open page's button in view when the menu is taller than the screen.
  const railActive = $('.rail a.active'); if (railActive) railActive.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
// The side menu scrolls on short laptop screens (wheel, touchpad, or the ▲ / ▼ buttons); a soft fade
// and the buttons show that more items are above or below.
function railScroll(rail) {
  const step = dir => rail.scrollBy({ top: dir * Math.max(120, rail.clientHeight * 0.6), behavior: 'smooth' });
  const up = h('button.rail__more.up', { type: 'button', tabindex: -1, 'aria-label': 'Scroll menu up', onclick: () => step(-1) }, icon('chevronDown', 'sm'));
  const down = h('button.rail__more.down', { type: 'button', tabindex: -1, 'aria-label': 'Scroll menu down', onclick: () => step(1) }, icon('chevronDown', 'sm'));
  rail.prepend(up); rail.append(down);
  const update = () => {
    const above = rail.scrollTop > 2, below = rail.scrollTop + rail.clientHeight < rail.scrollHeight - 2;
    rail.classList.toggle('more-above', above); rail.classList.toggle('more-below', below);
  };
  rail.addEventListener('scroll', () => { hideNavTip(); update(); }, { passive: true });
  addEventListener('resize', update);
  if ('ResizeObserver' in window) new ResizeObserver(update).observe(rail);
  requestAnimationFrame(update);
}
function placeIndicator(pills) {
  const ind = $('.pills__ind', pills), active = $('button.active', pills);
  if (!ind) return;
  if (!active) { ind.style.opacity = 0; return; }
  ind.style.opacity = 1; ind.style.width = active.offsetWidth + 'px'; ind.style.transform = `translateX(${active.offsetLeft}px)`;
}

// ---- Shell ---------------------------------------------------------------
// Rail labels render in one floating layer on <body>, so page cards can never cover or clip them.
function hideNavTip() { if (navTip) navTip.classList.remove('on'); }
function railTips(rail) {
  if (!navTip) { navTip = h('div.navtip', { role: 'tooltip', id: 'navtip' }); document.body.append(navTip); window.addEventListener('hashchange', hideNavTip); window.addEventListener('scroll', hideNavTip, { passive: true }); }
  const show = el => { const r = el.getBoundingClientRect(); navTip.textContent = el.dataset.tip; navTip.style.top = `${r.top + r.height / 2}px`; navTip.style.left = `${r.right + 12}px`; navTip.classList.add('on'); el.setAttribute('aria-describedby', 'navtip'); };
  // Tooltips appear only when the mouse RESTS on an icon (~0.6 s), never when it just passes over
  // one, and never right after a click or a light/dark switch — so nothing pops up by itself.
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  for (const el of rail.querySelectorAll('[data-tip]')) {
    el.addEventListener('pointerenter', e => { cancel(); if (e.pointerType !== 'mouse' || el.dataset.quiet || Date.now() < tipMuteUntil) return; timer = setTimeout(() => { if (el.matches(':hover') && Date.now() >= tipMuteUntil) show(el); }, 600); });
    el.addEventListener('pointerleave', () => { cancel(); delete el.dataset.quiet; hideNavTip(); });
    el.addEventListener('focus', () => { if (el.matches(':focus-visible')) show(el); });
    el.addEventListener('blur', hideNavTip);
    // A mouse/touch click should not leave a focus highlight or tooltip behind; keyboard focus stays visible.
    el.addEventListener('pointerdown', () => { cancel(); hideNavTip(); tipMuteUntil = Date.now() + 1200; });
    el.addEventListener('pointerup', () => { el.dataset.quiet = '1'; hideNavTip(); setTimeout(() => el.blur(), 0); });
  }
}
function navLink(item, cls) {
  return h('a.' + cls, { href: '#/' + item.id, dataset: { nav: item.id, tip: item.label }, 'aria-label': item.label }, icon(item.icon), h('span.txt', item.label), item.id === 'inventory' || item.id === 'attendance' || item.id === 'sync' ? h('span.badge' + (item.id === 'sync' && state.boot?.offlinePending ? '' : '.hide'), { dataset: { badge: item.id } }, item.id === 'sync' && state.boot?.offlinePending ? String(state.boot.offlinePending) : '') : null);
}
function buildShell() {
  const user = state.user, boot = state.boot, nav = navFor(user);
  const primary = nav.filter(n => n.primary).slice(0, 5), secondary = nav.filter(n => !primary.includes(n));
  const pills = h('div.pills', h('span.pills__ind'), ...primary.map(n => h('button', { dataset: { nav: n.id }, onclick: () => go(n.id) }, icon(n.icon, 'sm'), h('span.txt', n.label))));
  const bellDot = h('span.dot' + (boot.unread ? '.on' : ''));
  const bell = h('button.iconbtn.bell', { 'aria-label': 'Notifications', onclick: openNotifications }, icon('bell'), bellDot);
  const theme = h('button.theme', { 'aria-label': 'Toggle light or dark mode', onclick: e => setTheme(currentTheme() === 'dark' ? 'light' : 'dark', e.currentTarget) }, icon('sun', 'sun'), icon('moon', 'moon'));
  const chip = h('button.userchip' + (user.photo ? '.has-photo' : ''), { onclick: () => go('profile'), style: user.photo ? { '--chip-img': `url(/media/staff/${user.id}?v=${Date.now() >> 16})` } : null }, user.photo ? h('span.userchip__bg') : avatarEl(user), h('span.userchip__text', h('b', user.name), h('small', titleOf(user))), icon('chevronDown', 'sm chev'));
  const portal = portalOf(user);
  const NEW = { admin: ['pos', 'New sale'], clerk: ['pos', 'New order'], both: ['pos', 'New order'], stock: ['inventory?action=new', 'New material'] }[portal];
  const newBtn = NEW ? h('button.btn.new', { onclick: () => go(NEW[0]) }, icon('plus', 'sm'), h('span.txt', NEW[1])) : null;
  document.documentElement.dataset.portal = portal;
  const logoVersion = Date.now() >> 16;
  const topbar = h('header.topbar', h('div.topbar__inner', h('div.brand', h('span.brand__mark', h('img', { src: '/media/logo?v=' + logoVersion, alt: '' })), h('span.brand__text', h('b', boot.storeName), h('span', titleOf(user)))), pills, h('span.topbar__spacer'), bell, newBtn, h('button.theme.theme-mobile', { 'aria-label': 'Toggle dark mode', onclick: e => setTheme(currentTheme() === 'dark' ? 'light' : 'dark', e.currentTarget) }, icon('sun', 'sun'), icon('moon', 'moon')), chip));
  theme.dataset.tip = 'Light / dark mode';
  const rail = h('aside.rail', { 'aria-label': 'Main navigation' }, h('div.rail__group', theme), h('div.rail__group', ...nav.map(n => navLink(n, ''))), h('div.rail__group', h('a', { href: '#/profile', dataset: { nav: 'profile', tip: 'My Profile' }, 'aria-label': 'My Profile' }, icon('user')), h('a', { href: '#', dataset: { tip: 'Sign out' }, 'aria-label': 'Sign out', onclick: e => { e.preventDefault(); signOut(); } }, icon('logout'))));
  railTips(rail); railScroll(rail);
  const bottomItems = [...primary, ...secondary].slice(0, Math.max(4, primary.length));
  const bottom = user.role === 'attendance' ? h('nav.bottomnav' + (bottomItems.length > 4 ? '.six' : ''), ...bottomItems.map(n => navLink(n, '')), h('a', { href: '#', onclick: e => { e.preventDefault(); signOut(); } }, icon('logout'), h('span.txt', 'Sign out'))) : h('nav.bottomnav', ...bottomItems.map(n => navLink(n, '')), h('a', { href: '#', onclick: e => { e.preventDefault(); moreSheet(nav); } }, icon('grid'), h('span.txt', 'More')));
  clear(app).append(h('div.shell', topbar, h('div.layout', rail, h('main.page')), bottom));
  watchReveal($('main.page'));
  requestAnimationFrame(() => placeIndicator(pills));
  addEventListener('resize', () => placeIndicator(pills));
  syncBar();
  pollNotifications();
}
export const avatarEl = (user, cls = '') => h('span.avatar' + (cls ? '.' + cls : ''), user.photo ? h('img', { src: `/media/staff/${user.id}?v=${Date.now() >> 16}`, alt: '' }) : initials(user.name));
function moreSheet(nav) {
  modal({ title: 'Menu', body: close => h('div.grid', { style: { gridTemplateColumns: 'repeat(3,1fr)' } }, ...nav.map(n => h('button.btn', { style: { height: '72px', flexDirection: 'column', borderRadius: '16px', gap: '6px' }, onclick: () => { close(); go(n.id); } }, icon(n.icon), h('span.small', n.label))), h('button.btn', { style: { height: '72px', flexDirection: 'column', borderRadius: '16px', gap: '6px' }, onclick: () => { close(); go('profile'); } }, icon('user'), h('span.small', 'Profile')), h('button.btn.danger', { style: { height: '72px', flexDirection: 'column', borderRadius: '16px', gap: '6px' }, onclick: () => { close(); signOut(); } }, icon('logout'), h('span.small', 'Sign out'))) });
}

// ---- Notifications --------------------------------------------------------
let lastUnread = 0;
async function pollNotifications() {
  const tick = async () => {
    if (!state.user || document.hidden) return;
    try {
      const d = await api.get('notifications');
      const dot = $('.bell .dot'); if (dot) dot.classList.toggle('on', d.unread > 0);
      if (d.unread > lastUnread && lastUnread !== 0) { $('.bell')?.classList.add('ring'); sound.play('notify'); setTimeout(() => $('.bell')?.classList.remove('ring'), 900); }
      lastUnread = d.unread;
      updateBadges(d.items);
      pushGeneric(d.items);
    } catch { /* offline */ }
  };
  lastUnread = state.boot.unread; tick();
  clearInterval(pollNotifications.timer); pollNotifications.timer = setInterval(tick, 20000);
}
// Generic device push (no amounts shown on the lock screen) for the employee's own salary records.
let lastPushed = Number(sessionStorage.getItem('alaan.pushed') || 0);
function pushGeneric(items) {
  const fresh = items.filter(i => !i.read && i.kind === 'salary' && i.id > lastPushed);
  if (!fresh.length) return;
  lastPushed = Math.max(...fresh.map(i => i.id)); try { sessionStorage.setItem('alaan.pushed', lastPushed); } catch { /* private */ }
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(state.boot.appName || state.boot.storeName || 'DLKM BizPulse', { body: 'You have a new salary payment record. Open the app to view it.', icon: '/icon-192.png', tag: 'salary' }); } catch { /* unsupported */ }
}
export async function enablePush() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}
function updateBadges(items) {
  const pendingCounts = items.filter(i => !i.read && i.kind === 'count').length, pendingEx = items.filter(i => !i.read && i.kind === 'excuse').length;
  $$('[data-badge="inventory"]').forEach(b => { b.textContent = pendingCounts; b.classList.toggle('hide', !pendingCounts || state.user.role !== 'admin'); });
  $$('[data-badge="attendance"]').forEach(b => { b.textContent = pendingEx; b.classList.toggle('hide', !pendingEx || state.user.role !== 'admin'); });
}
const kindIcon = { sale: ['receipt', 'ok'], stock: ['boxes', 'info'], count: ['clipboard', 'warn'], attendance: ['clock', 'info'], excuse: ['calendar', 'warn'], payment: ['handCoins', 'ok'], price: ['tag', 'info'], material: ['box', 'info'], profile: ['user', 'info'], salary: ['coins', 'ok'], sync: ['refresh', 'warn'] };
async function openNotifications() {
  const d = drawer({ title: 'Activity', body: h('div', skeletonList()), actions: h('button.btn.sm', { onclick: async () => { await api.action('notifications.read', {}); $('.bell .dot')?.classList.remove('on'); lastUnread = 0; load(); } }, 'Mark all read') });
  const load = async () => {
    const data = await api.get('notifications');
    clear(d.body);
    if (!data.items.length) { d.body.append(empty('No activity yet', 'bell')); return; }
    const list = h('div.list.stagger');
    data.items.forEach((n, i) => {
      const [ic, tone] = kindIcon[n.kind] || ['info', ''];
      list.append(h('div.list__item.click' + (n.read ? '' : '.unread'), { style: { '--i': Math.min(i, 12) }, onclick: async () => { if (!n.read) await api.action('notifications.read', { ids: [n.id] }); d.close(); if (n.link) location.hash = n.link; } },
        h('span.ic.' + tone, icon(ic)), h('span.body', h('b', n.title), h('span', n.detail)), h('span.small.muted', ago(n.created))));
    });
    d.body.append(list);
  };
  load().catch(e => { clear(d.body).append(empty(errorOf(e), 'alert')); });
}
const skeletonList = () => h('div.col', ...Array.from({ length: 5 }, () => h('div.row', h('div.sk', { style: { width: '36px', height: '36px', borderRadius: '12px' } }), h('div.col.grow', { style: { gap: '6px' } }, h('div.sk.text', { style: { width: '50%' } }), h('div.sk.text', { style: { width: '80%' } })))));

// ---- Connection bar: slow connection, no connection (brownout / no internet), offline mode ----
// One bar under the top bar tells every role what is happening and what to do:
//   slow      → "Slow connection — still loading…"        (after 2.5 s; Offline mode offered after 8 s)
//   no server → "No connection to the server"              [Go to offline mode] [Try again]
//   offline   → "Offline mode · N pending sync"            [Go online]  (sales/orders, attendance and
//                stock are saved on this device and uploaded when the connection returns)
//   pending   → "N pending sync"                           [Sync now] / "Uploading…"
function syncBar() {
  let bar = null, slowSince = 0, slowTimer = null;
  // The bar floats under the top bar; the page keeps the same space free above its content, so the
  // bar never covers buttons (e.g. Stock Out while offline) — whatever the language's text length.
  const space = px => document.documentElement.style.setProperty('--netbar-space', px + 'px');
  const place = () => { if (!bar) return space(0); const tb = document.querySelector('.topbar'); bar.style.top = Math.max(8, Math.round(tb ? tb.getBoundingClientRect().bottom + 8 : 8)) + 'px'; space(Math.round(bar.offsetHeight + 12)); };
  const btn = (cls, label, fn, ic) => h('button.btn.sm.' + cls, { onclick: e => busy(e.currentTarget, async () => { await fn(); update(); }) }, ic ? icon(ic, 'sm') : null, label);
  const update = () => {
    const pending = queue.all(), n = pending.length, errors = pending.filter(p => p.error).length;
    const noServer = !navigator.onLine || !net.reachable;
    let kind = null, ic = null, text = null, actions = [];
    if (net.manual) {
      kind = 'offline'; ic = icon('wifiOff', 'sm');
      text = h('span', h('b', 'Offline mode'), ` · ${n} pending sync`, h('small', noServer ? 'Sales/orders, attendance and stock are saved on this device.' : 'The connection is back — you can sync now.'));
      actions = [btn(noServer ? 'soft' : 'primary', noServer ? 'Go online' : 'Go online & sync', async () => { setOfflineMode(false); await checkServer(); if (net.reachable) await queue.sync(); }, 'refresh')];
    } else if (noServer) {
      kind = 'down'; ic = h('span.pulse');
      text = h('span', h('b', 'No connection to the server'), n ? ` · ${n} saved on this device` : '', h('small', 'Brownout or no internet? Use offline mode — transactions and attendance are saved on this device.'));
      actions = [btn('primary', 'Go to offline mode', () => setOfflineMode(true), 'wifiOff'), btn('soft', 'Try again', () => checkServer(), 'refresh')];
    } else if (net.slow > 0) {
      if (!slowSince) { slowSince = Date.now(); clearTimeout(slowTimer); slowTimer = setTimeout(update, 8200); }
      kind = 'slow'; ic = h('span.spin');
      text = h('span', h('b', 'Slow connection'), ' — still loading, please wait…');
      if (Date.now() - slowSince > 8000) actions = [btn('soft', 'Offline mode', () => setOfflineMode(true), 'wifiOff')];
    } else if (n) {
      kind = 'pending'; ic = queue.syncing ? h('span.spin') : icon('refresh', 'sm');
      text = h('span', queue.syncing ? `Uploading ${n} pending…` : `${n} pending sync`);
      if (!queue.syncing) actions = [btn('soft', 'Sync now', () => queue.sync())];
    }
    if (net.slow <= 0) { slowSince = 0; clearTimeout(slowTimer); }
    if (errors) actions.push(h('button.btn.sm.danger', { onclick: () => reviewQueue() }, `Needs review (${errors})`));
    document.body.classList.toggle('is-offline', !!net.manual || noServer);
    if (!kind) { if (bar) { const old = bar; bar = null; old.classList.add('out'); setTimeout(() => old.remove(), 250); } space(0); return; }
    const next = h('div.syncbar.netbar.' + kind, { role: 'status', 'aria-live': 'polite' }, h('span.netbar__ic', ic), text, h('span.netbar__actions', ...actions));
    if (bar) bar.replaceWith(next); else document.body.append(next);
    bar = next; place();
  };
  for (const ev of ['alaan:queue', 'alaan:online', 'alaan:net']) addEventListener(ev, update);
  addEventListener('resize', place); addEventListener('scroll', place, { passive: true });
  update();
}
function reviewQueue() {
  const items = queue.all();
  modal({ title: 'Entries needing review', subtitle: 'These offline entries were rejected by the server.', body: close => h('div.list', ...items.filter(p => p.error).map(p => h('div.list__item', h('span.ic.danger', icon('alert')), h('span.body', h('b', p.action), h('span', p.error)), h('button.btn.sm.ghost', { onclick: () => { queue.remove(p.key); close(); } }, 'Discard')))) });
}

/** The app name the Admin chose (browser tab / installed app); the server also writes it into the page. */
export function setAppName(name) {
  if (!name) return;
  if (document.title !== name) document.title = name;
  for (const m of document.querySelectorAll('meta[name="apple-mobile-web-app-title"], meta[name="application-name"]')) m.content = name;
}

// ---- Sign in / out ----------------------------------------------------------
async function showLogin() {
  let branding = { storeName: 'JS ALAAN HARDWARE', demo: false };
  try { branding = await api.get('branding'); applyBrand(branding.brandColor); } catch { /* server offline */ }
  setAppName(branding.appName);
  const user = input({ name: 'username', placeholder: 'Username', autocomplete: 'username', autocapitalize: 'none', required: true });
  const pass = input({ name: 'password', type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const eye = h('button.iconbtn', { type: 'button', style: { position: 'absolute', right: '4px', top: '1px', width: '38px', height: '38px', border: 0, background: 'none' }, 'aria-label': 'Show password', onclick: () => { pass.type = pass.type === 'password' ? 'text' : 'password'; clear(eye).append(icon(pass.type === 'password' ? 'eye' : 'eyeOff', 'sm')); } }, icon('eye', 'sm'));
  const submit = h('button.btn.primary.lg.block', { type: 'submit' }, 'Sign in', icon('arrowRight', 'sm'));
  const form = h('form.col', { style: { gap: '12px' }, onsubmit: async e => {
    e.preventDefault(); showError(form, '');
    await busy(submit, async () => {
      try { const r = await api.login(user.value.trim(), pass.value); await enter(r.user); }
      catch (error) { showError(form, errorOf(error)); pass.classList.add('err'); setTimeout(() => pass.classList.remove('err'), 500); }
    });
  } }, h('div.field', user), h('div.field', { style: { position: 'relative' } }, pass, eye), submit);
  const card = h('div.login__card',
    h('div.login__brand', h('span.logo', h('img', { src: '/media/logo?v=' + (Date.now() >> 16), alt: 'Store logo' })), h('h1', branding.storeName), h('p', 'Sign in to continue')),
    form,
    h('div.login__lang', icon('globe', 'sm'), langSwitch(code => { if (code === lang) return; try { sessionStorage.setItem(LANG_PICKED, '1'); } catch { /* blocked */ } switchLanguage(code, null); })));
  clear(app).append(h('div.login', h('div.login__bg', { style: { '--login-bg': 'url(/media/background)' } }), h('div.login__veil'), card));
  setTimeout(() => user.focus(), 300);
}
// The account's language wins over the device's, except right after it was picked on the
// sign-in card (then that pick is saved to the account).
const LANG_PICKED = 'alaan.langPicked', LANG_PENDING = 'alaan.langPending';
// Saves the language on the account. Until the server confirms, the device remembers that its
// choice still has to reach the account (a pick made offline is not undone at the next sign-in).
async function saveLang(code, id = state.user?.id) {
  try { localStorage.setItem(LANG_PENDING, String(id ?? '')); } catch { /* blocked */ }
  await api.action('profile.lang', { lang: code });
  try { localStorage.removeItem(LANG_PENDING); } catch { /* blocked */ }
}
async function syncLanguage(user) {
  let picked = false;
  try { picked = sessionStorage.getItem(LANG_PICKED) === '1' || localStorage.getItem(LANG_PENDING) === String(user.id); sessionStorage.removeItem(LANG_PICKED); } catch { /* blocked */ }
  if (picked) { if (user.lang !== lang) saveLang(lang, user.id).catch(() => {}); else { try { localStorage.removeItem(LANG_PENDING); } catch { /* blocked */ } } return false; }
  if (user.lang && user.lang !== lang) {
    rememberLang(user.lang);
    // Reload only when the choice really stuck on this device and we have not just reloaded for it
    // (storage blocked / private window): never a reload loop.
    let stuck = false, recent = false;
    try { stuck = localStorage.getItem('alaan.lang') === user.lang; recent = Date.now() - Number(sessionStorage.getItem('alaan.langReload') || 0) < 30000; sessionStorage.setItem('alaan.langReload', String(Date.now())); } catch { /* blocked */ }
    if (stuck && !recent) { showLoading(user.lang); setTimeout(() => location.reload(), 600); return true; }
  }
  return false;
}
export function changeLanguage(code) {
  if (code === lang) return;
  sound.play('tap');
  switchLanguage(code, state.user ? c => saveLang(c) : null);
}
function langSwitch(onPick) {
  return h('div.langswitch', { role: 'group', 'aria-label': 'Language' }, ...LANGS.map(l => h('button' + (l.code === lang ? '.on' : ''), { type: 'button', 'data-no-i18n': '', 'aria-pressed': String(l.code === lang), onclick: () => onPick(l.code) }, l.name)));
}
export { langSwitch };
async function enter(user) {
  if (await syncLanguage(user)) return;
  state.user = user;
  offlineCache.put('/api/me', { user }); // a prepared device can reopen My Attendance without connection
  if (user.temporary) { await forcePasswordChange(); }
  state.boot = await api.get('bootstrap');
  applyBrand(state.boot.brandColor); setAppName(state.boot.appName);
  state.user = state.boot.user;
  buildShell();
  if (!location.hash || location.hash === '#/' || state.user.role === 'attendance') go(state.user.role === 'attendance' ? 'attendance' : 'dashboard');
  await renderRoute();
  queue.sync();
  setTimeout(prepareOffline, 2500);
}
// Prepare this device for a brownout: quietly keep a fresh copy of the screens that work offline
// (attendance, the catalog for sales/orders and stock, customers, suppliers), so offline mode works
// even for a screen nobody opened before the connection went down.
async function prepareOffline() {
  const u = state.user; if (!u || !navigator.onLine || net.manual || !net.reachable) return;
  const jobs = [];
  if (u.role !== 'admin') jobs.push(() => api.get('attendance', { month: monthPH(), day: todayPH() }), () => api.get('offline'));
  if (u.role !== 'attendance') jobs.push(() => api.get('materials'));
  if (u.role === 'admin' || u.role.includes('sales')) jobs.push(() => api.get('customers'));
  if (u.role === 'admin' || u.role.includes('stock')) jobs.push(() => api.get('suppliers'));
  for (const job of jobs) { if (!net.reachable || net.manual) break; await job().catch(() => {}); }
}
addEventListener('alaan:synced', () => setTimeout(prepareOffline, 1500));
function forcePasswordChange() {
  return new Promise(resolve => {
    const current = input({ type: 'password', placeholder: 'Temporary password', autocomplete: 'current-password' }), next = input({ type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' }), again = input({ type: 'password', placeholder: 'Repeat new password', autocomplete: 'new-password' });
    const body = h('div.form', field('Temporary password', current), field('New password', next), field('Repeat', again));
    modal({ title: 'Set your own password', subtitle: 'Your account uses a temporary password. Choose a new one to continue.', closable: false, body,
      foot: close => h('button.btn.primary', { onclick: async e => { showError(body, ''); if (next.value !== again.value) return showError(body, 'The new passwords do not match.'); await busy(e.currentTarget, async () => { try { await api.password(current.value, next.value); toast('Password updated', 'ok'); close(); resolve(); } catch (err) { showError(body, errorOf(err)); } }); } }, 'Save password') });
  });
}
export async function signOut() {
  const body = h('p.muted', 'Are you sure you want to sign out?');
  await new Promise(resolve => {
    modal({ title: 'Confirm sign out', body, foot: close => [
      h('button.btn', { onclick: () => { close(); resolve(false); } }, 'Stay signed in'),
      h('button.btn.danger', { onclick: () => { close(); resolve(true); } }, 'Sign out'),
    ] });
  }).then(async confirmed => {
    if (!confirmed) return;
    offlineCache.clear();
    try { await api.logout(); } catch { /* allow sign out when offline */ }
    state.user = null; state.boot = null; renderToken++;
    clearInterval(pollNotifications.timer);
    location.hash = ''; showLogin();
  });
}
export async function reloadBoot() { state.boot = await api.get('bootstrap'); applyBrand(state.boot.brandColor); setAppName(state.boot.appName); state.user = state.boot.user; buildShell(); highlightNav(parseHash().page); }

// ---- Boot -------------------------------------------------------------------
addEventListener('hashchange', renderRoute);

// Opened inside an editor preview (e.g. VS Code's Simple Browser) instead of a real browser:
// that preview is an embedded frame with limited storage, cookies and service workers, so pages
// can misbehave there. Say so plainly and offer to open the system in Chrome/Edge.
(function framedNotice() {
  let framed = false; try { framed = window.self !== window.top; } catch { framed = true; }
  if (!framed) return;
  const url = location.origin + '/';
  const note = h('div.framed-note', { role: 'status' },
    icon('alert', 'sm'),
    h('span', h('b', 'You are in an editor preview (e.g. VS Code Simple Browser). '), 'Navigation, sign-in and offline mode may misbehave here. Open it in Chrome or Edge: ', h('code', url)),
    h('a.btn.sm.primary', { href: url, target: '_blank', rel: 'noopener' }, 'Open in browser'),
    h('button.btn.sm.ghost', { onclick: () => note.remove(), 'aria-label': 'Isara' }, '✕'));
  const put = () => document.body.prepend(note);
  if (document.body) put(); else addEventListener('DOMContentLoaded', put);
})();
// After reconnecting and uploading offline entries, refresh screens that show their status.
addEventListener('alaan:synced', () => { const pg = parseHash().page; if (state.user && (pg === 'attendance' || pg === 'profile' || pg === 'sync')) renderRoute(); });
addEventListener('alaan:online', () => { const pg = parseHash().page; if (state.user && navigator.onLine && pg === 'attendance' && !queue.all().length) renderRoute(); });
addEventListener('alaan:signout', () => { toast('Session ended. Please sign in again.', 'warn'); showLogin(); });
(async () => {
  clear(app).append(h('div.splash', h('div.splash__logo', h('img', { src: '/media/logo', alt: '' })), h('div.splash__dots', h('i'), h('i'), h('i'))));
  try { const me = await api.get('me'); if (me.user) await enter(me.user); else showLogin(); }
  catch { showLogin(); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // App files carry a version tag (server.mjs), so a new version never mixes with old files
    // and no forced reload is needed; the check for a new service worker runs on every start.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(r => r.update?.()).catch(() => {});
  }
})();
