// Shared validation helpers, permission checks, and small formatters.
import { DECIMAL_UNITS, nowISO, dayOf } from './db.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
/** Name of the installed app (phone icon, browser tab). Admin can change it in Store Profile. */
export const DEFAULT_APP_NAME = 'DLKM BizPulse';
export const fail = (status, message) => { throw new HttpError(status, message); };
export const need = (ok, message, status = 400) => { if (!ok) fail(status, message); };

// ---- Permissions --------------------------------------------------------
export const isAdmin = u => u.role === 'admin';
// Sales area (prices, customers, receipts): Admin, Sales Clerk, Cashier.
export const canSell = u => isAdmin(u) || u.role.includes('sales') || u.role === 'cashier';
// Sales Clerk prepares orders; Cashier receives payment.
export const canOrder = u => isAdmin(u) || u.role.includes('sales');
export const canCash = u => isAdmin(u) || u.role === 'cashier';
export const canStock = u => isAdmin(u) || u.role.includes('stock');
export const isStaff = u => !isAdmin(u);
export const attendanceOnly = u => u.role === 'attendance';
// Title shown everywhere: custom job title for attendance-only staff, role name otherwise.
export const titleOf = u => u.role === 'attendance' ? (u.job_title || 'Staff') : u.role === 'admin' && u.is_main ? 'Main Admin' : ({ admin: 'Admin', cashier: 'Cashier', sales: 'Sales Clerk', stock: 'Stock Clerk', 'sales+stock': 'Sales & Stock Clerk' }[u.role] || u.role);
export const publicUser = u => ({
  id: u.id, username: u.username, name: u.name, role: u.role, isMain: !!u.is_main, jobTitle: u.job_title || null, title: titleOf(u), temporary: !!u.temporary,
  active: !!u.active, photo: !!u.photo, shift: { start: u.shift_start, end: u.shift_end }, lang: u.lang === 'fil' || u.lang === 'en' ? u.lang : null,
});

// ---- Validators ---------------------------------------------------------
export const text = (value, label, max = 160) => {
  const v = String(value ?? '').trim();
  need(v.length > 0 && v.length <= max, `${label} is required (up to ${max} characters).`);
  return v;
};
export const optional = (value, max = 300) => {
  const v = String(value ?? '').trim();
  need(v.length <= max, 'Text is too long.');
  return v;
};
export const int = (value, min = 0, max = 1_000_000_000, label = 'number') => {
  const n = Number(value);
  need(Number.isSafeInteger(n) && n >= min && n <= max, `Enter a valid ${label}.`);
  return n;
};
export const id = value => int(value, 1, Number.MAX_SAFE_INTEGER, 'record');

// "123.45" -> 12345 centavos. Accepts numbers or strings; rejects negatives.
export const money = (value, min = 0, label = 'amount') => {
  const v = String(value ?? '').trim().replace(/,/g, '');
  need(/^\d+(?:\.\d{1,2})?$/.test(v), `Enter a valid ${label}.`);
  const [whole, fraction = ''] = v.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  need(Number.isSafeInteger(cents) && cents >= min && cents <= 1_000_000_000_00, `Enter a valid ${label}.`);
  return cents;
};
// "2.5" kg -> 2500 thousandths. Whole units must be whole numbers.
export const quantity = (value, unit, min = 0) => {
  const v = String(value ?? '').trim();
  need(/^\d+(?:\.\d{1,3})?$/.test(v), 'Enter a valid quantity.');
  const [whole, fraction = ''] = v.split('.');
  const q = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
  need(Number.isSafeInteger(q) && q >= min && q <= 1_000_000_000_000, 'Enter a valid quantity.');
  need(DECIMAL_UNITS.has(unit) || q % 1000 === 0, `Use a whole number for ${unit}.`);
  return q;
};
export const unit = value => {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ');
  need(v.length > 0 && v.length <= 24 && /^[A-Za-z][A-Za-z0-9 ./_-]*$/.test(v), 'Enter a valid unit (letters, numbers, spaces, /, . or -).');
  return v;
};
export const date = value => {
  const v = String(value ?? '');
  const d = new Date(v + 'T00:00:00Z');
  need(/^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(+d) && d.toISOString().startsWith(v), 'Choose a valid date.');
  return v;
};
export const clock = value => { const v = String(value ?? ''); need(/^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'Enter a valid time (HH:MM).'); return v; };
export const username = value => {
  const v = text(value, 'Username', 40).toLowerCase();
  need(/^[a-z0-9_.-]+$/.test(v), 'Username may use letters, numbers, dots, dashes or underscores.');
  return v;
};
export const password = value => {
  const v = String(value ?? '');
  need(v.length >= 8 && v.length <= 128, 'Use a password with at least 8 characters.');
  return v;
};
// Photos arrive as a JPEG data URL already resized by the browser.
export const photo = value => {
  if (!value) return null;
  need(typeof value === 'string' && value.length <= 600_000 && /^data:image\/jpeg;base64,[a-zA-Z0-9+/]+=*$/.test(value), 'Choose a JPEG photo up to 400 KB.');
  const bytes = Buffer.from(value.slice(23), 'base64');
  need(bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8, 'The photo could not be read.');
  return value;
};
// App icons arrive as square PNG data URLs drawn by the Admin's browser from the store logo.
export const pngIcon = value => {
  need(typeof value === 'string' && value.length <= 600_000 && /^data:image\/png;base64,[a-zA-Z0-9+/]+=*$/.test(value), 'The app icon could not be made from this logo.');
  const bytes = Buffer.from(value.slice(22), 'base64');
  need(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, 'The app icon could not be made from this logo.');
  return value;
};
// Offline entries carry the original tap time; accept up to 14 days back.
export const occurredAt = value => {
  const t = value ? new Date(value) : new Date();
  need(Number.isFinite(+t) && +t <= Date.now() + 2 * 60_000 && +t >= Date.now() - 14 * 86_400_000, 'The entry timestamp needs review.');
  return t;
};

// ---- Formatting for API output -----------------------------------------
export const pesos = cents => cents === null || cents === undefined ? null : cents / 100;
export const units = thousandths => thousandths === null || thousandths === undefined ? null : thousandths / 1000;
export const lineTotal = (qtyThousandths, unitPriceCents) => Number((BigInt(qtyThousandths) * BigInt(unitPriceCents) + 500n) / 1000n);
export const effectivePrice = m => m.price === null ? null : Math.round(m.price * (100 - m.discount) / 100);
export const stockStatus = m => m.qty <= 0 ? 'out' : m.qty < m.low ? 'low' : m.qty >= m.high ? 'high' : 'adequate';
export { nowISO, dayOf };
