// Orders: the Sales Clerk's own orders, and the Cashier's payment queue.
// Clerk prepares → Cashier receives payment (cash/sukli, GCash, Maya, Other, utang / partial).
import { api } from '../api.js';
import { h, clear, peso, num, modal, toast, busy, errorOf, field, input, showError, empty, skeleton, tag, dateTime, ago, paymentFields, segmented, confirm, confetti } from '../ui.js';
import { sound } from '../sound.js';
import { icon } from '../icons.js';
import { go, reloadBoot } from '../app.js';

const STATUS = { waiting: ['Waiting for payment', 'pending'], paid: ['Paid', 'Present'], cancelled: ['Cancelled', 'neutral'] };
let queueTimer = null;

export async function orders(ctx) {
  const { el, user, params } = ctx;
  const cashier = user.role === 'cashier';
  if (user.role === 'admin' || !(cashier || user.role.includes('sales'))) { go('dashboard'); return; }
  clearInterval(queueTimer);
  if (params[0]) return orderDetail(ctx, Number(params[0]), cashier);
  el.append(h('div.page__head', h('div', h('p.eyebrow', cashier ? 'Cashier' : 'Sales Clerk'), h('h1', cashier ? 'Payment queue' : 'My orders'), h('p.muted', cashier ? 'Orders sent by the Sales Clerks. Open one to receive the payment.' : 'Orders you sent to the Cashier and their status.')),
    cashier ? null : h('div.page__actions', h('a.btn.primary', { href: '#/pos' }, icon('plus', 'sm'), 'New order'))));
  const body = h('div'); el.append(body); body.append(skeleton(2));
  const render = async () => {
    const d = await api.get('orders');
    clear(body);
    const t = d.today;
    body.append(h('div.grid.kpi.stagger', h('div.card.kpi', h('div.kpi__label', h('span.ic', icon('clock', 'sm')), 'Waiting'), h('div.kpi__value', String(d.waiting.length)), h('p.small.muted', peso(d.waiting.reduce((a, o) => a + o.total, 0)))),
      h('div.card.kpi', h('div.kpi__label', h('span.ic', icon('check', 'sm')), 'Paid today'), h('div.kpi__value', String(t.paid)), h('p.small.muted', peso(t.value))),
      h('div.card.kpi', h('div.kpi__label', h('span.ic', icon('receipt', 'sm')), 'Orders today'), h('div.kpi__value', String(t.orders)), h('p.small.muted', `${t.cancelled} cancelled`))));
    const card = o => h('button.card.order.click', { onclick: () => go('orders/' + o.id), style: { '--i': o.id % 10 } },
      h('div.row.between', h('div', h('b', `Order #${o.id}`), h('div.small.muted', `${cashier ? o.clerk + ' · ' : ''}${ago(o.created)}${o.customer ? ' · ' + o.customer : ''}`)), tag(STATUS[o.status][0], STATUS[o.status][1])),
      h('div.order__items', ...o.lines.slice(0, 4).map(l => h('span.order__chip', l.photo ? h('img', { src: `/media/item/${l.materialId}`, alt: '' }) : null, `${l.name} × ${num(l.qty)}`)), o.lines.length > 4 ? h('span.small.muted', `+${o.lines.length - 4} more`) : null),
      h('div.row.between', { style: { marginTop: '10px' } }, o.pricingMode === 'tawad' ? tag(`Tawad −${peso(o.tawadAmount)}`, 'warn plain') : o.pricingMode === 'promo' ? h('span.promo-badge', { style: { marginLeft: 0 } }, 'Promo') : h('span'), h('b.order__total', peso(o.total))));
    body.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('div', h('h2', cashier ? 'Waiting for payment' : 'Waiting at the Cashier'), h('p.sub', cashier ? 'Oldest first. This list refreshes by itself.' : 'The Cashier receives the payment; stock moves when it is paid.')), cashier ? h('span.live-dot') : null),
      d.waiting.length ? h('div.orders', ...d.waiting.map(card)) : empty(cashier ? 'No orders waiting' : 'Nothing waiting', 'check')));
    body.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('h2', 'Recent')), d.recent.length ? h('div.orders', ...d.recent.map(card)) : empty('No recent orders', 'receipt')));
    return d.waiting.length;
  };
  let last = await render();
  // The queue refreshes every 10 s; a new order plays a sound for the Cashier.
  queueTimer = setInterval(async () => {
    if (!document.body.contains(body)) return clearInterval(queueTimer);
    if (document.hidden || !navigator.onLine) return;
    try { const n = await render(); if (cashier && n > last) { sound.play('notify'); toast('New order in the queue', 'ok'); } last = n; } catch { /* offline */ }
  }, 10_000);
}

async function orderDetail(ctx, id, cashier) {
  const { el } = ctx;
  el.append(skeleton(2));
  const o = await api.get('orders', { id });
  clear(el);
  el.append(h('div.page__head', h('div', h('p.eyebrow', h('a', { href: '#/orders' }, cashier ? 'Payment queue' : 'My orders'), ' › Order'), h('h1', `Order #${o.id}`), h('p.muted', `Prepared by ${o.clerk} · ${dateTime(o.created)}${o.customer ? ' · ' + o.customer : ''}`)), h('div.page__actions', tag(STATUS[o.status][0], STATUS[o.status][1]))));
  const rows = o.lines.map(l => h('div.r', h('span', `${l.name} × ${num(l.qty)} ${l.unit || ''}`, h('br'), h('span.small.muted', `${peso(l.price)} each · ${num(l.stock)} in stock`)), h('span', peso(Math.round(l.price * l.qty * 100) / 100))));
  const receipt = h('div.receipt', ...rows, h('hr'),
    o.pricingMode === 'tawad' ? [h('div.r', h('span', 'Regular subtotal'), h('span', peso(o.regularSubtotal))), h('div.r', h('span', `Tawad by ${o.clerk} · ${o.tawadReason}`), h('span', '− ' + peso(o.tawadAmount)))] : o.regularSubtotal > o.total ? h('div.r', h('span', 'Promo savings'), h('span', '− ' + peso(o.regularSubtotal - o.total))) : null,
    h('div.r', h('b', 'TOTAL TO PAY'), h('b', { style: { fontSize: '20px' } }, peso(o.total))),
    o.payment ? paymentSummary(o.payment) : null);
  const actions = h('div.row.wrap', { style: { gap: '8px', marginTop: '14px', justifyContent: 'flex-end' } });
  if (o.status === 'waiting') {
    actions.append(h('button.btn.ghost', { onclick: async () => { const reason = await confirm({ title: `Cancel order #${o.id}?`, message: 'Nothing is charged and no stock moves.', okText: 'Cancel order', danger: true, requireReason: true }); if (!reason) return; try { await api.action('order.cancel', { id: o.id, reason }); toast('Order cancelled', 'ok'); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); } } }, 'Cancel order'));
    if (cashier) actions.append(h('button.btn', { onclick: async () => {
      const reason = await confirm({ title: 'Return to Sales Clerk?', okText: 'Return order', requireReason: true });
      if (!reason) return;
      try { await api.action('order.return', { id: o.id, reason }); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); }
    } }, 'Return for correction'));
    if (cashier) actions.append(h('button.btn.primary.lg', { onclick: () => o.payment ? verifyPayment(ctx, o) : payModal(ctx, o) }, icon('banknote', 'sm'), 'Receive payment'));
  }
  if (!cashier && o.status === 'cancelled' && o.cancelReason?.startsWith('Returned:')) actions.append(h('a.btn', { href: '#/pos?revise=' + o.id }, 'Revise and resubmit'));
  if (o.saleId) actions.append(h('a.btn', { href: '#/sales/' + o.saleId }, icon('receipt', 'sm'), 'View receipt'));
  el.append(h('div.grid.two.stagger', { style: { alignItems: 'start' } },
    h('div.card', h('div.card__head', h('h2', 'Items'), h('span.small.muted', `${o.items} line${o.items === 1 ? '' : 's'}`)), receipt, o.note ? h('p.small', { style: { marginTop: '10px' } }, h('b', 'Note: '), o.note) : null, actions),
    h('div.card', h('div.card__head', h('h2', 'Status')), h('div.list',
      h('div.list__item', h('span.ic.ok', icon('send')), h('span.body', h('b', 'Sent to Cashier'), h('span', `${o.clerk} · ${dateTime(o.created)}`))),
      o.status === 'paid' ? h('div.list__item', h('span.ic.ok', icon('check')), h('span.body', h('b', 'Paid'), h('span', `${o.cashier} · ${dateTime(o.closed)} · Sale #${o.saleId}`))) : null,
      o.status === 'cancelled' ? h('div.list__item', h('span.ic.danger', icon('x')), h('span.body', h('b', o.cancelReason?.startsWith('Returned:') ? 'Returned for correction' : 'Cancelled'), h('span', `${o.cancelReason} · ${dateTime(o.closed)}`))) : null,
      o.status === 'waiting' ? h('div.list__item', h('span.ic.warn', icon('clock')), h('span.body', h('b', 'Waiting for payment'), h('span', `Since ${ago(o.created)}`))) : null))));
}

function paymentSummary(payment) {
  const rows = [['Payment method', payment.paymentMethod === 'Other' ? payment.paymentOther : payment.paymentMethod],
    ['Payment reference', payment.reference],
    ['Cash received', payment.cashReceived === null ? null : peso(payment.cashReceived)],
    ['Sukli', payment.change === null ? null : peso(payment.change)],
    ['Utang balance added', payment.creditAdded ? peso(payment.creditAdded) : null]];
  return rows.filter(([, value]) => value).map(([label, value]) => h('div.r', h('span', label), h('b', value)));
}

function verifyPayment(ctx, order) {
  const body = h('div.receipt', h('div.r', h('b', 'Amount to collect'), h('b', peso(order.payment.paidNow))), paymentSummary(order.payment));
  modal({ title: 'Verify payment', subtitle: 'Confirm the payment received and give the displayed change for cash.', body,
    foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => {
      try {
        const sale = await api.action('order.pay', { id: order.id });
        close();
        modal({ title: '', size: 'narrow', body: done => h('div.center', h('div.success-check', icon('check')), h('h2', 'Transaction successful'), h('p.muted', `Order #${order.id} · Sale #${sale.id}`), sale.change !== undefined ? h('div.change', { style: { margin: '12px auto', maxWidth: '300px' } }, h('span', 'Sukli'), h('b', peso(sale.change))) : null,
          h('div.row', { style: { marginTop: '18px', justifyContent: 'center' } }, h('button.btn', { onclick: () => { done(); go('sales/' + sale.id); } }, icon('receipt', 'sm'), 'View receipt'), h('button.btn.primary', { onclick: () => { done(); go('orders'); } }, 'Next in queue'))) });
        requestAnimationFrame(() => confetti(document.querySelector('.success-check')));
      } catch (err) { showError(body, errorOf(err)); }
    }) }, 'Complete transaction') });
}

// Receive payment for an order: cash with sukli, digital, or utang with optional partial payment.
async function payModal(ctx, o, confirmTotal = null, total = o.total) {
  let kind = 'cash', customer = o.customerId ? { id: o.customerId, name: o.customer } : null, customers = [];
  const cash = input({ type: 'number', min: 0, step: '0.01', placeholder: '0.00', class: 'big', inputmode: 'decimal' });
  const paidNow = input({ type: 'number', min: 0, step: '0.01', placeholder: '0.00', class: 'big', inputmode: 'decimal' });
  const changeBox = h('div.change', h('span', 'Change / Sukli'), h('b', peso(0)));
  const creditBox = h('div.change', h('span', 'Added to utang'), h('b', peso(total)));
  const payment = paymentFields(() => upd());
  const denoms = h('div.denoms', ...[20, 50, 100, 200, 500, 1000].map(d => h('button', { type: 'button', onclick: () => { cash.value = (Number(cash.value || 0) + d).toFixed(2); upd(); } }, '+' + d)), h('button', { type: 'button', onclick: () => { cash.value = total.toFixed(2); upd(); } }, 'Exact'));
  const custSearch = input({ placeholder: 'Search customer…' }), custList = h('div.list', { style: { maxHeight: '170px', overflow: 'auto' } });
  const cashPane = h('div.form', field('Cash received (₱)', cash), denoms, changeBox);
  const creditPane = h('div.form', field('Customer', custSearch), custList, field('Paid now (optional)', paidNow), creditBox);
  const btn = h('button.btn.primary.lg', { onclick: e => submit(e.currentTarget) }, 'Confirm payment');
  const upd = () => {
    cashPane.style.display = kind === 'cash' && payment.method.value === 'Cash' ? '' : 'none';
    creditPane.style.display = kind === 'credit' ? '' : 'none';
    payment.el.style.display = kind === 'cash' || Number(paidNow.value) > 0 ? '' : 'none';
    const change = Math.max(0, Number(cash.value || 0) - total); changeBox.querySelector('b').textContent = peso(change);
    creditBox.querySelector('b').textContent = peso(Math.max(0, total - Number(paidNow.value || 0)));
    btn.disabled = kind === 'cash' ? payment.method.value === 'Cash' && Number(cash.value || 0) < total : !customer;
  };
  const renderCust = async () => { if (!customers.length) customers = (await api.get('customers')).items; const q = custSearch.value.toLowerCase(); clear(custList).append(...customers.filter(c => !q || (c.name + ' ' + c.phone).toLowerCase().includes(q)).slice(0, 8).map(c => h('button.list__item' + (customer?.id === c.id ? '.unread' : ''), { type: 'button', onclick: () => { customer = c; custSearch.value = c.name; renderCust(); upd(); } }, h('span.ic', icon('user')), h('span.body', h('b', c.name), h('span', `Balance ${peso(c.balance)}`))))); };
  cash.oninput = upd; paidNow.oninput = upd; custSearch.oninput = renderCust;
  const seg = segmented([{ value: 'cash', label: 'Pay in full' }, { value: 'credit', label: 'Utang / partial' }], kind, v => { kind = v; if (v === 'credit') renderCust(); upd(); });
  const body = h('div.form', h('div.change', h('span', `Order #${o.id} · ${o.clerk}`), h('b', { style: { fontSize: '24px' } }, peso(total))), seg, payment.el, cashPane, creditPane);
  if (customer) custSearch.value = customer.name;
  let closeFn;
  modal({ title: 'Receive payment', subtitle: o.pricingMode === 'tawad' ? `Includes Tawad −${peso(o.tawadAmount)} (${o.tawadReason})` : 'Count the money, then confirm', body, foot: close => { closeFn = close; return btn; } });
  upd();
  async function submit(b) {
    await busy(b, async () => {
      showError(body, '');
      try {
        const r = await api.action('order.pay', { id: o.id, kind, ...(kind === 'cash' ? { cashReceived: payment.method.value === 'Cash' ? cash.value : String(total) } : { customerId: customer?.id, paidNow: paidNow.value || '0' }), ...(kind === 'cash' || Number(paidNow.value) > 0 ? payment.values() : {}), ...(confirmTotal !== null ? { confirmTotal } : {}) });
        closeFn(); confetti(); // confetti() plays the one success sound
        modal({ title: '', size: 'narrow', body: c2 => h('div.success', h('div.check', icon('check', 'lg')), h('h2', 'Payment received'), h('p.muted', `Order #${o.id} · Sale #${r.id}`), r.change ? h('div.change', h('span', 'Sukli'), h('b', peso(r.change))) : r.creditAdded ? h('div.change', h('span', 'Added to utang'), h('b', peso(r.creditAdded))) : null,
          h('div.row', { style: { marginTop: '18px', justifyContent: 'center' } }, h('button.btn', { onclick: () => { c2(); go('sales/' + r.id); } }, icon('receipt', 'sm'), 'Receipt'), h('button.btn.primary', { onclick: () => { c2(); go('orders'); } }, 'Next in queue'))) });
        reloadBoot?.();
      } catch (err) {
        if (err.payload?.code === 'TOTAL_CHANGED' || err.payload?.code === 'SUBTOTAL_CHANGED') {
          closeFn();
          const newTotal = err.payload.updatedTotal ?? (err.payload.updatedSubtotal - (o.tawadAmount || 0));
          const cents = err.payload.updatedTotal !== undefined ? Math.round(err.payload.updatedTotal * 100) : Math.round(err.payload.updatedSubtotal * 100);
          modal({ title: 'Price changed', size: 'narrow', subtitle: errorOf(err), body: h('div.change', h('span', 'New total'), h('b', peso(newTotal))), foot: c => h('button.btn.primary', { onclick: () => { c(); payModal(ctx, o, cents, newTotal); } }, 'Confirm new total') });
          return;
        }
        showError(body, errorOf(err));
      }
    });
  }
}
