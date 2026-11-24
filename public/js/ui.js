// Small UI toolkit: element builder, formatters, toasts, modals, charts.
import { LOCALE } from './i18n.js';
export { LOCALE, t, lang } from './i18n.js';
import { icon } from './icons.js';
import { sound } from './sound.js';
export { sound };

// ---- Element builder --------------------------------------------------
// h('div.card.flat#id', {onclick, attrs}, children...)  — children may be
// strings, nodes, arrays, or null. Strings are text (safe by default).
export function h(spec, props, ...children) {
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  const [tag, ...rest] = spec.split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const part of rest) { if (part.length < 2) continue; part[0] === '.' ? el.classList.add(part.slice(1)) : (el.id = part.slice(1)); }
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isPhone = () => matchMedia('(max-width: 760px)').matches;

// ---- Formatters -------------------------------------------------------
const pesoFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 });
export const peso = v => v === null || v === undefined ? '—' : pesoFmt.format(v);
export const pesoShort = v => { const a = Math.abs(v); const s = a >= 1_000_000 ? (v / 1_000_000).toFixed(2) + 'M' : a >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)); return '₱' + s; };
export const num = v => v === null || v === undefined ? '—' : numFmt.format(v);
export const qtyText = (v, unit) => `${num(v)} ${unit}`;
export const dateText = (iso, opts = { month: 'short', day: 'numeric' }) => iso ? new Date(iso.length === 10 ? iso + 'T00:00:00+08:00' : iso).toLocaleDateString(LOCALE, { timeZone: 'Asia/Manila', ...opts }) : '—';
export const dateLong = iso => dateText(iso, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const timeText = iso => iso ? new Date(iso).toLocaleTimeString(LOCALE, { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }) : '—';
export const dateTime = iso => iso ? `${dateText(iso)} · ${timeText(iso)}` : '—';
export const ago = iso => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago'; return dateText(iso);
};
export const todayPH = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const monthPH = () => todayPH().slice(0, 7);
export const greeting = () => { const hr = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false }).format(new Date())); return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };
export const initials = name => name.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
export const roleName = r => ({ admin: 'Admin', sales: 'Sales Clerk', cashier: 'Cashier', stock: 'Stock Clerk', 'sales+stock': 'Sales & Stock Clerk', attendance: 'Staff' }[r] || r);
// Display title for a user object: custom job title for attendance-only staff, role name otherwise.
export const titleOf = u => u?.title || u?.jobTitle || roleName(u?.role);
export const statusName = s => ({ high: 'High stock', adequate: 'Adequate', low: 'Low stock', out: 'Out of stock' }[s] || s);

// ---- Promo pricing (mirrors src/pricing.mjs; server recomputes at checkout) ----
export function priceLine(m, qty) {
  const regular = Math.round(m.price * qty * 100) / 100;
  let final = regular, detail = '';
  const promo = m.promo;
  if (promo?.type === 'percent') { final = Math.round(Math.round(m.price * (100 - promo.value)) / 100 * qty * 100) / 100; detail = `${promo.value}% off`; }
  else if (promo?.type === 'fixed') { final = Math.round(promo.value * qty * 100) / 100; detail = `Promo price ${peso(promo.value)} each`; }
  else if (promo?.type === 'bundle') { const groups = Math.floor(qty / promo.qty), rest = qty - groups * promo.qty; final = Math.round((groups * promo.value + rest * m.price) * 100) / 100; detail = groups > 0 ? `${groups} × (${promo.qty} for ${peso(promo.value)})${rest ? ` + ${rest} at regular price` : ''}` : `Add ${promo.qty - rest} more for ${promo.qty} for ${peso(promo.value)}`; }
  return { regular, final, savings: Math.round((regular - final) * 100) / 100, detail, promo };
}
export const minutesText = m => m === null || m === undefined ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

// ---- Count-up animation ----------------------------------------------
const countFrames = new WeakMap();

export function countUp(el, value, { format = num, duration = 900 } = {}) {
  cancelAnimationFrame(countFrames.get(el));
  if (reduced() || !Number.isFinite(value)) { el.dataset.v = value; el.textContent = format(value); return; }
  const start = performance.now();
  const from = Number(el.dataset.v || 0);
  const step = now => {
    const t = Math.min(1, (now - start) / duration), e = 1 - Math.pow(1 - t, 3);
    const displayed = from + (value - from) * e;
    el.dataset.v = displayed;
    el.textContent = format(displayed);
    if (t < 1) countFrames.set(el, requestAnimationFrame(step));
  };
  countFrames.set(el, requestAnimationFrame(step));
}

// ---- Ripple on buttons -------------------------------------------------
document.addEventListener('pointerdown', e => {
  const btn = e.target.closest('.btn, .pills button, .chip, .product, .clockbtn');
  if (!btn || reduced()) return;
  // The ink lives in a clipped layer INSIDE the pressed button. (Before, buttons without their own
  // positioning — like the top tabs — placed it relative to the whole tab bar, so a dark circle
  // appeared over "Overview" whichever tab was pressed.)
  if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
  const r = btn.getBoundingClientRect(), size = Math.max(r.width, r.height) * 1.2;
  const layer = h('span.ripple-layer', h('span.ripple', { style: { width: size + 'px', height: size + 'px', left: e.clientX - r.left - size / 2 + 'px', top: e.clientY - r.top - size / 2 + 'px' } }));
  btn.append(layer); setTimeout(() => layer.remove(), 600);
});

// ---- Motion helpers -----------------------------------------------------
export const bump = el => { if (!el || reduced()) return; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); };
export const flash = el => { if (!el || reduced()) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); };
export const haptic = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
/** Animate a small ghost from one element to another (e.g. product → cart). */
export function flyTo(fromEl, toEl, imgSrc) {
  if (!fromEl || !toEl || reduced()) return;
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  const ghost = h('div.fly', imgSrc ? h('img', { src: imgSrc }) : icon('box'));
  ghost.style.left = a.left + a.width / 2 - 28 + 'px'; ghost.style.top = a.top + a.height / 2 - 28 + 'px';
  document.body.append(ghost);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  ghost.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx * .5}px, ${dy * .5 - 80}px) scale(.8)`, opacity: 1, offset: .55 }, { transform: `translate(${dx}px, ${dy}px) scale(.2)`, opacity: .4 }], { duration: 650, easing: 'cubic-bezier(.22,.61,.36,1)' }).onfinish = () => ghost.remove();
}
/** Confetti burst around an element. */
export function confetti(originEl, count = 26) {
  sound.play('success');
  if (reduced()) return;
  const r = originEl ? originEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const palette = ['#0f7a52', '#34d399', '#d9f99d', '#f2b14a', '#7aa7f5', '#f472b6'];
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2, dist = 90 + Math.random() * 160;
    const p = h('span.confetti', { style: { left: cx + 'px', top: cy + 'px', background: palette[i % palette.length], '--dx': Math.cos(ang) * dist + 'px', '--dy': Math.sin(ang) * dist + 120 + 'px', '--rot': (Math.random() * 720 - 360) + 'deg', animationDelay: Math.random() * 120 + 'ms' } });
    document.body.append(p); setTimeout(() => p.remove(), 1400);
  }
}

// ---- Toasts -------------------------------------------------------------
export function toast(message, kind = 'ok', ms = 3200) {
  const box = $('#toasts');
  const name = kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : kind === 'warn' ? 'warn' : 'info';
  const t = h('div.toast.' + kind, { style: { '--toast-ms': ms + 'ms' } }, icon(name), h('span', message));
  if (kind === 'err') sound.play('error'); else if (kind === 'warn') sound.play('warn');
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

// ---- Modal --------------------------------------------------------------
export function modal({ title, subtitle, body, foot, size = '', onClose, closable = true }) {
  const layers = $('#layers');
  const panel = h('div.modal' + (size ? '.' + size : ''), { role: 'dialog', 'aria-modal': 'true' });
  const overlay = h('div.overlay', panel);
  const close = () => { if (overlay.classList.contains('closing')) return; overlay.classList.add('closing'); setTimeout(() => { overlay.remove(); onClose?.(); }, 200); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape' && closable) close(); };
  if (title) panel.append(h('div.modal__head', h('div', h('h2', title), subtitle ? h('p', subtitle) : null), closable ? h('button.iconbtn', { onclick: close, 'aria-label': 'Close' }, icon('x')) : null));
  const bodyEl = h('div.modal__body'); append(bodyEl, [typeof body === 'function' ? body(close) : body]); panel.append(bodyEl);
  if (foot) { const f = h('div.modal__foot'); append(f, [typeof foot === 'function' ? foot(close) : foot]); panel.append(f); }
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay && closable) close(); });
  document.addEventListener('keydown', esc);
  layers.append(overlay);
  setTimeout(() => $('input, select, textarea, button.primary', panel)?.focus(), 80);
  return { close, panel };
}
export const confirm = ({ title, message, okText = 'Confirm', danger = false, requireReason = false }) => new Promise(resolve => {
  let reason;
  const m = modal({
    title, size: 'narrow',
    body: close => h('div.col', h('p.muted', message), requireReason ? (reason = h('textarea.textarea', { placeholder: 'Reason (required)' })) : null),
    foot: close => [
      h('button.btn', { onclick: () => { close(); resolve(null); } }, 'Cancel'),
      h('button.btn' + (danger ? '.danger.solid' : '.primary'), { onclick: () => { if (requireReason && !reason.value.trim()) { reason.classList.add('err'); return; } close(); resolve(requireReason ? reason.value.trim() : true); } }, okText),
    ],
    onClose: () => resolve(null),
  });
});

// ---- Drawer -------------------------------------------------------------
export function drawer({ title, body, actions }) {
  const layers = $('#layers');
  const panel = h('div.drawer');
  const overlay = h('div.overlay', { style: { placeItems: 'stretch', padding: 0 } }, panel);
  const close = () => { overlay.classList.add('closing'); panel.classList.add('closing'); setTimeout(() => overlay.remove(), 200); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  panel.append(h('div.drawer__head', h('h2', title), h('div.row', actions, h('button.iconbtn', { onclick: close }, icon('x')))));
  const b = h('div.drawer__body'); append(b, [typeof body === 'function' ? body(close) : body]); panel.append(b);
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close(); });
  layers.append(overlay);
  return { close, body: b };
}

// ---- Buttons with loading state -------------------------------------
export async function busy(btn, work) {
  btn.classList.add('loading'); btn.disabled = true;
  try { return await work(); } finally { btn.classList.remove('loading'); btn.disabled = false; }
}
export function errorOf(error) { return error?.message || 'Something went wrong.'; }

// ---- Segmented control with sliding indicator ---------------------------
export function segmented(options, value, onChange, { small = false } = {}) {
  const ind = h('span.seg__ind');
  const el = h('div.seg' + (small ? '.sm' : ''), ind);
  const buttons = options.map(o => h('button', { type: 'button', onclick: () => { if (o.value === current) return; set(o.value); onChange(o.value); } }, o.label));
  let current = value;
  const set = v => { current = v; buttons.forEach((b, i) => b.classList.toggle('active', options[i].value === v)); place(); };
  const place = () => { const b = buttons.find(b => b.classList.contains('active')); if (!b) return; ind.style.width = b.offsetWidth + 'px'; ind.style.transform = `translateX(${b.offsetLeft - 3}px)`; };
  el.append(...buttons);
  requestAnimationFrame(() => { set(current); requestAnimationFrame(place); });
  el.set = set; el.place = place;
  return el;
}

// ---- Form helpers -----------------------------------------------------
export function field(label, control, hint) { return h('div.field', h('label', label), control, hint ? h('span.hint', hint) : null); }
export function input(props = {}) { return h('input.input', { type: 'text', ...props }); }
export function select(options, props = {}) {
  const s = h('select.select', props);
  for (const o of options) s.append(h('option', { value: o.value ?? o, selected: (o.value ?? o) === props.value }, o.label ?? o));
  return s;
}
export function paymentFields(onChange = () => {}) {
  const method = select(['Cash', 'GCash', 'Maya', 'Bank transfer', 'Other']);
  const other = input({ maxlength: 60, placeholder: 'Specify the payment method' });
  const reference = input({ maxlength: 120, placeholder: 'Optional' });
  const otherField = field('Other payment method', other);
  otherField.style.display = 'none';
  method.onchange = () => { otherField.style.display = method.value === 'Other' ? '' : 'none'; onChange(); };
  other.oninput = onChange;
  return { el: h('div.form', field('Payment method', method), otherField, field('Payment reference', reference)), method,
    valid: () => (method.value !== 'Other' || !!other.value.trim()) && (method.value === 'Cash' || !!reference.value.trim()),
    values: () => ({ paymentMethod: method.value, paymentOther: method.value === 'Other' ? other.value : undefined, reference: reference.value }) };
}

export function showError(container, message) {
  container.querySelector('.formerr')?.remove();
  if (message) container.prepend(h('div.formerr', icon('alert', 'sm'), message));
}
export function values(form) { return Object.fromEntries([...form.querySelectorAll('[name]')].map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value])); }
// Resize an image file in the browser to a small JPEG data URL.
export const readPhoto = (file, max = 720) => new Promise((resolve, reject) => {
  const img = new Image(); const url = URL.createObjectURL(file);
  img.onload = () => {
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.82));
  };
  img.onerror = () => reject(new Error('Could not read the photo.'));
  img.src = url;
});
export function photoPicker({ current, onPick, label = 'Photo' }) {
  const preview = h('div.preview', current ? h('img', { src: current }) : icon('camera'));
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'sr-only', onchange: async () => { if (!file.files[0]) return; try { const data = await readPhoto(file.files[0]); clear(preview).append(h('img', { src: data })); onPick(data); } catch (e) { toast(errorOf(e), 'err'); } } });
  return h('div.photo-pick', preview, h('div.col', { style: { gap: '6px' } }, h('span.label', label), h('div.row', h('button.btn.sm', { type: 'button', onclick: () => file.click() }, icon('camera', 'sm'), 'Take or upload'), file), h('span.hint', 'JPEG, resized automatically')));
}

// ---- Empty state ----------------------------------------------------
export const empty = (message, name = 'inbox') => h('div.empty', icon(name), h('span', message));
export const skeleton = (n = 3) => h('div.col', ...Array.from({ length: n }, () => h('div.card', h('div.sk.title'), h('div.sk.text', { style: { marginTop: '12px' } }), h('div.sk.block', { style: { marginTop: '12px', height: '70px' } }))));

// ---- Tag -------------------------------------------------------------
export const tag = (text, kind = text) => h('span.tag', { class: kind }, text);

// ---- Charts (inline SVG, animated) ------------------------------------
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
export const colors = { sales: 'var(--primary)', expenses: 'var(--warn)', collections: 'var(--info)', net: 'var(--ink)' };

export function sparkline(values, { color = 'var(--primary)', fill = true } = {}) {
  const w = 100, hgt = 30, max = Math.max(...values, 1), min = Math.min(...values, 0);
  const pts = values.map((v, i) => [i / Math.max(1, values.length - 1) * w, hgt - 3 - (v - min) / (max - min || 1) * (hgt - 6)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const el = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'spark', preserveAspectRatio: 'none' });
  if (fill) { const grad = 'g' + Math.random().toString(36).slice(2, 7); const defs = svg('defs'); const lg = svg('linearGradient', { id: grad, x1: 0, y1: 0, x2: 0, y2: 1 }); lg.append(svg('stop', { offset: 0, 'stop-color': color, 'stop-opacity': .35 }), svg('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 })); defs.append(lg); el.append(defs); el.append(svg('path', { d: d + ` L${w} ${hgt} L0 ${hgt} Z`, fill: `url(#${grad})`, class: 'area' })); }
  const path = svg('path', { d, stroke: color, class: 'line' + (reduced() ? '' : ' draw') });
  el.append(path);
  requestAnimationFrame(() => { try { const len = path.getTotalLength(); path.style.setProperty('--len', len); } catch { /* not rendered */ } });
  return el;
}

let tip;
// Chart labels can be material or staff names typed by people: always escaped before display.
const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function showTip(x, y, html) { tip ??= document.body.appendChild(h('div.tooltip')); tip.innerHTML = html; tip.classList.add('on'); const r = tip.getBoundingClientRect(); tip.style.left = Math.min(innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + 'px'; tip.style.top = Math.max(8, y - r.height - 14) + 'px'; }
function hideTip() { tip?.classList.remove('on'); }

/**
 * Charts are drawn at the REAL pixel size of their box (no stretching), so numbers and dates keep
 * their shape on every screen. They redraw when the box changes size (rotate a phone, resize a
 * window) and animate the first time they scroll into view.
 */
function responsive(draw, height) {
  const box = h('div.chartbox', { style: { height: height + 'px' } });
  let lastW = 0, played = false, timer = null;
  const render = () => {
    const w = Math.round(box.clientWidth); if (!w || Math.abs(w - lastW) < 2) return;
    lastW = w; const el = draw(w);
    if (played) el.classList.add('play', 'instant');
    box.replaceChildren(el);
    if (!played) playOnView(el, () => { played = true; });
  };
  if ('ResizeObserver' in window) new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(render, lastW ? 120 : 0); }).observe(box);
  else requestAnimationFrame(() => { lastW = 0; render(); });
  return box;
}
const yTicks = (max, format, pad, ih, w, grid) => {
  for (let i = 0; i <= 4; i++) {
    const yy = pad.t + ih * i / 4;
    grid.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: yy, y2: yy }));
    const t = svg('text', { x: pad.l - 10, y: yy + 4, 'text-anchor': 'end', class: 'ytick' }); t.textContent = format(max * (1 - i / 4)); grid.append(t);
  }
};
/** Rounds the top of the scale to a tidy number so the axis reads ₱2k, ₱4k… not ₱2.6k, ₱5.2k. */
const niceMax = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 8 ? 8 : 10) * p; };

/** Multi-series line/area chart. series: [{key, label, color, values[]}], labels[] */
export function lineChart({ labels, series, height = 260, format = pesoShort }) {
  return responsive(w => {
    const narrow = w < 520, pad = { l: narrow ? 50 : 60, r: narrow ? 12 : 18, t: 16, b: 32 }, ih = height - pad.t - pad.b, iw = w - pad.l - pad.r;
    const max = niceMax(Math.max(1, ...series.flatMap(s => s.values)) * 1.05);
    const x = i => pad.l + (labels.length === 1 ? iw / 2 : i / (labels.length - 1) * iw), y = v => pad.t + ih - v / max * ih;
    const el = svg('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height, class: 'chart chart--line' });
    const grid = svg('g', { class: 'grid' }); yTicks(max, format, pad, ih, w, grid); el.append(grid);
    const room = Math.max(2, Math.floor(iw / (narrow ? 52 : 70))), every = Math.max(1, Math.ceil(labels.length / room));
    labels.forEach((l, i) => {
      const last = i === labels.length - 1; if (i % every && !last) return;
      if (!last && labels.length - 1 - i < every * .6) return; // keep the last date from colliding
      const t = svg('text', { x: x(i), y: height - 10, 'text-anchor': i === 0 && labels.length > 1 ? 'start' : last && labels.length > 1 ? 'end' : 'middle', class: 'xtick' }); t.textContent = l; el.append(t);
    });
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => [x(i), y(v)]);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      if (si === 0) { const id = 'lg' + Math.random().toString(36).slice(2, 7); const defs = svg('defs'); const lg = svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }); lg.append(svg('stop', { offset: 0, 'stop-color': s.color, 'stop-opacity': .28 }), svg('stop', { offset: 1, 'stop-color': s.color, 'stop-opacity': 0 })); defs.append(lg); el.append(defs, svg('path', { d: d + ` L${x(pts.length - 1)} ${pad.t + ih} L${x(0)} ${pad.t + ih} Z`, fill: `url(#${id})`, class: 'area' })); }
      const path = svg('path', { d, stroke: s.color, class: 'line' + (reduced() || s.dash ? '' : ' draw'), style: `--d:${si * 140}ms${s.dash ? ';stroke-dasharray:6 5;opacity:.7' : ''}` });
      el.append(path);
      requestAnimationFrame(() => { try { path.style.setProperty('--len', Math.ceil(path.getTotalLength())); } catch { /* ignore */ } });
    });
    const cw = labels.length > 1 ? iw / (labels.length - 1) : iw;
    labels.forEach((l, i) => {
      const g = svg('g');
      g.append(svg('rect', { x: x(i) - cw / 2, y: pad.t, width: cw, height: ih, fill: 'transparent', class: 'hit' }));
      series.forEach(s => g.append(svg('circle', { cx: x(i), cy: y(s.values[i]), r: 4.5, stroke: s.color, class: 'dot' })));
      const tipFor = e => showTip(e.clientX, e.clientY, `<b>${escHtml(l)}</b>` + series.map(s => `<span style="color:${escHtml(s.color)}">●</span> ${escHtml(s.label)}: ${escHtml(format(s.values[i]))}`).join('<br>'));
      g.addEventListener('pointermove', tipFor); g.addEventListener('pointerdown', tipFor); g.addEventListener('pointerleave', hideTip);
      el.append(g);
    });
    return el;
  }, height);
}

/** Grouped bar chart. */
export function barChart({ labels, series, height = 260, format = pesoShort, values = 'auto' }) {
  // Note: SVG bars use the class "cbar" (the class "bar" is the progress-bar style and would shrink them).
  return responsive(w => {
    const narrow = w < 520, pad = { l: narrow ? 50 : 60, r: narrow ? 8 : 14, t: 24, b: 32 }, ih = height - pad.t - pad.b, iw = w - pad.l - pad.r;
    const max = niceMax(Math.max(1, ...series.flatMap(s => s.values)) * 1.08);
    const el = svg('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height, class: 'chart chart--bar', role: 'img' });
    const grid = svg('g', { class: 'grid' }); yTicks(max, format, pad, ih, w, grid); el.append(grid);
    const gw = iw / labels.length, bw = Math.max(3, Math.min(narrow ? 22 : 34, (gw * .74) / series.length));
    const showValues = values === 'auto' ? labels.length * series.length <= (narrow ? 8 : 14) : values;
    const room = Math.max(2, Math.floor(iw / (narrow ? 34 : 44))), every = Math.max(1, Math.ceil(labels.length / room));
    labels.forEach((l, i) => {
      const cx = pad.l + gw * i + gw / 2;
      if (i % every === 0) { const t = svg('text', { x: cx, y: height - 10, 'text-anchor': 'middle', class: 'xtick' }); t.textContent = l; el.append(t); }
      const g = svg('g');
      series.forEach((s, si) => {
        const v = s.values[i] || 0, bh = Math.max(v > 0 ? 2 : 0, v / max * ih), bx = cx - (series.length * bw) / 2 + si * bw + 1;
        const r = svg('rect', { x: bx, y: pad.t + ih - bh, width: Math.max(1, bw - 2), height: bh, rx: Math.min(5, bw / 4), fill: s.color, class: 'cbar', style: `--i:${i * series.length + si}` });
        const tipFor = e => showTip(e.clientX, e.clientY, `<b>${escHtml(l)}</b>${escHtml(s.label)}: ${escHtml(format(v))}`);
        r.addEventListener('pointermove', tipFor); r.addEventListener('pointerdown', tipFor); r.addEventListener('pointerleave', hideTip);
        g.append(r);
        if (showValues && v > 0) { const t = svg('text', { x: bx + bw / 2 - 1, y: pad.t + ih - bh - 6, 'text-anchor': 'middle', class: 'cval', style: `--i:${i * series.length + si}` }); t.textContent = format(v); g.append(t); }
      });
      el.append(g);
    });
    return el;
  }, height);
}
/** Charts start their grow-in animation when they scroll into view (each time they are rendered). */
const playCb = new WeakMap();
const chartIO = 'IntersectionObserver' in window ? new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { e.target.classList.add('play'); chartIO.unobserve(e.target); playCb.get(e.target)?.(); } }, { threshold: .3 }) : null;
export function playOnView(el, onPlay) { if (!chartIO || reduced()) { el.classList.add('play'); onPlay?.(); return el; } if (onPlay) playCb.set(el, onPlay); requestAnimationFrame(() => chartIO.observe(el)); return el; }
/** Progress bar fill that animates when the bar scrolls into view (and again only on re-render). */
const barIO = 'IntersectionObserver' in window ? new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) { const i = e.target; barIO.unobserve(i); setTimeout(() => { i.style.width = i.dataset.fill; i.classList.add('filled'); }, Number(i.dataset.delay || 0)); } }, { threshold: .2 }) : null;
export function fillBar(i, pct, delay = 0) {
  i.dataset.fill = Math.max(0, Math.min(100, pct)) + '%'; i.dataset.delay = delay;
  if (reduced() || !barIO) { i.style.width = i.dataset.fill; return i; }
  requestAnimationFrame(() => barIO.observe(i));
  return i;
}

/** Donut gauge with centered label. */
export function donut(parts, { size = 130, label, sub } = {}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1, r = 44, c = 2 * Math.PI * r;
  const el = svg('svg', { viewBox: '0 0 110 110', class: 'donut', style: `width:${size}px;height:${size}px` });
  el.append(svg('circle', { cx: 55, cy: 55, r, stroke: 'var(--surface-3)' }));
  let offset = 0;
  for (const p of parts) {
    const len = p.value / total * c;
    const ring = svg('circle', { cx: 55, cy: 55, r, stroke: p.color, 'stroke-dasharray': `${len} ${c - len}`, 'stroke-dashoffset': c });
    ring.style.strokeDashoffset = c; el.append(ring);
    const o = -offset; requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.strokeDashoffset = o; }));
    offset += len;
  }
  if (label !== undefined) { const t = svg('text', { x: 55, y: 53, 'text-anchor': 'middle', style: 'font-size:18px;font-weight:800;fill:var(--ink)' }); t.textContent = label; el.append(t); }
  if (sub) { const t = svg('text', { x: 55, y: 69, 'text-anchor': 'middle', style: 'font-size:9px;fill:var(--muted)' }); t.textContent = sub; el.append(t); }
  return el;
}
export const legend = items => h('div.legend', ...items.map(i => h('span', h('i', { style: { background: i.color } }), i.label)));

// ---- Growth pill ------------------------------------------------------
export function trend(g, { lowerIsGood = false } = {}) {
  if (!g) return null;
  const good = g.direction === 'flat' ? null : lowerIsGood ? g.direction === 'down' : g.direction === 'up';
  const cls = g.direction === 'flat' ? 'flat' : good ? 'good' : 'bad';
  const pct = g.percent === null ? 'new' : (g.percent > 0 ? '+' : '') + g.percent + '%';
  return h('span.trend.' + cls, { title: `${peso(g.previous)} → ${peso(g.current)}` }, icon(g.direction === 'up' ? 'trendUp' : g.direction === 'down' ? 'trendDown' : 'minus', 'sm'), h('span', pct));
}
export const growthWords = (g, noun, lowerIsGood = false) => {
  if (!g || g.direction === 'flat') return `No change in ${noun}`;
  const amt = peso(Math.abs(g.diff)); const pct = g.percent === null ? '' : ` · ${g.direction === 'up' ? 'up' : 'down'} ${Math.abs(g.percent)}%`;
  return `${amt} ${g.direction === 'up' ? 'higher' : 'lower'}${pct}${lowerIsGood ? (g.direction === 'down' ? ' · good' : '') : ''}`;
};

// ---- Live payable time (mirrors src/payroll.mjs) ---------------------------
// Payable regular minutes = parts of the sessions inside the morning / afternoon windows.
// An open session runs until `nowMs`; regular pay stops at the cutoff, so grace adds nothing.
export function payableAt({ day, taps, schedule: s, excuse, nowMs }) {
  const at = hhmm => Date.parse(`${day}T${hhmm}:00+08:00`), p = k => taps[k] ? Date.parse(taps[k]) : null;
  const W = { morning: [at(s.start), at(s.lunchStart)], afternoon: [at(s.lunchEnd), at(s.end)] };
  const legacy = taps.in && taps.out && !taps.lunch_out && !taps.lunch_in;
  const ses = [];
  if (legacy) ses.push([p('in'), p('out')]);
  else {
    if (taps.in) { const e = p('lunch_out') ?? (!taps.lunch_in ? p('out') : null) ?? nowMs; ses.push([p('in'), e]); }
    if (taps.lunch_in) ses.push([p('lunch_in'), p('out') ?? nowMs]);
  }
  const ex = excuse && excuse.status === 'Excused' ? excuse : null;
  let ms = 0;
  for (const w of ['morning', 'afternoon']) {
    const actual = ses.reduce((x, [a, b]) => x + Math.max(0, Math.min(b, W[w][1]) - Math.max(a, W[w][0])), 0);
    const full = W[w][1] - W[w][0];
    ms += ex && ex.paid && (ex.coverage === 'whole' || ex.coverage === w) ? full : actual;
  }
  return ms / 60000;
}
/** Estimated pay in pesos (display may use fractional minutes for a smooth count). */
export const estimateFor = (rate, minutes) => rate === null || rate === undefined ? null : Math.round(rate * 100 * minutes / 480) / 100;
export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---- Search: starts-with matching + instant suggestions ---------------------
// Typing "E" lists items whose name (or any word / SKU) begins with E — Electrical Tape, Elbow…
// Longer queries (3+ letters) also match inside words.
export function matchScore(m, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const name = (m.label || m.name || '').toLowerCase(), sku = (m.sku || '').toLowerCase();
  const words = name.split(/[\s·,/()-]+/).filter(Boolean);
  if (name.startsWith(q)) return 1;
  if (words.some(w => w.startsWith(q))) return 2;
  if (sku.startsWith(q)) return 3;
  const parts = q.split(/\s+/);
  if (parts.length > 1 && parts.every(p => words.some(w => w.startsWith(p)))) return 4;
  if (q.length >= 3 && (name.includes(q) || sku.includes(q))) return 5;
  return -1;
}
export function searchItems(list, query) {
  const q = String(query || '').trim();
  if (!q) return list;
  return list.map(m => [m, matchScore(m, q)]).filter(([, s]) => s > 0).sort((a, b) => a[1] - b[1] || (a[0].label || a[0].name).localeCompare(b[0].label || b[0].name)).map(([m]) => m);
}
const mark = (text, q) => { const t = String(text), i = t.toLowerCase().indexOf(q.toLowerCase()); if (!q || i < 0) return [t]; return [t.slice(0, i), h('mark', t.slice(i, i + q.length)), t.slice(i + q.length)]; };
/** Attach an instant suggestion list under a search input. */
export function typeahead(input, { source, onPick, render, max = 8, emptyLabel = q => `No material starts with “${q}”` }) {
  const box = h('div.typeahead', { role: 'listbox', hidden: true });
  input.setAttribute('autocomplete', 'off'); input.setAttribute('aria-autocomplete', 'list');
  let items = [], active = -1;
  const close = () => { box.hidden = true; active = -1; };
  const paint = () => [...box.children].forEach((c, i) => c.classList.toggle('on', i === active));
  const update = () => {
    const q = input.value.trim();
    clear(box); items = q ? searchItems(source(), q).slice(0, max) : [];
    if (!items.length) { if (q) { box.append(h('div.typeahead__empty', typeof emptyLabel === 'function' ? emptyLabel(q) : emptyLabel)); box.hidden = false; } else close(); return; }
    active = 0;
    items.forEach((m, i) => box.append(h('button.typeahead__item', { type: 'button', role: 'option', onmousedown: e => { e.preventDefault(); onPick(m); close(); }, onmouseenter: () => { active = i; paint(); } },
      render ? render(m, q, mark) : h('span', ...mark(m.label || m.name, q)))));
    paint(); box.hidden = false;
  };
  input.addEventListener('input', update);
  input.addEventListener('focus', () => { if (input.value.trim()) update(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (e.defaultPrevented || box.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); onPick(items[active]); close(); }
    else if (e.key === 'Escape') close();
  });
  return box;
}

/**
 * Long lists show the first `n` rows and a "View more (k)" button that expands / collapses them.
 * Works for table rows (pass the <tbody>) and for any list container.
 */
export function viewMore(container, n = 6, { label = 'View more' } = {}) {
  const rows = [...container.children]; if (rows.length <= n) return null;
  const extra = rows.slice(n); let open = false;
  const set = () => { for (const r of extra) r.hidden = !open; btn.textContent = open ? 'Show less' : `${label} (${extra.length})`; btn.setAttribute('aria-expanded', String(open)); };
  const btn = h('button.btn.sm.ghost.viewmore', { type: 'button', onclick: () => { open = !open; set(); if (!open) container.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } });
  set();
  return btn;
}
