// Sales history and sale details (receipt view, void by Admin).
import { api } from '../api.js';
import { h, clear, peso, num, dateTime, dateText, ago, modal, confirm, toast, errorOf, input, empty, skeleton, segmented, tag, todayPH, countUp, fillBar, viewMore, LOCALE } from '../ui.js';
import { icon } from '../icons.js';
import { go } from '../app.js';

export async function sales(ctx) {
  const { el, params, user, query } = ctx;
  if (!(user.role === 'admin' || user.role === 'cashier' || user.role.includes('sales'))) { go('dashboard'); return; }
  if (params[0]) return saleDetail(ctx);
  let kind = 'all';
  const today = todayPH(), shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const from = input({ type: 'date', value: query.get('from') || today.slice(0, 8) + '01', max: today, onchange: () => { if (to.value < from.value) to.value = from.value; markPreset(); load(); } }),
    to = input({ type: 'date', value: query.get('to') || today, max: today, onchange: () => { if (from.value > to.value) from.value = to.value; markPreset(); load(); } });
  // Quick ranges, e.g. "This month" = Nov 1 – Nov 14 so far; any custom range with the date boxes.
  const lastMonthEnd = shift(today.slice(0, 8) + '01', -1);
  const PRESETS = [['Today', today, today], ['Yesterday', shift(today, -1), shift(today, -1)], ['7 days', shift(today, -6), today], ['This month', today.slice(0, 8) + '01', today], ['Last month', lastMonthEnd.slice(0, 8) + '01', lastMonthEnd]];
  const presetBtns = PRESETS.map(([l, a, b]) => h('button.chip', { type: 'button', onclick: () => { from.value = a; to.value = b; markPreset(); load(); } }, l));
  const markPreset = () => presetBtns.forEach((b, i) => b.classList.toggle('on', PRESETS[i][1] === from.value && PRESETS[i][2] === to.value));
  queueMicrotask(markPreset);
  const q = h('input', { placeholder: 'Search #, customer, clerk', oninput: () => load() });
  const seg = segmented([{ value: 'all', label: 'All' }, { value: 'cash', label: 'Paid in full' }, { value: 'credit', label: 'Credit' }], kind, v => { kind = v; load(); }, { small: true });
  const sum = { total: h('div.kpi__value'), count: h('div.kpi__value'), cash: h('div.kpi__value'), credit: h('div.kpi__value') };
  const list = h('div');
  el.append(h('div.page__head', h('div', h('p.eyebrow', user.role === 'admin' ? 'Store-wide' : user.role === 'cashier' ? 'Payments I received' : 'My paid orders'), h('h1', 'Sales history')), h('div.page__actions', h('button.btn.primary', { onclick: () => go(user.role === 'cashier' ? 'orders' : 'pos') }, icon(user.role === 'admin' || user.role === 'cashier' ? 'cart' : 'plus', 'sm'), user.role === 'cashier' ? 'Payment queue' : user.role === 'admin' ? 'New sale' : 'New order'))),
    h('div.grid.kpi.stagger', h('div.card.kpi', h('div.kpi__label', h('span.ic', icon('receipt', 'sm')), 'Confirmed sales'), sum.total), h('div.card.kpi', h('div.kpi__label', h('span.ic', icon('bars', 'sm')), 'Transactions'), sum.count), h('div.card.kpi.tone-ok', h('div.kpi__label', h('span.ic', icon('banknote', 'sm')), 'Paid in full'), sum.cash), h('div.card.kpi.tone-warn', h('div.kpi__label', h('span.ic', icon('wallet', 'sm')), 'New credit'), sum.credit)),
    h('div.card.salesfilter', { style: { margin: '14px 0' } }, h('div.chips', ...presetBtns), h('div.row.wrap', h('div.search.grow', icon('search', 'sm'), q), seg, h('div.row.daterange', from, h('span.muted', '→'), to))), list);
  async function load() {
    clear(list).append(skeleton(1));
    const d = await api.get('sales', { from: from.value, to: to.value, kind, q: q.value });
    countUp(sum.total, d.summary.total, { format: peso }); countUp(sum.count, d.summary.count, { format: v => String(Math.round(v)) }); countUp(sum.cash, d.summary.cash, { format: peso }); countUp(sum.credit, d.summary.credit, { format: peso });
    clear(list);
    if (!d.items.length) return list.append(h('div.card', empty('No sales in this range', 'receipt')));
    // Confirmed sales per day in the range (newest first) — tap a day to see only that day.
    const days = new Map();
    for (const s of d.items) { const g = days.get(s.day) || { day: s.day, n: 0, total: 0, tawad: 0, credit: 0, items: [] }; g.items.push(s); if (!s.voided) { g.n++; g.total += s.total; if (s.pricingMode === 'tawad') g.tawad++; if (s.kind === 'credit') g.credit++; } days.set(s.day, g); }
    const groups = [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
    const best = Math.max(1, ...groups.map(g => g.total));
    const dayLabel = day => new Date(day + 'T00:00:00+08:00').toLocaleDateString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
    if (from.value !== to.value) {
      const rows = h('div.daylist', ...groups.map((g, k) => h('button.daylist__row', { type: 'button', style: { '--i': Math.min(k, 20) }, onclick: () => { from.value = g.day; to.value = g.day; markPreset(); load(); } },
        h('span.daylist__date', h('b', dayLabel(g.day)), h('span', `${g.n} confirmed sale${g.n === 1 ? '' : 's'}${g.tawad ? ` · ${g.tawad} Tawad` : ''}${g.credit ? ` · ${g.credit} utang` : ''}`)),
        h('span.daylist__bar', h('span.bar', fillBar(h('i'), g.total / best * 100, 40 * k))),
        h('b.daylist__total', peso(g.total)))));
      list.append(h('div.card.stagger', h('div.card__head', h('div', h('h2', 'Confirmed sales per day'), h('p.sub', `${dateText(from.value)} – ${dateText(to.value)} · ${groups.length} day${groups.length === 1 ? '' : 's'} with sales · tap a day to open it`))), rows, viewMore(rows, 7, { label: 'More days' })));
    }
    const row = (s, i) => h('tr.click', { style: { '--i': Math.min(i, 20), opacity: s.voided ? .55 : 1 }, onclick: () => go('sales/' + s.id) },
      h('td', h('b', '#' + s.id), s.customer ? h('div.small.muted', s.customer) : null, s.pricingMode === 'tawad' ? h('div', tag('Tawad', 'warn plain'), h('span.small.muted', ` ${s.tawadReason || ''}`)) : s.pricingMode === 'promo' ? h('div', h('span.promo-badge', { style: { marginLeft: 0 } }, 'Promo')) : null),
      h('td', s.voided ? tag('Voided', 'voided') : tag(s.kind === 'credit' ? 'Credit' : (s.paymentMethod || 'Paid'), s.kind)),
      h('td.small', s.clerk && s.clerk !== s.actor ? [s.actor, h('div.muted', 'Clerk ' + s.clerk)] : s.actor),
      h('td.num', h('b', peso(s.total))),
      h('td.num.small.muted', s.kind === 'cash' ? (s.cashReceived === null ? 'Paid in full' : `${peso(s.cashReceived)} · sukli ${peso(s.change)}`) : `${peso(s.paidNow)} paid · ${peso(s.creditAdded)} utang`),
      h('td.small.muted', new Date(s.created).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })), h('td', icon('chevronRight', 'sm')));
    const body = [];
    let i = 0;
    for (const g of groups) {
      body.push(h('tr.dayhead', h('td', { colSpan: 7 }, h('div.row.between', h('b', dayLabel(g.day)), h('span', `${g.n} confirmed · ${peso(g.total)}`)))));
      for (const s of g.items) body.push(row(s, i++));
    }
    list.append(h('div.card.pad-0', { style: { marginTop: '14px' } }, h('div.table-wrap', h('table.t.t--sales', h('thead', h('tr', h('th', 'Sale'), h('th', 'Type'), h('th', 'Cashier / Clerk'), h('th.right', 'Total'), h('th.right', 'Cash / Paid'), h('th', 'Time'), h('th'))), h('tbody.stagger', ...body)))));
  }
  load();
}

async function saleDetail(ctx) {
  const { el, params, user } = ctx;
  el.append(skeleton(1));
  const s = await api.get('sale', { id: params[0] }); clear(el);
  const voidBtn = user.role === 'admin' && !s.voided ? h('button.btn.danger', { onclick: async () => { const reason = await confirm({ title: 'Void this sale?', message: 'Stock will be returned and the original record kept for audit.', okText: 'Void sale', danger: true, requireReason: true }); if (!reason) return; try { await api.action('sale.void', { id: s.id, reason }); toast('Sale voided', 'ok'); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); } } }, icon('x', 'sm'), 'Void') : null;
  el.append(h('div.page__head', h('div', h('a.small', { href: '#/sales' }, '← Sales history'), h('h1', `Sale #${s.id}`), h('p.muted', `${dateTime(s.created)} · ${s.actor}`), s.pricingMode === 'tawad' ? h('div.row', { style: { marginTop: '6px', gap: '8px' } }, tag('Tawad', 'warn'), h('span.small', `${peso(s.regularSubtotal)} → ${peso(s.total)} · “${s.tawadReason}” · approved at the counter by ${s.actor}`)) : null), h('div.page__actions', h('button.btn', { onclick: () => print() }, icon('printer', 'sm'), 'Print'), voidBtn)));
  const receipt = h('div.receipt', h('div.center', h('b', ctx.boot.storeName), h('div.small', 'Official sales record')), h('hr'),
    ...s.items.map(i => h('div.r', h('span', `${i.name}`, h('br'), h('span.muted', `${num(i.qty)} ${i.unit} × ${peso(i.regularPrice ?? i.unitPrice)}`), i.pricingMode === 'tawad' ? [h('br'), h('span.small.muted', `Tawad share −${peso(i.lineDiscount)}`)] : i.promo ? [h('br'), h('span.promo-badge', { style: { marginLeft: 0 } }, i.promo.label || i.promo.detail || 'Promo'), i.savings ? h('span.small.muted', ` saved ${peso(i.savings)}`) : null] : null), h('span', i.savings ? [h('s.small.muted', peso(Math.round((i.regularPrice ?? i.unitPrice) * i.qty * 100) / 100)), h('br')] : null, peso(i.lineTotal)))), h('hr'),
    s.pricingMode !== 'tawad' && s.items.some(i => i.savings) ? h('div.r', h('span', 'Promo savings'), h('span', '− ' + peso(s.items.reduce((a, i) => a + (i.savings || 0), 0)))) : null,
    s.pricingMode === 'tawad' ? [h('div.r', h('span', 'Regular subtotal'), h('span', peso(s.regularSubtotal))), h('div.r', h('span', `Tawad discount · ${s.tawadReason}`), h('span', '− ' + peso(s.tawadDiscount)))] : s.discountTotal && !s.items.some(i => i.savings) ? h('div.r', h('span', 'Discounts'), h('span', '− ' + peso(s.discountTotal))) : null, h('div.r', h('b', 'TOTAL'), h('b', peso(s.total))),
    s.paymentMethod ? h('div.r', h('span', 'Payment method'), h('span', s.paymentMethod)) : null,
    s.reference ? h('div.r', h('span', 'Payment reference'), h('span', s.reference)) : null,
    s.kind === 'cash' && s.cashReceived === null ? null : s.kind === 'cash' ? [h('div.r', h('span', 'Cash received'), h('span', peso(s.cashReceived))), h('div.r', h('span', 'Change / Sukli'), h('span', peso(s.change)))] : [h('div.r', h('span', 'Customer'), h('span', s.customer)), h('div.r', h('span', 'Paid at counter'), h('span', peso(s.paidNow))), h('div.r', h('span', 'Added to utang'), h('span', peso(s.creditAdded)))],
    h('hr'), h('div.r.small.muted', h('span', `Sale #${s.id} · ${s.kind}`), h('span', dateText(s.day, { year: 'numeric', month: 'short', day: 'numeric' }))), s.voided ? h('div.center', { style: { marginTop: '10px', color: 'var(--danger)', fontWeight: 700 } }, `VOIDED · ${s.voidReason}`) : null);
  el.append(h('div.grid.main.stagger', h('div.card', h('div.card__head', h('h2', 'Items & stock effect')), h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Material'), h('th.right', 'Qty'), h('th.right', 'Price'), h('th.right', 'Line total'), user.role === 'admin' ? h('th.right', 'Cost') : null, h('th.right', 'Stock'))), h('tbody', ...s.items.map(i => h('tr.click', { onclick: () => go('materials/' + i.materialId) }, h('td', h('b', i.name)), h('td.num', `${num(i.qty)} ${i.unit}`), h('td.num', peso(i.regularPrice ?? i.unitPrice), i.promo ? h('div', h('span.promo-badge', i.promo.label || 'Promo')) : null), h('td.num', h('b', peso(i.lineTotal)), i.savings ? h('div.small.muted', `saved ${peso(i.savings)}`) : null), user.role === 'admin' ? h('td.num.small', i.cost === null || i.cost === undefined ? tag('Cost unavailable', 'warn plain') : peso(i.cost)) : null, h('td.num.small.muted', i.before !== null ? `${num(i.before)} → ${num(i.after)}` : '—'))))))), h('div.card', h('div.card__head', h('h2', 'Receipt'), s.voided ? tag('Voided', 'voided') : tag(s.kind === 'credit' ? 'Credit' : (s.paymentMethod || 'Paid'), s.kind)), receipt, user.role === 'admin' ? h('div.receipt', { style: { marginTop: '12px' } }, h('div.r', h('span', 'Cost of goods (FIFO)'), h('span', s.cost === null ? 'Cost unavailable' : peso(s.cost))), h('div.r', h('b', 'Gross profit'), h('b', s.grossProfit === null ? 'Cost unavailable' : peso(s.grossProfit)))) : null, s.customerId ? h('a.btn.block', { href: '#/utang/' + s.customerId, style: { marginTop: '12px' } }, icon('wallet', 'sm'), 'Open customer ledger') : null)));
}
