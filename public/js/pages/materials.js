// Inventory: materials catalog, detail, stock in/out, counts, suppliers, movements, categories.
import { api, state } from '../api.js';
import { h, searchItems, typeahead, clear, peso, num, qtyText, priceLine, dateTime, dateText, ago, modal, confirm, toast, busy, errorOf, field, input, select, showError, photoPicker, empty, skeleton, tag, statusName, segmented, countUp, todayPH, isPhone } from '../ui.js';
import { icon } from '../icons.js';
import { go, reloadBoot } from '../app.js';

const canStock = u => u.role === 'admin' || u.role.includes('stock');
const canSell = u => u.role === 'admin' || u.role === 'cashier' || u.role.includes('sales');
// ---- Category sections ---------------------------------------------------
// Every category keeps one colour everywhere (chips, section headers, POS), based on its id.
const CAT_COLORS = ['#0f7a52', '#6d4fd6', '#e0742f', '#2f6fdb', '#d6453f', '#0ea5a4', '#b45309', '#64748b', '#be185d', '#4d7c0f'];
export const catColor = id => CAT_COLORS[Math.abs(Number(id) || 0) % CAT_COLORS.length];
/** Items split by category, in name order: [{ id, name, color, items }]. */
export function byCategory(items) {
  const groups = new Map();
  for (const m of items) { if (!groups.has(m.categoryId)) groups.set(m.categoryId, { id: m.categoryId, name: m.category, color: catColor(m.categoryId), items: [] }); groups.get(m.categoryId).items.push(m); }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** A highlighted header that stays on screen (under the top bar) while its category scrolls by. */
export function catHead(g, unit = 'item') {
  return h('div.cathead', { style: { '--cat': g.color }, role: 'heading', 'aria-level': '3' }, h('span.cathead__dot'), h('b.cathead__name', g.name), h('span.cathead__n', `${g.items.length} ${unit}${g.items.length === 1 ? '' : 's'}`));
}
/** Keeps --stick-top equal to the top bar's height, so sticky headers sit right under it. */
let stickWatch = false;
export function watchStickyTop() {
  if (stickWatch) return; stickWatch = true;
  const set = () => { const tb = document.querySelector('.topbar'); const top = tb ? Math.max(0, Math.round(tb.getBoundingClientRect().height)) : 0; document.documentElement.style.setProperty('--stick-top', top + 'px'); };
  set(); addEventListener('resize', set);
  try { new ResizeObserver(set).observe(document.querySelector('.topbar') || document.body); } catch { /* old browser: resize event is enough */ }
}
const thumb = m => h('span.thumb', m.photo ? h('img', { src: `/media/item/${m.id}`, alt: '', loading: 'lazy' }) : icon('box', 'sm'));

// ---- Inventory hub with sub-tabs -------------------------------------
export async function inventory(ctx) {
  const { el, params, user, query } = ctx;
  if (!canStock(user)) { go('materials'); return; }
  const tabs = [{ value: '', label: 'Materials' }, { value: 'counts', label: 'Counts' }, { value: 'suppliers', label: 'Suppliers' }, { value: 'movements', label: 'Movements' }];
  tabs.push({ value: 'categories', label: 'Categories' });
  const sub = params[0] || '';
  const actions = h('div.page__actions');
  if (sub === '' || sub === 'movements') actions.append(
    h('button.btn', { onclick: () => stockForm('in', ctx) }, icon('download', 'sm'), 'Stock In'),
    h('button.btn', { onclick: () => stockForm('out', ctx) }, icon('upload', 'sm'), 'Stock Out'),
    h('button.btn', { onclick: () => countForm(ctx) }, icon('clipboard', 'sm'), 'Count'),
    h('button.btn.primary', { onclick: () => materialForm(null, ctx) }, icon('plus', 'sm'), 'Add material'));
  if (sub === 'suppliers') actions.append(h('button.btn.primary', { onclick: () => supplierForm(null, ctx) }, icon('plus', 'sm'), 'Add supplier'));
  if (sub === 'categories') actions.append(h('button.btn.primary', { onclick: () => categoryForm(null, ctx) }, icon('plus', 'sm'), 'Add category'));
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Inventory'), h('h1', tabs.find(t => t.value === sub)?.label || 'Materials')), actions));
  el.append(h('div', { style: { margin: '0 4px 14px' } }, segmented(tabs, sub, v => go('inventory' + (v ? '/' + v : '')))));
  const body = h('div'); el.append(body);
  const action = query.get('action');
  if (action === 'in') setTimeout(() => stockForm('in', ctx), 100); if (action === 'out') setTimeout(() => stockForm('out', ctx), 100);
  if (action === 'count') setTimeout(() => countForm(ctx), 100); if (action === 'new') setTimeout(() => materialForm(null, ctx), 100);
  if (sub === 'counts') return countsTab(body, ctx);
  if (sub === 'suppliers') return suppliersTab(body, ctx);
  if (sub === 'movements') return movementsTab(body, ctx);
  if (sub === 'categories') return categoriesTab(body, ctx);
  return catalog(body, ctx);
}

// ---- Catalog (list/grid with filters) ----------------------------------
export async function materials(ctx) {
  const { el, user } = ctx;
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Catalog'), h('h1', 'Materials')), canSell(user) ? h('div.page__actions', h('button.btn.primary', { onclick: () => go('pos') }, icon('cart', 'sm'), 'Open POS')) : null));
  const body = h('div'); el.append(body);
  return catalog(body, ctx);
}
async function catalog(box, ctx) {
  const { user, query, boot } = ctx;
  let filters = { q: query.get('q') || '', category: query.get('category') || '', status: query.get('status') || 'all', nopric: query.get('nopric') === '1' };
  let view = localStorage.getItem('alaan.catalogView') || (isPhone() ? 'grid' : 'table');
  const searchInput = h('input', { placeholder: 'Search name, variant or SKU', value: filters.q, oninput: e => { filters.q = e.target.value; render(); } });
  const statusSeg = segmented([{ value: 'all', label: 'All' }, { value: 'high', label: 'High' }, { value: 'adequate', label: 'Adequate' }, { value: 'low', label: 'Low' }, { value: 'out', label: 'Out' }], filters.status, v => { filters.status = v; render(); }, { small: true });
  const catSelect = select([{ value: '', label: 'All categories' }], { class: 'only-phone', style: { width: 'auto', minWidth: '180px' }, onchange: e => { filters.category = e.target.value; render(); } });
  const chips = h('div.chips.only-desktop');
  const viewSeg = segmented([{ value: 'table', label: 'List' }, { value: 'grid', label: 'Cards' }], view, v => { view = v; localStorage.setItem('alaan.catalogView', v); render(); }, { small: true });
  const list = h('div'); const count = h('span.small.muted');
  const showPrice = canSell(ctx.user);
  const suggest = typeahead(searchInput, { source: () => all, onPick: m => go('materials/' + m.id), render: (m, q, mark) => [h('span.typeahead__name', ...mark(m.label, q)), h('span.typeahead__meta', `${m.sku} · ${m.category} · ${num(m.qty)} ${m.unit}`), showPrice && m.hasPrice ? h('b', peso(m.effective ?? m.price)) : null] });
  box.append(h('div.filterbar.has-typeahead', chips, catSelect, h('span.grow'), h('div.search', { style: { minWidth: '260px' } }, icon('search', 'sm'), searchInput, suggest), statusSeg, viewSeg), list);
  let all = [];
  const load = async () => { const d = await api.get('materials'); all = d.items; render(); };
  const renderChips = () => {
    const current = filters.category;
    clear(chips).append(h('button.chip' + (!current ? '.active' : ''), { onclick: () => { filters.category = ''; render(); } }, 'All', h('span.n', all.length)),
      ...boot.categories.filter(c => !c.archived && all.some(m => m.categoryId === c.id)).map(c => h('button.chip' + (String(c.id) === String(current) ? '.active' : ''), { onclick: () => { filters.category = String(c.id); render(); } }, h('span.dot', { style: { background: catColor(c.id) } }), c.name, h('span.n', all.filter(m => m.categoryId === c.id).length))));
    clear(catSelect).append(h('option', { value: '' }, `All categories (${all.length})`), ...boot.categories.filter(c => !c.archived || String(c.id) === String(current)).map(c => h('option', { value: c.id, selected: String(c.id) === String(current) }, `${c.name} (${all.filter(m => m.categoryId === c.id).length})`)));
  };
  const render = () => {
    renderChips();
    const q = filters.q.trim().toLowerCase();
    const items = searchItems(all, q).filter(m => (!filters.category || String(m.categoryId) === String(filters.category)) && (filters.status === 'all' || m.status === filters.status) && (!filters.nopric || !m.hasPrice));
    clear(list);
    count.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
    if (!items.length) { list.append(h('div.card', empty('No materials match these filters', 'box'))); return; }
    // All categories and no search: one section per category with a sticky, coloured header,
    // so staff always see which category they are scrolling through.
    const grouped = !filters.category && !q;
    if (grouped) watchStickyTop();
    if (view === 'grid') {
      if (!grouped) { list.append(h('div.products.stagger', ...items.map((m, i) => productCard(m, user, { i, onclick: () => go('materials/' + m.id) })))); return; }
      let i = 0;
      list.append(h('div.catgroups', ...byCategory(items).map(g => h('section.catgroup', { style: { '--cat': g.color } }, catHead(g), h('div.products.stagger', ...g.items.map(m => productCard(m, user, { i: i++, onclick: () => go('materials/' + m.id) })))))));
      return;
    }
    const showPrice = canSell(user);
    const row = (m, i) => h('tr.click', { style: { '--i': Math.min(i, 20) }, onclick: () => go('materials/' + m.id) },
      h('td.c-mat', h('div.row', thumb(m), h('div.c-matname', h('b', m.label), h('div.small.muted', h('span.c-sku', m.sku), h('span.c-cat', ' · ' + m.category))))),
      h('td.num.c-qty', h('b', num(m.qty)), h('span.small.muted', ' ' + m.unit)),
      h('td.num.small.muted.c-lh', `${num(m.low)} / ${num(m.high)}`),
      h('td.c-st', tag(statusName(m.status), m.status)),
      showPrice ? h('td.num.c-pr', m.hasPrice ? h('span', m.promo && m.promo.type !== 'bundle' ? h('s.small.muted', peso(m.price)) : null, ' ', h('b', peso(m.promo?.type === 'bundle' ? m.price : m.effective)), m.promo ? h('div', h('span.promo-badge', m.promo.label)) : null) : tag('Price pending', 'warn plain')) : null,
      h('td.c-go', icon('chevronRight', 'sm')));
    const head = () => h('thead', h('tr', h('th', 'Material'), h('th.right', 'On hand'), h('th.right', 'Low / High'), h('th', 'Status'), showPrice ? h('th.right', 'Price') : null, h('th')));
    const table = (rows, withHead) => h('div.card.pad-0', h('div.table-wrap', h('table.t.t--mat', withHead ? head() : null, h('tbody.stagger', ...rows))));
    if (!grouped) { list.append(table(items.map(row), true)); return; }
    let i = 0;
    list.append(h('div.catgroups', ...byCategory(items).map((g, gi) => h('section.catgroup', { style: { '--cat': g.color } }, catHead(g), table(g.items.map(m => row(m, i++)), gi === 0)))));
  };
  box.append(h('div.small.muted', { style: { margin: '10px 6px 0' } }, count));
  list.append(skeleton(1));
  await load();
}
const PH = [['#dff3e8', '#0f7a52'], ['#e9e4fb', '#6d4fd6'], ['#fde8dc', '#c2410c'], ['#dfeefb', '#2f6fdb'], ['#fbf1cf', '#a16207'], ['#d9f3f3', '#0e7490'], ['#fce7f3', '#be185d'], ['#e5e7eb', '#475569']];
const placeholderStyle = id => { const [bg, ink] = PH[(Number(id) || 0) % PH.length]; return { '--ph-bg': `linear-gradient(135deg, ${bg}, color-mix(in oklab, ${bg} 60%, white))`, '--ph-ink': ink }; };
export function productCard(m, user, { i = 0, onclick, onAdd } = {}) {
  const showPrice = canSell(user);
  // The + button sits on the photo's corner, so it never covers the name or price.
  const addBtn = onAdd && m.hasPrice && m.status !== 'out' ? h('button.product__add', { 'aria-label': 'Add ' + m.label + ' to cart', onclick: e => { e.stopPropagation(); onAdd(m, card); } }, icon('plus', 'sm')) : null;
  const card = h('div.product' + (!m.hasPrice && onAdd ? '.disabled' : ''), { style: { '--i': Math.min(i, 24) }, onclick },
    h('div.product__img' + (m.photo ? '' : '.ph'), { style: m.photo ? null : placeholderStyle(m.categoryId) }, m.photo ? h('img', { src: `/media/item/${m.id}`, alt: '', loading: 'lazy' }) : icon('box', 'lg'), addBtn),
    tag(m.status === 'out' ? 'Out' : m.status === 'low' ? 'Low' : num(m.qty) + ' ' + m.unit, m.status === 'out' ? 'out' : m.status === 'low' ? 'low' : 'ok plain'),
    h('div.product__name', { title: m.label }, m.label), h('div.product__meta', h('span.product__sku', m.sku), h('span.product__cat', m.category)),
    showPrice ? h('div.product__price', m.hasPrice ? [m.promo && m.promo.type !== 'bundle' ? h('s', peso(m.price)) : null, peso(m.promo?.type === 'bundle' ? m.price : m.effective), m.promo ? h('span.promo-badge', m.promo.label) : null] : h('span.small.muted', 'Price pending')) : h('div.product__meta', h('span', `Low ${num(m.low)} · High ${num(m.high)}`)),
    null);
  return card;
}

// ---- Material detail ---------------------------------------------------
export async function materialDetail(ctx) {
  const { el, params, user } = ctx;
  el.append(skeleton(2));
  const m = await api.get('material', { id: params[0] });
  clear(el);
  const isAdmin = user.role === 'admin';
  const actions = h('div.page__actions');
  if (canStock(user)) actions.append(h('button.btn', { onclick: () => stockForm('in', ctx, m) }, icon('download', 'sm'), 'Stock In'), h('button.btn', { onclick: () => stockForm('out', ctx, m) }, icon('upload', 'sm'), 'Stock Out'), h('button.btn', { onclick: () => countForm(ctx, m) }, icon('clipboard', 'sm'), 'Count'), h('button.btn', { onclick: () => materialForm(m, ctx) }, icon('edit', 'sm'), 'Edit'));
  if (isAdmin) actions.append(h('button.btn.primary', { onclick: () => priceForm(m, ctx) }, icon('tag', 'sm'), m.hasPrice ? 'Price & promo' : 'Set price'));
  if (canSell(user) && m.hasPrice) actions.append(h('button.btn.soft', { onclick: () => go('pos?add=' + m.id) }, icon('cart', 'sm'), 'Sell'));
  el.append(h('div.page__head', h('div', h('a.small', { href: '#/' + (canStock(user) ? 'inventory' : 'materials') }, '← Back to materials'), h('h1', m.label), h('p.muted', `${m.sku} · ${m.category}`)), actions));
  const qtyEl = h('div.kpi__value', '0'); requestAnimationFrame(() => countUp(qtyEl, m.qty, { format: v => num(v) + ' ' + m.unit }));
  const pct = Math.min(100, m.qty / (m.high || 1) * 100); const bar = h('i.' + (m.status === 'out' || m.status === 'low' ? 'danger' : m.status === 'high' ? '' : 'info')); setTimeout(() => bar.style.width = pct + '%', 100);
  el.append(h('div.grid.three.stagger',
    h('div.card', h('div.row', { style: { gap: '16px' } }, h('div.product__img', { style: { width: '120px', aspectRatio: '1', flex: 'none' } }, m.photo ? h('img', { src: `/media/item/${m.id}` }) : icon('box', 'lg')), h('div.grow', h('div.kpi__label', 'On hand'), qtyEl, h('div', { style: { marginTop: '8px' } }, tag(statusName(m.status), m.status)), h('div.bar', { style: { marginTop: '10px' } }, bar), h('p.small.muted', { style: { marginTop: '6px' } }, `Low ${num(m.low)} · High ${num(m.high)} ${m.unit}`)))),
    canSell(user) ? h('div.card', h('div.kpi__label', h('span.ic', icon('tag', 'sm')), 'Regular selling price'), h('div.kpi__value', m.hasPrice ? peso(m.price) : 'Pending'), m.promo ? h('p.small', h('span.promo-badge', m.promo.label), m.promo.type !== 'bundle' ? h('span.muted', ` → ${peso(m.effective)} per ${m.unit}`) : null) : h('p.small.muted', m.hasPrice ? 'No promo' : 'Admin needs to set a price'), m.sold30 !== undefined ? h('p.small', { style: { marginTop: '10px' } }, h('b', qtyText(m.sold30, m.unit)), h('span.muted', ' sold in the last 30 days')) : null) : h('div.card', h('div.kpi__label', 'Unit'), h('div.kpi__value', m.unit), h('p.small.muted', m.decimal ? 'Decimal quantities allowed' : 'Whole units only')),
    h('div.card', h('div.kpi__label', h('span.ic', icon('history', 'sm')), 'Recent counts'), m.counts.length ? h('div.list', ...m.counts.slice(0, 3).map(c => h('div.list__item', h('span.body', h('b', `Counted ${num(c.counted)} · system ${num(c.expected)}`), h('span', `${c.actor} · ${ago(c.created)}`)), tag(c.status, c.status === 'Approved' ? 'Approved' : c.status === 'Declined' ? 'Declined' : 'pending')))) : h('p.small.muted', { style: { marginTop: '8px' } }, 'No physical counts yet'))));
  if (isAdmin && m.cost) el.append(h('div.grid.three.stagger', { style: { marginTop: '14px' } },
    h('div.card', h('div.kpi__label', h('span.ic', icon('coins', 'sm')), 'Purchase cost (Admin only)'), h('div.kpi__value', m.cost.lastCost === null ? 'Cost unavailable' : peso(m.cost.lastCost)), h('p.small.muted', m.cost.averageCost !== null ? `Average of stock on hand ${peso(m.cost.averageCost)} · stock value ${m.cost.stockValue === null ? 'cost unavailable' : peso(m.cost.stockValue)}` : 'No costed stock yet'), m.cost.pendingQty > 0 ? h('div', { style: { marginTop: '10px' } }, tag(`${num(m.cost.pendingQty)} ${m.unit} without cost`, 'warn'), ' ', h('button.btn.sm', { onclick: () => openingCostForm(m, ctx) }, 'Enter opening cost')) : null),
    h('div.card', { style: { gridColumn: 'span 2' } }, h('div.card__head', h('h2', 'Purchase cost history')), m.purchaseHistory?.length ? h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Delivered'), h('th', 'Supplier'), h('th.right', 'Qty'), h('th.right', 'Unit cost'), h('th.right', 'Left in lot'), h('th', 'Reference'))), h('tbody', ...m.purchaseHistory.map(p => h('tr', h('td', dateText(p.delivered)), h('td', p.supplier || '—'), h('td.num', `${num(p.qty)} ${m.unit}`), h('td.num', p.unitCost === null ? tag('Cost unavailable', 'warn plain') : peso(p.unitCost)), h('td.num.small.muted', num(p.remaining)), h('td.small', p.reference)))))) : empty('No deliveries recorded', 'truck'))));
  const movementRows = m.movements.map(v => h('tr', h('td', h('b', v.kind), v.saleId ? h('a.small', { href: '#/sales/' + v.saleId }, ' #' + v.saleId) : null, h('div.small.muted', v.reference + (v.supplier ? ' · ' + v.supplier : ''))), h('td.num', h('b', { style: { color: v.delta < 0 ? 'var(--danger)' : 'var(--primary)' } }, (v.delta > 0 ? '+' : '') + num(v.delta))), h('td.num.small.muted', `${num(v.before)} → ${num(v.after)}`), h('td.small', v.actor), h('td.small.muted', dateTime(v.created))));
  el.append(h('div.grid.main.stagger', { style: { marginTop: '14px' } },
    h('div.card.pad-0', h('div.card__head', { style: { padding: '18px 18px 0' } }, h('h2', 'Movement history'), h('span.sub', `${m.movements.length} entries`)), h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Movement'), h('th.right', 'Change'), h('th.right', 'Before → After'), h('th', 'By'), h('th', 'When'))), h('tbody', ...(movementRows.length ? movementRows : [h('tr', h('td', { colSpan: 5 }, empty('No movements recorded', 'history')))]))))),
    isAdmin ? h('div.card', h('div.card__head', h('h2', 'Price history')), m.priceHistory?.length ? h('div.timeline', ...m.priceHistory.map(p => h('div.timeline__item', h('span.pt.info'), h('div', h('b', `${p.oldPrice === null ? 'Pending' : peso(p.oldPrice)} → ${peso(p.newPrice)}`), h('div.small.muted', `${p.newDiscount}% discount · ${p.actor} · ${dateTime(p.created)}`))))) : empty('No price changes yet', 'tag')) : null));
}

// ---- Forms --------------------------------------------------------------
const materialPicker = (boot, materials, props = {}) => select([{ value: '', label: 'Choose a material…' }, ...materials.map(m => ({ value: m.id, label: `${m.label} · ${m.sku} (${num(m.qty)} ${m.unit})` }))], props);
async function loadMaterials() { return (await api.get('materials')).items; }

export function materialForm(existing, ctx) {
  const { boot } = ctx; let photoData;
  const cats = boot.categories.filter(c => !c.archived);
  const knownUnits = boot.units || [];
  const unitOptions = knownUnits.map(u => ({ value: u, label: u }));
  if (existing?.unit && !knownUnits.includes(existing.unit)) unitOptions.push({ value: existing.unit, label: `${existing.unit} · custom` });
  unitOptions.push({ value: '__custom__', label: 'Other · add a unit' });
  const unitSelect = select(unitOptions, { name: 'unit', value: existing?.unit || 'pcs' });
  const customUnit = input({ maxlength: 24, placeholder: 'e.g. lengths, bundles, sheets' });
  const customUnitField = h('div.span.hide', field('Specify unit', customUnit, 'Use a short unit name; custom units use whole-number quantities.'));
  const updateUnitField = () => { const show = unitSelect.value === '__custom__'; customUnitField.classList.toggle('hide', !show); customUnit.required = show; if (!show) { customUnit.value = ''; customUnit.classList.remove('err'); } };
  unitSelect.onchange = updateUnitField;
  const f = {
    sku: input({ name: 'sku', value: existing?.sku || '', placeholder: 'e.g. ELT-001', style: { textTransform: 'uppercase' } }),
    name: input({ name: 'name', value: existing?.name || '', placeholder: 'e.g. Electrical Tape' }),
    variant: input({ name: 'variant', value: existing?.variant || '', placeholder: 'Size / variant (optional)' }),
    unit: unitSelect,
    category: select([{ value: '', label: 'Choose category…' }, ...cats.map(c => ({ value: c.id, label: c.name }))], { name: 'categoryId', value: existing?.categoryId || '' }),
    low: input({ name: 'low', type: 'number', min: 0, step: 'any', value: existing?.low ?? '', placeholder: '0' }),
    high: input({ name: 'high', type: 'number', min: 0, step: 'any', value: existing?.high ?? '', placeholder: '0' }),
    opening: input({ name: 'opening', type: 'number', min: 0, step: 'any', placeholder: '0' }),
  };
  // + Add Category inside the form: the new category is created and selected without losing what was typed.
  const newCat = input({ placeholder: 'New category name', maxlength: 60 }), catMsg = h('p.small');
  const addCat = async () => {
    catMsg.textContent = '';
    const name = newCat.value.trim().replace(/\s+/g, ' ');
    if (!name) { catMsg.textContent = 'Enter a category name.'; return; }
    if (boot.categories.some(c => c.name.trim().toLowerCase() === name.toLowerCase())) { catMsg.textContent = 'This category already exists.'; return; }
    try {
      const r = await api.action('category.add', { name });
      boot.categories.push({ id: r.id, name, archived: false });
      f.category.append(h('option', { value: r.id }, name)); f.category.value = String(r.id);
      newCat.value = ''; addCatRow.classList.add('hide'); toast(`Category “${name}” added and selected`, 'ok');
    } catch (err) { catMsg.textContent = errorOf(err); }
  };
  newCat.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addCat(); } };
  const addCatRow = h('div.span.hide', h('div.row', { style: { gap: '8px' } }, newCat, h('button.btn.sm.primary', { type: 'button', style: { flex: 'none' }, onclick: addCat }, 'Save category')), catMsg);
  const body = h('div.form.two',
    field('SKU', f.sku), field('Unit', f.unit), customUnitField, h('div.span', field('Material name', f.name)), h('div.span', field('Variant', f.variant)),
    h('div.span', field('Category', h('div.row', { style: { gap: '8px' } }, f.category, h('button.btn.sm.soft', { type: 'button', style: { flex: 'none' }, onclick: () => addCatRow.classList.toggle('hide') }, icon('plus', 'sm'), 'Add Category')), 'Required for new materials'), addCatRow), field('Low threshold', f.low, 'Below this = Low stock'), field('High threshold', f.high, 'At or above = High stock'),
    existing ? null : h('div.span', field('Opening stock', f.opening, 'Optional. Recorded as an Opening stock movement.')),
    h('div.span', photoPicker({ current: existing?.photo ? `/media/item/${existing.id}` : null, onPick: d => photoData = d, label: 'Item photo' })));
  modal({ title: existing ? 'Edit material' : 'Add material', subtitle: existing ? existing.label : 'New items start with a pending price until Admin sets one.', body,
    foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => {
      showError(body, '');
      try {
        if (f.unit.value === '__custom__' && !customUnit.value.trim()) { customUnit.classList.add('err'); customUnit.focus(); showError(body, 'Enter the custom unit name.'); return; }
        const r = await api.action('material.save', { id: existing?.id, sku: f.sku.value, name: f.name.value, variant: f.variant.value, unit: f.unit.value === '__custom__' ? customUnit.value.trim() : f.unit.value, categoryId: f.category.value, low: f.low.value, high: f.high.value, opening: f.opening.value, photo: photoData });
        toast(existing ? 'Material updated' : 'Material added', 'ok'); close(); ctx.refresh ? ctx.refresh() : go('materials/' + r.id);
      } catch (err) { showError(body, errorOf(err)); }
    }) }, existing ? 'Save changes' : 'Add material') });
  updateUnitField();
}

export async function stockForm(kind, ctx, preset) {
  const { boot } = ctx;
  const materials = await loadMaterials();
  const pick = materialPicker(boot, materials, { value: preset?.id || '' });
  const qty = input({ type: 'number', min: 0, step: 'any', placeholder: '0', class: 'big' });
  const supplier = select([{ value: '', label: 'Choose supplier…' }, ...boot.suppliers.map(s => ({ value: s.id, label: s.name }))]);
  const reference = input({ placeholder: kind === 'in' ? 'Delivery receipt / reference no.' : 'e.g. Damaged, Returned to supplier' });
  const unitCost = input({ type: 'number', min: 0, step: '0.01', placeholder: '0.00', inputmode: 'decimal' });
  const delivered = input({ type: 'date', value: todayPH(), max: todayPH() });
  const costTotal = h('span.small.muted');
  const preview = h('p.small.muted');
  const updatePreview = () => { const m = materials.find(x => String(x.id) === pick.value); const q = Number(qty.value || 0); if (!m) return preview.textContent = ''; const after = kind === 'in' ? m.qty + q : m.qty - q; preview.textContent = `${num(m.qty)} → ${num(after)} ${m.unit}${after < 0 ? ' · not enough stock' : ''}`; preview.style.color = after < 0 ? 'var(--danger)' : ''; };
  const updCost = () => { const q = Number(qty.value || 0), c = Number(unitCost.value || 0); costTotal.textContent = q && c ? `Total delivery cost ${peso(Math.round(q * c * 100) / 100)}` : 'Purchase cost per unit from the supplier invoice (kept private from the Sales Clerk)'; };
  pick.onchange = updatePreview; qty.oninput = () => { updatePreview(); updCost(); }; unitCost.oninput = updCost; updatePreview(); updCost();
  const body = h('div.form', field('Material', pick), field('Quantity', qty, preview), kind === 'in' ? h('div.form.two', field('Unit purchase cost (₱)', unitCost, costTotal), field('Delivery date', delivered)) : null, kind === 'in' ? field('Supplier', supplier, boot.suppliers.length ? '' : 'Add a supplier first under Inventory › Suppliers') : null, field(kind === 'in' ? 'Delivery reference' : 'Reason', reference));
  modal({ title: kind === 'in' ? 'Stock In' : 'Stock Out', subtitle: kind === 'in' ? 'Receive a supplier delivery' : 'Release stock for damage, returns or internal use', body,
    foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => {
      showError(body, '');
      try {
        const r = await api.action(kind === 'in' ? 'stock.in' : 'stock.out', { materialId: pick.value, qty: qty.value, supplierId: supplier.value, reference: reference.value, reason: reference.value, unitCost: kind === 'in' ? unitCost.value : undefined, delivered: kind === 'in' ? delivered.value : undefined }, { offlineOk: true });
        toast(r.queued ? 'Saved offline' : `${kind === 'in' ? 'Stock In' : 'Stock Out'} recorded · ${num(r.before)} → ${num(r.after)}`, 'ok'); close(); ctx.refresh?.();
      } catch (err) { showError(body, errorOf(err)); }
    }) }, kind === 'in' ? 'Receive stock' : 'Release stock') });
}
export async function countForm(ctx, preset) {
  const { boot } = ctx;
  const materials = await loadMaterials();
  const pick = materialPicker(boot, materials, { value: preset?.id || '' });
  const counted = input({ type: 'number', min: 0, step: 'any', placeholder: '0', class: 'big' });
  const note = input({ placeholder: 'Notes (optional)' });
  const preview = h('p.small.muted');
  const upd = () => { const m = materials.find(x => String(x.id) === pick.value); if (!m || counted.value === '') return preview.textContent = ''; const d = Number(counted.value) - m.qty; preview.textContent = `System shows ${num(m.qty)} ${m.unit} · difference ${d > 0 ? '+' : ''}${num(d)}`; };
  pick.onchange = upd; counted.oninput = upd;
  const body = h('div.form', field('Material', pick), field('Physical count', counted, preview), field('Notes', note));
  modal({ title: 'Submit physical count', subtitle: 'Admin reviews the count before the balance changes.', body,
    foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { const r = await api.action('count.submit', { materialId: pick.value, counted: counted.value, note: note.value }, { offlineOk: true }); toast(r.queued ? 'Saved offline' : 'Count submitted for review', 'ok'); close(); ctx.refresh?.(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Submit for review') });
}
export function priceForm(m, ctx) {
  const price = input({ type: 'number', min: 0, step: '0.01', value: m.price ?? '', class: 'big' });
  const type = select([{ value: 'none', label: 'No promo' }, { value: 'bundle', label: 'Bundle price (e.g. 5 for ₱50)' }, { value: 'percent', label: 'Percentage discount' }, { value: 'fixed', label: 'Fixed promo price per unit' }], { value: m.promo?.type || 'none' });
  const qty = input({ type: 'number', min: 2, step: 1, value: m.promo?.qty ?? 5, placeholder: '5' });
  const value = input({ type: 'number', min: 0, step: '0.01', value: m.promo ? m.promo.value : '', placeholder: '0.00' });
  const qtyField = field('Bundle quantity', qty, 'Whole number, at least 2'), valueField = field('Promo value', value);
  const preview = h('div.receipt');
  const upd = () => {
    const p = Number(price.value || 0), t = type.value;
    preview.append = (...n) => Element.prototype.append.apply(preview, n.filter(x => x !== null && x !== undefined && x !== false));
    qtyField.style.display = t === 'bundle' ? '' : 'none'; valueField.style.display = t === 'none' ? 'none' : '';
    valueField.querySelector('label').textContent = t === 'bundle' ? 'Total bundle price (₱)' : t === 'percent' ? 'Discount (%)' : 'Promo price per unit (₱)';
    clear(preview);
    if (!p) return preview.append(h('div.r', h('span.muted', 'Enter a regular price to preview')));
    const sampleQty = t === 'bundle' ? Math.max(2, Number(qty.value || 2)) : 1;
    const probe = { price: p, promo: t === 'none' ? null : { type: t, qty: Number(qty.value || 2), value: Number(value.value || 0) } };
    const l = priceLine(probe, sampleQty);
    preview.append(h('div.r', h('span', `Regular total for ${sampleQty} ${m.unit}`), h('span', peso(l.regular))), h('div.r', h('span', 'Savings'), h('span', { style: { color: 'var(--primary)' } }, '− ' + peso(l.savings))), h('hr'), h('div.r', h('b', 'Final price'), h('b', peso(l.final))), t !== 'none' && l.savings <= 0 ? h('div.r', h('span', { style: { color: 'var(--danger)' } }, 'The promo must be below the regular price')) : null);
  };
  price.oninput = upd; type.onchange = upd; qty.oninput = upd; value.oninput = upd; upd();
  const body = h('div.form', field('Regular selling price (₱)', price, 'Separate from purchase cost'), field('Promo', type, 'One active promo per item; shown as a badge in the POS'), qtyField, valueField, preview);
  modal({ title: 'Price & promo', subtitle: m.label, body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('material.price', { id: m.id, price: price.value, promoType: type.value, promoQty: qty.value, promoValue: type.value === 'none' ? undefined : value.value }); toast('Price saved', 'ok'); close(); ctx.refresh?.(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Save price') });
}
export function openingCostForm(m, ctx) {
  const cost = input({ type: 'number', min: 0, step: '0.01', class: 'big', placeholder: '0.00' });
  const body = h('div.form', h('p.muted', `${num(m.cost.pendingQty)} ${m.unit} on hand have no recorded purchase cost. Enter the cost per ${m.unit} paid for that stock so profit can be computed.`), field(`Opening cost per ${m.unit} (₱)`, cost));
  modal({ title: 'Enter opening cost', subtitle: m.label, body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('material.openingCost', { id: m.id, unitCost: cost.value }); toast('Opening cost saved', 'ok'); close(); ctx.refresh?.(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Save cost') });
}
export function supplierForm(existing, ctx) {
  const name = input({ value: existing?.name || '', placeholder: 'Supplier name' }), contact = input({ value: existing?.contact || '', placeholder: 'Phone / contact person' }), address = input({ value: existing?.address || '', placeholder: 'Address' });
  const body = h('div.form', field('Name', name), field('Contact', contact), field('Address', address));
  modal({ title: existing ? 'Edit supplier' : 'Add supplier', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('supplier.save', { id: existing?.id, name: name.value, contact: contact.value, address: address.value }); toast('Supplier saved', 'ok'); close(); await reloadBoot(); ctx.refresh?.(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Save') });
}
export function categoryForm(existing, ctx) {
  const name = input({ value: existing?.name || '', placeholder: 'Category name' });
  const body = h('div.form', field('Name', name));
  modal({ title: existing ? 'Rename category' : 'Add category', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action(existing ? 'category.update' : 'category.add', { id: existing?.id, name: name.value }); toast('Category saved', 'ok'); close(); await reloadBoot(); ctx.refresh?.(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Save') });
}

// ---- Tabs --------------------------------------------------------------
async function countsTab(box, ctx) {
  box.append(skeleton(1));
  const counts = await api.get('counts'); clear(box);
  const isAdmin = ctx.user.role === 'admin';
  const pending = counts.filter(c => c.status === 'Pending Approval'), done = counts.filter(c => c.status !== 'Pending Approval');
  const review = async (c, decision) => { const note = decision === 'Declined' ? await confirm({ title: 'Decline count', message: `Decline the count for ${c.material}?`, okText: 'Decline', danger: true, requireReason: true }) : await confirm({ title: 'Approve count', message: `Adjust ${c.material} from ${num(c.expected)} to ${num(c.counted)} ${c.unit}?`, okText: 'Approve' }); if (note === null) return; try { await api.action('count.review', { id: c.id, decision, note: typeof note === 'string' ? note : '' }); toast(`Count ${decision.toLowerCase()}`, 'ok'); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); } };
  const row = c => h('div.list__item', h('span.ic.' + (c.status === 'Pending Approval' ? 'warn' : c.status === 'Approved' ? 'ok' : 'danger'), icon('clipboard')),
    h('span.body', h('b', c.material), h('span', `Counted ${num(c.counted)} · system ${num(c.expected)} ${c.unit} · diff ${c.difference > 0 ? '+' : ''}${num(c.difference)} · ${c.actor} · ${ago(c.created)}${c.note ? ' · ' + c.note : ''}`), c.stale ? h('span', { style: { color: 'var(--danger)' } }, 'Stock moved since this count — ask for a fresh count') : null, c.reviewer ? h('span', `${c.status} by ${c.reviewer}${c.reviewNote ? ' · ' + c.reviewNote : ''}`) : null),
    c.status === 'Pending Approval' && isAdmin ? h('div.row', h('button.btn.sm.danger', { onclick: () => review(c, 'Declined') }, 'Decline'), h('button.btn.sm.primary', { disabled: c.stale, onclick: () => review(c, 'Approved') }, 'Approve')) : tag(c.status, c.status === 'Approved' ? 'Approved' : c.status === 'Declined' ? 'Declined' : 'pending'));
  box.append(h('div.grid.two.stagger', h('div.card', h('div.card__head', h('h2', 'Waiting for review'), h('span.badge', { style: { background: pending.length ? 'var(--warn)' : 'var(--line-2)' } }, pending.length)), pending.length ? h('div.list', ...pending.map(row)) : empty('No pending counts', 'check')),
    h('div.card', h('div.card__head', h('h2', 'Reviewed')), done.length ? h('div.list', ...done.slice(0, 40).map(row)) : empty('No reviewed counts yet', 'clipboard'))));
}
async function suppliersTab(box, ctx) {
  box.append(skeleton(1));
  const list = await api.get('suppliers'); clear(box);
  if (!list.length) return box.append(h('div.card', empty('No suppliers yet. Add one to receive deliveries.', 'truck')));
  box.append(h('div.grid.three.stagger', ...list.map(s => h('div.card.kpi.click', { onclick: () => supplierDetail(s, ctx) }, h('div.row', h('span.ic', { style: { width: '40px', height: '40px', borderRadius: '12px', display: 'grid', placeItems: 'center', background: 'var(--primary-soft)', color: 'var(--primary)' } }, icon('truck')), h('div.grow', h('b', s.name), h('p.small.muted', s.contact || 'No contact')), h('button.btn.icon.sm.ghost', { onclick: e => { e.stopPropagation(); supplierForm(s, ctx); } }, icon('edit', 'sm'))), h('div.row.between.small.muted', { style: { marginTop: '12px' } }, h('span', `${s.deliveries} deliver${s.deliveries === 1 ? 'y' : 'ies'}`), h('span', s.lastDelivery ? 'Last ' + ago(s.lastDelivery) : '—'))))));
}
async function supplierDetail(s, ctx) {
  const d = await api.get('supplier', { id: s.id });
  modal({ title: s.name, subtitle: [s.contact, s.address].filter(Boolean).join(' · ') || 'Delivery history', size: 'wide', body: d.deliveries.length ? h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Material'), h('th.right', 'Qty'), h('th', 'Reference'), h('th', 'By'), h('th', 'When'))), h('tbody', ...d.deliveries.map(v => h('tr.click', { onclick: () => go('materials/' + v.materialId) }, h('td', h('b', v.material)), h('td.num', `+${num(v.qty)} ${v.unit}`), h('td.small', v.reference), h('td.small', v.actor), h('td.small.muted', dateTime(v.created))))))) : empty('No deliveries recorded yet', 'truck') });
}
async function movementsTab(box, ctx) {
  let kind = 'all';
  const list = h('div');
  const seg = segmented([{ value: 'all', label: 'All' }, { value: 'Stock In', label: 'Stock In' }, { value: 'Stock Out', label: 'Stock Out' }, { value: 'Sale', label: 'Sales' }, { value: 'Count adjustment', label: 'Adjustments' }], kind, v => { kind = v; load(); }, { small: true });
  const from = input({ type: 'date', value: todayPH().slice(0, 8) + '01', onchange: () => load() }), to = input({ type: 'date', value: todayPH(), onchange: () => load() });
  box.append(h('div.card', { style: { marginBottom: '14px' } }, h('div.row.wrap', seg, h('span.grow'), h('div.row', from, h('span.muted', '→'), to))), list);
  const load = async () => {
    clear(list).append(skeleton(1));
    const rows = await api.get('movements', { kind, from: from.value, to: to.value }); clear(list);
    if (!rows.length) return list.append(h('div.card', empty('No movements in this range', 'history')));
    list.append(h('div.card.pad-0', h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Material'), h('th', 'Movement'), h('th.right', 'Change'), h('th.right', 'Before → After'), h('th', 'By'), h('th', 'When'))), h('tbody.stagger', ...rows.map((v, i) => h('tr.click', { style: { '--i': Math.min(i, 20) }, onclick: () => go('materials/' + v.materialId) }, h('td', h('b', v.material)), h('td', h('span', v.kind), h('div.small.muted', v.reference + (v.supplier ? ' · ' + v.supplier : ''))), h('td.num', h('b', { style: { color: v.delta < 0 ? 'var(--danger)' : 'var(--primary)' } }, (v.delta > 0 ? '+' : '') + num(v.delta) + ' ' + v.unit)), h('td.num.small.muted', `${num(v.before)} → ${num(v.after)}`), h('td.small', v.actor), h('td.small.muted', dateTime(v.created)))))))));
  };
  load();
}
async function categoriesTab(box, ctx) {
  const d = await api.get('materials'); const counts = {}; for (const m of d.items) counts[m.categoryId] = (counts[m.categoryId] || 0) + 1;
  const activeCount = {}; for (const m of d.items) if (!m.archived) activeCount[m.categoryId] = (activeCount[m.categoryId] || 0) + 1;
  const isAdminUser = ctx.user.role === 'admin';
  const toggle = async c => {
    if (c.archived) { try { await api.action('category.update', { id: c.id, archived: false }); toast('Category restored', 'ok'); await reloadBoot(); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); } return; }
    const n = activeCount[c.id] || 0;
    const target = select(state.boot.categories.filter(x => !x.archived && x.id !== c.id).map(x => ({ value: x.id, label: x.name })));
    const body = h('div.form', h('p', n ? `${n} active material${n === 1 ? '' : 's'} must move to another category first. Sales and stock history stay as they are.` : 'No active materials use this category.'), n ? field('Move active materials to', target) : null);
    modal({ title: `Archive “${c.name}”?`, size: 'narrow', body, foot: close => h('button.btn.danger', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('category.update', { id: c.id, archived: true, reassignTo: n ? target.value : undefined }); toast(n ? 'Materials moved · category archived' : 'Category archived', 'ok'); close(); await reloadBoot(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, n ? 'Move & archive' : 'Archive') });
  };
  box.append(h('div.card', h('div.list', ...state.boot.categories.map(c => h('div.list__item', h('span.ic', icon('layers')), h('span.body', h('b', c.name), h('span', `${counts[c.id] || 0} material${counts[c.id] === 1 ? '' : 's'}${c.archived ? ' · archived' : ''}`)), h('div.row', h('button.btn.sm.ghost', { onclick: () => categoryForm(c, ctx) }, 'Rename'), c.name === 'Uncategorized' || !isAdminUser ? null : h('button.btn.sm' + (c.archived ? '.soft' : '.ghost'), { onclick: () => toggle(c) }, c.archived ? 'Restore' : 'Archive')))))));
}
