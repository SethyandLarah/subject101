// Selling price, promos and line totals. Money in centavos, quantities in thousandths.
import { need, int, money, lineTotal } from './common.mjs';
import { DECIMAL_UNITS } from './db.mjs';

export const PROMO_TYPES = ['bundle', 'percent', 'fixed'];

/** Validate promo inputs against the regular price. Returns normalized {type, qty, value} or null. */
export function validatePromo(material, body) {
  const type = body.promoType ?? material.promo_type ?? null;
  if (!type || type === 'none') return null;
  need(PROMO_TYPES.includes(type), 'Choose a valid promo type.');
  const price = material.price;
  need(price !== null && price !== undefined, 'Set a regular selling price before adding a promo.');
  if (type === 'percent') {
    const value = int(body.promoValue ?? material.promo_value, 1, 100, 'discount percentage');
    return { type, qty: null, value };
  }
  if (type === 'fixed') {
    const value = body.promoValue !== undefined ? money(body.promoValue, 1, 'promo price') : material.promo_value;
    need(value < price, 'The promo price must be below the regular price.', 409);
    return { type, qty: null, value };
  }
  const qty = int(body.promoQty ?? material.promo_qty, 2, 100000, 'bundle quantity');
  need(!DECIMAL_UNITS.has(material.unit), 'Bundle promos need whole units (pcs, rolls, bags, boxes, sets).');
  const value = body.promoValue !== undefined ? money(body.promoValue, 1, 'bundle price') : material.promo_value;
  need(value < price * qty, `The bundle price must be below ${qty} × the regular price.`, 409);
  return { type, qty, value };
}

const php = c => '₱' + (c / 100).toLocaleString('en-PH', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
export const promoText = m => {
  if (!m.promo_type || m.price === null) return '';
  if (m.promo_type === 'percent') return `${m.promo_value}% off`;
  if (m.promo_type === 'fixed') return `Promo ${php(m.promo_value)} each`;
  return `${m.promo_qty} for ${php(m.promo_value)}`;
};

/** Price one cart line. qty is in thousandths. */
export function priceLine(m, qty) {
  const regular = lineTotal(qty, m.price);
  let final = regular, detail = '';
  if (m.promo_type === 'percent') { final = lineTotal(qty, Math.round(m.price * (100 - m.promo_value) / 100)); detail = `${m.promo_value}% off`; }
  else if (m.promo_type === 'fixed') { final = lineTotal(qty, m.promo_value); detail = `Promo price ₱${(m.promo_value / 100).toFixed(2)} each`; }
  else if (m.promo_type === 'bundle') {
    const bundleUnits = m.promo_qty * 1000;
    const groups = Math.floor(qty / bundleUnits), rest = qty - groups * bundleUnits;
    final = groups * m.promo_value + lineTotal(rest, m.price);
    detail = groups > 0 ? `${groups} × (${m.promo_qty} for ₱${(m.promo_value / 100).toFixed(2)})${rest ? ` + ${rest / 1000} at regular price` : ''}` : `Add ${(bundleUnits - rest) / 1000} more for the ${m.promo_qty}-for-₱${(m.promo_value / 100).toFixed(2)} bundle`;
  }
  const savings = Math.max(0, regular - final);
  return { regular, final, savings, unitPrice: qty > 0 ? Math.round(final * 1000 / qty) : m.price, promo: m.promo_type ? { type: m.promo_type, qty: m.promo_qty, value: m.promo_value, label: promoText(m), detail, applied: savings > 0 } : null };
}

/**
 * Tawad (haggled total): split the negotiated discount across lines in proportion to each
 * line's regular amount, in whole centavos, so the line amounts add up exactly to the agreed total.
 * Remainder centavos go to the lines with the largest fractional share (ties: first line first).
 */
export function allocateTawad(regulars, agreed) {
  const subtotal = regulars.reduce((a, b) => a + b, 0), discount = subtotal - agreed;
  const raw = regulars.map(r => (discount * r) / subtotal);
  const shares = raw.map(Math.floor);
  let left = discount - shares.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length) { const i = order[k][1]; if (shares[i] < regulars[i]) { shares[i]++; left--; } }
  return shares.map((d, i) => ({ discount: d, final: regulars[i] - d }));
}
