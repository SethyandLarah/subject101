// Language: English (default) or Filipino — chosen in My Profile (or on the sign-in card).
// The choice is kept on this device (alaan.lang) and on the account, then the app reloads.
// In Filipino, a watcher translates every piece of on-screen text the moment it appears
// (pages, lists, dialogs, toasts, server messages), so every screen follows one dictionary.
import { FIL, TPL } from './i18n-fil.js';

const KEY = 'alaan.lang';
const read = () => { try { return localStorage.getItem(KEY) === 'fil' ? 'fil' : 'en'; } catch { return 'en'; } };
/** The language of this page load: 'en' or 'fil'. It changes only through a reload. */
export const lang = read();
/** Locale for dates and times (numbers and pesos keep the en-PH format: ₱1,234.50). */
export const LOCALE = lang === 'fil' ? 'fil-PH' : 'en-PH';
export const LANGS = [{ code: 'en', name: 'English', note: 'English' }, { code: 'fil', name: 'Filipino', note: 'Tagalog / Taglish' }];

export function rememberLang(code) { try { localStorage.setItem(KEY, code === 'fil' ? 'fil' : 'en'); } catch { /* storage blocked */ } }

/** Full-screen loading, save, then reload the whole app in the new language. */
export async function switchLanguage(code, save) {
  code = code === 'fil' ? 'fil' : 'en';
  showLoading(code);
  const started = Date.now();
  rememberLang(code);
  if (save) { try { await Promise.race([save(code), new Promise(r => setTimeout(r, 4000))]); } catch { /* offline: the device keeps the choice */ } }
  // A short, steady loading screen reads as intentional, even when saving is instant.
  await new Promise(r => setTimeout(r, Math.max(0, 900 - (Date.now() - started))));
  location.reload();
}
export function showLoading(code) {
  if (document.getElementById('langveil')) return;
  const fil = code === 'fil';
  const veil = document.createElement('div');
  veil.id = 'langveil'; veil.className = 'langveil'; veil.setAttribute('data-no-i18n', ''); veil.setAttribute('role', 'status');
  veil.innerHTML = '<div class="langveil__box"><span class="langveil__spin" aria-hidden="true"></span>'
    + `<b>${fil ? 'Pinapalitan ang wika…' : 'Changing language…'}</b><span>${fil ? 'Filipino' : 'English'}</span></div>`;
  document.body.append(veil);
  requestAnimationFrame(() => veil.classList.add('in'));
}

// ---- Translator ----------------------------------------------------------------------------
const dict = new Map(Object.entries(FIL));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// {} = any text, {n} = a number or peso amount (so "{n} days" never swallows "15 unpaid days").
const NUM = '([+−-]?₱?[\\d.,]+[k%]?)';
const templates = TPL.map(([en, fil]) => ({ re: new RegExp('^' + en.split(/(\{n?\})/).map(p => p === '{}' ? '(.+?)' : p === '{n}' ? NUM : esc(p)).join('') + '$'), fil }));
const MONTH = { Jan: 'Ene', Feb: 'Peb', Mar: 'Mar', Apr: 'Abr', May: 'May', Jun: 'Hun', Jul: 'Hul', Aug: 'Ago', Sep: 'Set', Oct: 'Okt', Nov: 'Nob', Dec: 'Dis' };
const monthDay = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})$/;
const cache = new Map();
const UNIT = { pcs: 'piraso', rolls: 'rolyo', bags: 'sako', boxes: 'kahon', sets: 'set', meters: 'metro', liters: 'litro' };
const UNIT_RE = /(\d)\s(pcs|rolls|bags|boxes|sets|meters|liters)\b/g;
const piece = s => translate(s) ?? s; // values inside a template are translated too (always shorter, so this ends)

/** Filipino for one piece of English text (or the same text when there is none). */
export function t(s) {
  if (typeof s !== 'string') return s;
  const r = localize(s); return r === null ? s : r;
}

// English: the store words Tawad / Utang / Sukli are shown in English too (Haggle / Credit / Change),
// so English mode is English only. Filipino mode keeps them as they are.
const EN_PHRASES = new Map([
  ['Haggled / Tawad', 'Haggle discount'], ['Haggled price / Tawad', 'Haggled price'], ['Change / Sukli', 'Change'],
  ['Credit / Utang', 'Credit'], ['Utang / Partial', 'Credit / Partial'], ['Utang / partial', 'Credit / partial'],
  ['Credit sales (utang)', 'Credit sales'], ['Collections (utang paid)', 'Collections (credit paid)'],
  ['Promo suspended — Tawad', 'Promo suspended — haggle discount'], ['Sales & Tawad summary', 'Sales & Haggle summary'],
  ['Cash received is below the total. Choose Credit / Utang to record the balance.', 'Cash received is below the total. Choose Credit to record the balance.'],
]);
const EN_WORDS = { Tawad: 'Haggle', tawad: 'haggle', Utang: 'Credit', utang: 'credit', Sukli: 'Change', sukli: 'change' };
const EN_TEST = /\b(Tawad|tawad|Utang|utang|Sukli|sukli)\b/;
function english(s) {
  if (!EN_TEST.test(s)) return null;
  const core = s.trim();
  let out = EN_PHRASES.get(core);
  if (out === undefined) {
    out = core;
    for (const [a, b] of EN_PHRASES) if (a.length > 12) out = out.split(a).join(b);
    // Capital at the start of a sentence or label, small letter inside a sentence.
    out = out.replace(/\b(Tawad|tawad|Utang|utang|Sukli|sukli)\b/g, (w, _m, at, str) => {
      const before = str.slice(0, at), after = str.slice(at + w.length);
      // "Tawad" alone (not before a noun such as "amount") reads as "haggle discount".
      let en = EN_WORDS[w]; if (/^tawad$/i.test(w) && !/^\s+[A-Za-z]/.test(after)) en += ' discount';
      const cap = !before.trim() || /[.:!?·—/(\-]\s*$|^[^a-z]*$/.test(before) || /(^|\s)[A-Z][a-z]*\s+(&\s+)?$/.test(before) && /^\s*[A-Z]/.test(after.replace(/^\s*discount/, ''));
      return cap ? en[0].toUpperCase() + en.slice(1) : en.toLowerCase();
    });
  }
  if (out === core) return null;
  const i = s.indexOf(core);
  return s.slice(0, i) + out + s.slice(i + core.length);
}
const localize = s => lang === 'fil' ? translate(s) : english(s);
function translate(s) {
  const core = s.trim();
  if (!core || core.length > 400 || !/[A-Za-z]/.test(core)) return null;
  let out = dict.get(core);
  if (out === undefined) {
    if (cache.has(core)) out = cache.get(core);
    else {
      out = null;
      const md = monthDay.exec(core);
      if (md) out = MONTH[md[1]] + ' ' + md[2];
      else for (const { re, fil } of templates) {
        const m = re.exec(core);
        if (m) { out = fil.replace(/\{(\d)\}/g, (_, i) => piece(m[Number(i)] ?? '')); break; }
      }
      // Joined text: "Cash · 3 payments", "Sales: ₱1,200.00" — translate each part on its own.
      if (out === null && core.includes(' · ')) {
        const parts = core.split(' · '), done = parts.map(p => translate(p) ?? p);
        if (done.some((p, i) => p !== parts[i])) out = done.join(' · ');
      }
      // " · 2 pending sync", "— still loading" — a separator, then words.
      if (out === null) {
        const sm = /^([·—–→] )(.+)$/.exec(core);
        if (sm) { const w = translate(sm[2]); if (w !== null) out = sm[1] + w.trim(); }
      }
      // "Uncategorized (0)" — words followed by a count.
      if (out === null) {
        const cm = /^(.*\S) \((\d+)\)$/.exec(core);
        if (cm) { const w = translate(cm[1]); if (w !== null) out = w + ' (' + cm[2] + ')'; }
      }
      // "Good evening," — the same words with punctuation after them.
      if (out === null) {
        const pm = /^(.*[A-Za-z)])([,.:!?…]+)$/.exec(core);
        if (pm && dict.has(pm[1])) out = dict.get(pm[1]) + pm[2];
      }
      if (out === null) {
        const lv = /^([^:]{2,40}):(\s.*)$/.exec(core);
        if (lv && dict.has(lv[1])) out = dict.get(lv[1]) + ':' + (translate(lv[2]) ?? lv[2]);
      }
      if (cache.size > 4000) cache.clear();
      cache.set(core, out);
    }
  }
  // Units after a number ("54 boxes" → "54 kahon"), also inside longer text.
  const united = (out ?? core).replace(UNIT_RE, (_, n, u) => n + ' ' + UNIT[u]);
  if (united !== (out ?? core)) out = united;
  if (out === null || out === core) return null;
  const lead = s.slice(0, s.indexOf(core)), trail = s.slice(s.indexOf(core) + core.length);
  return lead + out + trail;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT']);
const ATTRS = ['placeholder', 'title', 'aria-label'];
const skipped = el => !el || SKIP.has(el.nodeName) || el.isContentEditable || !!el.closest?.('[data-no-i18n]');
// Attributes (placeholder, title, label) of a text box are interface text too, even if its content is not.
const attrSkipped = el => !el || !!el.closest?.('[data-no-i18n]');
function textNode(n) {
  if (skipped(n.parentElement)) return;
  const r = localize(n.data);
  if (r !== null && r !== n.data) n.data = r;
}
function attrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) { const r = localize(v); if (r !== null && r !== v) el.setAttribute(a, r); }
  }
}
function subtree(root) {
  if (root.nodeType === 3) return textNode(root);
  if (root.nodeType !== 1) return;
  if (!attrSkipped(root)) attrs(root);
  if (skipped(root)) return;
  for (const el of root.querySelectorAll('[placeholder],[title],[aria-label]')) if (!attrSkipped(el)) attrs(el);
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) textNode(n);
}

if (lang === 'fil' || lang === 'en') {
  document.documentElement.lang = lang === 'fil' ? 'fil' : 'en';
  const observer = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'childList') for (const n of r.addedNodes) subtree(n);
      else if (r.type === 'characterData') textNode(r.target);
      else if (r.type === 'attributes' && r.target.nodeType === 1 && !attrSkipped(r.target)) attrs(r.target);
    }
    observer.takeRecords(); // our own edits above are not new text
  });
  const start = () => {
    subtree(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  // The browser tab title.
  const title = document.querySelector('title');
  if (title) { const fix = () => { const r = localize(document.title); if (r !== null && r !== document.title) document.title = r; }; fix(); new MutationObserver(fix).observe(title, { childList: true, characterData: true, subtree: true }); }
}
