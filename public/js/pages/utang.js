// Utang Records: customers, balances, ledgers and payments.
import { paymentFields } from '../ui.js';
import { api } from '../api.js';
import { h, clear, peso, num, dateTime, dateText, ago, modal, toast, busy, errorOf, field, input, showError, empty, skeleton, tag, countUp, donut, confetti, bump, sound } from '../ui.js';
import { icon } from '../icons.js';
import { go } from '../app.js';

const round2 = v => Math.round(v * 100) / 100;

export async function utang(ctx) {
  const { el, params, user } = ctx;
  if (!(user.role === 'admin' || user.role === 'cashier' || user.role.includes('sales'))) { go('dashboard'); return; }
  if (params[0]) return customerDetail(ctx);
  const q = h('input', { placeholder: 'Search name or number…', oninput: () => render() });
  const list = h('div'); const total = h('div.kpi__value'), count = h('div.kpi__value');
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Credit'), h('h1', 'Utang Records')), h('div.page__actions', h('button.btn.primary', { onclick: () => customerForm(null, ctx) }, icon('plus', 'sm'), 'New customer'))),
    h('div.grid.kpi.stagger', h('div.card.kpi.tone-danger', h('div.kpi__label', h('span.ic', icon('wallet', 'sm')), 'Outstanding balance'), total), h('div.card.kpi', h('div.kpi__label', h('span.ic', icon('users', 'sm')), 'Customers with balance'), count)),
    h('div.card', { style: { margin: '14px 0' } }, h('div.search', icon('search', 'sm'), q)), list);
  let data = { items: [], totals: { balance: 0, withBalance: 0 } };
  const render = () => {
    const s = q.value.trim().toLowerCase();
    const items = data.items.filter(c => !s || (c.name + ' ' + c.phone).toLowerCase().includes(s)).sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
    clear(list);
    if (!items.length) return list.append(h('div.card', empty('No customers found', 'users')));
    list.append(h('div.card.pad-0', h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Customer'), h('th', 'Contact'), h('th.right', 'Total credit'), h('th.right', 'Paid'), h('th.right', 'Balance'), h('th', 'Status'), h('th'))), h('tbody.stagger', ...items.map((c, i) => h('tr.click', { style: { '--i': Math.min(i, 20) }, onclick: () => go('utang/' + c.id) }, h('td', h('b', c.name), h('div.small.muted', c.address)), h('td.small', c.phone || '—'), h('td.num', peso(c.credit)), h('td.num', peso(c.paid)), h('td.num', h('b', { style: { color: c.balance > 0 ? 'var(--danger)' : 'var(--primary)' } }, peso(c.balance))), h('td', c.balance > 0 ? tag('Has balance', 'warn') : c.credit > 0 ? tag('Fully Paid', 'paid') : tag('No credit', 'neutral')), h('td', icon('chevronRight', 'sm')))))))));
  };
  list.append(skeleton(1));
  data = await api.get('customers'); countUp(total, data.totals.balance, { format: peso }); countUp(count, data.totals.withBalance, { format: v => String(Math.round(v)) }); render();
}

export function customerForm(existing, ctx, onSaved) {
  const name = input({ value: existing?.name || '', placeholder: 'Full name' }), phone = input({ value: existing?.phone || '', placeholder: 'Contact number', inputmode: 'tel' }), address = input({ value: existing?.address || '', placeholder: 'Address' });
  const body = h('div.form', field('Full name', name), field('Contact number', phone), field('Address', address));
  let force = false;
  modal({ title: existing ? 'Edit customer' : 'New customer', subtitle: existing ? '' : 'Search first — reuse an existing record when possible.', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { const r = await api.action('customer.save', { id: existing?.id, name: name.value, phone: phone.value, address: address.value, force }); toast('Customer saved', 'ok'); close(); onSaved ? onSaved(r.id) : go('utang/' + r.id); } catch (err) { showError(body, errorOf(err) + (err.status === 409 ? ' Tap Save again to create anyway.' : '')); if (err.status === 409) force = true; } }) }, 'Save') });
}

async function customerDetail(ctx) {
  const { el, params } = ctx;
  el.append(skeleton(2));
  const c = await api.get('customer', { id: params[0] }); clear(el);
  const payBtn = c.balance > 0 && (ctx.user.role === 'admin' || ctx.user.role === 'cashier') ? h('button.btn.primary', { onclick: () => paymentForm(c, ctx) }, icon('handCoins', 'sm'), 'Record payment') : null;
  el.append(h('div.page__head', h('div', h('a.small', { href: '#/utang' }, '← Utang Records'), h('h1', c.name), h('p.muted', [c.phone, c.address].filter(Boolean).join(' · ') || 'No contact details')), h('div.page__actions', h('button.btn', { onclick: () => customerForm(c, ctx, () => ctx.refresh()) }, icon('edit', 'sm'), 'Edit'), h('button.btn', { onclick: () => go('pos') }, icon('cart', 'sm'), 'New credit sale'), payBtn)));
  const bal = h('div.kpi__value'); requestAnimationFrame(() => countUp(bal, c.balance, { format: peso }));
  el.append(h('div.grid.three.stagger',
    h('div.card.kpi' + (c.balance > 0 ? '.tone-danger' : '.tone-ok'), h('div.kpi__label', h('span.ic', icon('wallet', 'sm')), 'Remaining balance'), bal, h('div', { style: { marginTop: '8px' } }, c.balance > 0 ? tag('Has balance', 'warn') : c.credit > 0 ? tag('Fully Paid', 'paid') : tag('No credit yet', 'neutral'))),
    h('div.card', h('div.row', { style: { gap: '18px' } }, donut([{ value: c.paid, color: 'var(--primary)' }, { value: Math.max(0, c.balance), color: 'var(--danger)' }], { size: 110, label: c.credit ? Math.round(c.paid / c.credit * 100) + '%' : '—', sub: 'paid' }), h('div.col', { style: { gap: '8px' } }, h('div', h('div.small.muted', 'Total credit'), h('b', peso(c.credit))), h('div', h('div.small.muted', 'Total paid (collections)'), h('b', { style: { color: 'var(--primary)' } }, peso(c.paid)))))),
    h('div.card', h('div.kpi__label', h('span.ic', icon('history', 'sm')), 'Activity'), h('div.kpi__value', c.sales.length), h('p.small.muted', `credit sale${c.sales.length === 1 ? '' : 's'} · ${c.payments.filter(p => !p.atCounter).length} payment${c.payments.filter(p => !p.atCounter).length === 1 ? '' : 's'}`))));
  // Ledger: merge sales and payments by time
  const entries = [...c.sales.map(s => ({ t: s.created, type: 'sale', s })), ...c.payments.filter(p => !p.atCounter).map(p => ({ t: p.created, type: 'payment', p }))].sort((a, b) => b.t.localeCompare(a.t));
  let running = c.balance;
  const rows = entries.map(e => { const bal = running; if (e.type === 'sale' && !e.s.voided) running = round2(running - e.s.creditAdded); if (e.type === 'payment') running = round2(running + e.p.amount); return { ...e, bal }; });
  el.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('h2', 'Ledger'), h('span.sub', 'Newest first · balance after each entry')),
    rows.length ? h('div.timeline', ...rows.map((e, ti) => e.type === 'sale' ? h('div.timeline__item', { style: { '--i': Math.min(ti, 15) } }, h('span.pt' + (e.s.voided ? '.muted' : '.warn')), h('div', h('div.row.between', h('b', `Credit sale #${e.s.id}${e.s.voided ? ' (voided)' : ''}`), h('b', { style: { color: 'var(--danger)' } }, '+ ' + peso(e.s.creditAdded))), h('div.small.muted', `${dateTime(e.s.created)} · ${e.s.actor} · total ${peso(e.s.total)}${e.s.paidNow ? ` · paid ${peso(e.s.paidNow)} at counter` : ''} · balance after ${peso(e.bal)}`), h('ul.small', { style: { margin: '6px 0 0', paddingLeft: '18px', color: 'var(--ink-2)' } }, ...e.s.items.map(i => h('li', `${i.name} — ${num(i.qty)} ${i.unit} × ${peso(i.unitPrice)}${i.discount ? ` (${i.discount}% off)` : ''} = ${peso(i.lineTotal)}`))), h('a.small', { href: '#/sales/' + e.s.id }, 'View sale →')))
      : h('div.timeline__item', { style: { '--i': Math.min(ti, 15) } }, h('span.pt'), h('div', h('div.row.between', h('b', 'Payment received'), h('b', { style: { color: 'var(--primary)' } }, '− ' + peso(e.p.amount))), h('div.small.muted', `${dateTime(e.p.created)} · ${e.p.actor} · ${e.p.paymentMethod || "Method not recorded"}${e.p.reference ? ' · ' + e.p.reference : ''} · balance after ${peso(e.bal)}${e.bal === 0 ? ' · Fully Paid' : ''}`))))) : empty('No credit activity yet', 'wallet')));
}

function paymentForm(c, ctx) {
  const amount = input({ type: 'number', min: 0, step: '0.01', max: c.balance, placeholder: '0.00', class: 'big', inputmode: 'decimal' });
  const payment = paymentFields();
  const preview = h('div.change', h('span', 'Remaining after payment'), h('b', peso(c.balance)));
  const upd = () => { const a = Number(amount.value || 0); const r = round2(c.balance - a); preview.classList.toggle('short', r < 0); const txt = r < 0 ? 'Over balance' : r === 0 && a > 0 ? 'Fully Paid · ₱0.00' : peso(r); if (preview.dataset.v !== txt) { preview.dataset.v = txt; preview.lastChild.textContent = txt; bump(preview); } };
  amount.oninput = upd;
  const body = h('div.form', h('div.row.between', h('span.muted', 'Current balance'), h('b', peso(c.balance))), field('Amount (₱)', amount), h('div.denoms', h('button', { type: 'button', onclick: () => { amount.value = c.balance.toFixed(2); upd(); } }, 'Full balance'), ...[100, 500, 1000].filter(d => d < c.balance).map(d => h('button', { type: 'button', onclick: () => { amount.value = d.toFixed(2); upd(); } }, peso(d)))), payment.el, preview);
  modal({ title: 'Record payment', subtitle: c.name, body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { const r = await api.action('payment.record', { customerId: c.id, amount: amount.value, ...payment.values() }); toast(r.fullyPaid ? 'Fully Paid 🎉' : `Payment recorded · balance ${peso(r.remaining)}`, 'ok'); close(); if (r.fullyPaid) confetti(); else sound.play('coin'); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Save payment') });
}
