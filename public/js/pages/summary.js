// Cashier/Admin › Sales summary: sales at price − Tawad = net sales, and which materials
// were sold with Tawad (haggled) vs at the regular / promo price.
import { api } from '../api.js';
import { h, clear, peso, num, empty, skeleton, countUp, fillBar, dateTime, todayPH, segmented, input } from '../ui.js';
import { icon } from '../icons.js';
import { go } from '../app.js';

const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export async function summary(ctx) {
  const { el, user, query } = ctx;
  if (!(user.role === 'admin' || user.role === 'cashier')) { go('dashboard'); return; }
  const today = todayPH();
  const from = query.get('from') || today, to = query.get('to') || today;
  el.append(skeleton(2));
  const d = await api.get('summary', { from, to });
  clear(el);
  const range = from === to && to === today ? 'today' : from === shift(today, -6) && to === today ? 'week' : from === today.slice(0, 8) + '01' && to === today ? 'month' : 'custom';
  const seg = segmented([{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: 'This month' }], range, v => go(`summary?from=${v === 'today' ? today : v === 'week' ? shift(today, -6) : today.slice(0, 8) + '01'}&to=${today}`));
  const fromIn = input({ type: 'date', value: d.from, max: today }), toIn = input({ type: 'date', value: d.to, max: today });
  fromIn.onchange = toIn.onchange = () => go(`summary?from=${fromIn.value}&to=${toIn.value}`);
  el.append(h('div.page__head', h('div', h('p.eyebrow', user.role === 'admin' ? 'All cashiers' : 'Sales I received'), h('h1', 'Sales & Tawad summary'), h('p.muted', 'Sales at price − Tawad = Net sales. See which materials had a Tawad and which did not.')),
    h('div.page__actions.summary__range', seg, h('div.row', { style: { gap: '6px' } }, fromIn, h('span.muted', '→'), toIn))));

  // ---- The equation: at price − Tawad = net ----
  const val = (v, cls = '') => { const n = h('b.eq__v' + cls, peso(0)); countUp(n, v, { format: peso, duration: 1000 }); return n; };
  el.append(h('div.card.eq.stagger',
    h('div.eq__part', h('span.eq__label', 'Sales at price'), val(d.atPrice), h('span.small.muted', `${d.transactions} sale${d.transactions === 1 ? '' : 's'}`)),
    h('span.eq__op', '−'),
    h('div.eq__part.tawad', h('span.eq__label', 'Haggled / Tawad'), val(d.tawad, '.warn'), h('span.small.muted', `${d.tawadSales} sale${d.tawadSales === 1 ? '' : 's'} with Tawad`)),
    h('span.eq__op', '='),
    h('div.eq__part.net', h('span.eq__label', 'Net sales'), val(d.net, '.ok'), h('span.small.muted', d.atPrice ? `Tawad is ${(d.tawad / d.atPrice * 100).toFixed(1)}% of sales` : 'No sales yet'))));

  // ---- Materials with and without Tawad ----
  const maxNet = Math.max(1, ...d.withTawad.map(l => l.atPrice), ...d.withoutTawad.map(l => l.net));
  const row = (l, i, tawad) => h('div.sumrow', { style: { '--i': i } },
    l.photo ? h('img.sumrow__img', { src: `/media/item/${l.id}`, alt: '', loading: 'lazy' }) : h('span.sumrow__img.ph', icon('box', 'sm')),
    h('div.sumrow__body', h('div.row.between', h('b', l.name), h('b', peso(l.net))),
      h('div.row.between.small.muted', h('span', `${num(l.qty)} ${l.unit} · ${l.sales} sale${l.sales === 1 ? '' : 's'}`), tawad ? h('span', h('s', peso(l.atPrice)), h('span.tawad-amt', ` −${peso(l.tawad)}`)) : h('span', 'Regular / promo price')),
      h('div.bar.sumrow__bar', fillBar(h('i', { style: { background: tawad ? 'var(--warn)' : 'var(--primary)' } }), (tawad ? l.atPrice : l.net) / maxNet * 100, 60 * i))));
  el.append(h('div.grid.two.stagger', { style: { marginTop: '14px', alignItems: 'start' } },
    h('div.card', h('div.card__head', h('div', h('h2', h('span.dot.warn'), 'Materials with Tawad'), h('p.sub', `${d.withTawad.length} material${d.withTawad.length === 1 ? '' : 's'} · −${peso(d.tawad)}`))),
      d.withTawad.length ? h('div.sumlist', ...d.withTawad.map((l, i) => row(l, i, true))) : empty('No Tawad in this period', 'check')),
    h('div.card', h('div.card__head', h('div', h('h2', h('span.dot.ok'), 'Materials without Tawad'), h('p.sub', `${d.withoutTawad.length} material${d.withoutTawad.length === 1 ? '' : 's'} · ${peso(d.withoutTawad.reduce((a, l) => a + l.net, 0))}`))),
      d.withoutTawad.length ? h('div.sumlist', ...d.withoutTawad.map((l, i) => row(l, i, false))) : empty('No sales yet', 'receipt'))));

  // ---- Each Tawad sale ----
  el.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('div', h('h2', 'Tawad sales'), h('p.sub', 'Who agreed to the Tawad, the reason and the amount.'))),
    d.tawadList.length ? h('div.list', ...d.tawadList.map(s => h('button.list__item.click', { onclick: () => go('sales/' + s.id) }, h('span.ic.warn', icon('receipt')),
      h('span.body', h('b', `Sale #${s.id} · ${s.reason || 'Tawad'}`), h('span', `${dateTime(s.created)} · ${s.clerk ? 'Clerk ' + s.clerk + ' · ' : ''}Cashier ${s.cashier}`)),
      h('span.right', h('div.small.muted', h('s', peso(s.atPrice)), ` −${peso(s.tawad)}`), h('b', peso(s.net)))))) : empty('No sales with Tawad', 'check')));
}
