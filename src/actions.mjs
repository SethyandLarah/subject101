// Every write to the database goes through one of these actions.
// Each action is run inside one SQLite transaction by the server, receives the
// signed-in user and the request body, and returns a small JSON result.
import { hashPassword, checkPassword, dayOf, nowISO, timeOf, shiftDay, EXPENSE_CATEGORIES, ROLES, ATTENDANCE_TITLES } from './db.mjs';
import { validatePromo, priceLine, promoText, allocateTawad } from './pricing.mjs';
import { createCosting } from './costing.mjs';
import { createAutoClose, CLOSES } from './autoclose.mjs';
export const AUTO_CLOSE = Symbol('autoClose');
import { createPayroll, TAPS, TAP_LABELS, allowedTaps } from './payroll.mjs';
import {
  HttpError, need, fail, isAdmin, canSell, canStock, canOrder, canCash, text, optional, int, id, money, quantity, unit, date, clock,
  username, password, photo, pngIcon, occurredAt, effectivePrice, lineTotal, units, pesos,
} from './common.mjs';

function tender(body) {
  const method = body.paymentMethod ?? 'Cash';
  need(['Cash', 'GCash', 'Maya', 'Bank transfer', 'Other'].includes(method), 'Choose a valid payment method.');
  return method === 'Other' ? text(body.paymentOther, 'Other payment method', 60) : method;
}

export function createActions(db) {
  const sql = s => db.prepare(s);
  const material = mid => { const m = sql('SELECT * FROM materials WHERE id=?').get(id(mid)); need(m, 'Material not found.', 404); return m; };
  const user = uid => { const u = sql('SELECT * FROM users WHERE id=?').get(id(uid)); need(u, 'Staff account not found.', 404); return u; };
  const customer = cid => { const c = sql('SELECT * FROM customers WHERE id=?').get(id(cid)); need(c, 'Customer not found.', 404); return c; };
  const label = m => m.name + (m.variant ? ' · ' + m.variant : '');
  const notify = (actor, kind, title, detail = '', link = '', recipient = null) =>
    sql('INSERT INTO notifications(actor,recipient,kind,title,detail,link,created) VALUES (?,?,?,?,?,?,?)').run(actor.id, recipient, kind, title, detail, link, nowISO());
  const audit = (actor, action, detail) => sql('INSERT INTO audit(actor,action,detail,created) VALUES (?,?,?,?)').run(actor.id, action, detail, nowISO());
  const revision = mid => sql('SELECT coalesce(max(id),0) AS rev FROM movements WHERE material_id=?').get(mid).rev;
  const costing = createCosting(db);
  const shiftFor = (t, day) => { const r = sql('SELECT shift_start AS start, shift_end AS end, lunch_start AS lunchStart, lunch_end AS lunchEnd FROM schedules WHERE user_id=? AND effective<=? ORDER BY effective DESC, id DESC LIMIT 1').get(t.id, day); const x = r || { start: t.shift_start, end: t.shift_end, lunchStart: t.lunch_start, lunchEnd: t.lunch_end }; return { start: x.start || '07:30', end: x.end || '17:00', lunchStart: x.lunchStart || '11:30', lunchEnd: x.lunchEnd || '13:00' }; };
  const payroll = createPayroll(db, shiftFor);
  const autoClose = createAutoClose(db, payroll, shiftFor);
  const COVERAGE = { whole: 'Whole Day', morning: 'Morning Only', afternoon: 'Afternoon Only' };
  const PAY_METHODS = ['Cash', 'GCash', 'Maya', 'Bank transfer', 'Other'];
  const balance = cid => {
    const credit = sql('SELECT coalesce(sum(credit_added),0) AS v FROM sales WHERE customer_id=? AND voided=0').get(cid).v;
    const paid = sql('SELECT coalesce(sum(amount),0) AS v FROM payments WHERE customer_id=? AND at_counter=0').get(cid).v;
    return credit - paid;
  };

  // Apply a stock change and write the movement row (before → after).
  // Positive movements create a FIFO lot (unitCost may be null = cost unavailable).
  // Negative movements consume lots unless `consume:false` (a void returns units to their original lots).
  function moveStock(actor, m, delta, kind, reference, { supplierId = null, saleId = null, created = nowISO(), unitCost = null, delivered = null, consume = true } = {}) {
    const after = m.qty + delta;
    need(after >= 0, `Insufficient stock for ${label(m)}. Available: ${units(m.qty)} ${m.unit}.`, 409);
    sql('UPDATE materials SET qty=? WHERE id=?').run(after, m.id);
    const r = sql('INSERT INTO movements(material_id,kind,delta,before_qty,after_qty,supplier_id,sale_id,reference,actor,created,unit_cost,remaining,delivered) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(m.id, kind, delta, m.qty, after, supplierId, saleId, reference, actor.id, created, unitCost, delta > 0 && consume ? delta : 0, delivered);
    let cost = null;
    if (delta < 0 && consume) cost = costing.consume(m.id, -delta, saleId).cost;
    const result = { before: m.qty, after, movementId: Number(r.lastInsertRowid), cost };
    m.qty = after;
    return result;
  }

  const result = {
    // ---- Categories (admin) ---------------------------------------------
    'category.add'(u, b) {
      need(canStock(u), 'Only Admin or Stock Clerk manages categories.', 403);
      const name = text(String(b.name ?? '').replace(/\s+/g, ' '), 'Category name', 60);
      const same = sql('SELECT id, archived FROM categories WHERE lower(trim(name))=lower(?)').get(name);
      need(!same, same?.archived ? 'This category exists but is archived. Ask Admin to restore it.' : 'This category already exists.', 409);
      const r = sql('INSERT INTO categories(name) VALUES (?)').run(name);
      audit(u, 'category.add', name);
      return { id: Number(r.lastInsertRowid) };
    },
    'category.update'(u, b) {
      need(canStock(u), 'Only Admin or Stock Clerk manages categories.', 403);
      const c = sql('SELECT * FROM categories WHERE id=?').get(id(b.id)); need(c, 'Category not found.', 404);
      const name = text(String(b.name ?? c.name).replace(/\s+/g, ' '), 'Category name', 60);
      const other = sql('SELECT id FROM categories WHERE lower(trim(name))=lower(?)').get(name); need(!other || other.id === c.id, 'This category name is taken.', 409);
      const archived = b.archived === undefined ? c.archived : (b.archived ? 1 : 0);
      if (archived !== c.archived) need(isAdmin(u), 'Only Admin archives or restores categories.', 403);
      if (archived && !c.archived) {
        need(c.name !== 'Uncategorized', 'Uncategorized cannot be archived.');
        // Active materials must be moved to another category first (archived materials keep their history).
        const active = sql('SELECT count(*) AS n FROM materials WHERE category_id=? AND archived=0').get(c.id).n;
        if (active) {
          need(b.reassignTo, `Move the ${active} active material${active === 1 ? '' : 's'} to another category first.`, 409);
          const target = sql('SELECT * FROM categories WHERE id=? AND archived=0').get(id(b.reassignTo));
          need(target && target.id !== c.id, 'Choose an active category to move the materials to.');
          sql('UPDATE materials SET category_id=? WHERE category_id=? AND archived=0').run(target.id, c.id);
          audit(u, 'category.reassign', `${active} from ${c.name} → ${target.name}`);
        }
      }
      sql('UPDATE categories SET name=?, archived=? WHERE id=?').run(name, archived, c.id);
      audit(u, 'category.update', `${c.name} → ${name}${archived ? ' (archived)' : ''}`);
      return {};
    },

    // ---- Suppliers --------------------------------------------------------
    'supplier.save'(u, b) {
      need(canStock(u), 'Only Admin or Stock Clerk manages suppliers.', 403);
      const name = text(b.name, 'Supplier name', 100), contact = optional(b.contact, 100), address = optional(b.address, 200);
      const dup = sql('SELECT id FROM suppliers WHERE name=?').get(name);
      if (b.id) {
        const sid = id(b.id); need(!dup || dup.id === sid, 'This supplier already exists.', 409);
        sql('UPDATE suppliers SET name=?, contact=?, address=? WHERE id=?').run(name, contact, address, sid);
        audit(u, 'supplier.update', name); return { id: sid };
      }
      need(!dup, 'This supplier already exists.', 409);
      const r = sql('INSERT INTO suppliers(name,contact,address,created) VALUES (?,?,?,?)').run(name, contact, address, nowISO());
      audit(u, 'supplier.add', name);
      return { id: Number(r.lastInsertRowid) };
    },

    // ---- Materials --------------------------------------------------------
    'material.save'(u, b) {
      need(canStock(u), 'Only Admin or Stock Clerk manages materials.', 403);
      const name = text(b.name, 'Material name', 100), variant = optional(b.variant, 60), un = unit(b.unit);
      const category = sql('SELECT * FROM categories WHERE id=? AND archived=0').get(id(b.categoryId)); need(category, 'Choose a category.');
      const low = quantity(b.low, un), high = quantity(b.high, un);
      need(high > low, 'High threshold must be above the low threshold.');
      const sku = text(b.sku, 'SKU', 40).toUpperCase();
      const dup = sql('SELECT id FROM materials WHERE sku=?').get(sku);
      const pic = b.photo === undefined ? undefined : photo(b.photo);
      if (b.id) {
        const m = material(b.id); need(!dup || dup.id === m.id, 'This SKU is already used.', 409);
        sql('UPDATE materials SET sku=?, name=?, variant=?, unit=?, category_id=?, low=?, high=?, photo=coalesce(?, photo) WHERE id=?')
          .run(sku, name, variant, un, category.id, low, high, pic ?? null, m.id);
        audit(u, 'material.update', `${sku} ${name}`);
        return { id: m.id };
      }
      need(!dup, 'This SKU is already used.', 409);
      const r = sql('INSERT INTO materials(sku,name,variant,unit,category_id,low,high,photo,created) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(sku, name, variant, un, category.id, low, high, pic ?? null, nowISO());
      const mid = Number(r.lastInsertRowid);
      const opening = b.opening === undefined || b.opening === '' ? 0 : quantity(b.opening, un);
      if (opening > 0) moveStock(u, { id: mid, qty: 0, name, variant, unit: un }, opening, 'Opening stock', optional(b.reference) || 'Opening balance');
      notify(u, 'material', 'New material added', `${name}${variant ? ' · ' + variant : ''} · Price pending`, '#/materials/' + mid);
      audit(u, 'material.add', `${sku} ${name}`);
      return { id: mid };
    },
    'material.archive'(u, b) {
      need(isAdmin(u), 'Only Admin archives materials.', 403);
      const m = material(b.id);
      sql('UPDATE materials SET archived=? WHERE id=?').run(b.archived === false ? 0 : 1, m.id);
      audit(u, 'material.archive', label(m));
      return {};
    },
    'material.price'(u, b) {
      need(isAdmin(u), 'Only Admin sets prices and promos.', 403);
      const m = material(b.id), price = money(b.price, 1, 'price');
      // Promo: 'none' | 'bundle' | 'percent' | 'fixed'. Validated against the NEW regular price.
      const promoType = b.promoType === undefined ? (m.promo_type || 'none') : b.promoType;
      const promo = validatePromo({ ...m, price }, { promoType, promoQty: b.promoQty ?? m.promo_qty, promoValue: b.promoValue ?? (m.promo_type && b.promoType === undefined ? (m.promo_type === 'percent' ? m.promo_value : (m.promo_value / 100).toFixed(2)) : undefined) });
      const discount = promo?.type === 'percent' ? promo.value : 0; // legacy column mirrors percent promos
      sql('UPDATE materials SET price=?, discount=?, promo_type=?, promo_qty=?, promo_value=? WHERE id=?').run(price, discount, promo?.type ?? null, promo?.qty ?? null, promo?.value ?? null, m.id);
      sql('INSERT INTO price_history(material_id,old_price,new_price,old_discount,new_discount,actor,created) VALUES (?,?,?,?,?,?,?)')
        .run(m.id, m.price, price, m.discount, discount, u.id, nowISO());
      const after = { ...m, price, promo_type: promo?.type ?? null, promo_qty: promo?.qty ?? null, promo_value: promo?.value ?? null };
      notify(u, 'price', 'Price updated', `${label(m)} · ${m.price === null ? 'Pending' : '₱' + pesos(m.price)} → ₱${pesos(price)}${promo ? ' · ' + promoText(after) : ''}`, '#/materials/' + m.id);
      audit(u, 'material.price', `${label(m)} ${m.price} → ${price}${promo ? ' promo ' + promoText(after) : ' no promo'}`);
      return { promo: promo ? promoText(after) : null };
    },
    'material.openingCost'(u, b) {
      need(isAdmin(u), 'Only Admin enters opening costs.', 403);
      const m = material(b.id), unitCost = money(b.unitCost, 0, 'unit cost');
      const lots = costing.setOpeningCost(m.id, unitCost);
      need(lots > 0, 'This material has no stock waiting for a cost.', 409);
      audit(u, 'material.openingCost', `${label(m)} ₱${pesos(unitCost)} on ${lots} lot(s)`);
      return { lots };
    },

    // ---- Stock in / out / counts -----------------------------------------
    'stock.in'(u, b) {
      need(canStock(u), 'Only Admin or Stock Clerk receives stock.', 403);
      const m = material(b.materialId), q = quantity(b.qty, m.unit, 1);
      const supplier = sql('SELECT * FROM suppliers WHERE id=?').get(id(b.supplierId)); need(supplier, 'Choose a supplier.');
      const reference = text(b.reference, 'Delivery reference', 120);
      const unitCost = money(b.unitCost, 0, 'unit purchase cost');
      const delivered = b.delivered ? date(b.delivered) : dayOf();
      need(delivered <= dayOf(), 'Delivery date cannot be in the future.');
      const r = moveStock(u, m, q, 'Stock In', reference, { supplierId: supplier.id, created: occurredAt(b.occurred).toISOString(), unitCost, delivered });
      notify(u, 'stock', 'Stock In received', `${label(m)} · ${units(r.before)} → ${units(r.after)} ${m.unit} · ${supplier.name}`, '#/materials/' + m.id);
      audit(u, 'stock.in', `${label(m)} +${units(q)} @ ₱${pesos(unitCost)} · ${supplier.name} · ${reference}`);
      return { before: units(r.before), after: units(r.after) };
    },
    'stock.out'(u, b) {
      need(canStock(u), 'Only Admin or Stock Clerk releases stock.', 403);
      const m = material(b.materialId), q = quantity(b.qty, m.unit, 1);
      const reason = text(b.reason, 'Reason', 120);
      const r = moveStock(u, m, -q, 'Stock Out', reason, { created: occurredAt(b.occurred).toISOString() });
      notify(u, 'stock', 'Stock Out recorded', `${label(m)} · ${units(r.before)} → ${units(r.after)} ${m.unit} · ${reason}`, '#/materials/' + m.id);
      return { before: units(r.before), after: units(r.after) };
    },
    'count.submit'(u, b) {
      need(canStock(u), 'Only Admin or Stock Clerk submits counts.', 403);
      const m = material(b.materialId), counted = quantity(b.counted, m.unit), rev = revision(m.id);
      need(!sql("SELECT 1 FROM counts WHERE material_id=? AND status='Pending Approval'").get(m.id), 'A count for this material is already waiting for review.', 409);
      const r = sql('INSERT INTO counts(material_id,expected,counted,revision,note,actor,created) VALUES (?,?,?,?,?,?,?)')
        .run(m.id, m.qty, counted, rev, optional(b.note, 200), u.id, nowISO());
      notify(u, 'count', 'Physical count needs review', `${label(m)} · system ${units(m.qty)} · counted ${units(counted)} ${m.unit}`, '#/inventory/counts');
      return { id: Number(r.lastInsertRowid), difference: units(counted - m.qty) };
    },
    'count.review'(u, b) {
      need(isAdmin(u), 'Only Admin reviews counts.', 403);
      const c = sql('SELECT * FROM counts WHERE id=?').get(id(b.id));
      need(c && c.status === 'Pending Approval', 'This count was already reviewed.', 409);
      const approve = b.decision === 'Approved'; need(approve || b.decision === 'Declined', 'Choose Approve or Decline.');
      const m = material(c.material_id);
      if (approve) {
        need(revision(m.id) === c.revision, 'Stock moved since this count was taken. Ask for a fresh count.', 409);
        if (c.counted !== m.qty) moveStock(u, m, c.counted - m.qty, 'Count adjustment', `Approved count #${c.id}`);
      }
      sql('UPDATE counts SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?').run(b.decision, u.id, nowISO(), optional(b.note, 200), c.id);
      notify(u, 'count', `Count ${b.decision.toLowerCase()}`, `${label(m)} · counted ${units(c.counted)} ${m.unit}`, '#/materials/' + m.id, c.actor);
      audit(u, 'count.review', `#${c.id} ${b.decision}`);
      return {};
    },

    // ---- Customers & Utang -----------------------------------------------
    'customer.save'(u, b) {
      need(canSell(u), 'Only Admin, Sales Clerk or Cashier manages customers.', 403);
      const name = text(b.name, 'Customer name', 100), phone = optional(b.phone, 30), address = optional(b.address, 200);
      if (b.id) {
        const c = customer(b.id);
        sql('UPDATE customers SET name=?, phone=?, address=? WHERE id=?').run(name, phone, address, c.id);
        audit(u, 'customer.update', name); return { id: c.id };
      }
      const dup = sql('SELECT id,name FROM customers WHERE lower(name)=lower(?) OR (phone<>\'\' AND phone=?)').get(name, phone);
      need(!dup || b.force, `A customer named "${dup?.name}" already exists. Reuse that record or confirm to create another.`, 409);
      const r = sql('INSERT INTO customers(name,phone,address,created) VALUES (?,?,?,?)').run(name, phone, address, nowISO());
      audit(u, 'customer.add', name);
      return { id: Number(r.lastInsertRowid) };
    },
    'payment.record'(u, b) {
      need(canCash(u), 'Only the Cashier or Admin receives payments.', 403);
      const c = customer(b.customerId), amount = money(b.amount, 1, 'payment amount');
      const due = balance(c.id);
      need(due > 0, 'This customer has no outstanding balance.', 409);
      need(amount <= due, `Payment exceeds the remaining balance of ₱${pesos(due).toFixed(2)}.`, 409);
      const day = dayOf(), created = nowISO();
      const method = tender(b);
      const r = sql('INSERT INTO payments(customer_id,sale_id,amount,reference,actor,day,created,payment_method) VALUES (?,?,?,?,?,?,?,?)')
        .run(c.id, null, amount, optional(b.reference, 120), u.id, day, created, method);
      const remaining = due - amount;
      notify(u, 'payment', 'Utang payment received', `${c.name} · ₱${pesos(amount).toFixed(2)} · balance ₱${pesos(remaining).toFixed(2)}${remaining === 0 ? ' · Fully Paid' : ''}`, '#/utang/' + c.id);
      return { id: Number(r.lastInsertRowid), remaining: pesos(remaining), fullyPaid: remaining === 0 };
    },

    // ---- POS checkout -----------------------------------------------------
    // ---- Orders: Sales Clerk prepares, Cashier receives payment ---------------
    'order.create'(u, b) {
      need(canOrder(u), 'Only the Sales Clerk or Admin prepares orders.', 403);
      // Price the order exactly as checkout would (stock, promos, Tawad), then roll the dry run back.
      let quote;
      db.exec('SAVEPOINT quote');
      try { quote = result['sale.checkout']({ ...u, role: 'admin' }, { ...b, ...(b.preparePayment ? {} : { kind: 'cash', cashReceived: '99999999', customerId: undefined, paidNow: undefined, paymentMethod: 'Cash' }) }); }
      finally { db.exec('ROLLBACK TO quote'); db.exec('RELEASE quote'); }
      const tawad = b.pricingMode === 'tawad';
      const customerId = b.customerId ? Number(b.customerId) : null;
      if (customerId) need(sql('SELECT 1 FROM customers WHERE id=?').get(customerId), 'Customer not found.', 404);
      const lines = b.lines.map(l => ({ materialId: Number(l.materialId), qty: l.qty, name: label(material(l.materialId)), unit: material(l.materialId).unit, price: pesos(material(l.materialId).price) }));
      const prepared = b.preparePayment ? JSON.stringify({ kind: b.kind === 'credit' ? 'credit' : 'cash', paymentMethod: quote.paidNow > 0 ? (b.paymentMethod ?? 'Cash') : null, paymentOther: b.paymentMethod === 'Other' ? quote.paymentMethod : undefined, cashReceived: quote.cashReceived, change: quote.change, paidNow: quote.paidNow, creditAdded: quote.creditAdded, reference: optional(b.reference, 120) }) : null;
      const r = sql('INSERT INTO orders(clerk,customer_id,customer_name,note,lines,pricing_mode,tawad_amount,tawad_reason,regular_subtotal,total,created,day,prepared_payment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(u.id, customerId, optional(b.customerName, 80), optional(b.note, 200), JSON.stringify(lines), quote.pricingMode, tawad ? money(b.tawadAmount, 1, 'Tawad amount') : null, tawad ? text(b.tawadReason, 'Tawad reason', 120) : null, money(String(quote.regularSubtotal), 0), money(String(quote.total), 0), nowISO(), dayOf(), prepared);
      const orderId = Number(r.lastInsertRowid);
      for (const c of sql("SELECT id FROM users WHERE role='cashier' AND active=1").all()) notify(u, 'order', `Order #${orderId} waiting for payment`, `${u.name} · ₱${quote.total.toFixed(2)}${tawad ? ' · Tawad' : ''}`, '#/orders/' + orderId, c.id);
      audit(u, 'order.create', `#${orderId} ₱${quote.total}`);
      return { id: orderId, total: quote.total, regularSubtotal: quote.regularSubtotal, savings: quote.savings, pricingMode: quote.pricingMode };
    },
    'order.cancel'(u, b) {
      const o = sql('SELECT * FROM orders WHERE id=?').get(id(b.id)); need(o, 'Order not found.', 404);
      need(u.role === 'cashier' || o.clerk === u.id, 'You can only cancel your own orders.', 403);
      need(o.status === 'waiting', 'This order is already closed.', 409);
      const reason = text(b.reason, 'Reason', 200);
      sql("UPDATE orders SET status='cancelled', cancel_reason=?, cashier=?, closed=? WHERE id=?").run(reason, canCash(u) ? u.id : null, nowISO(), o.id);
      if (o.clerk !== u.id) notify(u, 'order', `Order #${o.id} cancelled`, reason, '#/orders/' + o.id, o.clerk);
      audit(u, 'order.cancel', `#${o.id} · ${reason}`);
      return {};
    },
    'order.return'(u, b) {
      need(u.role === 'cashier', 'Only the Cashier returns orders.', 403);
      const o = sql('SELECT * FROM orders WHERE id=?').get(id(b.id));
      need(o?.status === 'waiting', 'This order is no longer waiting.', 409);
      const reason = text(b.reason, 'Return reason', 200);
      sql("UPDATE orders SET status='cancelled', cancel_reason=?, cashier=?, closed=? WHERE id=?").run('Returned: ' + reason, u.id, nowISO(), o.id);
      notify(u, 'order', 'Order #' + o.id + ' returned for correction', reason, '#/orders/' + o.id, o.clerk);
      audit(u, 'order.return', '#' + o.id + ' · ' + reason);
      return {};
    },
    'order.pay'(u, b) {
      need(u.role === 'cashier', 'Only the Cashier receives payment for orders.', 403);
      const o = sql('SELECT * FROM orders WHERE id=?').get(id(b.id)); need(o, 'Order not found.', 404);
      need(o.status === 'waiting', o.status === 'paid' ? 'This order was already paid.' : 'This order was cancelled.', 409);
      const tawad = o.pricing_mode === 'tawad';
      const prepared = o.prepared_payment ? JSON.parse(o.prepared_payment) : null;
      const details = prepared || b;
      const confirm = !prepared && b.confirmTotal !== undefined ? int(b.confirmTotal, 0, Number.MAX_SAFE_INTEGER) : null;
      const body = { lines: JSON.parse(o.lines), kind: details.kind === 'credit' ? 'credit' : 'cash', cashReceived: details.cashReceived, paidNow: details.paidNow, paymentMethod: details.paymentMethod, paymentOther: details.paymentOther, reference: details.reference,
        customerId: o.customer_id || (!prepared ? b.customerId : undefined),
        ...(tawad ? { pricingMode: 'tawad', tawadAmount: String(o.tawad_amount / 100), tawadReason: o.tawad_reason, expectedSubtotal: confirm ?? o.regular_subtotal } : { expectedTotal: confirm ?? o.total }) };
      const sale = result['sale.checkout'](u, body, true);
      sql('UPDATE sales SET clerk_id=?, order_id=? WHERE id=?').run(o.clerk, o.id, sale.id);
      sql("UPDATE orders SET status='paid', sale_id=?, cashier=?, closed=?, total=? WHERE id=?").run(sale.id, u.id, nowISO(), money(String(sale.total), 0), o.id);
      notify(u, 'order', `Order #${o.id} paid`, `Sale #${sale.id} · ₱${sale.total.toFixed(2)} · ${u.name}`, '#/orders/' + o.id, o.clerk);
      return { ...sale, orderId: o.id };
    },
    'cash.count'(u, b) {
      // End-of-day drawer count: what the system expects in cash vs what the cashier counted.
      need(u.role === 'cashier', 'Only the Cashier counts the cash drawer.', 403);
      const day = dayOf();
      // Same rule as the Cash drawer page: a sale/payment without a method is cash.
      const expected = sql("SELECT coalesce(sum(paid_now),0) AS v FROM sales WHERE actor=? AND day=? AND voided=0 AND coalesce(payment_method,'Cash')='Cash'").get(u.id, day).v
        + sql("SELECT coalesce(sum(amount),0) AS v FROM payments WHERE actor=? AND day=? AND at_counter=0 AND coalesce(payment_method,'Cash')='Cash'").get(u.id, day).v
        - sql('SELECT coalesce(sum(amount),0) AS v FROM expenses WHERE actor=? AND day=? AND from_drawer=1').get(u.id, day).v;
      const counted = money(b.counted, 0, 'counted cash');
      sql('INSERT INTO cash_counts(cashier,day,expected,counted,note,created) VALUES (?,?,?,?,?,?)').run(u.id, day, expected, counted, optional(b.note, 200), nowISO());
      const variance = counted - expected;
      if (variance !== 0) notify(u, 'cash', `Cash count ${variance > 0 ? 'over' : 'short'} ₱${Math.abs(pesos(variance)).toFixed(2)}`, `${u.name} · ${day}`, '#/cash');
      audit(u, 'cash.count', `${day} expected ₱${pesos(expected)} counted ₱${pesos(counted)}`);
      return { expected: pesos(expected), counted: pesos(counted), variance: pesos(variance) };
    },
    'sale.checkout'(u, b, fromOrder = false) {
      need(isAdmin(u) || (u.role === 'cashier' && fromOrder), 'Only the Cashier or Admin completes sales. Sales Clerks send orders to the Cashier.', 403);
      need(Array.isArray(b.lines) && b.lines.length > 0 && b.lines.length <= 60, 'Add at least one material to the cart.');
      const kind = b.kind === 'credit' ? 'credit' : 'cash';
      const seen = new Set();
      // Every line is priced on the server from the current regular price and promo.
      const lines = b.lines.map(line => {
        const m = material(line.materialId);
        need(!seen.has(m.id), `${label(m)} appears twice. Combine it into one line.`); seen.add(m.id);
        need(!m.archived, `${label(m)} is archived.`, 409);
        const q = quantity(line.qty, m.unit, 1);
        need(m.price !== null, `${label(m)} has no selling price yet.`, 409);
        need(m.qty >= q, `Insufficient stock for ${label(m)}. Available: ${units(m.qty)} ${m.unit}.`, 409);
        const p = priceLine(m, q);
        return { m, q, ...p };
      });
      // One pricing mode per sale: Admin promos, or a Tawad (haggled) total that suspends every promo.
      const tawad = b.pricingMode === 'tawad';
      let tawadReason = null;
      if (tawad) {
        for (const l of lines) { l.regular = lineTotal(l.q, l.m.price); l.promo = null; }
        const regularSubtotal = lines.reduce((x, l) => x + l.regular, 0);
        if (b.expectedSubtotal !== undefined && int(b.expectedSubtotal, 0, Number.MAX_SAFE_INTEGER) !== regularSubtotal) {
          const error = new HttpError(409, 'A regular price changed while the cart was open. Review the new subtotal and agree on the total again.');
          error.payload = { code: 'SUBTOTAL_CHANGED', updatedSubtotal: pesos(regularSubtotal) };
          throw error;
        }
        // The clerk enters the Tawad amount (the deduction); older clients may still send the agreed total.
        let agreed;
        if (b.tawadAmount !== undefined && b.tawadAmount !== null && b.tawadAmount !== '') {
          const off = money(b.tawadAmount, 1, 'Tawad amount');
          need(off > 0, 'The Tawad amount must be more than ₱0.');
          need(off < regularSubtotal, `The Tawad amount must be less than the regular subtotal ₱${pesos(regularSubtotal).toFixed(2)}.`, 409);
          agreed = regularSubtotal - off;
        } else {
          agreed = money(b.agreedTotal, 1, 'agreed total');
          need(agreed > 0, 'The agreed total must be more than ₱0.');
          need(agreed < regularSubtotal, `The agreed total must be below the regular subtotal ₱${pesos(regularSubtotal).toFixed(2)}.`, 409);
        }
        tawadReason = text(b.tawadReason, 'Tawad reason', 120);
        allocateTawad(lines.map(l => l.regular), agreed).forEach((x, i) => { const l = lines[i]; l.final = x.final; l.savings = x.discount; l.unitPrice = Math.round(x.final * 1000 / l.q); });
      }
      const subtotal = lines.reduce((s, l) => s + l.regular, 0), total = lines.reduce((s, l) => s + l.final, 0);
      const discountTotal = subtotal - total;
      const mode = tawad ? 'tawad' : lines.some(l => l.promo && l.savings > 0) ? 'promo' : 'regular';
      // The cart was priced on the device; if a price or promo changed meanwhile, send back the new total and ask for confirmation.
      if (!tawad && b.expectedTotal !== undefined && int(b.expectedTotal, 0, Number.MAX_SAFE_INTEGER) !== total) {
        const error = new HttpError(409, 'A price or promo changed while the cart was open. Review the updated total, then confirm again.');
        error.payload = { code: 'TOTAL_CHANGED', updatedTotal: pesos(total), lines: lines.map(l => ({ materialId: l.m.id, qty: units(l.q), regular: pesos(l.regular), final: pesos(l.final), savings: pesos(l.savings), promo: l.promo })) };
        throw error;
      }
      const when = occurredAt(b.occurred), day = dayOf(when), created = when.toISOString();
      let cash = null, change = null, paidNow = total, creditAdded = 0, customerId = null;
      const method = tender(b);
      if (kind === 'cash' && method === 'Cash') {
        cash = money(b.cashReceived, 0, 'cash received');
        need(cash >= total, `Cash received is below the total. Choose Credit / Utang to record the balance.`, 409);
        change = cash - total;
      } else if (kind === 'credit') {
        const c = customer(b.customerId); customerId = c.id;
        paidNow = b.paidNow === undefined || b.paidNow === '' ? 0 : money(b.paidNow, 0, 'amount paid now');
        need(paidNow <= total, 'Amount paid now cannot exceed the total.', 409);
        creditAdded = total - paidNow;
        need(creditAdded > 0, 'This sale is fully paid. Use Pay in full instead.', 409);
      }
      const r = sql('INSERT INTO sales(actor,customer_id,kind,subtotal,discount_total,total,cash_received,change_due,paid_now,credit_added,reference,day,created,payment_method,pricing_mode,regular_subtotal,tawad_discount,tawad_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(u.id, customerId, kind, subtotal, discountTotal, total, cash, change, paidNow, creditAdded, optional(b.reference, 120), day, created, paidNow > 0 ? method : null, mode, subtotal, tawad ? discountTotal : 0, tawadReason);
      const saleId = Number(r.lastInsertRowid);
      const summary = []; let cogs = 0, costUnknown = false;
      for (const l of lines) {
        const mv = moveStock(u, l.m, -l.q, 'Sale', `Sale #${saleId}`, { saleId, created });
        if (mv.cost === null) costUnknown = true; else cogs += mv.cost;
        sql('INSERT INTO sale_items(sale_id,material_id,name,unit,qty,unit_price,discount,line_total,regular_price,promo,savings,cost,pricing_mode,line_discount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(saleId, l.m.id, label(l.m), l.m.unit, l.q, l.unitPrice, !tawad && l.m.promo_type === 'percent' ? l.m.promo_value : 0, l.final, l.m.price, l.promo ? JSON.stringify(l.promo) : null, l.savings, mv.cost, tawad ? 'tawad' : l.promo && l.savings > 0 ? 'promo' : 'regular', l.savings);
        summary.push(`${label(l.m)} ×${units(l.q)} · ${units(mv.before)} → ${units(mv.after)}`);
      }
      if (kind === 'credit' && paidNow > 0) sql('INSERT INTO payments(customer_id,sale_id,amount,reference,at_counter,actor,day,created,payment_method) VALUES (?,?,?,?,1,?,?,?,?)').run(customerId, saleId, paidNow, optional(b.reference, 120), u.id, day, created, method);
      notify(u, 'sale', kind === 'credit' ? 'Credit sale recorded' : 'New sale recorded', `Sale #${saleId} · ₱${pesos(total).toFixed(2)} · ${u.name} · ${summary.slice(0, 2).join(' / ')}${summary.length > 2 ? ` +${summary.length - 2} more` : ''}`, '#/sales/' + saleId);
      return { id: saleId, total: pesos(total), savings: pesos(discountTotal), pricingMode: mode, regularSubtotal: pesos(subtotal), paymentMethod: paidNow > 0 ? method : null, cashReceived: pesos(cash), change: pesos(change), creditAdded: pesos(creditAdded), paidNow: pesos(paidNow), grossProfit: isAdmin(u) ? (costUnknown ? null : pesos(total - cogs)) : undefined };
    },
    'sale.void'(u, b) {
      need(isAdmin(u), 'Only Admin can void a sale.', 403);
      const s = sql('SELECT * FROM sales WHERE id=?').get(id(b.id)); need(s && !s.voided, 'This sale cannot be voided.', 409);
      const reason = text(b.reason, 'Void reason', 200);
      if (s.kind === 'credit') need(balance(s.customer_id) >= s.credit_added, 'Payments were already applied to this credit. Correct the customer ledger first.', 409);
      // Units go back to the lots they were taken from (restores the original cost allocation).
      costing.restore(s.id);
      for (const it of sql('SELECT * FROM sale_items WHERE sale_id=?').all(s.id)) {
        const m = material(it.material_id);
        moveStock(u, m, it.qty, 'Void return', `Voided sale #${s.id}`, { consume: false });
      }
      sql('UPDATE sales SET voided=1, void_reason=? WHERE id=?').run(reason, s.id);
      sql('DELETE FROM payments WHERE sale_id=? AND at_counter=1').run(s.id);
      notify(u, 'sale', 'Sale voided', `Sale #${s.id} · ₱${pesos(s.total).toFixed(2)} · ${reason}`, '#/sales/' + s.id);
      audit(u, 'sale.void', `#${s.id} ${reason}`);
      return {};
    },

    // ---- Expenses (admin) -------------------------------------------------
    // Admin records any expense. The Cashier records an expense paid out of the drawer
    // (today only); it is taken off the expected cash and the Admin is notified.
    'expense.add'(u, b) {
      need(isAdmin(u) || u.role === 'cashier', 'Only the Admin or Cashier records expenses.', 403);
      const category = String(b.category ?? ''); need(EXPENSE_CATEGORIES.includes(category), 'Choose an expense category.');
      const detail = category === 'Other' ? text(b.detail, 'Specify expense type', 80) : optional(b.detail, 80);
      const cashier = u.role === 'cashier', day = cashier ? dayOf() : date(b.day), amount = money(b.amount, 1);
      const reference = text(b.reference, 'Reason or reference', 160);
      const r = sql('INSERT INTO expenses(actor,amount,category,detail,reference,day,created,from_drawer) VALUES (?,?,?,?,?,?,?,?)')
        .run(u.id, amount, category, detail, reference, day, nowISO(), cashier ? 1 : 0);
      audit(u, 'expense.add', `${category} ${detail || ''} ${b.amount}${cashier ? ' · from drawer' : ''}`);
      if (cashier) notify(u, 'expense', `Expense from drawer ₱${pesos(amount).toFixed(2)}`, `${u.name} · ${category === 'Other' ? detail : category} · ${reference}`, '#/expenses');
      return { id: Number(r.lastInsertRowid) };
    },
    'expense.remove'(u, b) {
      const e = sql('SELECT * FROM expenses WHERE id=?').get(id(b.id)); need(e, 'Expense not found.', 404);
      need(isAdmin(u) || (u.role === 'cashier' && e.actor === u.id && e.day === dayOf()), 'Only the Admin removes expenses (the Cashier can remove own entries today).', 403);
      sql('DELETE FROM expenses WHERE id=?').run(e.id);
      audit(u, 'expense.remove', `#${e.id} ${e.category} ₱${pesos(e.amount)} · ${text(b.reason, 'Reason', 200)}`);
      return {};
    },

    // ---- Attendance -------------------------------------------------------
    'attendance.clock'(u, b) {
      need(TAPS.includes(b.kind), 'Choose a valid attendance tap.');
      const when = occurredAt(b.occurred), day = dayOf(when);
      autoClose.run();
      const taps = payroll.tapsFor(u.id, day);
      if (taps[b.kind]) {
        // A manual Time Out made before the grace deadline (e.g. recorded offline) replaces the automatic closure:
        // one closure is kept, the scheduled cutoff still caps regular pay.
        const auto = sql("SELECT * FROM attendance WHERE user_id=? AND day=? AND kind=? AND source='auto'").get(u.id, day, b.kind);
        if (auto && +when <= Date.parse(auto.grace_deadline)) {
          const prevKind = b.kind === 'lunch_out' ? 'in' : 'lunch_in';
          need(!taps[prevKind] || Date.parse(taps[prevKind]) <= +when, 'This tap is earlier than the previous one.', 409);
          sql("UPDATE attendance SET occurred=?, received=?, source=? WHERE id=?").run(when.toISOString(), nowISO(), b._offline ? 'offline' : 'manual', auto.id);
          const paidDay = payroll.isPaid(u.id, day);
          if (paidDay) notify(u, 'attendance', 'Paid day changed — review', `${u.name} · ${day} · ${TAP_LABELS[b.kind]} replaced an Auto Time Out`, '#/attendance/review');
          const e = payroll.settle(u, day);
          return { day, kind: b.kind, time: timeOf(when), reconciled: true, next: null, earnings: e ? { workedMinutes: e.minutes, payableMinutes: e.payable, scheduledMinutes: e.scheduled, status: e.status, review: e.review || paidDay, flags: e.flags, amount: pesos(e.amount), rateSet: e.rate !== null } : null };
        }
        need(!auto, `This session was closed automatically at ${timeOf(new Date(auto?.grace_deadline || when))}. Ask Admin for a correction.`, 409);
        need(false, `${TAP_LABELS[b.kind]} is already recorded for today.`, 409);
      }
      const cx = payroll.ctxFor(u, day, +when);
      const allowed = allowedTaps(taps, { excuse: cx.excuse, schedule: cx.schedule, day, nowMs: +when });
      need(allowed.includes(b.kind), allowed.length ? `Record ${TAP_LABELS[allowed[0]]} first.` : 'Today is already complete.', 409);
      const previous = TAPS.slice(0, TAPS.indexOf(b.kind)).map(k => taps[k]).filter(Boolean).pop();
      need(!previous || Date.parse(previous) <= +when, 'This tap is earlier than the previous one.', 409);
      // A session start remembers its cutoff and grace deadline; a manual close after the deadline is not possible
      // (the auto-closer would already have closed it), so grace minutes never add pay.
      const win = CLOSES[b.kind] ? autoClose.windowFor(u, day, b.kind) : null;
      if (win) need(+when < Date.parse(win.deadline), b.kind === 'in' ? 'The morning session has ended. Use Afternoon Time In.' : 'The afternoon session has ended for today.', 409);
      if (!CLOSES[b.kind]) {
        const start = sql("SELECT * FROM attendance WHERE user_id=? AND day=? AND kind=?").get(u.id, day, b.kind === 'lunch_out' ? 'in' : 'lunch_in');
        need(!start?.grace_deadline || +when <= Date.parse(start.grace_deadline), 'The grace period has ended; this session closes automatically.', 409);
      }
      sql('INSERT INTO attendance(user_id,day,kind,occurred,received,source,cutoff,grace_deadline,grace_minutes) VALUES (?,?,?,?,?,?,?,?,?)').run(u.id, day, b.kind, when.toISOString(), nowISO(), b._offline ? 'offline' : 'manual', win?.cutoff ?? null, win?.deadline ?? null, win?.grace ?? null);
      autoClose.run();
      const title = TAP_LABELS[b.kind];
      notify(u, 'attendance', `${title} recorded`, `${u.name} · ${timeOf(when)}`, '#/attendance');
      let earnings = null;
      const e = payroll.settle(u, day); // finalizes once the day's last required tap is in
      if (e) {
        earnings = { workedMinutes: e.minutes, payableMinutes: e.payable, scheduledMinutes: e.scheduled, status: e.status, review: e.review, flags: e.flags, amount: pesos(e.amount), rateSet: e.rate !== null };
        if (e.review) notify(u, 'attendance', `Attendance needs review · ${e.status}`, `${u.name} · ${day} · ${Math.floor(e.minutes / 60)}h ${e.minutes % 60}m worked · ${e.flags.join(', ')}`, '#/attendance/review');
      }
      if (!isAdmin(u)) notify(u, 'attendance', `${title} confirmed`, `${day} · ${timeOf(when)}`, '#/attendance', u.id);
      const after = payroll.tapsFor(u.id, day);
      return { day, kind: b.kind, time: timeOf(when), next: allowedTaps(after, { excuse: cx.excuse, schedule: cx.schedule, day, nowMs: +when })[0] ?? null, earnings };
    },
    'attendance.morningAbsent'(u, b) {
      // Admin confirms an unexcused morning absence so the valid afternoon session counts without a review flag.
      need(isAdmin(u), 'Only Admin confirms absences.', 403);
      const target = user(b.userId), day = date(b.day), reason = text(b.reason, 'Reason', 200);
      need(day <= dayOf(), 'Choose today or an earlier date.');
      const t = payroll.tapsFor(target.id, day); need(!t.in, 'This day already has a Morning Time In.', 409);
      sql('INSERT INTO morning_absences(user_id,day,reason,actor,created) VALUES (?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET reason=excluded.reason, actor=excluded.actor, created=excluded.created').run(target.id, day, reason, u.id, nowISO());
      audit(u, 'attendance.morningAbsent', `${target.name} ${day} · ${reason}`);
      const e = payroll.settle(target, day);
      return { earnings: e ? { status: e.status, payableMinutes: e.payable, amount: pesos(e.amount), locked: e.locked } : null };
    },
    'attendance.correct'(u, b) {
      need(isAdmin(u), 'Only Admin corrects attendance.', 403);
      const target = user(b.userId), day = date(b.day), kind = b.kind, time = clock(b.time), reason = text(b.reason, 'Correction reason', 200);
      need(TAPS.includes(kind), 'Choose a valid attendance tap.');
      const corrected = new Date(`${day}T${time}:00+08:00`).toISOString();
      need(corrected <= nowISO(), 'Choose a time that has already passed.');
      const taps = payroll.tapsFor(target.id, day);
      const idx = TAPS.indexOf(kind);
      for (const k of TAPS.slice(0, idx)) if (taps[k]) need(taps[k] <= corrected, `${TAP_LABELS[kind]} must come after ${TAP_LABELS[k]}.`);
      for (const k of TAPS.slice(idx + 1)) if (taps[k]) need(taps[k] >= corrected, `${TAP_LABELS[kind]} must come before ${TAP_LABELS[k]}.`);
      if (kind === 'lunch_out') need(taps.in, 'Record Morning Time In before Lunch Time Out.');
      if (kind === 'out') need(taps.in || taps.lunch_in, 'Record a Time In before the Final Time Out.');
      const original = sql('SELECT occurred FROM attendance WHERE user_id=? AND day=? AND kind=?').get(target.id, day, kind)?.occurred ?? null;
      sql("INSERT INTO attendance(user_id,day,kind,occurred,received,source) VALUES (?,?,?,?,?,'admin') ON CONFLICT(user_id,day,kind) DO UPDATE SET occurred=excluded.occurred, source='admin'")
        .run(target.id, day, kind, corrected, nowISO());
      sql('INSERT INTO attendance_corrections(user_id,day,kind,original,corrected,reason,actor,created) VALUES (?,?,?,?,?,?,?,?)')
        .run(target.id, day, kind, original, corrected, reason, u.id, nowISO());
      notify(u, 'attendance', 'Attendance corrected', `${target.name} · ${day} · ${TAP_LABELS[kind]} → ${time}`, '#/attendance', target.id);
      audit(u, 'attendance.correct', `${target.name} ${day} ${kind} ${original} → ${corrected} · ${reason}`);
      const e = payroll.settle(target, day);
      return { earnings: e ? { status: e.status, workedMinutes: e.minutes, payableMinutes: e.payable, amount: pesos(e.amount), locked: e.locked } : null };
    },
    'attendance.mark'(u, b) {
      need(isAdmin(u), 'Only Admin marks attendance.', 403);
      const target = user(b.userId), day = date(b.day), status = String(b.status ?? '');
      need(['Absent', 'Present'].includes(status), 'Choose a status.');
      need(day < dayOf(), 'Mark attendance only for completed days.');
      need(!sql("SELECT 1 FROM excuses WHERE user_id=? AND day=? AND status IN ('Excused','Pending Approval')").get(target.id, day), 'Resolve the excuse request for this date first.', 409);
      sql('INSERT INTO attendance_marks(user_id,day,status,reason,actor,created) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET status=excluded.status, reason=excluded.reason, actor=excluded.actor, created=excluded.created')
        .run(target.id, day, status, text(b.reason, 'Reason', 200), u.id, nowISO());
      audit(u, 'attendance.mark', `${target.name} ${day} ${status}`);
      return {};
    },
    'attendance.settings'(u, b) {
      need(isAdmin(u), 'Only Admin changes attendance settings.', 403);
      const grace = int(b.graceMinutes, 0, 120, 'grace period');
      const before = autoClose.graceMinutes();
      sql("INSERT INTO settings(key,value) VALUES ('grace_minutes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(grace));
      audit(u, 'attendance.settings', `Time Out grace ${before} → ${grace} min (applies to sessions started from now on)`);
      return { graceMinutes: grace };
    },
    'schedule.set'(u, b) {
      need(isAdmin(u), 'Only Admin sets schedules.', 403);
      const start = clock(b.start), end = clock(b.end), effective = date(b.effective), lunchStart = clock(b.lunchStart || '11:30'), lunchEnd = clock(b.lunchEnd || '13:00');
      need(end > start, 'Shift end must be after the start.');
      need(lunchStart > start && lunchEnd > lunchStart && lunchEnd < end, 'The lunch break must fall inside the shift.');
      const targets = Array.isArray(b.userIds) ? b.userIds.map(user) : [user(b.userId)];
      for (const t of targets) {
        sql('INSERT INTO schedules(user_id,effective,shift_start,shift_end,lunch_start,lunch_end,actor,created) VALUES (?,?,?,?,?,?,?,?)').run(t.id, effective, start, end, lunchStart, lunchEnd, u.id, nowISO());
        notify(u, 'attendance', 'New shift schedule', `${start}–${lunchStart} and ${lunchEnd}–${end} starting ${effective}`, '#/attendance', t.id);
      }
      audit(u, 'schedule.set', `${targets.map(t => t.name).join(', ')} · ${effective} ${start}–${end} lunch ${lunchStart}–${lunchEnd}`);
      return {};
    },
    'excuse.request'(u, b) {
      // Advance requests and same-day emergencies; coverage is the whole day, the morning or the afternoon.
      const day = date(b.day); need(day >= dayOf(), 'Choose today or a future date.');
      const coverage = String(b.coverage ?? ''); need(['whole', 'morning', 'afternoon'].includes(coverage), 'Choose Whole Day, Morning Only or Afternoon Only.');
      need(!sql('SELECT 1 FROM excuses WHERE user_id=? AND day=?').get(u.id, day), 'You already filed an excuse for this date.', 409);
      const emergency = day === dayOf() ? 1 : 0;
      const r = sql('INSERT INTO excuses(user_id,day,reason,coverage,emergency,created) VALUES (?,?,?,?,?,?)').run(u.id, day, text(b.reason, 'Reason', 400), coverage, emergency, nowISO());
      notify(u, 'excuse', emergency ? 'Same-day emergency excuse' : 'Excuse request', `${u.name} · ${day} · ${COVERAGE[coverage]}`, '#/attendance/excuses');
      return { id: Number(r.lastInsertRowid) };
    },
    'excuse.review'(u, b) {
      need(isAdmin(u), 'Only Admin reviews excuses.', 403);
      const e = sql('SELECT * FROM excuses WHERE id=?').get(id(b.id)); need(e && e.status === 'Pending Approval', 'This request was already reviewed.', 409);
      need(['Excused', 'Declined'].includes(b.decision), 'Choose Approve or Decline.');
      let paid = null;
      if (b.decision === 'Excused') { need(b.paid === true || b.paid === false || b.paid === 'paid' || b.paid === 'unpaid', 'Mark the approved excuse Paid or Unpaid.'); paid = b.paid === true || b.paid === 'paid' ? 1 : 0; }
      sql('UPDATE excuses SET status=?, paid=?, note=?, reviewed_by=?, reviewed_at=? WHERE id=?').run(b.decision, paid, optional(b.note, 300), u.id, nowISO(), e.id);
      notify(u, 'excuse', `Excuse ${b.decision === 'Excused' ? 'approved' : 'declined'}`, `${e.day} · ${COVERAGE[e.coverage] || 'Whole Day'}${paid === null ? '' : paid ? ' · Paid' : ' · Unpaid'}${b.note ? ' · ' + b.note : ''}`, '#/attendance', e.user_id);
      audit(u, 'excuse.review', `#${e.id} ${b.decision}${paid === null ? '' : paid ? ' paid' : ' unpaid'}`);
      if (e.day <= dayOf()) payroll.settle(user(e.user_id), e.day);
      return {};
    },
    'excuse.pay'(u, b) {
      need(isAdmin(u), 'Only Admin decides paid excuses.', 403);
      const e = sql('SELECT * FROM excuses WHERE id=?').get(id(b.id)); need(e && e.status === 'Excused', 'Only approved excuses can be marked Paid or Unpaid.', 409);
      need(!payroll.isPaid(e.user_id, e.day), 'This date is already included in a salary payment.', 409);
      const paid = b.paid === true || b.paid === 'paid' ? 1 : 0;
      sql('UPDATE excuses SET paid=? WHERE id=?').run(paid, e.id);
      audit(u, 'excuse.pay', `#${e.id} ${paid ? 'paid' : 'unpaid'}`);
      if (e.day <= dayOf()) payroll.settle(user(e.user_id), e.day);
      return { paid: !!paid };
    },

    // ---- Staff accounts (admin) -----------------------------------------
    'staff.save'(u, b) {
      need(isAdmin(u), 'Only Admin manages staff accounts.', 403);
      const name = text(b.name, 'Full name', 80), uname = username(b.username), role = String(b.role ?? '');
      need(ROLES.includes(role), 'Choose a staff role.');
      // Admin accounts: only the Main Admin creates them or changes anyone to / from Admin.
      if (role === 'admin') need(u.is_main, 'Only the Main Admin can create or assign Admin accounts.', 403);
      // Attendance-only staff carry a job title (preset or typed under "Other"); clerks do not.
      let jobTitle = null;
      if (role === 'attendance') {
        const picked = String(b.jobTitle ?? '').trim();
        if (picked === 'Other') jobTitle = text(b.jobTitleOther, 'Specify job title', 60);
        else { need(ATTENDANCE_TITLES.includes(picked), 'Choose a job title or Other.'); jobTitle = picked; }
      }
      const dup = sql('SELECT id FROM users WHERE username=?').get(uname);
      if (b.id) {
        const t = user(b.id);
        need(!t.is_main || (u.is_main && role === 'admin'), 'The Main Admin account cannot be demoted or edited here.', 403);
        if (isAdmin(t) || t.role !== role) need(u.is_main || (!isAdmin(t) && role !== 'admin'), 'Only the Main Admin can change Admin accounts.', 403);
        need(!dup || dup.id === t.id, 'This username is taken.', 409);
        // Same account id is kept, so attendance, excuses and schedules stay attached.
        sql('UPDATE users SET name=?, username=?, role=?, job_title=? WHERE id=?').run(name, uname, role, jobTitle, t.id);
        if (b.photo) sql('UPDATE users SET photo=? WHERE id=?').run(photo(b.photo), t.id);
        else if (b.removePhoto) sql('UPDATE users SET photo=NULL WHERE id=?').run(t.id);
        if (t.role !== role) sql('DELETE FROM sessions WHERE user_id=?').run(t.id);
        audit(u, t.role !== role ? 'staff.role' : 'staff.update', `${uname} ${t.role !== role ? t.role + ' → ' : ''}${role}${jobTitle ? ' · ' + jobTitle : ''}`); return { id: t.id };
      }
      need(!dup, 'This username is taken.', 409);
      const temp = password(b.password);
      const r = sql('INSERT INTO users(username,name,password,role,job_title,temporary,created) VALUES (?,?,?,?,?,1,?)').run(uname, name, hashPassword(temp), role, jobTitle, nowISO());
      if (b.photo) sql('UPDATE users SET photo=? WHERE id=?').run(photo(b.photo), r.lastInsertRowid);
      audit(u, role === 'admin' ? 'admin.create' : 'staff.create', `${uname} ${role}${jobTitle ? ' · ' + jobTitle : ''}`);
      return { id: Number(r.lastInsertRowid) };
    },
    'staff.rate'(u, b) {
      // Rate history: each entry applies from its effective date. Unpaid earnings on/after that date are recomputed;
      // paid days keep the rate and amount they were paid with.
      need(isAdmin(u), 'Only Admin sets daily rates.', 403);
      const t = user(b.id); need(!isAdmin(t), 'Admin accounts have no daily rate.', 403);
      const rate = money(b.rate, 0, 'daily rate');
      const first = !sql('SELECT 1 FROM rates WHERE user_id=?').get(t.id);
      const effective = b.effective ? date(b.effective) : first ? '0000-01-01' : dayOf();
      sql('INSERT INTO rates(user_id,rate,effective,actor,created) VALUES (?,?,?,?,?)').run(t.id, rate, effective, u.id, nowISO());
      const current = payroll.rateFor(t, dayOf());
      sql('UPDATE users SET daily_rate=? WHERE id=?').run(current, t.id);
      const fresh = user(t.id); let recomputed = 0;
      for (const r of sql('SELECT day FROM earnings WHERE user_id=? AND day>=? AND NOT EXISTS (SELECT 1 FROM salary_payment_days d WHERE d.user_id=earnings.user_id AND d.day=earnings.day)').all(t.id, effective)) { payroll.finalize(fresh, r.day); recomputed++; }
      audit(u, 'staff.rate', `${t.username} → ₱${pesos(rate)} from ${effective === '0000-01-01' ? 'the start' : effective}`);
      return { rate: pesos(rate), effective, recomputed };
    },
    'earnings.finalize'(u, b) {
      // Admin recomputes a day after a correction or rate decision (paid days stay frozen).
      need(isAdmin(u), 'Only Admin finalizes earnings.', 403);
      const t = user(b.userId), day = date(b.day);
      const e = payroll.settle(t, day); need(e, 'The day is not finished yet (taps missing).', 409);
      audit(u, 'earnings.finalize', `${t.username} ${day} ${e.status} ₱${pesos(e.amount)}${e.locked ? ' (already paid, unchanged)' : ''}`);
      return { status: e.status, workedMinutes: e.minutes, payableMinutes: e.payable, amount: pesos(e.amount), locked: e.locked };
    },
    'salary.pay'(u, b) {
      need(isAdmin(u), 'Only Admin records salary payments.', 403);
      const t = user(b.userId), from = date(b.from), to = date(b.to), payDate = date(b.payDate);
      need(from <= to, 'The period end must be on or after the start.'); need(to <= dayOf(), 'The period cannot end in the future.');
      const method = String(b.method ?? ''); need(PAY_METHODS.includes(method), 'Choose a payment method.');
      const rows = sql('SELECT * FROM earnings WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY day').all(t.id, from, to);
      need(rows.length > 0, 'No finalized earnings in this period.', 409);
      const alreadyPaid = sql('SELECT day FROM salary_payment_days WHERE user_id=? AND day BETWEEN ? AND ?').all(t.id, from, to).map(r => r.day);
      need(alreadyPaid.length === 0, `Already paid: ${alreadyPaid.join(', ')}. Choose a period that does not overlap.`, 409);
      const amount = rows.reduce((a, r) => a + (r.amount || 0), 0);
      need(money(b.amount, 0, 'amount') === amount, `The amount must match the computed total ₱${pesos(amount).toFixed(2)}. Refresh the preview.`, 409);
      const r = sql('INSERT INTO salary_payments(user_id,amount,from_day,to_day,pay_date,method,reference,days,actor,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(t.id, amount, from, to, payDate, method, optional(b.reference, 120), rows.length, u.id, nowISO());
      const pid = Number(r.lastInsertRowid);
      const mark = sql('INSERT INTO salary_payment_days(user_id,day,payment_id,amount) VALUES (?,?,?,?)');
      for (const row of rows) mark.run(t.id, row.day, pid, row.amount || 0);
      // Only the employee concerned is told; Admin keeps the record in the profile.
      notify(u, 'salary', 'Salary payment recorded', `₱${pesos(amount).toFixed(2)} · ${from === to ? from : from + ' to ' + to} · ${rows.length} day${rows.length === 1 ? '' : 's'} · ${method}`, '#/attendance/pay', t.id);
      audit(u, 'salary.pay', `${t.username} ₱${pesos(amount)} ${from}..${to} ${method}`);
      return { id: pid, amount: pesos(amount), days: rows.length };
    },
    'staff.reset'(u, b) {
      need(isAdmin(u), 'Only Admin resets passwords.', 403);
      const t = user(b.id); need(!isAdmin(t) || u.is_main, 'Only the Main Admin resets Admin passwords.', 403);
      need(!t.is_main || t.id === u.id, 'The Main Admin password can only be changed by the Main Admin.', 403);
      sql('UPDATE users SET password=?, temporary=1 WHERE id=?').run(hashPassword(password(b.password)), t.id);
      sql('DELETE FROM sessions WHERE user_id=?').run(t.id);
      audit(u, 'staff.reset', t.username);
      return {};
    },
    'staff.active'(u, b) {
      need(isAdmin(u), 'Only Admin deactivates accounts.', 403);
      const t = user(b.id);
      need(!t.is_main, 'The Main Admin account cannot be deactivated.', 403);
      need(!isAdmin(t) || u.is_main, 'Only the Main Admin can deactivate Admin accounts.', 403);
      const active = b.active ? 1 : 0;
      sql('UPDATE users SET active=? WHERE id=?').run(active, t.id);
      if (!active) sql('DELETE FROM sessions WHERE user_id=?').run(t.id);
      audit(u, isAdmin(t) ? 'admin.active' : 'staff.active', `${t.username} → ${active ? 'active' : 'deactivated'}`);
      return {};
    },

    // ---- Private valid ID (Admin only; never public, never in notifications or offline storage) ----
    'staff.idUpload'(u, b) {
      need(isAdmin(u), 'Only Admin manages valid IDs.', 403);
      const t = user(b.id);
      const m = /^data:(image\/jpeg|image\/png|image\/webp|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.file ?? ''));
      need(m, 'Upload a JPG, PNG, WEBP or PDF file.', 415);
      const data = Buffer.from(m[2], 'base64');
      need(data.length > 0 && data.length <= 1_400_000, 'The ID file must be 1.4 MB or smaller.', 413);
      // The file must really be what it claims to be (magic bytes).
      const sig = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46], 'application/pdf': [0x25, 0x50, 0x44, 0x46] }[m[1]];
      need(sig.every((x, i) => data[i] === x), 'The file content does not match its type.', 415);
      const name = optional(b.name, 120)?.replace(/[^\w .()-]/g, '_') || 'valid-id';
      const replaced = !!sql('SELECT 1 FROM staff_ids WHERE user_id=?').get(t.id);
      sql('INSERT INTO staff_ids(user_id,mime,name,size,data,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mime=excluded.mime, name=excluded.name, size=excluded.size, data=excluded.data, uploaded_by=excluded.uploaded_by, uploaded_at=excluded.uploaded_at')
        .run(t.id, m[1], name, data.length, data, u.id, nowISO());
      audit(u, replaced ? 'staffid.replace' : 'staffid.upload', `${t.username} · ${m[1]} · ${data.length} bytes`);
      return { replaced };
    },
    'staff.idRemove'(u, b) {
      need(isAdmin(u), 'Only Admin manages valid IDs.', 403);
      const t = user(b.id);
      need(sql('DELETE FROM staff_ids WHERE user_id=?').run(t.id).changes, 'No valid ID on file.', 404);
      audit(u, 'staffid.remove', t.username);
      return {};
    },

    // ---- Own profile ------------------------------------------------------
    'profile.update'(u, b) {
      const name = text(b.name ?? u.name, 'Display name', 80);
      // Staff profile photos are set by the Admin (Staff → Edit). Only an Admin changes their own here.
      need(b.photo === undefined || b.photo === null || isAdmin(u), 'Only the Admin sets staff profile photos.', 403);
      const pic = b.photo ? photo(b.photo) : undefined;
      sql('UPDATE users SET name=?, photo=coalesce(?, photo) WHERE id=?').run(name, pic ?? null, u.id);
      return {};
    },
    'profile.lang'(u, b) {
      need(b.lang === 'en' || b.lang === 'fil', 'Choose English or Filipino.');
      sql('UPDATE users SET lang=? WHERE id=?').run(b.lang, u.id);
      return { lang: b.lang };
    },
    'password.change'(u, b) {
      need(checkPassword(String(b.current ?? ''), u.password), 'Current password is incorrect.', 403);
      const next = password(b.password); need(next !== String(b.current), 'Choose a different new password.');
      sql('UPDATE users SET password=?, temporary=0 WHERE id=?').run(hashPassword(next), u.id);
      sql('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, b._sessionDigest || '');
      return {};
    },

    // ---- Branding & settings (admin) ------------------------------------
    'settings.save'(u, b) {
      need(isAdmin(u), 'Only Admin changes store settings.', 403);
      const put = sql('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      if (b.storeName !== undefined) put.run('store_name', text(b.storeName, 'Store name', 60));
      if (b.appName !== undefined) put.run('app_name', text(b.appName, 'App name', 30));
      if (b.logo) put.run('logo', photo(b.logo));
      // The installed app's icon follows the store logo (made square by the Admin's browser).
      if (b.appIcon512 || b.appIcon192) { put.run('app_icon_512', pngIcon(b.appIcon512)); put.run('app_icon_192', pngIcon(b.appIcon192)); }
      if (b.background) put.run('background', photo(b.background));
      if (b.brandColor !== undefined) {
        const c = String(b.brandColor || '').trim().toLowerCase();
        if (!c || c === 'default') sql("DELETE FROM settings WHERE key='brand_color'").run();
        else { need(/^#[0-9a-f]{6}$/.test(c), 'Choose a valid brand colour.'); put.run('brand_color', c); }
      }
      if (b.resetLogo) sql("DELETE FROM settings WHERE key IN ('logo','app_icon_512','app_icon_192')").run();
      if (b.resetBackground) sql("DELETE FROM settings WHERE key='background'").run();
      audit(u, 'settings.save', Object.keys(b).filter(k => !['key', 'action'].includes(k)).join(','));
      return {};
    },

    // ---- Notifications ----------------------------------------------------
    'notifications.read'(u, b) {
      const ids = Array.isArray(b.ids) ? b.ids.map(id) : null;
      const visible = isAdmin(u) ? 'recipient IS NULL OR recipient=?' : 'recipient=?';
      const rows = ids
        ? sql(`SELECT id FROM notifications WHERE id IN (${ids.map(() => '?').join(',')}) AND (${visible})`).all(...ids, u.id)
        : sql(`SELECT id FROM notifications WHERE ${visible}`).all(u.id);
      const mark = sql('INSERT OR IGNORE INTO notification_reads(notification_id,user_id) VALUES (?,?)');
      for (const row of rows) mark.run(row.id, u.id);
      return { marked: rows.length };
    },
  };
  result[AUTO_CLOSE] = autoClose;
  Object.assign(result, offlineActions(result));
  return result;

  // ---- Offline sync approval -------------------------------------------------
  // Entries recorded on a device without connection are uploaded into an inbox. Nothing in the
  // inbox counts in sales, stock or payroll until an Admin approves it; approval re-runs the
  // normal validation with the original timestamp and employee, one savepoint per entry.
  function offlineActions(all) {
    const label = { 'attendance.clock': 'Attendance tap', 'sale.checkout': 'Sale', 'stock.in': 'Stock In', 'stock.out': 'Stock Out', 'count.submit': 'Physical count' };
    const execute = (row, admin, atCurrentPrices) => {
      const owner = sql('SELECT * FROM users WHERE id=?').get(row.user_id);
      const body = { ...JSON.parse(row.body), occurred: row.occurred, _offline: true };
      if (atCurrentPrices) { delete body.expectedTotal; delete body.expectedSubtotal; }
      db.exec('SAVEPOINT offline_entry');
      try {
        need(owner && owner.active, 'The account that recorded this entry is deactivated.', 409);
        const out = all[row.action](owner, body) || {};
        db.exec('RELEASE offline_entry');
        sql("UPDATE offline_inbox SET status='approved', result=?, error=NULL, reviewer=?, reviewed_at=?, attempts=attempts+1 WHERE id=?").run(JSON.stringify(out), admin.id, nowISO(), row.id);
        notify(admin, 'sync', `${label[row.action]} approved`, `Recorded offline ${timeOf(new Date(row.occurred))} · ${row.occurred.slice(0, 10)}`, '#/profile', row.user_id);
        return { id: row.id, status: 'approved' };
      } catch (error) {
        db.exec('ROLLBACK TO offline_entry'); db.exec('RELEASE offline_entry');
        if (!(error instanceof HttpError)) throw error;
        const code = error.payload?.code || null;
        sql("UPDATE offline_inbox SET status='needs_review', error=?, result=?, reviewer=?, reviewed_at=?, attempts=attempts+1 WHERE id=?").run(error.message, code ? JSON.stringify({ code, ...error.payload }) : null, admin.id, nowISO(), row.id);
        return { id: row.id, status: 'needs_review', error: error.message, code };
      }
    };
    return {
      'offline.approve'(u, b) {
        need(isAdmin(u), 'Only Admin approves offline entries.', 403);
        const rows = b.all ? sql("SELECT * FROM offline_inbox WHERE status='pending' ORDER BY occurred, id").all()
          : (Array.isArray(b.ids) ? b.ids : [b.id]).map(x => sql('SELECT * FROM offline_inbox WHERE id=?').get(id(x))).filter(Boolean).sort((a, c) => a.occurred.localeCompare(c.occurred) || a.id - c.id);
        need(rows.length, 'Nothing to approve.');
        const results = [];
        for (const row of rows) {
          if (row.status === 'approved' || row.status === 'rejected') { results.push({ id: row.id, status: row.status, skipped: true }); continue; } // repeated approvals are harmless
          results.push(execute(row, u, !!b.atCurrentPrices));
        }
        const ok = results.filter(r => r.status === 'approved' && !r.skipped).length, flagged = results.filter(r => r.status === 'needs_review').length;
        audit(u, 'offline.approve', `${ok} approved, ${flagged} need review${b.atCurrentPrices ? ' (current prices)' : ''}`);
        return { approved: ok, needsReview: flagged, results };
      },
      'offline.reject'(u, b) {
        need(isAdmin(u), 'Only Admin rejects offline entries.', 403);
        const row = sql('SELECT * FROM offline_inbox WHERE id=?').get(id(b.id)); need(row, 'Entry not found.', 404);
        need(row.status !== 'approved', 'This entry was already approved.', 409);
        const reason = text(b.reason, 'Reason', 200);
        sql("UPDATE offline_inbox SET status='rejected', error=?, reviewer=?, reviewed_at=? WHERE id=?").run(reason, u.id, nowISO(), row.id);
        notify(u, 'sync', `${label[row.action]} not accepted`, `Recorded offline ${row.occurred.slice(0, 10)} · ${reason}`, '#/profile', row.user_id);
        audit(u, 'offline.reject', `#${row.id} ${row.action} · ${reason}`);
        return {};
      },
    };
  }
}

