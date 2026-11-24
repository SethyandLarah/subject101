// Overview page per role: greeting, stock health, growth analytics, activity.
import { api } from '../api.js';
import { viewMore, LOCALE } from '../ui.js';
import { h, fillBar, clear, peso, pesoShort, num, countUp, sparkline, lineChart, barChart, donut, legend, segmented, trend, growthWords, colors, timeText, dateText, ago, greeting, empty, skeleton, tag, statusName, roleName, todayPH, toast, errorOf } from '../ui.js';
import { icon } from '../icons.js';
import { go, avatarEl } from '../app.js';

const shiftDay = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const kindTone = { Sale: ['receipt', 'ok'], 'Stock In': ['download', 'info'], 'Stock Out': ['upload', 'warn'], 'Count adjustment': ['clipboard', 'warn'], 'Opening stock': ['box', ''], 'Void return': ['refresh', 'danger'] };

export async function dashboard({ el, user, boot }) {
  el.append(skeleton(2));
  const isAdmin = user.role === 'admin', isCashier = user.role === 'cashier', isClerk = !isAdmin && user.role.includes('sales'), canSell = isAdmin || isCashier || isClerk, canStock = isAdmin || user.role.includes('stock');
  let period = localStorage.getItem('alaan.period') || 'daily';
  let data = await api.get('dashboard', { period });
  clear(el);

  // Hero greeting
  const clock = h('b'), dateEl = h('span');
  const tickClock = () => { const now = new Date(); clock.textContent = now.toLocaleTimeString(LOCALE, { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }); dateEl.textContent = now.toLocaleDateString(LOCALE, { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric' }); };
  tickClock(); const timer = setInterval(() => { if (!el.isConnected) return clearInterval(timer); tickClock(); }, 15000);
  const hero = h('section.card.hero', { style: user.photo && !isAdmin ? { '--hero-img': `url(/media/staff/${user.id})` } : null },
    user.photo && !isAdmin ? h('div.hero__photo') : null,
    h('div.hero__text', h('p.eyebrow', `${greeting()},`), h('h1', user.name + '!'), h('p.muted', isAdmin ? 'Here is how the store is doing today.' : `${boot.storeName} · ${roleName(user.role)}`),
    ),
    h('img.hero__logo', { src: '/media/logo', alt: boot.storeName + ' logo' }),
    h('div.hero__time', clock, dateEl));
  el.append(h('div.stagger', hero));

  // Stock health tiles (clickable)
  const c = data.counts;
  const categoriesCount = (boot?.categories || []).filter(c => !c.archived).length;
  const tiles = [
    ['Total materials', c.total, 'box', 'ink', 'all', `${categoriesCount} categories`], ['High stock', c.high, 'trendUp', 'ok', 'high', 'at or above high'], ['Adequate', c.adequate, 'check', 'info', 'adequate', 'within range'], ['Low stock', c.low, 'warn', 'warn', 'low', 'below low threshold'], ['Out of stock', c.out, 'alert', 'danger', 'out', 'zero on hand'],
  ];
  const stockGrid = h('div.grid.kpi.stagger', ...tiles.map(([label, value, ic, tone, status, note], i) => {
    const v = h('span', '0');
    const card = h('div.card.kpi.click' + (tone ? '.tone-' + tone : ''), { style: { '--i': i + 1 }, onclick: () => go((canStock ? 'inventory' : 'materials') + (status === 'all' ? '' : '?status=' + status)) }, h('div.kpi__label', h('span.ic', icon(ic, 'sm')), label), h('div.kpi__value', v, h('span.chip-note', note)));
    requestAnimationFrame(() => countUp(v, value, { format: x => String(Math.round(x)) }));
    return card;
  }));
  const stockSection = h('section', { style: { marginTop: '14px' } }, h('div.page__head', { style: { margin: '0 4px 10px' } }, h('div', h('h2', 'Stock health'), h('p.small.muted', 'Counts of material records against each item’s thresholds'))), stockGrid);
  // Cashier and Sales Clerk see their own work first; stock health comes after it.
  if (!(isCashier || isClerk)) el.append(stockSection); // the Cashier has no stock view (no Catalog)

  if (isAdmin) {
    // ---- Growth analytics ---------------------------------------------
    const analyticsBox = h('div');
    let pickedDay = todayPH();
    let compareYear;
    let requestNumber = 0;
    let displayed = new Map();
    let frame;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

    function animateGrowth(metrics) {
      cancelAnimationFrame(frame);
      const previous = displayed;
      let start;
      function draw(progress) {
        displayed = new Map();
        for (const { key, node, target, format } of metrics) {
          const from = previous.get(key) ?? target;
          const value = progress === 1 ? target : from + (target - from) * progress;
          displayed.set(key, value);
          node.textContent = format(value);
        }
      }
      function tick(now) {
        if (!analyticsBox.isConnected) return;
        start ??= now;
        const progress = reducedMotion.matches ? 1 : Math.min(1, (now - start) / 750);
        draw(1 - (1 - progress) ** 3);
        if (progress < 1) frame = requestAnimationFrame(tick);
      }
      if (!previous.size || reducedMotion.matches) draw(1);
      else {
        draw(0);
        frame = requestAnimationFrame(tick);
      }
    }
    const compareWord = a => a.period === 'daily' ? (pickedDay === todayPH() ? 'yesterday' : dateText(a.compare.from, { month: 'short', day: 'numeric' })) : a.period === 'monthly' ? 'previous month' : String(a.previousYear);
    const renderAnalytics = () => {
      const a = data.analytics;
      const metrics = [];
      clear(analyticsBox);
      const kp = (label, g, key, lowerIsGood, ic) => {
        const v = h('div.kpi__value');
        const badge = trend(g, { lowerIsGood });
        if (g.percent !== null) {
          metrics.push({ key: key + '-percent', node: badge.lastChild, target: g.percent, format: x => {
            const percent = Number(x.toFixed(1));
            return (percent > 0 ? '+' : '') + percent + '%';
          } });
        }
        const sparkVals = a.series.map(s => key === 'net' ? s.sales - s.expenses : s[key]);
        const card = h('div.card.kpi', h('div.kpi__label', h('span.ic', icon(ic, 'sm')), label), v, h('div.kpi__foot', badge, h('div.kpi__spark', sparkline(sparkVals, { color: colors[key] || colors.net }))), h('p.small.muted', { style: { marginTop: '6px' } }, growthWords(g, label.toLowerCase(), lowerIsGood) + ` vs ${compareWord(a)}`));
        metrics.push({ key, node: v, target: g.current, format: peso });
        return card;
      };
      const kpis = h('div.grid.kpi.stagger', kp('Sales', a.sales, 'sales', false, 'receipt'), kp('Expenses', a.expenses, 'expenses', true, 'coins'), kp('Sales − Expenses', a.net, 'net', false, 'chart'), kp('Collections', a.collections, 'collections', false, 'handCoins'));
      const chartMode = localStorage.getItem('alaan.chart') || 'line';
      const chartBox = h('div');
      const yearly = a.period === 'yearly';
      const legendItems = yearly
        ? [{ label: `Sales ${a.year}`, color: colors.sales }, { label: `Sales ${a.previousYear}`, color: 'var(--muted)' }, { label: `Expenses ${a.year}`, color: colors.expenses }, { label: `Collections ${a.year}`, color: colors.collections }]
        : [{ label: 'Sales', color: colors.sales }, { label: 'Expenses', color: colors.expenses }, { label: 'Collections', color: colors.collections }];
      const drawChart = mode => {
        clear(chartBox);
        const series = yearly
          ? [{ key: 'sales', label: `Sales ${a.year}`, color: colors.sales, values: a.series.map(s => s.sales) }, { key: 'prevSales', label: `Sales ${a.previousYear}`, color: 'var(--muted)', dash: true, values: a.series.map(s => s.prevSales) }, { key: 'expenses', label: `Expenses ${a.year}`, color: colors.expenses, values: a.series.map(s => s.expenses) }, { key: 'collections', label: `Collections ${a.year}`, color: colors.collections, values: a.series.map(s => s.collections) }]
          : [{ key: 'sales', label: 'Sales', color: colors.sales, values: a.series.map(s => s.sales) }, { key: 'expenses', label: 'Expenses', color: colors.expenses, values: a.series.map(s => s.expenses) }, { key: 'collections', label: 'Collections', color: colors.collections, values: a.series.map(s => s.collections) }];
        chartBox.append(mode === 'bar' ? barChart({ labels: a.series.map(s => s.label), series }) : lineChart({ labels: a.series.map(s => s.label), series }));
      };
      drawChart(chartMode);
      const title = a.period === 'daily' ? `14 days ending ${dateText(a.range.to, { month: 'long', day: 'numeric' })}` : a.period === 'monthly' ? `6 months ending ${dateText(a.range.from, { month: 'long', year: 'numeric' })}` : `${a.year} by month vs ${a.previousYear}`;
      const compareNote = a.period === 'yearly' ? (a.partial ? ` · ${a.year} so far compared with the same days of ${a.previousYear}` : ` · full year compared with ${a.previousYear}`) : a.partial ? ' · compared with the same days last month' : a.period === 'monthly' ? ' · compared with the previous month' : ` · compared with ${compareWord(a)}`;
      const transactionCount = h('span');
      metrics.push({ key: 'transactions', node: transactionCount, target: a.transactions.current, format: x => num(Math.round(x)) });
      const chartCard = h('div.card', h('div.card__head', h('div', h('h2', title), h('p.sub', `Selected: ${dateText(a.range.from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${dateText(a.range.to, { month: 'short', day: 'numeric', year: 'numeric' })}${compareNote} · Last updated ${timeText(new Date().toISOString())}`)),
        h('div.row.wrap', legend(legendItems), segmented([{ value: 'line', label: 'Line' }, { value: 'bar', label: 'Bars' }], chartMode, m => { localStorage.setItem('alaan.chart', m); drawChart(m); }, { small: true }))), chartBox,
        h('div.row.wrap', { style: { marginTop: '10px', gap: '16px' } }, h('span.small.muted', transactionCount, ` confirmed sales in the selected ${a.period === 'daily' ? 'day' : a.period === 'monthly' ? 'month' : 'year'} (${a.transactions.previous} in the comparison period)`), h('a.small', { href: '#/sales?from=' + a.range.from + '&to=' + a.range.to }, 'Open the confirmed sales behind these totals →')));
      const profitRow = h('div.grid.three.stagger', { style: { marginTop: '14px' } },
        h('div.card.flat', h('div.kpi__label', h('span.ic', icon('box', 'sm')), 'Cost of goods sold'), h('div.kpi__value', { style: { fontSize: '22px' } }, a.cogs === null || a.cogs === undefined ? 'Cost unavailable' : peso(a.cogs)), a.costMissingLines ? h('p.small.muted', `${a.costMissingLines} sold lines without cost`) : h('p.small.muted', 'FIFO purchase cost')),
        h('div.card.flat', h('div.kpi__label', h('span.ic', icon('chart', 'sm')), 'Gross profit'), h('div.kpi__value', { style: { fontSize: '22px', color: a.grossProfit < 0 ? 'var(--danger)' : 'var(--primary)' } }, a.grossProfit === null || a.grossProfit === undefined ? 'Cost unavailable' : peso(a.grossProfit)), h('p.small.muted', 'Sales after discounts − COGS')),
        h('div.card.flat', h('div.kpi__label', h('span.ic', icon('receipt', 'sm')), 'Gross margin'), h('div.kpi__value', { style: { fontSize: '22px' } }, a.grossProfit === null || a.grossProfit === undefined || !a.sales?.current ? '—' : (a.grossProfit / a.sales.current * 100).toFixed(1) + '%'), h('a.small', { href: '#/reports' }, 'Full report →')));
      analyticsBox.append(kpis, profitRow, h('div', { style: { height: '14px' } }), chartCard);
      animateGrowth(metrics);
      if (yearly) {
        const header = h('tr', ...['Year', 'Through', 'Sales', 'Expenses', 'Collections'].map(label => h('th', label)));
        const rows = a.history.map(r => h('tr', h('td', r.year), h('td', r.through), ...[r.sales, r.expenses, r.collections].map(v => h('td.num', peso(v)))));
        analyticsBox.append(h('div.card', { style: { marginTop: '14px' } }, h('h2', 'Annual totals'), h('div.table-wrap', h('table.t', h('thead', header), h('tbody', ...rows)))));
      }
    };
    const reload = async () => {
      const request = ++requestNumber;
      try {
        const next = await api.get('dashboard', { period, day: pickedDay, ...(compareYear ? { compareYear } : {}) });
        if (request !== requestNumber) return;
        data = next;
        renderAnalytics();
        renderPicker();
      } catch (err) {
        if (request === requestNumber) toast(errorOf(err), 'err');
      }
    };
    const pickerBox = h('div');
    const renderPicker = () => {
      clear(pickerBox);
      if (period === 'daily') pickerBox.append(h('input.input', { type: 'date', value: pickedDay, max: todayPH(), style: { height: '36px', width: '160px' }, onchange: e => { if (e.target.value) { pickedDay = e.target.value; reload(); } } }));
      else if (period === 'monthly') pickerBox.append(h('input.input', { type: 'month', value: pickedDay.slice(0, 7), max: todayPH().slice(0, 7), style: { height: '36px', width: '170px' }, onchange: e => { if (e.target.value) { pickedDay = e.target.value + '-01'; reload(); } } }));
      else {
        const years = data.analytics.years?.length ? data.analytics.years : [Number(todayPH().slice(0, 4))];
        const all = Array.from(new Set([...years, Number(pickedDay.slice(0, 4)), Number(todayPH().slice(0, 4))])).sort();
        const selected = Number(pickedDay.slice(0, 4));
        const comparison = data.analytics.previousYear ?? selected - 1;
        const choices = [...new Set([...all, comparison])].filter(y => y !== selected).sort((a, b) => b - a);
        const options = (years, value) => years.map(y => h('option', { value: y, selected: y === value }, String(y)));
        pickerBox.append(h('div.row.wrap',
          h('label.small', 'Year ', h('select.select', { onchange: e => { pickedDay = e.target.value + '-01-01'; reload(); } }, ...options(all, selected))),
          h('label.small', 'Compare with ', h('select.select', { onchange: e => { compareYear = e.target.value; reload(); } }, ...options(choices, comparison)))));

      }
    };
    const seg = segmented([{ value: 'daily', label: 'Daily' }, { value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }], period, async v => { period = v; localStorage.setItem('alaan.period', v); pickedDay = todayPH(); await reload(); });
    el.append(h('section', { style: { marginTop: '18px' } }, h('div.page__head', { style: { margin: '0 4px 10px' } }, h('div', h('h2', 'Growth analytics'), h('p.small.muted', 'Pick a day, month or year to see its sales, expenses and collections — compared with the period before it')), h('div.row.wrap', pickerBox, seg)), analyticsBox));
    renderPicker();
    renderAnalytics();

    // ---- Pending + top materials + staff ---------------------------------
    const p = data.pending;
    const pendingList = h('div.list',
      item('clipboard', p.counts ? 'warn' : '', `${p.counts} physical count${p.counts === 1 ? '' : 's'} to review`, 'Approve or decline stock adjustments', () => go('inventory/counts')),
      item('calendar', p.excuses ? 'warn' : '', `${p.excuses} excuse request${p.excuses === 1 ? '' : 's'}`, 'Staff waiting for a decision', () => go('attendance/excuses')),
      item('clock', p.review ? 'warn' : '', `${p.review || 0} attendance day${p.review === 1 ? '' : 's'} to review`, 'Short hours, overtime or incomplete', () => go('attendance/review')),
      item('tag', p.pricing ? 'info' : '', `${p.pricing} material${p.pricing === 1 ? '' : 's'} without a price`, 'New items cannot be sold until priced', () => go('inventory?status=all&nopric=1')),
      item('wallet', p.utang > 0 ? 'danger' : 'ok', `${peso(p.utang)} outstanding utang`, 'Total remaining balance across customers', () => go('utang')));
    const top = h('div.col', { style: { gap: '12px' } }, ...(data.topMaterials.length ? data.topMaterials.map((m, i) => { const max = data.topMaterials[0].total || 1; const bar = fillBar(h('i'), m.total / max * 100, 90 * i); return h('div', h('div.row.between.small', h('b.truncate', m.name), h('span.muted', `${num(m.qty)} ${m.unit} · ${pesoShort(m.total)}`)), h('div.bar', { style: { marginTop: '5px' } }, bar)); }) : [empty('No sales in the last 30 days', 'receipt')]));
    const staffList = h('div.list', ...(data.staffToday.length ? data.staffToday.map(s => h('div.list__item.click', { onclick: () => go('attendance?day=' + todayPH()) }, avatarEl(s), h('span.body', h('b', s.name), h('span', s.title || roleName(s.role))), s.time_in ? h('span.col', { style: { gap: '2px', alignItems: 'flex-end' } }, tag(s.time_out ? 'Timed out' : 'Present', 'Present'), h('span.small.muted', `${timeText(s.time_in)}${s.time_out ? ' – ' + timeText(s.time_out) : ''}`)) : tag('No record yet', 'neutral'))) : [empty('No active staff', 'users')]));
    el.append(h('div.grid.three.stagger', { style: { marginTop: '14px' } },
      h('div.card', h('div.card__head', h('h2', 'Needs attention')), pendingList),
      h('div.card', h('div.card__head', h('h2', 'Top sellers'), h('span.sub', '30 days')), top, viewMore(top, 5)),
      h('div.card', h('div.card__head', h('h2', 'Staff today'), h('a.small', { href: '#/attendance' }, 'Attendance →')), staffList)));
  }

  // ---- Role quick actions ------------------------------------------------
  const quick = [];
  if (isCashier) quick.push(['Payment queue', 'Orders from the Sales Clerks', 'bell', 'orders', 'primary'], ['Cash drawer', 'Money by method · end-of-day count', 'banknote', 'cash'], ['Utang payments', 'Record a customer payment', 'wallet', 'utang'], ['Tawad summary', 'Sales at price − Tawad = Net', 'chart', 'summary'], ['Expense from drawer', 'Record money paid out', 'coins', 'expenses']);
  if (isClerk) quick.push(['New order', 'Build the order with the customer', 'plus', 'pos', 'primary'], ['My orders', 'See which orders were paid', 'send', 'orders'], ['Catalog', 'Prices, promos and stock', 'box', 'materials']);
  if (canStock) quick.push(['Stock In', 'Receive a supplier delivery', 'download', 'inventory?action=in']);
  if (canStock) quick.push(['Physical count', 'Submit a count for review', 'clipboard', 'inventory?action=count']);
  if (canStock) quick.push(['Add material', 'Create a new catalog item', 'plus', 'inventory?action=new']);
  quick.push(['Attendance', 'Time in / out and excuses', 'clock', 'attendance']);
  const k = (label, value, ic, sub, fmt = peso, extra = {}) => { const v = h('div.kpi__value', fmt(0)); countUp(v, value, { format: fmt, duration: 900 }); const act = extra.onclick; return h('div.card.kpi' + (act ? '.click' : '') + (extra.tone ? '.tone-' + extra.tone : ''), { style: { textAlign: 'left' }, onclick: act, role: act ? 'button' : null, tabindex: act ? '0' : null, onkeydown: act ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } } : null }, h('div.kpi__label', h('span.ic', icon(ic, 'sm')), label, extra.live ? h('span.live-dot', { style: { marginLeft: 'auto' } }) : null), v, sub ? h('p.small.muted', { style: { marginTop: '6px' } }, sub) : null); };
  const int = x => String(Math.round(x));
  const dayLabel = d => new Date(d + 'T00:00:00+08:00').toLocaleDateString(LOCALE, { weekday: 'short', timeZone: 'Asia/Manila' });
  // ---- Cashier portal: queue + money received ----
  if (isCashier && data.myWeek) {
    const t = data.today, wk = data.myWeek, o = data.orders || { queue: 0, waitingValue: 0 };
    el.append(h('div.grid.kpi.stagger.cashier-kpis', { style: { marginTop: '14px' } },
      k('Waiting for payment', o.queue, 'bell', o.queue ? 'Tap to open the queue' : 'Queue is clear', int, { onclick: () => go('orders'), tone: o.queue ? 'warn' : 'ok', live: true }),
      k('Collected today', t.collected, 'banknote', 'Cash & digital received', peso, { onclick: () => go('cash?view=collections') }),
      k('Sales today', t.sales, 'receipt', `${t.transactions} transaction${t.transactions === 1 ? '' : 's'}`, peso, { onclick: () => go('sales?from=' + todayPH() + '&to=' + todayPH()) }),
      k('Utang today', t.credit, 'wallet', 'Credit given to customers', peso, { onclick: () => go('utang') })));
    const weekTotal = wk.reduce((a, d) => a + d.paid + d.credit, 0);
    el.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('div', h('h2', 'Payments I received · last 7 days'), h('p.sub', `${peso(weekTotal)} · ${wk.reduce((a, d) => a + d.n, 0)} transactions`)), legend([{ label: 'Collected', color: colors.sales }, { label: 'Utang', color: colors.expenses }])),
      barChart({ labels: wk.map(d => dayLabel(d.day)), series: [{ label: 'Collected', color: colors.sales, values: wk.map(d => d.paid) }, { label: 'Utang', color: colors.expenses, values: wk.map(d => d.credit) }], height: 220, values: false })));
    // Today: money by payment method, and sales at price − Tawad = net.
    const ms = data.methods || [], mMax = Math.max(1, ...ms.map(x => x.amount));
    const METHOD_COLOR = { Cash: 'var(--primary)', GCash: 'var(--info)', Maya: '#2bb673', Other: 'var(--muted)', Utang: 'var(--warn)' };
    el.append(h('div.grid.two.stagger', { style: { marginTop: '14px', alignItems: 'start' } },
      h('div.card', h('div.card__head', h('div', h('h2', 'Today by payment method'), h('p.sub', 'Cash, digital and utang you handled today')), h('a.small', { href: '#/cash' }, 'Drawer →')),
        h('div.methods', ...ms.map((x, i) => h('div.method', h('span.method__dot', { style: { background: METHOD_COLOR[x.method] } }), h('span.method__name', x.method, h('small', `${x.count} ${x.count === 1 ? 'payment' : 'payments'}`)),
          h('span.method__bar', h('span.bar', fillBar(h('i', { style: { background: METHOD_COLOR[x.method] } }), x.amount / mMax * 100, 60 * i))), h('b.method__amt', peso(x.amount)))))),
      h('div.card', h('div.card__head', h('div', h('h2', 'Today: sales − Tawad'), h('p.sub', `${t.tawad} sale${t.tawad === 1 ? '' : 's'} with Tawad`)), h('a.small', { href: '#/summary' }, 'Tawad summary →')),
        h('div.eqmini', h('div', h('span', 'Sales at price'), h('b', peso(t.atPrice))), h('div.op', '−'), h('div.tawad', h('span', 'Tawad'), h('b', peso(t.tawadAmount))), h('div.op', '='), h('div.net', h('span', 'Net sales'), h('b', peso(t.sales)))))));
  }
  // ---- Sales Clerk portal: my orders ----
  if (isClerk && data.myWeek) {
    const t = data.today, wk = data.myWeek, o = data.orders || { today: 0, paid: 0, waiting: 0, waitingValue: 0 };
    el.append(h('div.grid.kpi.stagger.cashier-kpis', { style: { marginTop: '14px' } },
      k('Orders today', o.today, 'send', `${o.paid} paid at the Cashier`, int, { onclick: () => go('orders') }),
      k('Waiting at Cashier', o.waiting, 'clock', o.waiting ? peso(o.waitingValue) + ' not paid yet' : 'All sent orders are done', int, { onclick: () => go('orders'), tone: o.waiting ? 'warn' : 'ok', live: !!o.waiting }),
      k('My paid orders', t.sales, 'receipt', `${t.transactions} sale${t.transactions === 1 ? '' : 's'} today`, peso, { onclick: () => go('sales?from=' + todayPH() + '&to=' + todayPH()) }),
      k('Average order', t.average, 'chart', t.tawad ? `${t.tawad} Tawad · −${peso(t.tawadAmount)}` : `${t.materials} different materials`, peso, { onclick: () => go('orders') })));
    el.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('div', h('h2', 'My orders paid · last 7 days'), h('p.sub', `${peso(wk.reduce((a, d) => a + d.paid + d.credit, 0))} · ${wk.reduce((a, d) => a + d.n, 0)} orders`)), legend([{ label: 'Paid', color: colors.sales }, { label: 'Utang', color: colors.expenses }])),
      barChart({ labels: wk.map(d => dayLabel(d.day)), series: [{ label: 'Paid', color: colors.sales, values: wk.map(d => d.paid) }, { label: 'Utang', color: colors.expenses, values: wk.map(d => d.credit) }], height: 220, values: false })));
  }
  if (isClerk) el.append(stockSection);
  if (!isAdmin) el.append(h('div.grid.three.stagger', { style: { marginTop: '14px' } }, ...quick.map(([t, s, ic, path, tone]) => h('button.card.kpi.click', { style: { textAlign: 'left' }, onclick: () => go(path) }, h('div.row', h('span.ic', { style: tone ? { background: 'var(--primary)', color: 'var(--primary-ink)', width: '38px', height: '38px', borderRadius: '12px', display: 'grid', placeItems: 'center' } : { width: '38px', height: '38px', borderRadius: '12px', display: 'grid', placeItems: 'center', background: 'var(--surface-3)' } }, icon(ic)), h('div.grow', h('b', t), h('p.small.muted', s)), icon('chevronRight', 'sm'))))));

  // ---- Recent columns ----------------------------------------------------
  const cols = [];
  if (canSell && data.recentSales) cols.push(h('div.card', h('div.card__head', h('div', h('h2', isAdmin ? 'Recent sales' : isClerk ? 'My paid orders' : 'Sales I received'), h('p.sub', data.today ? `${peso(data.today.sales)} today · ${data.today.transactions} transaction${data.today.transactions === 1 ? '' : 's'}` : '')), h('a.small', { href: '#/sales' }, 'All sales →')),
    data.recentSales.length ? h('div.list', ...data.recentSales.map(s => h('div.list__item.click', { onclick: () => go('sales/' + s.id) }, s.firstPhoto ? h('span.ic.photo', h('img', { src: `/media/item/${s.firstMaterialId}`, alt: '', loading: 'lazy' })) : h('span.ic.' + (s.voided ? 'danger' : s.kind === 'credit' ? 'warn' : 'ok'), icon(s.kind === 'credit' ? 'wallet' : 'receipt')), h('span.body', h('b', `Sale #${s.id}${s.customer ? ' · ' + s.customer : ''}`), h('span', `${s.firstName}${s.lineCount > 1 ? ` +${s.lineCount - 1} more` : ''} · ${s.actor} · ${ago(s.created)}`)), h('b.num', peso(s.total))))) : empty('No sales yet', 'receipt')));
  if (canStock && data.recentMovements) cols.push(h('div.card', h('div.card__head', h('h2', 'Stock movements'), h('a.small', { href: '#/inventory/movements' }, 'All movements →')),
    data.recentMovements.length ? h('div.list', ...data.recentMovements.map(m => { const [ic, tone] = kindTone[m.kind] || ['box', '']; return h('div.list__item.click', { onclick: () => go('materials/' + (m.materialId || '')) }, m.photo ? h('span.ic.photo', h('img', { src: `/media/item/${m.materialId}`, alt: '', loading: 'lazy' })) : h('span.ic.' + tone, icon(ic)), h('span.body', h('b', m.material), h('span', `${m.kind} · ${num(m.before)} → ${num(m.after)} ${m.unit} · ${m.actor}`)), h('span.small.muted', ago(m.created))); })) : empty('No movements yet', 'boxes')));
  if (canStock && data.lowStock) cols.push(h('div.card', h('div.card__head', h('h2', 'Reorder soon'), h('a.small', { href: '#/inventory?status=low' }, 'Low stock →')),
    data.lowStock.length ? h('div.list', ...data.lowStock.map(m => h('div.list__item.click', { onclick: () => go('materials/' + m.id) }, m.photo ? h('span.ic.photo', h('img', { src: `/media/item/${m.id}`, alt: '', loading: 'lazy' })) : h('span.ic.' + (m.status === 'out' ? 'danger' : 'warn'), icon(m.status === 'out' ? 'alert' : 'warn')), h('span.body', h('b', m.label), h('span', `${num(m.qty)} ${m.unit} · low threshold ${num(m.low)}`)), tag(statusName(m.status), m.status)))) : empty('All items are above their low threshold', 'check')));
  if (!isAdmin) cols.push(h('div.card', h('div.card__head', h('h2', 'My activity')), data.notifications.length ? h('div.list', ...data.notifications.slice(0, 6).map(n => h('div.list__item' + (n.read ? '' : '.unread'), h('span.ic.info', icon('bell')), h('span.body', h('b', n.title), h('span', n.detail)), h('span.small.muted', ago(n.created))))) : empty('Nothing yet', 'bell')));
  if (cols.length) el.append(h('div.grid.two.stagger', { style: { marginTop: '14px' } }, ...cols));
}
const item = (ic, tone, title, sub, onclick) => h('div.list__item.click', { onclick }, h('span.ic.' + tone, icon(ic)), h('span.body', h('b', title), h('span', sub)), icon('chevronRight', 'sm'));
