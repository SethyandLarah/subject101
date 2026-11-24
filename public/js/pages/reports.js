// Reports (Admin): totals for a date range with breakdowns.
import { api } from '../api.js';
import { h, fillBar, clear, peso, num, pesoShort, dateText, input, empty, skeleton, countUp, barChart, legend, colors, todayPH, viewMore, LOCALE } from '../ui.js';
import { icon } from '../icons.js';
import { go } from '../app.js';

export async function reports(ctx) {
  const { el, user, query } = ctx;
  if (user.role !== 'admin') { go('dashboard'); return; }
  const from = input({ type: 'date', value: query.get('from') || todayPH().slice(0, 8) + '01', onchange: () => load() }), to = input({ type: 'date', value: query.get('to') || todayPH(), max: todayPH(), onchange: () => load() });
  const presets = h('div.chips', ...[['Today', 0], ['7 days', 6], ['30 days', 29], ['This month', 'm']].map(([l, n]) => h('button.chip', { onclick: () => { const t = todayPH(); if (n === 'm') { from.value = t.slice(0, 8) + '01'; } else { const d = new Date(t + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); from.value = d.toISOString().slice(0, 10); } to.value = t; load(); } }, l)));
  const body = h('div');
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Admin'), h('h1', 'Reports')), h('div.page__actions', h('button.btn', { onclick: () => print() }, icon('printer', 'sm'), 'Print'))), h('div.card', { style: { marginBottom: '14px' } }, h('div.row.wrap', presets, h('span.grow'), h('div.row', from, h('span.muted', '→'), to))), body);
  async function load() {
    clear(body).append(skeleton(2));
    const r = await api.get('reports', { from: from.value, to: to.value }); clear(body);
    const kp = (label, v, ic, tone, sub) => { const val = h('div.kpi__value'); requestAnimationFrame(() => countUp(val, v, { format: peso })); return h('div.card.kpi' + (tone ? '.tone-' + tone : ''), h('div.kpi__label', h('span.ic', icon(ic, 'sm')), label), val, sub ? h('p.small.muted', { style: { marginTop: '6px' } }, sub) : null); };
    body.append(h('div.grid.kpi.stagger', kp('Confirmed sales', r.sales, 'receipt', 'ok', `${r.transactions} transactions`), kp('Expenses', r.expenses, 'coins', 'warn'), kp('Sales − Expenses', r.net, 'chart', r.net >= 0 ? 'ok' : 'danger'), kp('Collections (utang paid)', r.collections, 'handCoins', 'info', 'Not counted as new sales')));
    const gpCard = (label, v, ic, tone, sub) => v === null ? h('div.card.kpi.tone-warn', h('div.kpi__label', h('span.ic', icon(ic, 'sm')), label), h('div.kpi__value', 'Cost unavailable'), h('p.small.muted', { style: { marginTop: '6px' } }, `${r.costMissingLines} sold line${r.costMissingLines === 1 ? '' : 's'} have no purchase cost`)) : kp(label, v, ic, tone, sub);
    body.append(h('div.grid.kpi.stagger', { style: { marginTop: '14px' } }, kp('Collected at counter', r.collected, 'banknote', 'ok', 'Cash & digital received for sales'), kp('Credit sales (utang)', r.creditSales, 'wallet', 'warn', 'Sold on credit, not yet collected'), gpCard('Cost of goods sold', r.cogs, 'box', '', 'FIFO purchase cost of items sold'), gpCard('Gross profit', r.grossProfit, 'chart', r.grossProfit >= 0 ? 'ok' : 'danger', 'Sales after discounts − cost of goods sold')));
    if (r.costPending?.length) body.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('div', h('h2', 'Stock without purchase cost'), h('p.sub', 'Enter an opening cost so profit can be computed for these items.'))), h('div.list', ...r.costPending.map(m => h('a.list__item', { href: '#/materials/' + m.id }, h('span.ic.warn', icon('box')), h('span.body', h('b', m.name), h('span', `${num(m.qty)} on hand · Cost unavailable`)), h('span.btn.sm', 'Enter opening cost'))))));
    const table = (title, rows, cols) => {
      if (!rows.length) return h('div.card', h('div.card__head', h('h2', title)), h('div.empty.empty--compact', icon('receipt'), h('span', 'Nothing in this range')));
      const body = h('tbody', ...rows.map((row, k) => h('tr', ...cols.map((c, ci) => h('td' + (c.right ? '.num' : ''), ci === 0 ? [h('span.rank', String(k + 1)), c.render(row)] : c.render(row))))));
      return h('div.card', h('div.card__head', h('h2', title), h('span.sub', `${rows.length} item${rows.length === 1 ? '' : 's'}`)), h('div.table-wrap', h('table.t.t--rank', h('thead', h('tr', ...cols.map(c => h('th' + (c.right ? '.right' : ''), c.label)))), body)), viewMore(body, 6));
    };
    const maxCat = r.byCategory[0]?.total || 1;
    const trend = h('div.card', h('div.card__head', h('div', h('h2', 'Sales vs expenses'), h('p.sub', r.trend.unit === 'month' ? 'Per month' : `Per day · ${dateText(r.range.from)} – ${dateText(r.range.to)}`)), legend([{ label: 'Sales', color: colors.sales }, { label: 'Expenses', color: colors.expenses }, { label: 'Collections', color: colors.collections }])), h('div.col', { style: { gap: '10px' } }, barChart({ labels: r.trend.buckets.map(d => r.trend.unit === 'month' ? new Date(d + '-01T00:00:00Z').toLocaleString(LOCALE, { month: 'short', timeZone: 'UTC' }) : String(Number(d.slice(8)))), series: [{ label: 'Sales', color: colors.sales, values: r.trend.sales }, { label: 'Expenses', color: colors.expenses, values: r.trend.expenses }, { label: 'Collections', color: colors.collections, values: r.trend.collections }], height: 230 }),
      h('div.chartsum', h('div', h('i', { style: { background: colors.sales } }), h('span', 'Sales'), h('b', peso(r.sales))), h('div', h('i', { style: { background: colors.expenses } }), h('span', 'Expenses'), h('b', peso(r.expenses))), h('div', h('i', { style: { background: colors.collections } }), h('span', 'Collections'), h('b', peso(r.collections))), h('div', h('i', { style: { background: r.net >= 0 ? 'var(--primary)' : 'var(--danger)' } }), h('span', 'Sales − Expenses'), h('b', peso(r.net))))));
    const categories = h('div.card', h('div.card__head', h('h2', 'Sales by category'), h('span.sub', `${dateText(r.range.from)} – ${dateText(r.range.to)}`)), r.byCategory.length ? h('div.col', { style: { gap: '10px' }, dataset: { list: 'cats' } }, ...r.byCategory.map((c, i) => { const bar = fillBar(h('i'), c.total / maxCat * 100, 90 * i); return h('div', h('div.row.between.small', h('b', c.name), h('span', peso(c.total))), h('div.bar', { style: { marginTop: '4px' } }, bar)); })) : empty('No sales', 'chart'));
    const reports = h('div.report-masonry.stagger', categories,
      table('Top materials', r.byMaterial, [{ label: 'Material', render: x => h('b', x.name) }, { label: 'Qty', right: true, render: x => `${num(x.qty)} ${x.unit}` }, { label: 'Sales', right: true, render: x => peso(x.total) }]),
      table('Expenses by type', r.byExpense, [{ label: 'Type', render: x => h('b', x.name) }, { label: 'Total', right: true, render: x => peso(x.total) }]),
      table('Deliveries by supplier', r.bySupplier, [{ label: 'Supplier', render: x => h('b', x.name) }, { label: 'Deliveries', right: true, render: x => x.deliveries }, { label: 'Units', right: true, render: x => num(x.qty) }]),
      table('Sales by clerk', r.byClerk, [{ label: 'Clerk', render: x => h('b', x.name) }, { label: 'Transactions', right: true, render: x => x.count }, { label: 'Sales', right: true, render: x => peso(x.total) }]));
    body.append(trend, reports);
    const cats = body.querySelector('[data-list="cats"]'); if (cats) { const more = viewMore(cats, 6); if (more) cats.after(more); }
    body.append(h('div.row', { style: { marginTop: '12px', justifyContent: 'flex-end' } }, h('a.btn', { href: `#/sales?from=${r.range.from}&to=${r.range.to}` }, icon('receipt', 'sm'), 'Open sales in this range')));
  }
  load();
}
