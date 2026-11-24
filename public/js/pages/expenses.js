// Expenses (Admin): record with category, "Other" requires a specific type.
import { api } from '../api.js';
import { h, fillBar, clear, peso, pesoShort, dateText, modal, confirm, toast, busy, errorOf, field, input, select, showError, empty, skeleton, countUp, donut, legend, todayPH, monthPH } from '../ui.js';
import { icon } from '../icons.js';
import { go } from '../app.js';

const palette = ['var(--primary)', 'var(--warn)', 'var(--info)', '#a78bfa', '#f472b6', '#22d3ee', '#94a3b8'];

export async function expenses(ctx) {
  const { el, user, query, boot } = ctx;
  const cashier = user.role === 'cashier';
  if (user.role !== 'admin' && !cashier) { go('dashboard'); return; }
  const month = query.get('month') || monthPH();
  el.append(skeleton(2));
  const d = await api.get('expenses', { month }); clear(el);
  const picker = input({ type: 'month', value: month, onchange: e => go('expenses?month=' + e.target.value) });
  const total = h('div.kpi__value'); requestAnimationFrame(() => countUp(total, d.total, { format: peso }));
  el.append(h('div.page__head', h('div', h('p.eyebrow', cashier ? 'Cashier' : 'Admin'), h('h1', cashier ? 'My expenses' : 'Expenses'), cashier ? h('p.muted', 'Expenses you pay out of the cash drawer. They are taken off the expected cash and the Admin is notified.') : null), h('div.page__actions', picker, h('button.btn.primary', { onclick: () => expenseForm(ctx) }, icon('plus', 'sm'), 'Record expense'))));
  const parts = d.byCategory.map((c, i) => ({ ...c, color: palette[i % palette.length] }));
  el.append(h('div.grid.three.stagger',
    h('div.card.kpi.tone-warn', h('div.kpi__label', h('span.ic', icon('coins', 'sm')), cashier ? 'My expenses this month' : 'Total this month'), total, h('p.small.muted', { style: { marginTop: '6px' } }, `${d.items.length} record${d.items.length === 1 ? '' : 's'} · ${dateText(month + '-01', { month: 'long', year: 'numeric' })}`)),
    h('div.card', { style: { gridColumn: 'span 2' } }, h('div.card__head', h('h2', 'By category')), parts.length ? h('div.row', { style: { gap: '20px', flexWrap: 'wrap' } }, donut(parts.map(p => ({ value: p.total, color: p.color })), { size: 120, label: pesoShort(d.total) }), h('div.col.grow', { style: { gap: '8px' } }, ...parts.map((p, i) => { const bar = fillBar(h('i', { style: { background: p.color } }), p.total / (parts[0].total || 1) * 100, 90 * i); return h('div', h('div.row.between.small', h('span', h('i', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '3px', background: p.color, marginRight: '8px' } }), p.name), h('b', peso(p.total))), h('div.bar', { style: { marginTop: '4px' } }, bar)); }))) : empty('No expenses recorded this month', 'coins'))));
  const remove = async e => { const reason = await confirm({ title: 'Remove this expense?', message: `${e.category}${e.detail ? ' · ' + e.detail : ''} · ${peso(e.amount)}`, okText: 'Remove', danger: true, requireReason: true }); if (!reason) return; try { await api.action('expense.remove', { id: e.id, reason }); toast('Expense removed', 'ok'); ctx.refresh(); } catch (err) { toast(errorOf(err), 'err'); } };
  el.append(h('div.card.pad-0.stagger', { style: { marginTop: '14px' } }, h('div.card__head', { style: { padding: '18px 18px 0' } }, h('h2', 'History')), d.items.length ? h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Date'), h('th', 'Category'), h('th', 'Reason / reference'), h('th', 'By'), h('th.right', 'Amount'), h('th'))), h('tbody', ...d.items.map(e => h('tr', h('td', dateText(e.day, { month: 'short', day: 'numeric' })), h('td', h('b', e.category === 'Other' ? e.detail : e.category), e.category === 'Other' ? h('div.small.muted', 'Other') : e.detail ? h('div.small.muted', e.detail) : null), h('td.small', e.reference), h('td.small.muted', e.actor, e.fromDrawer ? h('div', h('span.tag.warn.plain', 'From drawer')) : null), h('td.num', h('b', peso(e.amount))), h('td.right', e.canRemove ? h('button.btn.icon.sm.ghost', { 'aria-label': 'Remove', onclick: () => remove(e) }, icon('trash', 'sm')) : null)))))) : empty('No expenses this month', 'coins')));
}
export function expenseForm(ctx) {
  const amount = input({ type: 'number', min: 0, step: '0.01', class: 'big', placeholder: '0.00', inputmode: 'decimal' });
  const category = select(ctx.boot.expenseCategories, { value: 'Delivery' }), detail = input({ placeholder: 'Specify expense type' }), reference = input({ placeholder: 'Reason or reference' }), day = input({ type: 'date', value: todayPH(), max: todayPH() });
  const detailField = field('Specify expense type', detail, 'Required when Other is selected'); detailField.style.display = 'none';
  category.onchange = () => { detailField.style.display = category.value === 'Other' ? '' : 'none'; if (category.value === 'Other') detail.focus(); };
  const cashier = ctx.user?.role === 'cashier';
  const body = h('div.form', field('Amount (₱)', amount), cashier ? field('Category', category) : h('div.form.two', field('Category', category), field('Date', day)), detailField, field('Reason or reference', reference), cashier ? h('p.small.muted', 'Paid out of the cash drawer today. It is taken off the expected cash and the Admin is notified.') : null);
  modal({ title: cashier ? 'Expense from the drawer' : 'Record expense', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('expense.add', { amount: amount.value, category: category.value, detail: detail.value, reference: reference.value, day: day.value }); toast('Expense recorded', 'ok'); close(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Save expense') });
}
