// Read-only queries. Each returns plain JSON for one screen of the app.
// Money comes back in pesos and quantities in plain units.
import { dayOf, timeOf, shiftDay, monthStart, nextMonth, EXPENSE_CATEGORIES, UNITS, DECIMAL_UNITS, ATTENDANCE_TITLES } from './db.mjs';
import { promoText, priceLine } from './pricing.mjs';
import { TAPS, TAP_LABELS, allowedTaps, compute, scheduledMinutes, payFor, createPayroll } from './payroll.mjs';
import { need, isAdmin, canSell, canStock, canOrder, canCash, publicUser, titleOf, pesos, units, effectivePrice, stockStatus, date, id, int, DEFAULT_APP_NAME } from './common.mjs';

export function createQueries(db) {
  const sql = s => db.prepare(s);
  const setting = key => sql('SELECT value FROM settings WHERE key=?').get(key)?.value || '';
  const labelOf = m => m.name + (m.variant ? ' · ' + m.variant : '');

  const materialOut = (m, u) => ({
    id: m.id, sku: m.sku, name: m.name, variant: m.variant, label: labelOf(m), unit: m.unit, decimal: DECIMAL_UNITS.has(m.unit),
    categoryId: m.category_id, category: m.category, qty: units(m.qty), low: units(m.low), high: units(m.high),
    status: stockStatus(m), photo: !!m.photo, archived: !!m.archived,
    price: canSell(u) ? pesos(m.price) : undefined, discount: canSell(u) ? m.discount : undefined,
    effective: canSell(u) ? pesos(m.price === null ? null : m.promo_type === 'percent' ? Math.round(m.price * (100 - m.promo_value) / 100) : m.promo_type === 'fixed' ? m.promo_value : m.price) : undefined,
    promo: canSell(u) && m.promo_type && m.price !== null ? { type: m.promo_type, qty: m.promo_qty, value: m.promo_type === 'percent' ? m.promo_value : pesos(m.promo_value), label: promoText(m) } : null,
    hasPrice: m.price !== null, revision: m.revision ?? undefined,
    // Purchase cost figures are Admin-only (never sent to the Sales Clerk portal).
    cost: isAdmin(u) ? costSummary(m.id) : undefined,
  });
  const costSummary = mid => {
    const r = sql('SELECT coalesce(sum(remaining),0) AS q, coalesce(sum(CASE WHEN unit_cost IS NULL THEN remaining ELSE 0 END),0) AS pending, coalesce(sum(CASE WHEN unit_cost IS NOT NULL THEN remaining*unit_cost ELSE 0 END),0) AS value FROM movements WHERE material_id=? AND remaining>0').get(mid);
    const last = sql("SELECT unit_cost FROM movements WHERE material_id=? AND kind IN ('Stock In','Opening stock') AND unit_cost IS NOT NULL ORDER BY id DESC LIMIT 1").get(mid)?.unit_cost ?? null;
    const known = r.q - r.pending;
    return { lastCost: pesos(last), averageCost: known > 0 ? pesos(Math.round(r.value / known)) : null, pendingQty: units(r.pending), stockValue: r.pending > 0 ? null : pesos(Math.round(r.value / 1000)) };
  };
  const saleOut = s => ({
    id: s.id, kind: s.kind, actor: s.actor_name, actorId: s.actor, customer: s.customer_name || null, customerId: s.customer_id,
    subtotal: pesos(s.subtotal), discountTotal: pesos(s.discount_total), total: pesos(s.total), cashReceived: pesos(s.cash_received),
    change: pesos(s.change_due), paidNow: pesos(s.paid_now), creditAdded: pesos(s.credit_added), reference: s.reference, paymentMethod: s.payment_method ?? (s.cash_received !== null ? "Cash" : null),
    voided: !!s.voided, voidReason: s.void_reason, day: s.day, created: s.created, items: s.items ?? undefined,
    clerk: s.clerk_name || null, orderId: s.order_id || null, pricingMode: s.pricing_mode || 'regular', regularSubtotal: pesos(s.regular_subtotal ?? s.subtotal), tawadDiscount: pesos(s.tawad_discount || 0), tawadReason: s.tawad_reason || null,
  });
  const saleCost = sid => { const r = sql('SELECT sum(cost) AS c, sum(cost IS NULL) AS missing FROM sale_items WHERE sale_id=?').get(sid); return r.missing ? null : (r.c || 0); };
  const shiftFor = (u, day) => sql('SELECT shift_start AS start, shift_end AS end, lunch_start AS lunchStart, lunch_end AS lunchEnd FROM schedules WHERE user_id=? AND effective<=? ORDER BY effective DESC, id DESC LIMIT 1').get(u.id, day)
    || { start: u.shift_start, end: u.shift_end, lunchStart: u.lunch_start || '11:30', lunchEnd: u.lunch_end || '13:00' };
  const payroll = createPayroll(db, (u, d) => shiftFor(u, d));
  const graceSetting = () => { const v = Number(sql("SELECT value FROM settings WHERE key='grace_minutes'").get()?.value); return Number.isInteger(v) ? v : 10; };
  const unread = u => sql(`SELECT count(*) AS n FROM notifications n WHERE (${isAdmin(u) ? 'n.recipient IS NULL OR n.recipient=?' : 'n.recipient=?'}) AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.user_id=?)`).get(u.id, u.id).n;
  const balanceOf = cid => {
    const credit = sql('SELECT coalesce(sum(credit_added),0) AS v FROM sales WHERE customer_id=? AND voided=0').get(cid).v;
    const paid = sql('SELECT coalesce(sum(amount),0) AS v FROM payments WHERE customer_id=? AND at_counter=0').get(cid).v;
    return { credit, paid, balance: credit - paid };
  };
  const stockCounts = () => {
    const rows = sql('SELECT qty, low, high FROM materials WHERE archived=0').all();
    const c = { total: rows.length, high: 0, adequate: 0, low: 0, out: 0 };
    for (const r of rows) c[stockStatus(r)]++;
    return c;
  };

  // ---- Growth analytics -------------------------------------------------
  const sum = (table, column, from, to, extra = '') => sql(`SELECT coalesce(sum(${column}),0) AS v FROM ${table} WHERE day BETWEEN ? AND ? ${extra}`).get(from, to).v;
  const totals = (from, to) => ({
    sales: sum('sales', 'total', from, to, 'AND voided=0'),
    expenses: sum('expenses', 'amount', from, to),
    collections: sum('payments', 'amount', from, to, 'AND at_counter=0'),
    transactions: sql('SELECT count(*) AS v FROM sales WHERE day BETWEEN ? AND ? AND voided=0').get(from, to).v,
    // Money actually received: cash/digital sales in full + amounts paid at the counter on credit sales (+ later collections reported separately).
    collected: sum('sales', 'paid_now', from, to, 'AND voided=0'),
    credit: sum('sales', 'credit_added', from, to, 'AND voided=0'),
    ...(() => { const r = sql('SELECT coalesce(sum(i.cost),0) AS cogs, coalesce(sum(i.cost IS NULL),0) AS missing FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.voided=0 AND s.day BETWEEN ? AND ?').get(from, to); return { cogs: r.cogs, costMissing: r.missing }; })(),
  });
  // Growth wording: for expenses, "lower" is good. Handles a zero baseline.
  const growth = (current, previous) => {
    const diff = current - previous;
    const percent = previous === 0 ? (current === 0 ? 0 : null) : Math.round(diff / previous * 1000) / 10;
    return { current: pesos(current), previous: pesos(previous), diff: pesos(diff), percent, direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat' };
  };
  function analytics(period, day, requestedComparison) {
    const today = dayOf();
    if (period === 'yearly') {
      const year = Number(day.slice(0, 4)), start = `${year}-01-01`, end = `${year}-12-31`;
      const partial = year === Number(today.slice(0, 4));
      const curEnd = partial ? today : end;
      const requested = Number(requestedComparison);
      const comparison = /^\d{4}$/.test(requestedComparison || '') && requested >= 2000 && requested <= Number(today.slice(0, 4)) && requested !== year ? requested : year - 1;
      const matchingMonth = comparison + today.slice(4, 7) + '-01';
      const matchingEnd = shiftDay(nextMonth(matchingMonth), -1);
      const matchingDay = [comparison + today.slice(4), matchingEnd].sort()[0];
      const prevStart = `${comparison}-01-01`, prevEnd = partial ? matchingDay : comparison === Number(today.slice(0, 4)) ? today : `${comparison}-12-31`;
      const cur = totals(start, curEnd), prev = totals(prevStart, prevEnd);
      const series = [];
      for (let m = 1; m <= 12; m++) {
        const mm = String(m).padStart(2, '0'), from = `${year}-${mm}-01`, to = shiftDay(nextMonth(from), -1), pf = `${comparison}-${mm}-01`, pt = shiftDay(nextMonth(pf), -1);
        const t = totals(from, to), pv = totals(pf, pt < prevEnd ? pt : prevEnd);
        series.push({ label: new Date(from + 'T00:00:00Z').toLocaleString('en-PH', { month: 'short', timeZone: 'UTC' }), key: from.slice(0, 7), sales: pesos(t.sales), expenses: pesos(t.expenses), collections: pesos(t.collections), prevSales: pesos(pv.sales), prevExpenses: pesos(pv.expenses), prevCollections: pesos(pv.collections) });
      }
      const firstSale = sql('SELECT min(day) AS d FROM (SELECT day FROM sales UNION ALL SELECT day FROM expenses UNION ALL SELECT day FROM payments)').get().d || today;
      const years = []; for (let y = Number(firstSale.slice(0, 4)); y <= Number(today.slice(0, 4)); y++) years.push(y);
      const history = years.slice(-3).reverse().map(y => {
        const end = y === Number(today.slice(0, 4)) ? today : y + '-12-31';
        const t = totals(y + '-01-01', end);
        return { year: y, through: end, sales: pesos(t.sales), expenses: pesos(t.expenses), collections: pesos(t.collections) };
      });
      return {
        period, year, previousYear: comparison, years, history, range: { from: start, to: curEnd }, compare: { from: prevStart, to: prevEnd }, partial,
        sales: growth(cur.sales, prev.sales), expenses: growth(cur.expenses, prev.expenses), net: growth(cur.sales - cur.expenses, prev.sales - prev.expenses),
        collections: growth(cur.collections, prev.collections), transactions: { current: cur.transactions, previous: prev.transactions }, series,
      };
    }
    if (period === 'monthly') {
      const start = monthStart(day), end = shiftDay(nextMonth(day), -1);
      const prevStart = monthStart(shiftDay(start, -1));
      // Compare equivalent partial periods when the month is still running.
      const partial = day.slice(0, 7) === today.slice(0, 7);
      const dayNumber = Number((partial ? today : end).slice(8, 10));
      const prevEndFull = shiftDay(start, -1);
      const prevEnd = partial ? (prevStart.slice(0, 8) + String(Math.min(dayNumber, Number(prevEndFull.slice(8, 10)))).padStart(2, '0')) : prevEndFull;
      const cur = totals(start, partial ? today : end), prev = totals(prevStart, prevEnd);
      const series = [];
      for (let i = 5; i >= 0; i--) {
        let m = start; for (let k = 0; k < i; k++) m = monthStart(shiftDay(m, -1));
        const t = totals(m, shiftDay(nextMonth(m), -1));
        series.push({ label: new Date(m + 'T00:00:00Z').toLocaleString('en-PH', { month: 'short', timeZone: 'UTC' }), key: m.slice(0, 7), sales: pesos(t.sales), expenses: pesos(t.expenses), collections: pesos(t.collections) });
      }
      return {
        period, range: { from: start, to: partial ? today : end }, compare: { from: prevStart, to: prevEnd }, partial,
        sales: growth(cur.sales, prev.sales), expenses: growth(cur.expenses, prev.expenses), net: growth(cur.sales - cur.expenses, prev.sales - prev.expenses),
        collections: growth(cur.collections, prev.collections), transactions: { current: cur.transactions, previous: prev.transactions }, series,
      };
    }
    const prevDay = shiftDay(day, -1);
    const cur = totals(day, day), prev = totals(prevDay, prevDay);
    const series = [];
    for (let i = 13; i >= 0; i--) {
      const d = shiftDay(day, -i); const t = totals(d, d);
      series.push({ label: new Date(d + 'T00:00:00Z').toLocaleString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }), key: d, sales: pesos(t.sales), expenses: pesos(t.expenses), collections: pesos(t.collections) });
    }
    return {
      period: 'daily', range: { from: day, to: day }, compare: { from: prevDay, to: prevDay }, partial: false,
      sales: growth(cur.sales, prev.sales), expenses: growth(cur.expenses, prev.expenses), net: growth(cur.sales - cur.expenses, prev.sales - prev.expenses),
      collections: growth(cur.collections, prev.collections), transactions: { current: cur.transactions, previous: prev.transactions }, series,
    };
  }

  const notificationsFor = (u, limit = 60) => sql(`SELECT n.*, a.name AS actor_name, EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.user_id=?) AS read
    FROM notifications n JOIN users a ON a.id=n.actor WHERE ${isAdmin(u) ? 'n.recipient IS NULL OR n.recipient=?' : 'n.recipient=?'} ORDER BY n.id DESC LIMIT ?`).all(u.id, u.id, limit)
    .map(n => ({ id: n.id, kind: n.kind, title: n.title, detail: n.detail, link: n.link, actor: n.actor_name, created: n.created, read: !!n.read }));

  return {
    // Everything the shell needs right after sign-in.
    bootstrap(u) {
      const offlinePending = isAdmin(u) ? sql("SELECT count(*) AS n FROM offline_inbox WHERE status IN ('pending','needs_review')").get().n : 0;
      const day = dayOf();
      return {
        user: publicUser(u), day, shift: shiftFor(u, day), tapLabels: TAP_LABELS, offlinePending, payMethods: ['Cash', 'GCash', 'Maya', 'Bank transfer', 'Other'], storeName: setting('store_name') || 'JS ALAAN HARDWARE', appName: setting('app_name') || DEFAULT_APP_NAME, brandColor: setting('brand_color') || null,
        branding: { customLogo: !!setting('logo'), customBackground: !!setting('background') },
        categories: sql('SELECT * FROM categories ORDER BY (name=\'Uncategorized\'), name').all().map(c => ({ ...c, archived: !!c.archived })),
        suppliers: canStock(u) ? sql('SELECT * FROM suppliers ORDER BY name').all() : [],
        units: UNITS, expenseCategories: EXPENSE_CATEGORIES, attendanceTitles: ATTENDANCE_TITLES, unread: unread(u),
        attendanceToday: { in: sql("SELECT occurred FROM attendance WHERE user_id=? AND day=? AND kind='in'").get(u.id, day)?.occurred || null, out: sql("SELECT occurred FROM attendance WHERE user_id=? AND day=? AND kind='out'").get(u.id, day)?.occurred || null },
      };
    },
    dashboard(u, q) {
      const day = dayOf();
      const out = { counts: stockCounts(), notifications: notificationsFor(u, 12), unread: unread(u) };
      if (isAdmin(u)) {
        const period = ['monthly', 'yearly'].includes(q.get('period')) ? q.get('period') : 'daily';
        out.analytics = analytics(period, q.get('day') ? date(q.get('day')) : day, q.get('compareYear'));
        out.pending = {
          counts: sql("SELECT count(*) AS n FROM counts WHERE status='Pending Approval'").get().n,
          excuses: sql("SELECT count(*) AS n FROM excuses WHERE status='Pending Approval'").get().n,
          pricing: sql('SELECT count(*) AS n FROM materials WHERE price IS NULL AND archived=0').get().n,
          utang: sql('SELECT coalesce(sum(credit_added),0) AS v FROM sales WHERE voided=0').get().v - sql('SELECT coalesce(sum(amount),0) AS v FROM payments WHERE at_counter=0').get().v,
        };
        out.pending.utang = pesos(out.pending.utang);
        out.pending.review = sql("SELECT count(*) AS n FROM earnings e WHERE e.review=1 AND NOT EXISTS (SELECT 1 FROM salary_payment_days d WHERE d.user_id=e.user_id AND d.day=e.day)").get().n;
        { const r = out.analytics.range; const t = totals(r.from, r.to); out.analytics.grossProfit = t.costMissing ? null : pesos(t.sales - t.cogs); out.analytics.cogs = t.costMissing ? null : pesos(t.cogs); out.analytics.costMissingLines = t.costMissing; }
        out.topMaterials = sql(`SELECT i.name, sum(i.qty) AS qty, sum(i.line_total) AS total, i.unit FROM sale_items i JOIN sales s ON s.id=i.sale_id
          WHERE s.voided=0 AND s.day BETWEEN ? AND ? GROUP BY i.material_id ORDER BY total DESC LIMIT 6`).all(shiftDay(day, -29), day)
          .map(r => ({ name: r.name, qty: units(r.qty), unit: r.unit, total: pesos(r.total) }));
        out.staffToday = sql(`SELECT u.id, u.name, u.role, u.job_title, (u.photo IS NOT NULL) AS photo, (SELECT occurred FROM attendance WHERE user_id=u.id AND day=? AND kind='in') AS time_in,
          (SELECT occurred FROM attendance WHERE user_id=u.id AND day=? AND kind='out') AS time_out FROM users u WHERE u.role<>'admin' AND u.active=1 ORDER BY u.name`).all(day, day)
          .map(r => ({ ...r, title: titleOf(r), photo: !!r.photo }));
      }
      if (canSell(u)) {
        const col = u.role === 'cashier' ? 'actor' : 'clerk_id';
        const mine = isAdmin(u) ? '' : `AND s.${col}=` + u.id;
        out.portal = isAdmin(u) ? 'admin' : u.role === 'cashier' ? 'cashier' : 'clerk';
        const t = sql(`SELECT coalesce(sum(total),0) AS total, count(*) AS n FROM sales s WHERE s.day=? AND s.voided=0 ${mine}`).get(day);
        out.today = { sales: pesos(t.total), transactions: t.n };
        if (!isAdmin(u)) {
          // Cashier view: own sales for the last 7 Manila days (collected vs utang) + today's quick numbers.
          const days = []; for (let i = 6; i >= 0; i--) days.push(shiftDay(day, -i));
          const rows = new Map(sql(`SELECT day, sum(total - credit_added) AS paid, sum(credit_added) AS credit, count(*) AS n FROM sales s WHERE s.voided=0 AND s.${col}=? AND day BETWEEN ? AND ? GROUP BY day`).all(u.id, days[0], day).map(r => [r.day, r]));
          out.myWeek = days.map(d => ({ day: d, paid: pesos(rows.get(d)?.paid || 0), credit: pesos(rows.get(d)?.credit || 0), n: rows.get(d)?.n || 0 }));
          const items = sql('SELECT coalesce(sum(i.qty),0) AS q, count(DISTINCT i.material_id) AS m FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.voided=0 AND s.' + col + '=? AND s.day=?').get(u.id, day);
          const tawad = sql(`SELECT count(*) AS n, coalesce(sum(tawad_discount),0) AS d FROM sales WHERE voided=0 AND ${col}=? AND day=? AND pricing_mode='tawad'`).get(u.id, day);
          out.today.average = t.n ? pesos(Math.round(t.total / t.n)) : 0; out.today.materials = items.m; out.today.tawad = tawad.n; out.today.tawadAmount = pesos(tawad.d);
          out.today.collected = pesos(rows.get(day)?.paid || 0); out.today.credit = pesos(rows.get(day)?.credit || 0);
          out.today.atPrice = pesos(t.total + tawad.d);
          if (u.role === 'cashier') {
            out.today.collected += pesos(sql('SELECT coalesce(sum(amount),0) AS amount FROM payments WHERE day=? AND actor=? AND at_counter=0').get(day, u.id).amount);
            // Today's money by payment method (sales paid now + utang payments) — the Cashier's drawer at a glance.
            const m = new Map();
            for (const r of sql("SELECT coalesce(payment_method,'Cash') AS method, coalesce(sum(paid_now),0) AS v, count(*) AS n FROM sales WHERE voided=0 AND actor=? AND day=? AND paid_now>0 GROUP BY 1").all(u.id, day)) m.set(r.method, { amount: r.v, count: r.n });
            for (const r of sql("SELECT coalesce(payment_method,'Cash') AS method, coalesce(sum(amount),0) AS v, count(*) AS n FROM payments WHERE actor=? AND day=? AND at_counter=0 GROUP BY 1").all(u.id, day)) { const x = m.get(r.method) || { amount: 0, count: 0 }; x.amount += r.v; x.count += r.n; m.set(r.method, x); }
            out.methods = ['Cash', 'GCash', 'Maya', 'Other'].map(k => ({ method: k, amount: pesos(m.get(k)?.amount || 0), count: m.get(k)?.count || 0 }))
              .concat([{ method: 'Utang', amount: out.today.credit, count: sql('SELECT count(*) AS n FROM sales WHERE voided=0 AND actor=? AND day=? AND credit_added>0').get(u.id, day).n }]);
          }
          const o = sql(`SELECT count(*) AS n, sum(status='paid') AS paid, sum(status='waiting') AS waiting, coalesce(sum(CASE WHEN status='waiting' THEN total END),0) AS wv FROM orders WHERE day=?${u.role === 'cashier' ? '' : ' AND clerk=' + u.id}`).get(day);
          out.orders = { today: o.n, paid: o.paid || 0, waiting: o.waiting || 0, waitingValue: pesos(o.wv), queue: sql("SELECT count(*) AS n FROM orders WHERE status='waiting'").get().n };
        }
        out.recentSales = sql(`SELECT s.*, u.name AS actor_name, c.name AS customer_name,
          (SELECT i.material_id FROM sale_items i WHERE i.sale_id=s.id ORDER BY i.id LIMIT 1) AS first_material,
          (SELECT m.photo IS NOT NULL FROM sale_items i JOIN materials m ON m.id=i.material_id WHERE i.sale_id=s.id ORDER BY i.id LIMIT 1) AS first_photo,
          (SELECT count(*) FROM sale_items i WHERE i.sale_id=s.id) AS line_count,
          (SELECT i.name FROM sale_items i WHERE i.sale_id=s.id ORDER BY i.id LIMIT 1) AS first_name
          FROM sales s JOIN users u ON u.id=s.actor LEFT JOIN customers c ON c.id=s.customer_id WHERE 1 ${mine} ORDER BY s.id DESC LIMIT 6`).all().map(r => ({ ...saleOut(r), firstMaterialId: r.first_material, firstPhoto: !!r.first_photo, lineCount: r.line_count, firstName: r.first_name }));
      }
      if (canStock(u)) {
        out.recentMovements = sql(`SELECT v.*, m.name, m.variant, m.unit, (m.photo IS NOT NULL) AS has_photo, u.name AS actor_name, s.name AS supplier_name FROM movements v JOIN materials m ON m.id=v.material_id JOIN users u ON u.id=v.actor LEFT JOIN suppliers s ON s.id=v.supplier_id ORDER BY v.id DESC LIMIT 8`).all()
          .map(v => ({ id: v.id, kind: v.kind, material: labelOf(v), materialId: v.material_id, photo: !!v.has_photo, unit: v.unit, delta: units(v.delta), before: units(v.before_qty), after: units(v.after_qty), actor: v.actor_name, supplier: v.supplier_name, reference: v.reference, created: v.created }));
        out.lowStock = sql('SELECT m.*, c.name AS category FROM materials m JOIN categories c ON c.id=m.category_id WHERE m.archived=0 AND m.qty < m.low ORDER BY (m.qty=0) DESC, m.qty*1.0/m.low LIMIT 8').all().map(m => materialOut(m, u));
      }
      return out;
    },
    materials(u, q) {
      const search = (q.get('q') || '').trim().toLowerCase(), category = q.get('category'), status = q.get('status');
      const archived = q.get('archived') === '1';
      const rows = sql(`SELECT m.*, c.name AS category, (SELECT coalesce(max(id),0) FROM movements WHERE material_id=m.id) AS revision FROM materials m JOIN categories c ON c.id=m.category_id WHERE m.archived=? ${category ? 'AND m.category_id=' + int(category, 1) : ''} ORDER BY m.name, m.variant`).all(archived ? 1 : 0);
      let list = rows.map(m => materialOut(m, u));
      if (search) list = list.filter(m => (m.name + ' ' + m.variant + ' ' + m.sku).toLowerCase().includes(search));
      if (status && status !== 'all') list = list.filter(m => m.status === status);
      return { items: list, counts: stockCounts() };
    },
    material(u, q) {
      const m = sql('SELECT m.*, c.name AS category FROM materials m JOIN categories c ON c.id=m.category_id WHERE m.id=?').get(id(q.get('id'))); need(m, 'Material not found.', 404);
      const out = materialOut(m, u);
      out.movements = sql('SELECT v.*, u.name AS actor_name, s.name AS supplier_name FROM movements v JOIN users u ON u.id=v.actor LEFT JOIN suppliers s ON s.id=v.supplier_id WHERE v.material_id=? ORDER BY v.id DESC LIMIT 100').all(m.id)
        .map(v => ({ id: v.id, kind: v.kind, delta: units(v.delta), before: units(v.before_qty), after: units(v.after_qty), actor: v.actor_name, supplier: v.supplier_name, reference: v.reference, saleId: v.sale_id, created: v.created, delivered: v.delivered, unitCost: isAdmin(u) ? pesos(v.unit_cost) : undefined, remaining: isAdmin(u) ? units(v.remaining) : undefined }));
      if (isAdmin(u)) out.purchaseHistory = sql("SELECT v.*, u.name AS actor_name, s.name AS supplier_name FROM movements v JOIN users u ON u.id=v.actor LEFT JOIN suppliers s ON s.id=v.supplier_id WHERE v.material_id=? AND v.kind IN ('Stock In','Opening stock') ORDER BY v.id DESC LIMIT 60").all(m.id).map(v => ({ id: v.id, delivered: v.delivered || v.created.slice(0, 10), supplier: v.supplier_name || (v.kind === 'Opening stock' ? 'Opening stock' : null), qty: units(v.kind === 'Opening stock' && !v.delta ? v.remaining : v.delta), unitCost: pesos(v.unit_cost), remaining: units(v.remaining), reference: v.reference, actor: v.actor_name }));
      out.counts = sql('SELECT c.*, u.name AS actor_name FROM counts c JOIN users u ON u.id=c.actor WHERE c.material_id=? ORDER BY c.id DESC LIMIT 20').all(m.id)
        .map(c => ({ id: c.id, expected: units(c.expected), counted: units(c.counted), status: c.status, note: c.note, actor: c.actor_name, created: c.created }));
      if (isAdmin(u)) out.priceHistory = sql('SELECT p.*, u.name AS actor_name FROM price_history p JOIN users u ON u.id=p.actor WHERE p.material_id=? ORDER BY p.id DESC LIMIT 20').all(m.id)
        .map(p => ({ oldPrice: pesos(p.old_price), newPrice: pesos(p.new_price), oldDiscount: p.old_discount, newDiscount: p.new_discount, actor: p.actor_name, created: p.created }));
      if (canSell(u)) out.sold30 = units(sql("SELECT coalesce(sum(i.qty),0) AS v FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE i.material_id=? AND s.voided=0 AND s.day>=?").get(m.id, shiftDay(dayOf(), -29)).v);
      return out;
    },
    suppliers(u) {
      need(canStock(u), 'Not allowed.', 403);
      return sql(`SELECT s.*, (SELECT count(*) FROM movements WHERE supplier_id=s.id) AS deliveries, (SELECT max(created) FROM movements WHERE supplier_id=s.id) AS last_delivery FROM suppliers s ORDER BY s.name`).all()
        .map(s => ({ id: s.id, name: s.name, contact: s.contact, address: s.address, deliveries: s.deliveries, lastDelivery: s.last_delivery }));
    },
    supplier(u, q) {
      need(canStock(u), 'Not allowed.', 403);
      const s = sql('SELECT * FROM suppliers WHERE id=?').get(id(q.get('id'))); need(s, 'Supplier not found.', 404);
      return { ...s, deliveries: sql('SELECT v.*, m.name, m.variant, m.unit, u.name AS actor_name FROM movements v JOIN materials m ON m.id=v.material_id JOIN users u ON u.id=v.actor WHERE v.supplier_id=? ORDER BY v.id DESC LIMIT 200').all(s.id)
        .map(v => ({ id: v.id, material: labelOf(v), materialId: v.material_id, unit: v.unit, qty: units(v.delta), reference: v.reference, actor: v.actor_name, created: v.created })) };
    },
    movements(u, q) {
      need(canStock(u), 'Not allowed.', 403);
      const kind = q.get('kind'), from = q.get('from') ? date(q.get('from')) : shiftDay(dayOf(), -30), to = q.get('to') ? date(q.get('to')) : dayOf();
      return sql(`SELECT v.*, m.name, m.variant, m.unit, u.name AS actor_name, s.name AS supplier_name FROM movements v JOIN materials m ON m.id=v.material_id JOIN users u ON u.id=v.actor LEFT JOIN suppliers s ON s.id=v.supplier_id
        WHERE substr(v.created,1,10) BETWEEN ? AND ? ${kind && kind !== 'all' ? 'AND v.kind=?' : ''} ORDER BY v.id DESC LIMIT 300`).all(...(kind && kind !== 'all' ? [shiftDay(from, -1), shiftDay(to, 1), kind] : [shiftDay(from, -1), shiftDay(to, 1)]))
        .map(v => ({ id: v.id, kind: v.kind, material: labelOf(v), materialId: v.material_id, unit: v.unit, delta: units(v.delta), before: units(v.before_qty), after: units(v.after_qty), actor: v.actor_name, supplier: v.supplier_name, reference: v.reference, saleId: v.sale_id, created: v.created }));
    },
    counts(u) {
      need(canStock(u), 'Not allowed.', 403);
      return sql(`SELECT c.*, m.name, m.variant, m.unit, u.name AS actor_name, r.name AS reviewer FROM counts c JOIN materials m ON m.id=c.material_id JOIN users u ON u.id=c.actor LEFT JOIN users r ON r.id=c.reviewed_by ORDER BY (c.status='Pending Approval') DESC, c.id DESC LIMIT 150`).all()
        .map(c => ({ id: c.id, material: labelOf(c), materialId: c.material_id, unit: c.unit, expected: units(c.expected), counted: units(c.counted), difference: units(c.counted - c.expected), status: c.status, note: c.note, reviewNote: c.review_note, actor: c.actor_name, reviewer: c.reviewer, created: c.created, reviewedAt: c.reviewed_at,
          stale: c.status === 'Pending Approval' && sql('SELECT coalesce(max(id),0) AS rev FROM movements WHERE material_id=?').get(c.material_id).rev !== c.revision }));
    },
    sales(u, q) {
      need(canSell(u), 'Not allowed.', 403);
      const from = q.get('from') ? date(q.get('from')) : shiftDay(dayOf(), -30), to = q.get('to') ? date(q.get('to')) : dayOf();
      const kind = q.get('kind'), search = (q.get('q') || '').trim();
      const mine = isAdmin(u) ? '' : u.role === 'cashier' ? 'AND s.actor=' + u.id : `AND (s.clerk_id=${u.id} OR s.actor=${u.id})`;
      const rows = sql(`SELECT s.*, u.name AS actor_name, c.name AS customer_name, k.name AS clerk_name FROM sales s JOIN users u ON u.id=s.actor LEFT JOIN users k ON k.id=s.clerk_id LEFT JOIN customers c ON c.id=s.customer_id
        WHERE s.day BETWEEN ? AND ? ${mine} ${kind && kind !== 'all' ? 'AND s.kind=?' : ''} ORDER BY s.id DESC LIMIT 500`).all(...(kind && kind !== 'all' ? [from, to, kind] : [from, to]));
      let list = rows.map(saleOut);
      if (search) {
        const n = Number(search.replace('#', ''));
        list = list.filter(s => s.id === n || (s.customer || '').toLowerCase().includes(search.toLowerCase()) || s.actor.toLowerCase().includes(search.toLowerCase()));
      }
      const live = list.filter(s => !s.voided);
      return { items: list, summary: { total: live.reduce((a, s) => a + s.total, 0), count: live.length, cash: live.filter(s => s.kind === 'cash').reduce((a, s) => a + s.total, 0), credit: live.filter(s => s.kind === 'credit').reduce((a, s) => a + s.creditAdded, 0) } };
    },
    sale(u, q) {
      need(canSell(u), 'Not allowed.', 403);
      const s = sql('SELECT s.*, u.name AS actor_name, c.name AS customer_name, k.name AS clerk_name FROM sales s JOIN users u ON u.id=s.actor LEFT JOIN users k ON k.id=s.clerk_id LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?').get(id(q.get('id')));
      need(s && (isAdmin(u) || s.actor === u.id || s.clerk_id === u.id), 'Sale not found.', 404);
      const items = sql('SELECT i.*, v.before_qty, v.after_qty FROM sale_items i LEFT JOIN movements v ON v.sale_id=i.sale_id AND v.material_id=i.material_id AND v.kind=\'Sale\' WHERE i.sale_id=? ORDER BY i.id').all(s.id)
        .map(i => ({ materialId: i.material_id, name: i.name, unit: i.unit, qty: units(i.qty), unitPrice: pesos(i.unit_price), discount: i.discount, lineTotal: pesos(i.line_total), regularPrice: pesos(i.regular_price ?? i.unit_price), savings: pesos(i.savings || 0), pricingMode: i.pricing_mode || 'regular', lineDiscount: pesos(i.line_discount || 0), promo: i.promo ? JSON.parse(i.promo) : null, before: units(i.before_qty), after: units(i.after_qty), cost: isAdmin(u) ? pesos(i.cost) : undefined }));
      const cost = isAdmin(u) ? saleCost(s.id) : undefined;
      return { ...saleOut(s), items, cost: isAdmin(u) ? pesos(cost) : undefined, grossProfit: !isAdmin(u) ? undefined : cost === null ? null : pesos(s.total - cost) };
    },
    customers(u, q) {
      need(canSell(u), 'Not allowed.', 403);
      const search = (q.get('q') || '').trim().toLowerCase();
      const rows = sql(`SELECT c.*, (SELECT coalesce(sum(credit_added),0) FROM sales WHERE customer_id=c.id AND voided=0) AS credit, (SELECT coalesce(sum(amount),0) FROM payments WHERE customer_id=c.id AND at_counter=0) AS paid,
        (SELECT max(created) FROM sales WHERE customer_id=c.id) AS last_sale FROM customers c ORDER BY c.name`).all();
      let list = rows.map(c => ({ id: c.id, name: c.name, phone: c.phone, address: c.address, credit: pesos(c.credit), paid: pesos(c.paid), balance: pesos(c.credit - c.paid), lastSale: c.last_sale }));
      if (search) list = list.filter(c => (c.name + ' ' + c.phone).toLowerCase().includes(search));
      return { items: list, totals: { balance: list.reduce((a, c) => a + c.balance, 0), withBalance: list.filter(c => c.balance > 0).length } };
    },
    customer(u, q) {
      need(canSell(u), 'Not allowed.', 403);
      const c = sql('SELECT * FROM customers WHERE id=?').get(id(q.get('id'))); need(c, 'Customer not found.', 404);
      const b = balanceOf(c.id);
      const sales = sql('SELECT s.*, u.name AS actor_name FROM sales s JOIN users u ON u.id=s.actor WHERE s.customer_id=? ORDER BY s.id DESC').all(c.id).map(saleOut);
      for (const s of sales) s.items = sql('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(s.id).map(i => ({ name: i.name, unit: i.unit, qty: units(i.qty), unitPrice: pesos(i.unit_price), discount: i.discount, lineTotal: pesos(i.line_total) }));
      const payments = sql('SELECT p.*, u.name AS actor_name FROM payments p JOIN users u ON u.id=p.actor WHERE p.customer_id=? ORDER BY p.id DESC').all(c.id)
        .map(p => ({ id: p.id, amount: pesos(p.amount), reference: p.reference, paymentMethod: p.payment_method, atCounter: !!p.at_counter, saleId: p.sale_id, actor: p.actor_name, day: p.day, created: p.created }));
      return { ...c, credit: pesos(b.credit), paid: pesos(b.paid), balance: pesos(b.balance), sales, payments };
    },
    expenses(u, q) {
      need(isAdmin(u) || u.role === 'cashier', 'Not allowed.', 403);
      const month = q.get('month') && /^\d{4}-\d{2}$/.test(q.get('month')) ? q.get('month') : dayOf().slice(0, 7);
      const from = month + '-01', to = shiftDay(nextMonth(from), -1);
      const mine = isAdmin(u) ? '' : ' AND e.actor=' + u.id, today = dayOf();
      const items = sql('SELECT e.*, u.name AS actor_name FROM expenses e JOIN users u ON u.id=e.actor WHERE e.day BETWEEN ? AND ?' + mine + ' ORDER BY e.day DESC, e.id DESC').all(from, to)
        .map(e => ({ id: e.id, amount: pesos(e.amount), category: e.category, detail: e.detail, reference: e.reference, day: e.day, actor: e.actor_name, fromDrawer: !!e.from_drawer, canRemove: isAdmin(u) || (e.actor === u.id && e.day === today) }));
      const byCategory = {}; for (const e of items) byCategory[e.detail && e.category === 'Other' ? e.detail : e.category] = (byCategory[e.detail && e.category === 'Other' ? e.detail : e.category] || 0) + e.amount;
      return { month, items, total: items.reduce((a, e) => a + e.amount, 0), byCategory: Object.entries(byCategory).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total) };
    },
    reports(u, q) {
      need(isAdmin(u), 'Not allowed.', 403);
      const from = q.get('from') ? date(q.get('from')) : monthStart(dayOf()), to = q.get('to') ? date(q.get('to')) : dayOf();
      const t = totals(from, to);
      return {
        range: { from, to }, sales: pesos(t.sales), expenses: pesos(t.expenses), collections: pesos(t.collections), net: pesos(t.sales - t.expenses), transactions: t.transactions,
        // Trend for the chart: one bucket per day (up to 62 days), otherwise per month.
        trend: (() => {
          const days = []; for (let d = from; d <= to && days.length < 400; d = shiftDay(d, 1)) days.push(d);
          const monthly = days.length > 62;
          const keyOf = d => monthly ? d.slice(0, 7) : d;
          const buckets = [...new Set(days.map(keyOf))];
          const pick = (rows) => { const m = new Map(rows.map(r => [r.k, r.v])); return buckets.map(b => pesos(m.get(b) || 0)); };
          const k = monthly ? 'substr(day,1,7)' : 'day';
          return { unit: monthly ? 'month' : 'day', buckets,
            sales: pick(sql(`SELECT ${k} AS k, sum(total) AS v FROM sales WHERE voided=0 AND day BETWEEN ? AND ? GROUP BY k`).all(from, to)),
            expenses: pick(sql(`SELECT ${k} AS k, sum(amount) AS v FROM expenses WHERE day BETWEEN ? AND ? GROUP BY k`).all(from, to)),
            collections: pick(sql(`SELECT ${k} AS k, sum(amount) AS v FROM payments WHERE at_counter=0 AND day BETWEEN ? AND ? GROUP BY k`).all(from, to)) };
        })(),
        collected: pesos(t.collected), creditSales: pesos(t.credit), cogs: t.costMissing ? null : pesos(t.cogs), grossProfit: t.costMissing ? null : pesos(t.sales - t.cogs), costMissingLines: t.costMissing,
        costPending: sql('SELECT m.id, m.name, m.variant, sum(v.remaining) AS q FROM movements v JOIN materials m ON m.id=v.material_id WHERE v.unit_cost IS NULL AND v.remaining>0 GROUP BY m.id ORDER BY m.name').all().map(r => ({ id: r.id, name: r.name + (r.variant ? ' · ' + r.variant : ''), qty: units(r.q) })),
        byMaterial: sql('SELECT i.name, i.unit, sum(i.qty) AS qty, sum(i.line_total) AS total FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.voided=0 AND s.day BETWEEN ? AND ? GROUP BY i.material_id ORDER BY total DESC LIMIT 25').all(from, to).map(r => ({ name: r.name, unit: r.unit, qty: units(r.qty), total: pesos(r.total) })),
        byCategory: sql('SELECT c.name, sum(i.line_total) AS total FROM sale_items i JOIN sales s ON s.id=i.sale_id JOIN materials m ON m.id=i.material_id JOIN categories c ON c.id=m.category_id WHERE s.voided=0 AND s.day BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC').all(from, to).map(r => ({ name: r.name, total: pesos(r.total) })),
        bySupplier: sql('SELECT s.name, count(*) AS deliveries, sum(v.delta) AS qty FROM movements v JOIN suppliers s ON s.id=v.supplier_id WHERE v.kind=\'Stock In\' AND substr(v.created,1,10) BETWEEN ? AND ? GROUP BY s.id ORDER BY deliveries DESC').all(from, to).map(r => ({ name: r.name, deliveries: r.deliveries, qty: units(r.qty) })),
        byExpense: sql('SELECT CASE WHEN category=\'Other\' AND detail<>\'\' THEN detail ELSE category END AS name, sum(amount) AS total FROM expenses WHERE day BETWEEN ? AND ? GROUP BY name ORDER BY total DESC').all(from, to).map(r => ({ name: r.name, total: pesos(r.total) })),
        byClerk: sql('SELECT u.name, count(*) AS n, sum(s.total) AS total FROM sales s JOIN users u ON u.id=s.actor WHERE s.voided=0 AND s.day BETWEEN ? AND ? GROUP BY u.id ORDER BY total DESC').all(from, to).map(r => ({ name: r.name, count: r.n, total: pesos(r.total) })),
      };
    },
    attendance(u, q) {
      const day = q.get('day') ? date(q.get('day')) : dayOf();
      const month = q.get('month') && /^\d{4}-\d{2}$/.test(q.get('month')) ? q.get('month') : day.slice(0, 7);
      const from = month + '-01', to = shiftDay(nextMonth(from), -1);
      const COVER = { whole: 'Whole Day', morning: 'Morning Only', afternoon: 'Afternoon Only' };
      const statusFor = (uid, d, rows, marks, excuses, schedule) => {
        const taps = { in: null, lunch_out: null, lunch_in: null, out: null };
        const src = {}, rowOf = {};
        for (const r of rows) if (r.user_id === uid && r.day === d) { taps[r.kind] = r.occurred; src[r.kind] = r.source || 'manual'; rowOf[r.kind] = r; }
        const tin = taps.in, tout = taps.out, any = Object.values(taps).some(Boolean);
        const ex = excuses.find(e => e.user_id === uid && e.day === d), mark = marks.find(m => m.user_id === uid && m.day === d);
        const sched = schedule || { start: '07:30', end: '17:00', lunchStart: '11:30', lunchEnd: '13:00' };
        const exCtx = ex ? { status: ex.status, coverage: ex.coverage || 'whole', paid: ex.paid } : null;
        const morningConfirmed = !!sql('SELECT 1 FROM morning_absences WHERE user_id=? AND day=?').get(uid, d);
        const partial = ex?.status === 'Excused' && ex.coverage && ex.coverage !== 'whole';
        let status = any ? 'Present' : ex?.status === 'Excused' ? (partial ? `Excused · ${COVER[ex.coverage]}` : 'Excused') : ex?.status === 'Pending Approval' ? 'Pending Approval' : mark?.status || (d < dayOf() ? 'Absent' : d === dayOf() ? 'No record yet' : 'Upcoming');
        if (new Date(d + 'T00:00:00Z').getUTCDay() === 0 && !any && !ex) status = d <= dayOf() ? 'Rest day' : 'Upcoming';
        const isToday = d === dayOf();
        const work = any || ex?.status === 'Excused' ? compute(taps, { day: d, schedule: sched, excuse: exCtx, morningConfirmed, nowMs: isToday ? Date.now() : null }) : null;
        const earn = sql('SELECT * FROM earnings WHERE user_id=? AND day=?').get(uid, d);
        const paid = sql('SELECT p.id, p.pay_date FROM salary_payment_days d JOIN salary_payments p ON p.id=d.payment_id WHERE d.user_id=? AND d.day=?').get(uid, d);
        const allowed = allowedTaps(taps, { excuse: exCtx, schedule: sched, day: d, nowMs: isToday ? Date.now() : null });
        const rate = payroll.rateFor({ id: uid }, d);
        const open = isToday && ((taps.in && !taps.lunch_out && !taps.out) || (taps.lunch_in && !taps.out));
        // Open session: its saved cutoff (end of regular pay) and grace deadline (automatic Time Out).
        const startRow = open ? (taps.lunch_in ? rowOf.lunch_in : rowOf.in) : null;
        const now = Date.now();
        const session = startRow ? { kind: startRow.kind, closes: startRow.kind === 'in' ? 'lunch_out' : 'out', cutoff: startRow.cutoff, deadline: startRow.grace_deadline, grace: startRow.grace_minutes,
          state: !startRow.cutoff ? 'working' : now < Date.parse(startRow.cutoff) ? 'working' : 'grace' } : null;
        return { day: d, status, timeIn: tin, timeOut: tout, lunchOut: taps.lunch_out, lunchIn: taps.lunch_in, taps, next: allowed[0] ?? null, allowed,
          sources: src, session,
          clock: !any ? 'Not clocked in' : session?.state === 'grace' ? 'Time Out due' : open ? 'Working' : allowed.length === 0 ? 'Done for the day' : taps.lunch_out && !taps.lunch_in ? 'On lunch break' : 'Clocked out',
          missingOut: any && !tout && d < dayOf() && allowed.length > 0, incomplete: any && d < dayOf() && allowed.length > 0,
          worked: work ? { minutes: work.minutes, payable: work.payable, scheduled: work.scheduled, format: work.format, status: work.status, flags: work.flags, review: work.review } : null,
          live: isToday && work && !earn ? { payable: work.payable, estimate: pesos(payFor(rate, work.payable)), rate: pesos(rate), accruing: !!open && session?.state !== 'grace', schedule: sched, excuse: exCtx, morningConfirmed, serverNow: new Date(now).toISOString() } : null,
          earnings: earn ? { minutes: earn.worked_minutes, payable: earn.payable_minutes, status: earn.status, amount: pesos(earn.amount), rate: pesos(earn.rate), rateMissing: earn.rate === null, finalized: earn.finalized, review: !!earn.review, flags: earn.flags ? earn.flags.split(',') : [] } : null,
          paid: paid ? { paymentId: paid.id, payDate: paid.pay_date } : null, morningConfirmed,
          excuse: ex ? { id: ex.id, reason: ex.reason, status: ex.status, note: ex.note, reviewer: ex.reviewer, coverage: ex.coverage || 'whole', coverageLabel: COVER[ex.coverage || 'whole'], paid: ex.paid === null || ex.paid === undefined ? null : !!ex.paid, emergency: !!ex.emergency, created: ex.created } : null, mark: mark ? { status: mark.status, reason: mark.reason } : null };
      };
      const excuseRows = (where, args) => sql(`SELECT e.*, r.name AS reviewer, u.name AS user_name FROM excuses e JOIN users u ON u.id=e.user_id LEFT JOIN users r ON r.id=e.reviewed_by WHERE ${where} ORDER BY e.day DESC`).all(...args);
      const mine = {
        today: statusFor(u.id, dayOf(), sql('SELECT * FROM attendance WHERE user_id=? AND day=?').all(u.id, dayOf()), [], excuseRows('e.user_id=? AND e.day=?', [u.id, dayOf()]), shiftFor(u, dayOf())),
        shift: shiftFor(u, dayOf()), scheduledMinutes: scheduledMinutes(shiftFor(u, dayOf())), tapLabels: TAP_LABELS,
        rate: pesos(payroll.rateFor(u, dayOf())), graceMinutes: graceSetting(), day: dayOf(),
        // Own earnings and salary payments (My Attendance › Pay).
        earnings: sql('SELECT * FROM earnings WHERE user_id=? ORDER BY day DESC LIMIT 60').all(u.id).map(e => ({ day: e.day, minutes: e.worked_minutes, payable: e.payable_minutes, scheduled: e.scheduled_minutes, status: e.status, amount: pesos(e.amount), rate: pesos(e.rate), rateMissing: e.rate === null, paid: !!sql('SELECT 1 FROM salary_payment_days WHERE user_id=? AND day=?').get(u.id, e.day) })),
        payments: sql('SELECT * FROM salary_payments WHERE user_id=? ORDER BY id DESC LIMIT 40').all(u.id).map(p => ({ id: p.id, amount: pesos(p.amount), from: p.from_day, to: p.to_day, payDate: p.pay_date, method: p.method, reference: p.reference, days: p.days, created: p.created })),
        unpaidTotal: pesos(sql('SELECT coalesce(sum(e.amount),0) AS v FROM earnings e WHERE e.user_id=? AND NOT EXISTS (SELECT 1 FROM salary_payment_days d WHERE d.user_id=e.user_id AND d.day=e.day)').get(u.id).v),
        month, days: [], excuses: excuseRows('e.user_id=?', [u.id]).slice(0, 40).map(e => ({ id: e.id, day: e.day, reason: e.reason, status: e.status, note: e.note, reviewer: e.reviewer, created: e.created, coverage: e.coverage, coverageLabel: COVER[e.coverage], paid: e.paid === null ? null : !!e.paid, emergency: !!e.emergency })),
      };
      {
        const rows = sql('SELECT * FROM attendance WHERE user_id=? AND day BETWEEN ? AND ?').all(u.id, from, to), marks = sql('SELECT * FROM attendance_marks WHERE user_id=? AND day BETWEEN ? AND ?').all(u.id, from, to), ex = excuseRows('e.user_id=? AND e.day BETWEEN ? AND ?', [u.id, from, to]);
        for (let d = from; d <= to; d = shiftDay(d, 1)) mine.days.push(statusFor(u.id, d, rows, marks, ex, shiftFor(u, d)));
      }
      if (!isAdmin(u)) return { mine };
      const staff = sql("SELECT * FROM users WHERE role<>'admin' ORDER BY active DESC, name").all();
      const rows = sql('SELECT * FROM attendance WHERE day BETWEEN ? AND ?').all(from, to), marks = sql('SELECT * FROM attendance_marks WHERE day BETWEEN ? AND ?').all(from, to), ex = excuseRows('e.day BETWEEN ? AND ?', [from, to]);
      const daily = staff.filter(s => s.active).map(s => ({ userId: s.id, name: s.name, role: s.role, title: titleOf(s), photo: !!s.photo, shift: shiftFor(s, day), ...statusFor(s.id, day, rows, marks, ex, shiftFor(s, day)) }));
      const person = q.get('user') ? int(q.get('user'), 1) : null;
      const monthly = person ? (() => { const s = staff.find(x => x.id === person); if (!s) return null; const days = []; for (let d = from; d <= to; d = shiftDay(d, 1)) days.push(statusFor(s.id, d, rows, marks, ex, shiftFor(s, d))); return { userId: s.id, name: s.name, title: titleOf(s), hasRate: s.daily_rate !== null, days, summary: { present: days.filter(x => x.status === 'Present').length, absent: days.filter(x => x.status === 'Absent').length, excused: days.filter(x => x.status === 'Excused').length, pending: days.filter(x => x.status === 'Pending Approval').length, missingOut: days.filter(x => x.missingOut).length } }; })() : null;
      const corrections = sql('SELECT c.*, u.name AS user_name, a.name AS actor_name FROM attendance_corrections c JOIN users u ON u.id=c.user_id JOIN users a ON a.id=c.actor WHERE c.day BETWEEN ? AND ? ORDER BY c.id DESC LIMIT 100').all(from, to);
      return {
        settings: { graceMinutes: graceSetting() },
        mine, day, month, staff: staff.map(s => ({ id: s.id, name: s.name, role: s.role, title: titleOf(s), active: !!s.active, shift: shiftFor(s, day) })), daily, monthly,
        pendingExcuses: excuseRows("e.status='Pending Approval'", []).map(e => ({ id: e.id, userId: e.user_id, name: e.user_name, day: e.day, reason: e.reason, created: e.created, coverage: e.coverage, coverageLabel: COVER[e.coverage], emergency: !!e.emergency })),
        recentExcuses: excuseRows("e.status<>'Pending Approval'", []).slice(0, 30).map(e => ({ id: e.id, name: e.user_name, day: e.day, reason: e.reason, status: e.status, note: e.note, reviewer: e.reviewer, coverage: e.coverage, coverageLabel: COVER[e.coverage], paid: e.paid === null ? null : !!e.paid, emergency: !!e.emergency, locked: !!sql('SELECT 1 FROM salary_payment_days WHERE user_id=? AND day=?').get(e.user_id, e.day) })),
        corrections: corrections.map(c => ({ id: c.id, name: c.user_name, day: c.day, kind: c.kind, original: c.original, corrected: c.corrected, reason: c.reason, actor: c.actor_name, created: c.created })),
        schedules: sql('SELECT s.*, u.name AS user_name FROM schedules s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 40').all().map(s => ({ id: s.id, name: s.user_name, effective: s.effective, start: s.shift_start, end: s.shift_end, lunchStart: s.lunch_start, lunchEnd: s.lunch_end })),
        // Days needing Admin review: short, overtime or incomplete (no final out) and not yet paid.
        review: (() => {
          const flagged = sql("SELECT e.*, u.name FROM earnings e JOIN users u ON u.id=e.user_id WHERE e.review=1 AND NOT EXISTS (SELECT 1 FROM salary_payment_days d WHERE d.user_id=e.user_id AND d.day=e.day) ORDER BY e.day DESC LIMIT 60").all().map(e => ({ userId: e.user_id, name: e.name, day: e.day, status: e.status, flags: e.flags ? e.flags.split(',') : [], minutes: e.worked_minutes, payable: e.payable_minutes, scheduled: e.scheduled_minutes, amount: pesos(e.amount), rateMissing: e.rate === null }));
          const incomplete = sql("SELECT a.user_id, a.day, u.name FROM attendance a JOIN users u ON u.id=a.user_id WHERE a.day<? GROUP BY a.user_id, a.day HAVING sum(a.kind='out')=0 AND NOT EXISTS (SELECT 1 FROM earnings e WHERE e.user_id=a.user_id AND e.day=a.day) ORDER BY a.day DESC LIMIT 60").all(dayOf()).map(r => ({ userId: r.user_id, name: r.name, day: r.day, status: 'incomplete', flags: ['missing_taps'], minutes: null, scheduled: null, amount: null }));
          return [...incomplete, ...flagged];
        })(),
      };
    },
    // Admin employee profile: rate, earnings, salary payments and a pay-period preview.
    earnings(u, q) {
      const target = isAdmin(u) && q.get('user') ? sql('SELECT * FROM users WHERE id=?').get(int(q.get('user'), 1)) : u;
      need(target && (isAdmin(u) || target.id === u.id), 'Not allowed.', 403);
      const from = q.get('from') ? date(q.get('from')) : null, to = q.get('to') ? date(q.get('to')) : null;
      const rows = sql('SELECT * FROM earnings WHERE user_id=? ORDER BY day DESC LIMIT 120').all(target.id);
      const paidDays = new Map(sql('SELECT d.day, d.payment_id, p.pay_date FROM salary_payment_days d JOIN salary_payments p ON p.id=d.payment_id WHERE d.user_id=?').all(target.id).map(r => [r.day, r]));
      const out = {
        user: { id: target.id, name: target.name, title: titleOf(target), rate: isAdmin(u) ? pesos(payroll.rateFor(target, dayOf())) : undefined, shift: shiftFor(target, dayOf()) },
        rates: isAdmin(u) ? sql('SELECT r.*, a.name AS actor_name FROM rates r LEFT JOIN users a ON a.id=r.actor WHERE r.user_id=? ORDER BY r.effective DESC, r.id DESC').all(target.id).map(r => ({ rate: pesos(r.rate), effective: r.effective === '0000-01-01' ? null : r.effective, actor: r.actor_name, created: r.created })) : undefined,
        earnings: rows.map(e => ({ day: e.day, minutes: e.worked_minutes, payable: e.payable_minutes, scheduled: e.scheduled_minutes, status: e.status, flags: e.flags ? e.flags.split(',') : [], review: !!e.review, format: e.format, amount: pesos(e.amount), rateMissing: e.rate === null, rate: isAdmin(u) ? pesos(e.rate) : undefined, paid: paidDays.has(e.day) ? { paymentId: paidDays.get(e.day).payment_id, payDate: paidDays.get(e.day).pay_date } : null })),
        payments: sql('SELECT p.*, a.name AS actor_name FROM salary_payments p JOIN users a ON a.id=p.actor WHERE p.user_id=? ORDER BY p.id DESC LIMIT 60').all(target.id).map(p => ({ id: p.id, amount: pesos(p.amount), from: p.from_day, to: p.to_day, payDate: p.pay_date, method: p.method, reference: p.reference, days: p.days, actor: p.actor_name, created: p.created })),
        unpaidTotal: pesos(rows.filter(e => !paidDays.has(e.day)).reduce((a, e) => a + (e.amount || 0), 0)),
      };
      if (from && to && isAdmin(u)) {
        const inRange = rows.filter(e => e.day >= from && e.day <= to).sort((a, b) => a.day.localeCompare(b.day));
        const already = inRange.filter(e => paidDays.has(e.day)).map(e => ({ day: e.day, payDate: paidDays.get(e.day).pay_date }));
        const payable = inRange.filter(e => !paidDays.has(e.day));
        const finalizedDays = new Set(inRange.map(e => e.day));
        const unsettled = sql('SELECT DISTINCT day FROM attendance WHERE user_id=? AND day BETWEEN ? AND ?').all(target.id, from, to).map(r => r.day).filter(d => !finalizedDays.has(d) && d < dayOf());
        out.preview = { from, to, days: payable.map(e => ({ day: e.day, status: e.status, review: !!e.review, flags: e.flags ? e.flags.split(',') : [], minutes: e.worked_minutes, payable: e.payable_minutes, rate: pesos(e.rate), amount: pesos(e.amount), rateMissing: e.rate === null })),
          pendingReview: payable.filter(e => e.review).length + unsettled.length, unsettled, ratesApplied: [...new Set(payable.map(e => e.rate))].filter(r => r !== null).map(pesos), amount: pesos(payable.reduce((a, e) => a + (e.amount || 0), 0)), alreadyPaid: already, flagged: payable.filter(e => e.review).length, rateMissing: payable.filter(e => e.rate === null).length, blocked: already.length > 0 };
      }
      return out;
    },
    staff(u, q) {
      const search = (q.get('q') || '').trim().toLowerCase();
      const rows = isAdmin(u) ? sql('SELECT * FROM users ORDER BY is_main DESC, (role=\'admin\') DESC, active DESC, name').all() : [sql('SELECT * FROM users WHERE id=?').get(u.id)];
      const idOf = id => isAdmin(u) ? sql('SELECT mime, name, size, uploaded_at FROM staff_ids WHERE user_id=?').get(id) : null;
      let list = rows.map(r => ({ ...publicUser(r), validId: (x => x ? { mime: x.mime, name: x.name, size: x.size, uploaded: x.uploaded_at } : null)(idOf(r.id)), hasRate: r.daily_rate !== null, rate: isAdmin(u) ? pesos(r.daily_rate) : undefined, lunch: { start: r.lunch_start, end: r.lunch_end }, created: r.created, lastIn: sql("SELECT max(day) AS d FROM attendance WHERE user_id=? AND kind='in'").get(r.id).d }));
      if (search) list = list.filter(s => (s.name + ' ' + s.username + ' ' + s.role + ' ' + s.title).toLowerCase().includes(search));
      return list;
    },
    notifications(u) { return { items: notificationsFor(u, 100), unread: unread(u) }; },
    // Orders: the Cashier queue (waiting) and each Sales Clerk's own orders.
    orders(u, q) {
      // The order queue belongs to the Cashier; Sales Clerks see their own orders.
      need(u.role === 'cashier' || (!isAdmin(u) && u.role.includes('sales')), 'The order queue is for the Cashier.', 403);
      const mats = new Map(sql('SELECT id, name, variant, unit, price, photo IS NOT NULL AS has_photo, qty FROM materials').all().map(m => [m.id, m]));
      const out = o => { const lines = JSON.parse(o.lines).map(l => { const m = mats.get(l.materialId); return { materialId: l.materialId, qty: Number(l.qty), name: l.name ?? (m ? m.name + (m.variant ? ' · ' + m.variant : '') : '#' + l.materialId), unit: l.unit ?? m?.unit, photo: !!m?.has_photo, price: l.price ?? (m ? pesos(m.price) : null), stock: m ? units(m.qty) : null }; });
        return { id: o.id, status: o.status, clerk: o.clerk_name, clerkId: o.clerk, cashier: o.cashier_name, customer: o.cust_name || o.customer_name || null, customerId: o.customer_id, note: o.note, payment: o.prepared_payment ? JSON.parse(o.prepared_payment) : null, lines, items: lines.length,
          pricingMode: o.pricing_mode, tawadAmount: o.tawad_amount === null ? null : pesos(o.tawad_amount), tawadReason: o.tawad_reason, regularSubtotal: pesos(o.regular_subtotal), total: pesos(o.total), saleId: o.sale_id, cancelReason: o.cancel_reason, created: o.created, closed: o.closed }; };
      const base = 'SELECT o.*, k.name AS clerk_name, c.name AS cashier_name, cu.name AS cust_name FROM orders o JOIN users k ON k.id=o.clerk LEFT JOIN users c ON c.id=o.cashier LEFT JOIN customers cu ON cu.id=o.customer_id';
      if (q.get('id')) { const o = sql(base + ' WHERE o.id=?').get(id(q.get('id'))); need(o && (canCash(u) || o.clerk === u.id), 'Order not found.', 404); return out(o); }
      const mine = canCash(u) ? '' : ' AND o.clerk=' + u.id;
      return {
        waiting: sql(base + " WHERE o.status='waiting'" + mine + ' ORDER BY o.id').all().map(out),
        recent: sql(base + " WHERE o.status<>'waiting' AND o.day>=?" + mine + ' ORDER BY o.closed DESC LIMIT 40').all(shiftDay(dayOf(), -7)).map(out),
        today: (() => { const r = sql(`SELECT count(*) AS n, sum(status='paid') AS paid, sum(status='waiting') AS waiting, sum(status='cancelled') AS cancelled, coalesce(sum(CASE WHEN status='paid' THEN total END),0) AS value FROM orders o WHERE day=?${mine}`).get(dayOf()); return { orders: r.n, paid: r.paid || 0, waiting: r.waiting || 0, cancelled: r.cancelled || 0, value: pesos(r.value) }; })(),
      };
    },
    // Cashier drawer: today's money by method, plus past counts.
    cash(u) {
      need(u.role === 'cashier', 'The cash drawer is for the Cashier.', 403);
      const day = dayOf(), who = isAdmin(u) ? '' : ' AND actor=' + u.id;
      const byMethod = sql(`SELECT coalesce(payment_method,'Cash') AS m, sum(paid_now) AS v, count(*) AS n FROM sales WHERE day=? AND voided=0 AND paid_now>0${who} GROUP BY m`).all(day).map(r => ({ method: r.m, amount: pesos(r.v), count: r.n }));
      const collections = sql(`SELECT coalesce(payment_method,'Cash') AS m, sum(amount) AS v, count(*) AS n FROM payments WHERE day=? AND at_counter=0${who} GROUP BY m`).all(day).map(r => ({ method: r.m, amount: pesos(r.v), count: r.n }));
      const cashSales = byMethod.find(x => x.method === 'Cash')?.amount || 0, cashCollections = collections.find(x => x.method === 'Cash')?.amount || 0;
      const drawerExpenses = sql(`SELECT e.*, u.name FROM expenses e JOIN users u ON u.id=e.actor WHERE e.day=? AND e.from_drawer=1${isAdmin(u) ? '' : ' AND e.actor=' + u.id} ORDER BY e.id DESC`).all(day)
        .map(e => ({ id: e.id, amount: pesos(e.amount), category: e.category, detail: e.detail, reference: e.reference, by: e.name }));
      const paidOut = drawerExpenses.reduce((a, e) => a + Math.round(e.amount * 100), 0) / 100;
      const t = sql(`SELECT count(*) AS n, coalesce(sum(total),0) AS total, coalesce(sum(credit_added),0) AS credit FROM sales WHERE day=? AND voided=0${who}`).get(day);
      const counts = sql(`SELECT cc.*, u.name FROM cash_counts cc JOIN users u ON u.id=cc.cashier ${isAdmin(u) ? '' : 'WHERE cc.cashier=' + u.id} ORDER BY cc.id DESC LIMIT 20`).all().map(c => ({ id: c.id, cashier: c.name, day: c.day, expected: pesos(c.expected), counted: pesos(c.counted), variance: pesos(c.counted - c.expected), note: c.note, created: c.created }));
      const receipts = sql(`SELECT id, paid_now AS amount, payment_method, reference, created FROM sales WHERE day=? AND voided=0 AND paid_now>0${who} ORDER BY id DESC`).all(day)
        .map(r => ({ id: r.id, amount: pesos(r.amount), method: r.payment_method || 'Cash', reference: r.reference, created: r.created, sale: true }));
      const repayments = sql(`SELECT id, amount, payment_method, reference, created FROM payments WHERE day=? AND at_counter=0${who} ORDER BY id DESC`).all(day)
        .map(r => ({ id: r.id, amount: pesos(r.amount), method: r.payment_method || 'Cash', reference: r.reference, created: r.created, sale: false }));
      return { day, byMethod, collections, received: [...receipts, ...repayments].sort((a, b) => b.created.localeCompare(a.created)), expectedCash: Math.round((cashSales + cashCollections - paidOut) * 100) / 100, drawerExpenses, paidOut, transactions: t.n, salesTotal: pesos(t.total), creditGiven: pesos(t.credit), counts,
        waiting: sql("SELECT count(*) AS n FROM orders WHERE status='waiting'").get().n };
    },
    // Sales summary for the Cashier/Admin: sales at price − Tawad = net, and which materials
    // were sold with Tawad vs at the regular / promo price.
    summary(u, q) {
      need(canCash(u), 'Not allowed.', 403);
      const today = dayOf();
      let from = q.get('from') ? date(q.get('from')) : today, to = q.get('to') ? date(q.get('to')) : today;
      if (to > today) to = today; if (from > to) from = to;
      const who = isAdmin(u) ? '' : ' AND s.actor=' + u.id;
      const t = sql(`SELECT count(*) AS n, coalesce(sum(s.total),0) AS net, coalesce(sum(s.tawad_discount),0) AS tawad, coalesce(sum(CASE WHEN s.pricing_mode='tawad' THEN 1 ELSE 0 END),0) AS tn,
        coalesce(sum(CASE WHEN s.pricing_mode='tawad' THEN s.total ELSE 0 END),0) AS tnet FROM sales s WHERE s.voided=0 AND s.day BETWEEN ? AND ?${who}`).get(from, to);
      const lines = sql(`SELECT i.material_id AS id, i.name, i.unit, (s.pricing_mode='tawad') AS tawad, sum(i.qty) AS qty, sum(i.line_total) AS net,
        sum(CASE WHEN s.pricing_mode='tawad' THEN i.line_discount ELSE 0 END) AS discount, count(DISTINCT s.id) AS sales, m.photo IS NOT NULL AS photo
        FROM sale_items i JOIN sales s ON s.id=i.sale_id LEFT JOIN materials m ON m.id=i.material_id WHERE s.voided=0 AND s.day BETWEEN ? AND ?${who}
        GROUP BY i.material_id, (s.pricing_mode='tawad') ORDER BY net DESC`).all(from, to)
        .map(r => ({ id: r.id, name: r.name, unit: r.unit, qty: units(r.qty), atPrice: pesos(r.net + r.discount), tawad: pesos(r.discount), net: pesos(r.net), sales: r.sales, photo: !!r.photo, withTawad: !!r.tawad }));
      const tawadSales = sql(`SELECT s.id, s.created, s.regular_subtotal, s.tawad_discount, s.total, s.tawad_reason, c.name AS clerk, a.name AS cashier FROM sales s LEFT JOIN users c ON c.id=s.clerk_id JOIN users a ON a.id=s.actor
        WHERE s.voided=0 AND s.pricing_mode='tawad' AND s.day BETWEEN ? AND ?${who} ORDER BY s.id DESC LIMIT 100`).all(from, to)
        .map(r => ({ id: r.id, created: r.created, atPrice: pesos(r.regular_subtotal), tawad: pesos(r.tawad_discount), net: pesos(r.total), reason: r.tawad_reason, clerk: r.clerk, cashier: r.cashier }));
      return { from, to, transactions: t.n, atPrice: pesos(t.net + t.tawad), tawad: pesos(t.tawad), net: pesos(t.net), tawadSales: t.tn, tawadNet: pesos(t.tnet),
        withTawad: lines.filter(l => l.withTawad), withoutTawad: lines.filter(l => !l.withTawad), tawadList: tawadSales };
    },
    // Offline sync: Admin sees the approval inbox; everyone else sees the status of their own uploads.
    offline(u, q) {
      const TAPL = { in: 'Morning Time In', lunch_out: 'Lunch Time Out', lunch_in: 'Afternoon Time In', out: 'Final Time Out' };
      const mats = new Map(sql('SELECT id, name, variant, unit, price FROM materials').all().map(m => [m.id, m]));
      const describe = r => {
        const b = JSON.parse(r.body);
        if (r.action === 'attendance.clock') return { title: TAPL[b.kind] || b.kind, detail: `${r.occurred.slice(0, 10)} · ${timeOf(new Date(r.occurred))}` };
        if (r.action === 'stock.in') { const m = mats.get(Number(b.materialId)); return { title: `Stock In · ${m ? m.name + (m.variant ? ' · ' + m.variant : '') : '#' + b.materialId}`, detail: `${b.qty} ${m?.unit || ''} @ ₱${b.unitCost ?? '—'} · ${b.reference || ''}` }; }
        const lines = (b.lines || []).map(l => { const m = mats.get(Number(l.materialId)); return `${m ? m.name : '#' + l.materialId} × ${l.qty}`; });
        return { title: `Sale · ${b.kind === 'credit' ? 'Utang' : 'Cash'}${b.pricingMode === 'tawad' ? ' · Tawad ₱' + (b.tawadAmount || '') : ''}`, detail: lines.join(', '), total: b.expectedTotal !== undefined ? b.expectedTotal / 100 : b.expectedSubtotal !== undefined ? b.expectedSubtotal / 100 - Number(b.tawadAmount || 0) : null };
      };
      const STATUS = { pending: 'Pending Admin approval', approved: 'Approved', needs_review: 'Needs review', rejected: 'Rejected' };
      const out = r => ({ id: r.id, key: r.key, action: r.action, status: r.status, statusLabel: STATUS[r.status], occurred: r.occurred, uploaded: r.uploaded, error: r.error, conflict: r.result && r.status === 'needs_review' ? JSON.parse(r.result).code : null, name: r.name, title: r.title, reviewer: r.reviewer_name, reviewedAt: r.reviewed_at, ...describe(r) });
      const base = 'SELECT i.*, u.name, u.job_title, u.role, rv.name AS reviewer_name FROM offline_inbox i JOIN users u ON u.id=i.user_id LEFT JOIN users rv ON rv.id=i.reviewer';
      if (!isAdmin(u)) return { mine: sql(base + ' WHERE i.user_id=? ORDER BY i.id DESC LIMIT 50').all(u.id).map(out) };
      return {
        pending: sql(base + " WHERE i.status='pending' ORDER BY i.occurred, i.id").all().map(out),
        review: sql(base + " WHERE i.status='needs_review' ORDER BY i.occurred, i.id").all().map(out),
        recent: sql(base + " WHERE i.status IN ('approved','rejected') ORDER BY i.reviewed_at DESC LIMIT 40").all().map(out),
        mine: [],
      };
    },
    audit(u, q) {
      need(isAdmin(u), 'Not allowed.', 403);
      return sql('SELECT a.*, u.name AS actor_name FROM audit a JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT ?').all(int(q.get('limit') || 200, 1, 1000)).map(a => ({ id: a.id, action: a.action, detail: a.detail, actor: a.actor_name, created: a.created }));
    },
    // Compact catalog used by the offline cache on phones (no prices for stock-only roles).
    catalog(u) {
      return sql('SELECT m.*, c.name AS category FROM materials m JOIN categories c ON c.id=m.category_id WHERE m.archived=0 ORDER BY m.name').all().map(m => materialOut(m, u));
    },
  };
}

