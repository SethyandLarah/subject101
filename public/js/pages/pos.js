// Point of sale: product grid, live cart, cash change / credit checkout.
import { api } from '../api.js';
import { h, searchItems, typeahead, clear, peso, num, priceLine, modal, toast, busy, errorOf, field, input, select, showError, empty, skeleton, segmented, paymentFields, countUp, tag, isPhone, dateTime, bump, flash, haptic, flyTo, confetti, sound } from '../ui.js';
import { icon } from '../icons.js';
import { go } from '../app.js';
import { productCard, byCategory, catHead, catColor, watchStickyTop } from './materials.js';

const CART_KEY = 'alaan.cart';
const round2 = v => Math.round(v * 100) / 100;

export async function pos(ctx) {
  const { el, user, boot, query } = ctx;
  // Sales Clerk: builds an order and sends it to the Cashier. Cashier / Admin: rings up and takes payment.
  const orderMode = user.role !== 'admin' && user.role.includes('sales');
  if (!(user.role === 'admin' || orderMode)) { go('dashboard'); return; }
  el.append(h('div.sk-grid', ...Array.from({ length: 8 }, () => h('div.sk'))));
  let items = (await api.get('materials')).items.filter(m => !m.archived);
  clear(el);
  const KEY = orderMode ? CART_KEY + '.order' : CART_KEY;
  let cart = []; try { cart = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { cart = []; }
  cart = cart.filter(c => items.find(m => m.id === c.id));
  if (orderMode && query.get('revise')) {
    const previous = await api.get('orders', { id: query.get('revise') });
    if (previous.status === 'cancelled' && previous.cancelReason?.startsWith('Returned:')) {
      cart = previous.lines.filter(l => items.some(m => m.id === l.materialId)).map(l => ({ id: l.materialId, qty: l.qty }));
      sessionStorage.setItem(KEY, JSON.stringify(cart));
    }
  }
  const saveCart = () => sessionStorage.setItem(KEY, JSON.stringify(cart));
  let filters = { q: '', category: '' };

  // ---- Left: catalog -------------------------------------------------------
  const search = h('input', { placeholder: 'Search or scan SKU…', oninput: e => { filters.q = e.target.value; renderGrid(); }, onkeydown: e => { if (e.key === 'Enter') { const q = filters.q.trim().toLowerCase(); const exact = items.find(m => m.sku.toLowerCase() === q); if (exact) { e.preventDefault(); add(exact); search.value = ''; filters.q = ''; renderGrid(); search.dispatchEvent(new Event('input')); } } } });
  const chips = h('div.chips');
  const grid = h('div.products.stagger');
  const renderChips = () => clear(chips).append(h('button.chip' + (!filters.category ? '.active' : ''), { onclick: () => { filters.category = ''; renderGrid(); } }, 'All'), ...boot.categories.filter(c => !c.archived && items.some(m => m.categoryId === c.id)).map(c => h('button.chip' + (String(c.id) === String(filters.category) ? '.active' : ''), { onclick: () => { filters.category = String(c.id); renderGrid(); } }, h('span.dot', { style: { background: catColor(c.id) } }), c.name)));
  const renderGrid = () => {
    renderChips();
    const q = filters.q.trim().toLowerCase();
    const list = searchItems(items, q).filter(m => !filters.category || String(m.categoryId) === String(filters.category));
    clear(grid);
    if (!list.length) return grid.append(h('div', { style: { gridColumn: '1/-1' } }, empty('No materials match', 'search')));
    const card = (m, i) => productCard(m, user, { i, onclick: e => m.hasPrice && m.status !== 'out' ? add(m, e.currentTarget) : toast(m.hasPrice ? 'Out of stock' : 'This item has no price yet', 'warn'), onAdd: add });
    // "All" with no search: a sticky coloured header per category while the clerk scrolls.
    if (!filters.category && !q) {
      watchStickyTop(); let i = 0;
      for (const g of byCategory(list)) grid.append(h('section.catgroup.catgroup--grid', { style: { '--cat': g.color } }, catHead(g), h('div.products', ...g.items.map(m => card(m, i++)))));
      return;
    }
    list.forEach((m, i) => grid.append(card(m, i)));
  };
  const suggest = typeahead(search, { source: () => items, emptyLabel: 'No materials match', onPick: m => { if (m.hasPrice && m.status !== 'out') add(m); else toast(m.hasPrice ? 'Out of stock' : 'This item has no price yet', 'warn'); search.value = ''; filters.q = ''; renderGrid(); }, render: (m, q, mark) => [h('span.typeahead__name', ...mark(m.label, q)), h('span.typeahead__meta', `${m.sku} · ${num(m.qty)} ${m.unit}`), h('b', m.hasPrice ? peso(m.effective ?? m.price) : 'Price pending')] });
  const searchCard = h('div.card.has-typeahead.pos-search-card', { style: { marginBottom: '12px' } }, h('div.search', icon('search', 'sm'), search, h('kbd', 'Enter'), suggest), h('div', { style: { marginTop: '10px' } }, chips));
  let searchRaised = false;
  const revealSearch = () => {
    if (!matchMedia('(max-width: 760px)').matches || searchRaised) return;
    searchRaised = true; searchCard.classList.add('search-active');
    requestAnimationFrame(() => searchCard.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  search.addEventListener('focus', revealSearch);
  search.addEventListener('blur', () => { searchRaised = false; searchCard.classList.remove('search-active'); });
  const left = h('div', searchCard, grid);

  // ---- Right: cart ------------------------------------------------------
  const cartItems = h('div.cart__items');
  const subtotalEl = h('span.num'), discountEl = h('span.num'), totalEl = h('b.num', '₱0.00'), countEl = h('span.badge', { style: { background: 'var(--primary)' } }, '0');
  const checkoutBtn = h('button.btn.primary.lg.block', { onclick: () => checkout() }, icon(orderMode ? 'send' : 'arrowRight', 'sm'), orderMode ? 'Send to Cashier' : 'Checkout');
  const clearBtn = h('button.btn.ghost.sm', { onclick: () => { clearAgreed(); cart = []; saveCart(); renderCart(); } }, 'Clear');
  // ---- Pricing mode: Admin promos (default) or Tawad — one agreed total for the whole cart, promos suspended.
  const tawad = { on: false };
  const agreedInput = input({ type: 'number', min: 0, step: '0.01', placeholder: '0.00', inputmode: 'decimal', class: 'big', oninput: () => renderTotals() });
  const reasonInput = input({ placeholder: 'e.g. Suki, bulk order', maxlength: 120, oninput: () => renderTotals() });
  const tawadToggle = h('button.toggle', { 'aria-label': 'Haggled price / Tawad', onclick: () => setTawad(!tawad.on) });
  const tawadPane = h('div.tawad', { style: { display: 'none' } }, h('p.small.muted', 'Promos are suspended for this sale. Enter how much is deducted from the whole cart.'), h('div.form.two', field('Tawad amount (₱)', agreedInput), field('Reason', reasonInput)), h('div.tawad__eq'), h('p.small.tawad__msg'));
  const tawadBox = h('div.tawad-box', h('div.row.between', h('div', h('b', 'Haggled price / Tawad'), h('div.small.muted', 'Single item, bulk or mixed cart')), tawadToggle), tawadPane);
  const setTawad = on => { tawad.on = on; tawadToggle.classList.toggle('on', on); tawadPane.style.display = on ? '' : 'none'; tawadBox.classList.toggle('active', on); if (!on) { agreedInput.value = ''; } renderCart(); if (on) setTimeout(() => agreedInput.focus(), 100); };
  const clearAgreed = () => { if (tawad.on && agreedInput.value) { agreedInput.value = ''; toast('Cart changed — enter the Tawad amount again', 'warn', 2200); } };
  const discountLabel = h('span', 'Discounts'), subtotalLabel = h('span', 'Subtotal'), totalLabel = h('span', 'Total');
  // Phones/tablets: the total and the main button stay visible above the bottom menu, so the
  // clerk/cashier never has to scroll to the end of the cart to send or check out.
  const dockTotal = h('b'), dockCount = h('span');
  let cartSheet = null, cartSlot = null, cartSheetAmount = null, cartSheetSubmit = null;
  const dockBtn = h('button.btn.primary', { onclick: () => checkoutBtn.click() }, icon(orderMode ? 'send' : 'arrowRight', 'sm'), orderMode ? 'Send to Cashier' : 'Checkout');
  const dock = h('div.paydock', { role: 'region', 'aria-label': 'Cart total' }, h('button.paydock__sum', { type: 'button', 'aria-label': 'Open cart', onclick: () => openCart() }, dockCount, dockTotal), dockBtn);
  document.querySelectorAll('.paydock').forEach(x => x.remove()); document.body.append(dock);
  // Keep the action above the on-screen keyboard instead of hiding it while payment fields are edited.
  const viewport = window.visualViewport;
  const syncKeyboard = () => {
    const height = viewport ? Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop)) : 0;
    document.documentElement.style.setProperty('--keyboard-height', `${height}px`);
  };
  viewport?.addEventListener('resize', syncKeyboard); viewport?.addEventListener('scroll', syncKeyboard); window.addEventListener('resize', syncKeyboard); syncKeyboard();
  // Keep the compact checkout action available while the customer and clerk review the cart.
  const dropDock = () => { cartSheet?.close(); dock.remove(); document.body.classList.remove('has-dock'); document.documentElement.style.removeProperty('--keyboard-height'); viewport?.removeEventListener('resize', syncKeyboard); viewport?.removeEventListener('scroll', syncKeyboard); window.removeEventListener('resize', syncKeyboard); removeEventListener('hashchange', dropDock); };
  addEventListener('hashchange', dropDock);
  const cartCard = h('div.card.cart', h('div.card__head', h('div.row', h('h2', 'Cart'), countEl), clearBtn), cartItems, tawadBox, h('div.cart__sum', h('div.line', subtotalLabel, subtotalEl), h('div.line', discountLabel, discountEl), h('div.line.total', totalLabel, totalEl)), h('div.cart__submit', { style: { marginTop: '12px' } }, checkoutBtn));
  cartSlot = h('div.cart-slot', cartCard);
  function openCart() {
    if (innerWidth > 1000) { cartCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (cartSheet || !cart.length) return;
    cartSlot.hidden = true; cartCard.classList.add('in-sheet');
    cartSheetAmount = h('b', peso(totals().total));
    cartSheet = modal({ title: orderMode ? 'Review order' : 'Review sale', subtitle: `${cart.length} line${cart.length === 1 ? '' : 's'} · Check the items and total`,
      body: h('div.cart-sheet', cartCard),
      foot: close => (cartSheetSubmit = h('button.btn.primary.lg.cart-sheet__action', { onclick: () => checkoutBtn.click() }, icon(orderMode ? 'send' : 'arrowRight', 'sm'), h('span', orderMode ? 'Send to Cashier' : 'Checkout'), cartSheetAmount)),
      onClose: () => { cartCard.classList.remove('in-sheet'); cartSlot?.append(cartCard); if (cartSlot) cartSlot.hidden = false; cartSheet = null; cartSheetAmount = null; cartSheetSubmit = null; } });
    cartSheet.panel.classList.add('cart-modal');
  }
  const lineOf = c => { const m = items.find(x => x.id === c.id); if (tawad.on) { const regular = round2(m.price * c.qty); return { regular, final: regular, savings: 0, detail: '' }; } return priceLine(m, c.qty); };
  const totals = () => {
    let subtotal = 0, total = 0; for (const c of cart) { const l = lineOf(c); subtotal += l.regular; total += l.final; }
    subtotal = round2(subtotal); total = round2(total);
    if (tawad.on) { const off = Number(agreedInput.value); const valid = agreedInput.value !== '' && /^\d+(\.\d{1,2})?$/.test(agreedInput.value.trim()) && off > 0 && off < subtotal; return { subtotal, total: valid ? round2(subtotal - off) : subtotal, discount: valid ? round2(off) : 0, tawad: true, valid: valid && reasonInput.value.trim().length > 0, agreedOk: valid }; }
    return { subtotal, total, discount: round2(subtotal - total), tawad: false, valid: true };
  };
  const renderCart = () => {
    clear(cartItems);
    if (!cart.length) cartItems.append(empty('Tap a material to add it', 'cart'));
    for (const c of cart) {
      const m = items.find(x => x.id === c.id);
      const qtyInput = h('input', { type: 'number', min: 0, step: m.decimal ? 'any' : 1, value: c.qty, onchange: e => setQty(c, Number(e.target.value)) });
      const l = lineOf(c);
      cartItems.append(h('div.cart__item', { dataset: { id: c.id } }, h('div', h('b', m.label), h('div.price', `${peso(m.price)} / ${m.unit}${m.promo && !tawad.on ? ' · ' + m.promo.label : ''}`), m.promo && tawad.on ? h('div.small.muted', 'Promo suspended — Tawad') : m.promo ? h('div.small', { style: { color: l.savings > 0 ? 'var(--primary)' : 'var(--muted)' } }, l.savings > 0 ? `${l.detail} · you save ${peso(l.savings)}` : l.detail) : null), h('div.total', l.savings > 0 ? [h('s.small.muted', peso(l.regular)), ' ', peso(l.final)] : peso(l.final)),
        h('div.row', h('div.qty', h('button', { onclick: () => setQty(c, round2(c.qty - (m.decimal ? 0.5 : 1))) }, icon('minus', 'sm')), qtyInput, h('button', { onclick: () => setQty(c, round2(c.qty + (m.decimal ? 0.5 : 1))) }, icon('plus', 'sm'))), h('span.small.muted', `${num(m.qty)} ${m.unit} available`)),
        h('button.btn.icon.sm.ghost', { style: { justifySelf: 'end' }, 'aria-label': 'Remove', 'data-silent-click': 'true', onclick: e => { sound.play('remove'); e.currentTarget.closest('.cart__item').classList.add('removing'); setTimeout(() => { clearAgreed(); cart = cart.filter(x => x !== c); saveCart(); renderCart(); }, 180); } }, icon('trash', 'sm'))));
    }
    renderTotals();
  };
  function renderTotals() {
    const t = totals();
    subtotalLabel.textContent = t.tawad ? 'Regular subtotal' : 'Subtotal'; discountLabel.textContent = t.tawad ? 'Tawad' : 'Promo discounts'; totalLabel.textContent = t.tawad ? 'Amount due' : 'Total';
    subtotalEl.textContent = peso(t.subtotal); discountEl.textContent = t.discount ? '− ' + peso(t.discount) : peso(0);
    countUp(totalEl, t.total, { format: peso, duration: 400 });
    countEl.textContent = cart.reduce((a, c) => a + 1, 0);
    const msg = tawadPane.querySelector('.tawad__msg');
    const eq = tawadPane.querySelector('.tawad__eq');
    if (eq) { clear(eq); if (t.tawad && cart.length) eq.append(h('span', peso(t.subtotal)), h('span.op', '−'), h('span' + (t.agreedOk ? '' : '.muted'), t.agreedOk ? peso(t.discount) : '₱?'), h('span.op', '='), h('b', peso(t.total))); }
    if (t.tawad) msg.textContent = !cart.length ? '' : agreedInput.value === '' ? `Regular cart total ${peso(t.subtotal)} — enter the Tawad amount.` : !t.agreedOk ? `The Tawad amount must be more than ₱0 and less than ${peso(t.subtotal)}.` : !reasonInput.value.trim() ? 'Add a short reason.' : `Customer pays ${peso(t.total)}`;
    if (msg) msg.classList.toggle('err', t.tawad && agreedInput.value !== '' && !t.agreedOk);
    checkoutBtn.disabled = !cart.length || !t.valid;
    dockBtn.disabled = checkoutBtn.disabled; dockTotal.textContent = peso(cart.length ? t.total : 0);
    dockCount.textContent = `${cart.length} item${cart.length === 1 ? '' : 's'}${t.tawad && t.agreedOk ? ' · Tawad' : ''}`;
    if (cartSheetAmount) cartSheetAmount.textContent = peso(t.total);
    if (cartSheetSubmit) cartSheetSubmit.disabled = checkoutBtn.disabled;
    dock.classList.toggle('on', cart.length > 0); document.body.classList.toggle('has-dock', cart.length > 0 && dock.isConnected);
  }
  const setQty = (c, q) => { clearAgreed(); const m = items.find(x => x.id === c.id); if (!(q > 0)) { cart = cart.filter(x => x !== c); } else { if (q > m.qty) { toast(`Only ${num(m.qty)} ${m.unit} available`, 'warn'); q = m.qty; } c.qty = m.decimal ? round2(q) : Math.round(q); } saveCart(); renderCart(); bump(totalEl); flash(cartItems.querySelector(`.cart__item[data-id="${c.id}"]`)); haptic(8); };
  function add(m, cardEl) {
    clearAgreed();
    const existing = cart.find(c => c.id === m.id);
    if (existing) { if (existing.qty + 1 > m.qty) return toast(`Only ${num(m.qty)} ${m.unit} available`, 'warn'); existing.qty = round2(existing.qty + 1); }
    else cart.push({ id: m.id, qty: 1 });
    saveCart();
    flyTo(cardEl, countEl, m.photo ? `/media/item/${m.id}` : null);
    setTimeout(() => { renderCart(); bump(countEl); bump(totalEl); flash(cartItems.querySelector(`.cart__item[data-id="${m.id}"]`)); }, cardEl ? 420 : 0);
    if (cardEl) { cardEl.classList.remove('pop'); void cardEl.offsetWidth; cardEl.classList.add('pop'); }
    haptic();
    if (isPhone()) toast(`Added ${m.label}`, 'ok', 1200);
  }

  el.append(h('div.page__head', h('div', h('p.eyebrow', orderMode ? 'Sales Clerk' : user.role === 'admin' ? 'Admin · point of sale' : 'Cashier · walk-in sale'), h('h1', orderMode ? 'New order' : 'New sale'), orderMode ? h('p.muted', 'Help the customer pick items, agree on Tawad if any, then send the order to the Cashier for payment.') : null), h('div.page__actions', orderMode ? h('a.btn', { href: '#/orders' }, icon('receipt', 'sm'), 'My orders') : [user.role === 'cashier' ? h('a.btn', { href: '#/orders' }, icon('clock', 'sm'), 'Order queue') : null, h('a.btn', { href: '#/sales' }, icon('receipt', 'sm'), 'Sales history')])));
  el.append(h('div.pos', left, cartSlot));
  renderGrid(); renderCart();
  if (query.get('add')) { const m = items.find(x => String(x.id) === query.get('add')); if (m && m.hasPrice) add(m); }

  // ---- Checkout --------------------------------------------------------
  async function checkout() {
    const t = totals(); let confirmedTotal = null; let kind = 'cash'; let customer = null; let customers = [];
    const cash = input({ type: 'number', min: 0, step: '0.01', placeholder: '0.00', class: 'big', inputmode: 'decimal' });
    const paidNow = input({ type: 'number', min: 0, step: '0.01', placeholder: '0.00', class: 'big', inputmode: 'decimal', value: '' });
    const changeBox = h('div.change', h('span', 'Change / Sukli'), h('b', peso(0)));
    const creditBox = h('div.change', h('span', 'Added to utang'), h('b', peso(t.total)));
    const denoms = h('div.denoms', ...[20, 50, 100, 200, 500, 1000].map(d => h('button', { type: 'button', onclick: () => { cash.value = (Number(cash.value || 0) + d).toFixed(2); upd(); } }, '+' + d)), h('button', { type: 'button', onclick: () => { cash.value = t.total.toFixed(2); upd(); } }, 'Exact'));
    const custSearch = input({ placeholder: 'Search customer by name or number…' });
    const custList = h('div.list', { style: { maxHeight: '180px', overflow: 'auto' } });
    const custPicked = h('div.row', { style: { display: 'none' } });
    const confirmBtn = h('button.btn.primary.lg', { onclick: e => submit(e.currentTarget) }, orderMode ? 'Send to Cashier' : 'Confirm sale');
    const payment = paymentFields(() => upd());
    const upd = () => {
      const isCash = payment.method.value === 'Cash';
      const paid = kind === 'cash' || Number(paidNow.value) > 0;
      cashPane.style.display = kind === 'cash' && isCash ? '' : 'none';
      payment.el.style.display = paid ? '' : 'none';
      if (kind === 'cash' && !isCash) confirmBtn.disabled = !payment.valid();
      else if (kind === 'cash') { const c = Number(cash.value || 0); const ch = round2(c - t.total); changeBox.classList.toggle('short', ch < 0); changeBox.firstChild.textContent = ch < 0 ? 'Short by' : 'Change / Sukli'; if (changeBox.lastChild.textContent !== peso(Math.abs(ch))) { changeBox.lastChild.textContent = peso(Math.abs(ch)); bump(changeBox); } confirmBtn.disabled = ch < 0 || cash.value === ''; }
      else { const p = Number(paidNow.value || 0); const added = round2(t.total - p); creditBox.classList.toggle('short', added <= 0 || p < 0); if (creditBox.lastChild.textContent !== peso(Math.max(0, added))) { creditBox.lastChild.textContent = peso(Math.max(0, added)); bump(creditBox); } confirmBtn.disabled = !customer || added <= 0 || p < 0 || (paid && !payment.valid()); }
    };
    cash.oninput = upd; paidNow.oninput = upd;
    const renderCustomers = q => { clear(custList); const list = customers.filter(c => !q || (c.name + ' ' + c.phone).toLowerCase().includes(q.toLowerCase())).slice(0, 8); if (!list.length) custList.append(h('div.small.muted', { style: { padding: '8px' } }, 'No match. ', h('a', { href: '#', onclick: e => { e.preventDefault(); newCustomer(q); } }, 'Add new customer'))); for (const c of list) custList.append(h('div.list__item.click', { onclick: () => pickCustomer(c) }, h('span.ic', icon('user')), h('span.body', h('b', c.name), h('span', `${c.phone || 'no number'} · balance ${peso(c.balance)}`)))); };
    const pickCustomer = c => { customer = c; custPicked.style.display = 'flex'; clear(custPicked).append(h('span.ic', { style: { width: '36px', height: '36px', borderRadius: '12px', display: 'grid', placeItems: 'center', background: 'var(--primary-soft)', color: 'var(--primary)' } }, icon('user')), h('div.grow', h('b', c.name), h('div.small.muted', `Current balance ${peso(c.balance)} · after this sale ${peso(round2(c.balance + t.total - Number(paidNow.value || 0)))}`)), h('button.btn.sm.ghost', { onclick: () => { customer = null; custPicked.style.display = 'none'; custList.style.display = ''; custSearch.style.display = ''; upd(); } }, 'Change customer')); custList.style.display = 'none'; custSearch.style.display = 'none'; upd(); };
    const newCustomer = async prefill => { const name = input({ value: prefill || '', placeholder: 'Full name' }), phone = input({ placeholder: 'Contact number', inputmode: 'tel' }), address = input({ placeholder: 'Address' }); const b = h('div.form', field('Full name', name), field('Contact number', phone), field('Address', address)); modal({ title: 'New customer', body: b, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(b, ''); try { const r = await api.action('customer.save', { name: name.value, phone: phone.value, address: address.value, force: true }); customers = (await api.get('customers')).items; pickCustomer(customers.find(c => c.id === r.id)); close(); } catch (err) { showError(b, errorOf(err)); } }) }, 'Save customer') }); };
    custSearch.oninput = e => renderCustomers(e.target.value);
    const cashPane = h('div.form', field('Cash received (₱)', cash), denoms, changeBox);
    const creditPane = h('div.form', { style: { display: 'none' } }, field('Customer', h('div.col', custSearch, custList, custPicked), 'Search first to reuse an existing record'), field('Amount paid now (₱)', paidNow, 'Leave 0 for full credit'), creditBox);
    const seg = segmented([{ value: 'cash', label: 'Pay in full' }, { value: 'credit', label: 'Utang / Partial' }], 'cash', async v => { kind = v; creditPane.style.display = v === 'credit' ? '' : 'none'; if (v === 'credit' && !customers.length) { try { customers = (await api.get('customers')).items; renderCustomers(''); } catch (err) { toast('Credit sales need a server connection', 'warn'); } } upd(); });
    const summary = h('div.receipt', ...cart.map(c => { const m = items.find(x => x.id === c.id); const l = lineOf(c); return h('div.r', h('span', `${m.label} × ${num(c.qty)}`, l.savings > 0 ? h('span.small', { style: { color: 'var(--primary)' } }, ` · ${l.detail}`) : null), h('span', peso(l.final))); }), h('hr'), t.tawad ? [h('div.r', h('span', 'Regular subtotal'), h('span', peso(t.subtotal))), h('div.r', h('span', `Tawad (${reasonInput.value.trim()})`), h('span', '− ' + peso(t.discount))), h('div.r.small', h('span', `${peso(t.subtotal)} − ${peso(t.discount)} = ${peso(t.total)}`), h('span'))] : t.discount ? h('div.r', h('span', 'Promo savings'), h('span', '− ' + peso(t.discount))) : null, h('div.r', h('b', t.tawad ? 'AMOUNT DUE' : 'TOTAL'), h('b', peso(t.total))));
    const body = h('div.col', { style: { gap: '14px' } }, summary, seg, creditPane, payment.el, cashPane);
    const m = modal({ title: 'Checkout', subtitle: `${cart.length} line${cart.length === 1 ? '' : 's'} · ${peso(t.total)}`, body, foot: close => [h('button.btn', { onclick: close }, 'Back'), confirmBtn] });
    upd(); setTimeout(() => cash.focus(), 150);
    async function submit(btn) {
      showError(body, '');
      await busy(btn, async () => {
        try {
          const lines = cart.map(c => ({ materialId: c.id, qty: c.qty }));
          const expectedTotal = confirmedTotal ?? Math.round(t.total * 100);
          const mode = t.tawad ? { pricingMode: 'tawad', tawadAmount: agreedInput.value, tawadReason: reasonInput.value.trim(), expectedSubtotal: Math.round(t.subtotal * 100) } : { expectedTotal };
          const r = await api.action(orderMode ? 'order.create' : 'sale.checkout', { preparePayment: orderMode, kind, lines, ...mode, ...((kind === 'cash' || Number(paidNow.value) > 0) ? payment.values() : {}), cashReceived: kind === 'cash' && payment.method.value === 'Cash' ? cash.value : undefined, customerId: customer?.id, paidNow: kind === 'credit' ? (paidNow.value || '0') : undefined }, { offlineOk: orderMode || (kind === 'cash' && payment.method.value === 'Cash') });
          cartSheet?.close();
          m.close();
          cart = []; saveCart(); if (tawad.on) setTawad(false); else renderCart();
          if (r.queued) { toast(orderMode ? 'Order saved on this device · it goes to the Cashier when the connection returns' : 'Sale saved on this device · Pending sync', 'warn'); return; }
          if (orderMode) { sound.play('success'); toast('Order #' + r.id + ' sent to the Cashier', 'ok'); go('orders/' + r.id); return; }
          items = (await api.get('materials')).items.filter(x => !x.archived); renderGrid();
          successModal(r, kind, customer);
        } catch (err) {
          if (err.payload?.code === 'SUBTOTAL_CHANGED') {
            // A regular price changed: the haggled total must be agreed again on the new subtotal.
            m.close(); items = (await api.get('materials')).items.filter(x => !x.archived); agreedInput.value = ''; renderGrid(); renderCart();
            modal({ title: 'Price changed', size: 'narrow', subtitle: errorOf(err), body: h('div.change', h('span', 'New regular subtotal'), h('b', peso(err.payload.updatedSubtotal))), foot: close => h('button.btn.primary', { onclick: () => { close(); agreedInput.focus(); } }, 'Enter Tawad amount again') });
            return;
          }
          if (err.payload?.code === 'TOTAL_CHANGED') {
            // Price or promo changed while the cart was open: show the new total and ask the clerk to confirm.
            items = (await api.get('materials')).items.filter(x => !x.archived); renderGrid(); renderCart();
            const nt = h('div.change', h('span', 'Updated total'), h('b', peso(err.payload.updatedTotal)));
            modal({ title: 'Price changed', size: 'narrow', subtitle: errorOf(err), body: h('div.col', nt, h('div.receipt', ...err.payload.lines.map(l => { const m = items.find(x => x.id === l.materialId); return h('div.r', h('span', `${m?.label || l.materialId} × ${num(l.qty)}`), h('span', peso(l.final))); }))),
              foot: close => [h('button.btn', { onclick: close }, 'Back to cart'), h('button.btn.primary', { onclick: () => { confirmedTotal = Math.round(err.payload.updatedTotal * 100); close(); submit(btn); } }, 'Confirm new total')] });
            return;
          }
          showError(body, errorOf(err)); if (err.status === 409) { items = (await api.get('materials')).items.filter(x => !x.archived); renderGrid(); renderCart(); } }
      });
    }
  }
  function successModal(r, kind, customer) {
    haptic(30);
    // One success sound per sale: confetti() plays it (it used to play here, after saving and in confetti too).
    setTimeout(() => confetti(document.querySelector('.success-check')), 150);
    modal({ size: 'narrow', body: close => h('div.center', h('div.success-check', icon('check')), h('h2', kind === 'credit' ? 'Credit sale recorded' : 'Sale confirmed'), h('p.muted', `Sale #${r.id} · ${peso(r.total)}`),
      kind === 'cash' && r.paymentMethod !== 'Cash' ? h('p', 'Paid via ' + r.paymentMethod) : kind === 'cash' ? h('div.change', { style: { marginTop: '16px', textAlign: 'left' } }, h('span', 'Change / Sukli', h('br'), h('small', `Cash ${peso(r.cashReceived)}`)), h('b', { style: { fontSize: '26px' } }, peso(r.change))) : h('div.change', { style: { marginTop: '16px', textAlign: 'left' } }, h('span', `Added to ${customer?.name}'s utang`, h('br'), h('small', `Paid now ${peso(r.paidNow)}`)), h('b', { style: { fontSize: '22px' } }, peso(r.creditAdded))),
      h('div.row', { style: { marginTop: '18px', justifyContent: 'center' } }, h('button.btn', { onclick: () => { close(); go('sales/' + r.id); } }, icon('receipt', 'sm'), 'View receipt'), h('button.btn.primary', { onclick: close }, 'New sale'))) });
  }
}
