// Cashier › Cash drawer: today's money by payment method and the end-of-day count.
import { api } from '../api.js';
import { h, clear, peso, toast, busy, errorOf, field, input, empty, skeleton, tag, dateTime, countUp } from '../ui.js';
import { icon } from '../icons.js';
import { go } from '../app.js';
import { expenseForm } from './expenses.js';

export async function cash(ctx) {
  const { el, user } = ctx;
  if (user.role !== 'cashier') { go('dashboard'); return; }
  el.append(skeleton(2));
  const d = await api.get('cash');
  clear(el);
  if (ctx.query.get('view') === 'collections') {
    const list = d.received.map(r => h('div.list__item', h('span.body',
      r.sale ? h('a', { href: '#/sales/' + r.id }, 'Sale #' + r.id) : h('b', 'Utang payment #' + r.id),
      h('span', [r.method, r.reference, dateTime(r.created)].filter(Boolean).join(' · '))),
      h('b', peso(r.amount))));
    el.append(h('div.page__head', h('h1', 'Collected today'), h('a.btn', { href: '#/cash' }, 'Cash drawer')),
      h('div.card', h('div.list', ...(list.length ? list : [empty('No confirmed payments today', 'banknote')]))));
    return;
  }
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Cashier'), h('h1', 'Cash drawer'), h('p.muted', 'Money received today by method, and the end-of-day cash count.')), h('div.page__actions', h('a.btn', { href: '#/summary' }, icon('chart', 'sm'), 'Tawad summary'), h('button.btn', { onclick: () => expenseForm(ctx) }, icon('coins', 'sm'), 'Expense from drawer'))));
  const k = (label, v, ic, sub) => { const n = h('div.kpi__value', peso(0)); countUp(n, v, { format: peso, duration: 900 }); return h('div.card.kpi', h('div.kpi__label', h('span.ic', icon(ic, 'sm')), label), n, sub ? h('p.small.muted', { style: { marginTop: '6px' } }, sub) : null); };
  el.append(h('div.grid.kpi.stagger', k('Expected cash in drawer', d.expectedCash, 'banknote', d.paidOut ? `Cash in − ${peso(d.paidOut)} expenses` : 'Cash sales + cash utang payments'), k('Sales total', d.salesTotal, 'receipt', `${d.transactions} transaction${d.transactions === 1 ? '' : 's'}`), k('Utang given', d.creditGiven, 'wallet', 'Not collected yet'),
    h('button.card.kpi.click', { style: { textAlign: 'left' }, onclick: () => go('orders') }, h('div.kpi__label', h('span.ic', icon('clock', 'sm')), 'Orders waiting'), h('div.kpi__value', String(d.waiting)), h('p.small.muted', { style: { marginTop: '6px' } }, 'Open the payment queue →'))));
  const rows = (list) => list.length ? h('div.list', ...list.map(r => h('div.list__item', h('span.ic', icon(r.method === 'Cash' ? 'banknote' : 'wallet')), h('span.body', h('b', r.method), h('span', `${r.count} payment${r.count === 1 ? '' : 's'}`)), h('b', peso(r.amount))))) : empty('Nothing yet today', 'banknote');
  const counted = input({ type: 'number', min: 0, step: '0.01', class: 'big', placeholder: '0.00', inputmode: 'decimal' });
  const note = input({ placeholder: 'Optional note', maxlength: 200 });
  const variance = h('div.change', h('span', 'Difference'), h('b', '—'));
  counted.oninput = () => { const v = Math.round((Number(counted.value || 0) - d.expectedCash) * 100) / 100; variance.querySelector('b').textContent = counted.value === '' ? '—' : (v === 0 ? 'Balanced ✓' : (v > 0 ? 'Over ' : 'Short ') + peso(Math.abs(v))); variance.classList.toggle('bad', v < 0); };
  const save = e => busy(e.currentTarget, async () => { try { const r = await api.action('cash.count', { counted: counted.value, note: note.value }); toast(r.variance === 0 ? 'Cash count saved · balanced' : `Cash count saved · ${r.variance > 0 ? 'over' : 'short'} ${peso(Math.abs(r.variance))}`, r.variance === 0 ? 'ok' : 'warn'); ctx.refresh(); } catch (err) { toast(errorOf(err), 'err'); } });
  el.append(h('div.grid.two.stagger', { style: { marginTop: '14px', alignItems: 'start' } },
    h('div.card', h('div.card__head', h('h2', 'Sales received today')), rows(d.byMethod), h('div.card__head', { style: { marginTop: '14px' } }, h('h2', 'Utang payments today')), rows(d.collections),
      h('div.card__head', { style: { marginTop: '14px' } }, h('h2', 'Paid out (expenses)'), h('button.btn.sm', { onclick: () => expenseForm(ctx) }, icon('plus', 'sm'), 'Add')),
      d.drawerExpenses.length ? h('div.list', ...d.drawerExpenses.map(e => h('div.list__item', h('span.ic.warn', icon('coins')), h('span.body', h('b', e.category === 'Other' ? e.detail : e.category), h('span', `${e.reference}${user.role === 'admin' ? ' · ' + e.by : ''}`)), h('b', '− ' + peso(e.amount))))) : h('p.small.muted', 'No expenses paid from the drawer today.')),
    h('div.card', h('div.card__head', h('div', h('h2', 'End-of-day count'), h('p.sub', `Expected ${peso(d.expectedCash)} in cash`))), h('div.form', field('Cash counted (₱)', counted), variance, field('Note', note), h('button.btn.primary.lg.block', { onclick: save }, icon('check', 'sm'), 'Save count')))));
  el.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('h2', 'Past counts')), d.counts.length ? h('div.list', ...d.counts.map(c => h('div.list__item', h('span.ic.' + (c.variance === 0 ? 'ok' : c.variance < 0 ? 'danger' : 'warn'), icon('banknote')), h('span.body', h('b', `${c.day} · ${c.cashier}`), h('span', `Expected ${peso(c.expected)} · counted ${peso(c.counted)}${c.note ? ' · ' + c.note : ''}`)), tag(c.variance === 0 ? 'Balanced' : (c.variance > 0 ? 'Over ' : 'Short ') + peso(Math.abs(c.variance)), c.variance === 0 ? 'Present' : c.variance < 0 ? 'Absent' : 'warn')))) : empty('No counts yet', 'banknote')));
}
