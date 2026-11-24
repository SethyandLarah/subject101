// Database layer — one SQLite file, all tables, migrations, and helpers.
// Money is stored in centavos (₱1.00 = 100). Quantities are stored in
// thousandths (1 pc = 1000) so kilograms and meters can carry 3 decimals
// while pieces stay whole. The API layer converts both back to plain numbers.
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compute, payFor } from './payroll.mjs';

export const TZ = 'Asia/Manila';
export const ROLES = ['admin', 'sales', 'cashier', 'stock', 'sales+stock', 'attendance'];
// Attendance-only job titles the Admin can pick (plus 'Other' with a custom title).
export const ATTENDANCE_TITLES = ['Staff', 'Cement Worker', 'Delivery Driver', 'Helper', 'Loader'];
export const UNITS = ['pcs', 'rolls', 'bags', 'boxes', 'sets', 'kg', 'meters', 'liters'];
export const DECIMAL_UNITS = new Set(['kg', 'meters', 'liters']);
export const EXPENSE_CATEGORIES = ['Delivery', 'Utilities', 'Supplies', 'Salary', 'Rent', 'Repairs', 'Other'];
export const DEFAULT_CATEGORIES = ['Electrical', 'Plumbing', 'Cement & Masonry', 'Paint & Accessories', 'Fasteners', 'Tools & Equipment', 'Uncategorized'];

// ---- Time helpers (everything in Philippine time) ------------------------
export const nowISO = () => new Date().toISOString();
export const dayOf = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const timeOf = (d = new Date()) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
export const shiftDay = (day, delta) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };
export const monthStart = day => day.slice(0, 7) + '-01';
export const nextMonth = day => { const d = new Date(monthStart(day) + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };

// ---- Passwords ----------------------------------------------------------
export const hashPassword = (password, salt = randomBytes(16).toString('hex')) =>
  salt + ':' + scryptSync(password, salt, 64).toString('hex');
export function checkPassword(password, encoded) {
  const [salt, digest] = String(encoded).split(':');
  const candidate = hashPassword(password, salt).split(':')[1];
  return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(candidate, 'hex'));
}

// ---- Schema -------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','sales','cashier','stock','sales+stock','attendance')),
  active INTEGER NOT NULL DEFAULT 1, temporary INTEGER NOT NULL DEFAULT 0, photo TEXT, job_title TEXT,
  shift_start TEXT NOT NULL DEFAULT '07:00', shift_end TEXT NOT NULL DEFAULT '17:00', created TEXT NOT NULL,
  lunch_start TEXT NOT NULL DEFAULT '11:30', lunch_end TEXT NOT NULL DEFAULT '13:00', daily_rate INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, contact TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS materials(
  id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id),
  qty INTEGER NOT NULL DEFAULT 0 CHECK(qty >= 0), low INTEGER NOT NULL, high INTEGER NOT NULL CHECK(high > low),
  price INTEGER CHECK(price >= 0), discount INTEGER NOT NULL DEFAULT 0 CHECK(discount BETWEEN 0 AND 100),
  photo TEXT, archived INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, promo_type TEXT, promo_qty INTEGER, promo_value INTEGER);
CREATE TABLE IF NOT EXISTS price_history(id INTEGER PRIMARY KEY, material_id INTEGER NOT NULL REFERENCES materials(id),
  old_price INTEGER, new_price INTEGER NOT NULL, old_discount INTEGER NOT NULL, new_discount INTEGER NOT NULL,
  actor INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS movements(id INTEGER PRIMARY KEY, material_id INTEGER NOT NULL REFERENCES materials(id),
  kind TEXT NOT NULL, delta INTEGER NOT NULL, before_qty INTEGER NOT NULL, after_qty INTEGER NOT NULL,
  supplier_id INTEGER REFERENCES suppliers(id), sale_id INTEGER REFERENCES sales(id), reference TEXT NOT NULL DEFAULT '',
  actor INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL, unit_cost INTEGER, remaining INTEGER NOT NULL DEFAULT 0, delivered TEXT);
CREATE TABLE IF NOT EXISTS counts(id INTEGER PRIMARY KEY, material_id INTEGER NOT NULL REFERENCES materials(id),
  expected INTEGER NOT NULL, counted INTEGER NOT NULL, revision INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Pending Approval', actor INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_note TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, actor INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id), kind TEXT NOT NULL CHECK(kind IN ('cash','credit')),
  subtotal INTEGER NOT NULL, discount_total INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  cash_received INTEGER, change_due INTEGER, paid_now INTEGER NOT NULL DEFAULT 0, credit_added INTEGER NOT NULL DEFAULT 0,
  reference TEXT NOT NULL DEFAULT '', voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),
  material_id INTEGER NOT NULL REFERENCES materials(id), name TEXT NOT NULL, unit TEXT NOT NULL, qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL, discount INTEGER NOT NULL, line_total INTEGER NOT NULL,
  regular_price INTEGER, promo TEXT, savings INTEGER NOT NULL DEFAULT 0, cost INTEGER);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  sale_id INTEGER REFERENCES sales(id), amount INTEGER NOT NULL CHECK(amount > 0), reference TEXT NOT NULL DEFAULT '',
  at_counter INTEGER NOT NULL DEFAULT 0, actor INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, actor INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK(amount > 0), category TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '', day TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  day TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('in','lunch_out','lunch_in','out')), occurred TEXT NOT NULL, received TEXT NOT NULL,
  UNIQUE(user_id, day, kind));
CREATE TABLE IF NOT EXISTS attendance_corrections(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  day TEXT NOT NULL, kind TEXT NOT NULL, original TEXT, corrected TEXT NOT NULL, reason TEXT NOT NULL,
  actor INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attendance_marks(user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', actor INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL,
  PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS excuses(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending Approval', note TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, created TEXT NOT NULL, UNIQUE(user_id, day));
CREATE TABLE IF NOT EXISTS schedules(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  effective TEXT NOT NULL, shift_start TEXT NOT NULL, shift_end TEXT NOT NULL, lunch_start TEXT NOT NULL DEFAULT '11:30', lunch_end TEXT NOT NULL DEFAULT '13:00', actor INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS earnings(user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL, worked_minutes INTEGER NOT NULL,
  scheduled_minutes INTEGER NOT NULL, rate INTEGER, amount INTEGER, status TEXT NOT NULL, format TEXT NOT NULL, finalized TEXT NOT NULL,
  PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS salary_payments(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL CHECK(amount >= 0),
  from_day TEXT NOT NULL, to_day TEXT NOT NULL, pay_date TEXT NOT NULL, method TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '',
  days INTEGER NOT NULL, actor INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS salary_payment_days(user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
  payment_id INTEGER NOT NULL REFERENCES salary_payments(id), amount INTEGER NOT NULL, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS sale_allocations(id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),
  material_id INTEGER NOT NULL REFERENCES materials(id), lot_id INTEGER NOT NULL REFERENCES movements(id), qty INTEGER NOT NULL, unit_cost INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, actor INTEGER NOT NULL REFERENCES users(id),
  recipient INTEGER REFERENCES users(id), kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notification_reads(notification_id INTEGER NOT NULL REFERENCES notifications(id),
  user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(notification_id, user_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests(actor INTEGER NOT NULL REFERENCES users(id), key TEXT NOT NULL, digest TEXT NOT NULL,
  result TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(actor, key));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sale_alloc_sale ON sale_allocations(sale_id);
CREATE INDEX IF NOT EXISTS ix_materials_name ON materials(name);
CREATE INDEX IF NOT EXISTS ix_materials_category ON materials(category_id);
CREATE INDEX IF NOT EXISTS ix_movements_material ON movements(material_id, id);
CREATE INDEX IF NOT EXISTS ix_movements_created ON movements(created);
CREATE INDEX IF NOT EXISTS ix_sales_day ON sales(day, id);
CREATE INDEX IF NOT EXISTS ix_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS ix_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS ix_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS ix_payments_day ON payments(day);
CREATE INDEX IF NOT EXISTS ix_expenses_day ON expenses(day);
CREATE INDEX IF NOT EXISTS ix_attendance_day ON attendance(day);
CREATE INDEX IF NOT EXISTS ix_attendance_user ON attendance(user_id, day);
CREATE INDEX IF NOT EXISTS ix_excuses_day ON excuses(day);
CREATE INDEX IF NOT EXISTS ix_notifications_recipient ON notifications(recipient, id);
CREATE INDEX IF NOT EXISTS ix_customers_name ON customers(name);
`;

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL + NORMAL sync is crash-safe for WAL and much faster on SD cards / cheap disks.
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000;');
  db.exec(SCHEMA);
  for (const table of ['sales', 'payments']) {
    if (!db.prepare('PRAGMA table_info(' + table + ')').all().some(column => column.name === 'payment_method')) {
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN payment_method TEXT');
    }
  }
  migrateUsers(db);
  migrateV23(db);
  migrateV24(db);
  migrateV25(db);
  migrateV26(db);
  migrateV27(db);
  if (!db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === 'prepared_payment')) {
    db.exec('ALTER TABLE orders ADD COLUMN prepared_payment TEXT');
  }
  // v2.9.1: each account remembers its language (NULL = not chosen yet; the device setting is used).
  // Added after the users-table migrations above, so a rebuild of an old table cannot drop it.
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'lang')) {
    db.exec("ALTER TABLE users ADD COLUMN lang TEXT CHECK (lang IS NULL OR lang IN ('en','fil'))");
  }
  // Indexes for the per-person lists that grow every day (Cashier/Clerk sales, payments, orders…).
  db.exec(`CREATE INDEX IF NOT EXISTS ix_sales_actor ON sales(actor, day);
    CREATE INDEX IF NOT EXISTS ix_sales_clerk ON sales(clerk_id, day);
    CREATE INDEX IF NOT EXISTS ix_payments_actor ON payments(actor, day);
    CREATE INDEX IF NOT EXISTS ix_expenses_actor ON expenses(actor, day);
    CREATE INDEX IF NOT EXISTS ix_orders_clerk ON orders(clerk, id);
    CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS ix_audit_created ON audit(created);
    CREATE INDEX IF NOT EXISTS ix_cash_counts_day ON cash_counts(day, cashier);`);
  db.exec('PRAGMA optimize');
  // Default categories exist on every database so new materials always have one.
  const addCategory = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)');
  for (const name of DEFAULT_CATEGORIES) addCategory.run(name);
  return db;
}

// Older databases: add job_title and allow the 'attendance' role (rebuild the
// users table because SQLite cannot alter a CHECK constraint in place).
function migrateUsers(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!columns.includes('job_title')) db.exec('ALTER TABLE users ADD COLUMN job_title TEXT');
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
  if (ddl.includes("'attendance'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE users_new(
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','sales','cashier','stock','sales+stock','attendance')),
      active INTEGER NOT NULL DEFAULT 1, temporary INTEGER NOT NULL DEFAULT 0, photo TEXT, job_title TEXT,
      shift_start TEXT NOT NULL DEFAULT '07:00', shift_end TEXT NOT NULL DEFAULT '17:00', created TEXT NOT NULL)`);
    db.exec('INSERT INTO users_new(id,username,name,password,role,active,temporary,photo,job_title,shift_start,shift_end,created) SELECT id,username,name,password,role,active,temporary,photo,job_title,shift_start,shift_end,created FROM users');
    db.exec('DROP TABLE users'); db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys = ON'); }
}

// v2.3: lunch taps, earnings, costs and promos on databases created earlier.
function migrateV23(db) {
  const addColumn = (table, column, ddl) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
  addColumn('users', 'lunch_start', "TEXT NOT NULL DEFAULT '11:30'"); addColumn('users', 'lunch_end', "TEXT NOT NULL DEFAULT '13:00'"); addColumn('users', 'daily_rate', 'INTEGER');
  addColumn('schedules', 'lunch_start', "TEXT NOT NULL DEFAULT '11:30'"); addColumn('schedules', 'lunch_end', "TEXT NOT NULL DEFAULT '13:00'");
  addColumn('movements', 'unit_cost', 'INTEGER'); addColumn('movements', 'remaining', 'INTEGER NOT NULL DEFAULT 0'); addColumn('movements', 'delivered', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS ix_movements_lots ON movements(material_id, remaining)');
  addColumn('sale_items', 'regular_price', 'INTEGER'); addColumn('sale_items', 'promo', 'TEXT'); addColumn('sale_items', 'savings', 'INTEGER NOT NULL DEFAULT 0'); addColumn('sale_items', 'cost', 'INTEGER');
  addColumn('materials', 'promo_type', 'TEXT'); addColumn('materials', 'promo_qty', 'INTEGER'); addColumn('materials', 'promo_value', 'INTEGER');
  // Legacy percent discounts become a percentage promo (same effect at checkout).
  db.exec("UPDATE materials SET promo_type='percent', promo_value=discount WHERE promo_type IS NULL AND discount > 0");
  // Attendance: allow the two lunch taps (rebuild for the CHECK constraint). Old two-tap rows are kept as they are.
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attendance'").get()?.sql || '';
  if (!ddl.includes('lunch_out')) {
    db.exec('PRAGMA foreign_keys = OFF'); db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE attendance_new(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('in','lunch_out','lunch_in','out')), occurred TEXT NOT NULL, received TEXT NOT NULL, UNIQUE(user_id, day, kind))`);
      db.exec('INSERT INTO attendance_new(id,user_id,day,kind,occurred,received) SELECT id,user_id,day,kind,occurred,received FROM attendance');
      db.exec('DROP TABLE attendance'); db.exec('ALTER TABLE attendance_new RENAME TO attendance');
      db.exec('CREATE INDEX IF NOT EXISTS ix_attendance_day ON attendance(day)'); db.exec('CREATE INDEX IF NOT EXISTS ix_attendance_user ON attendance(user_id, day)');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  // Existing stock without purchase costs: one "opening" lot per material so FIFO can run; cost stays unknown until Admin enters it.
  if (!db.prepare("SELECT value FROM settings WHERE key='lots_seeded'").get()) {
    const materials = db.prepare('SELECT id, qty FROM materials').all();
    const lotSum = db.prepare('SELECT coalesce(sum(remaining),0) AS r FROM movements WHERE material_id=?');
    const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
    const insert = db.prepare("INSERT INTO movements(material_id,kind,delta,before_qty,after_qty,reference,actor,created,unit_cost,remaining) VALUES (?,'Opening stock',0,?,?,'Existing stock (cost pending)',?,?,NULL,?)");
    if (admin) for (const m of materials) { const missing = m.qty - lotSum.get(m.id).r; if (missing > 0) insert.run(m.id, m.qty, m.qty, admin.id, nowISO(), missing); }
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('lots_seeded','1')").run();
  }
}

// v2.4: excuse coverage + paid flag, rate history, payable minutes, Tawad pricing.
function migrateV24(db) {
  const addColumn = (table, column, ddl) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
  addColumn('excuses', 'coverage', "TEXT NOT NULL DEFAULT 'whole'"); addColumn('excuses', 'paid', 'INTEGER'); addColumn('excuses', 'emergency', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('earnings', 'payable_minutes', 'INTEGER'); addColumn('earnings', 'flags', "TEXT NOT NULL DEFAULT ''"); addColumn('earnings', 'review', 'INTEGER NOT NULL DEFAULT 0');
  // Older earnings rows: payable = worked capped at scheduled; short/overtime/incomplete stay flagged.
  db.exec("UPDATE earnings SET payable_minutes=min(worked_minutes, scheduled_minutes), review=CASE WHEN status IN ('overtime','incomplete') THEN 1 ELSE 0 END WHERE payable_minutes IS NULL");
  db.exec(`CREATE TABLE IF NOT EXISTS rates(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), rate INTEGER NOT NULL CHECK(rate >= 0),
    effective TEXT NOT NULL, actor INTEGER REFERENCES users(id), created TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_rates_user ON rates(user_id, effective)');
  db.exec(`CREATE TABLE IF NOT EXISTS morning_absences(user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL, reason TEXT NOT NULL,
    actor INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL, PRIMARY KEY(user_id, day))`);
  // Existing single rates become the first entry of each employee's rate history (applies to all earlier dates).
  db.exec("INSERT INTO rates(user_id,rate,effective,actor,created) SELECT id, daily_rate, '0000-01-01', NULL, datetime('now') FROM users u WHERE daily_rate IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rates r WHERE r.user_id=u.id)");
  addColumn('sales', 'pricing_mode', "TEXT NOT NULL DEFAULT 'regular'"); addColumn('sales', 'regular_subtotal', 'INTEGER'); addColumn('sales', 'tawad_discount', 'INTEGER NOT NULL DEFAULT 0'); addColumn('sales', 'tawad_reason', 'TEXT');
  addColumn('sale_items', 'pricing_mode', "TEXT NOT NULL DEFAULT 'regular'"); addColumn('sale_items', 'line_discount', 'INTEGER NOT NULL DEFAULT 0');
  db.exec("UPDATE sales SET regular_subtotal=subtotal WHERE regular_subtotal IS NULL");
  db.exec("UPDATE sale_items SET pricing_mode='promo' WHERE promo IS NOT NULL AND pricing_mode='regular'");
}

// v2.5: Main Admin, private valid IDs, Time Out grace + auto closure, offline approval inbox.
function migrateV25(db) {
  const addColumn = (table, column, ddl) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
  addColumn('users', 'is_main', 'INTEGER NOT NULL DEFAULT 0');
  // The first Admin account (the store owner) becomes Main Admin.
  if (!db.prepare('SELECT 1 FROM users WHERE is_main=1').get()) db.exec("UPDATE users SET is_main=1 WHERE id=(SELECT min(id) FROM users WHERE role='admin')");
  db.exec(`CREATE TABLE IF NOT EXISTS staff_ids(user_id INTEGER PRIMARY KEY REFERENCES users(id), mime TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
    data BLOB NOT NULL, uploaded_by INTEGER NOT NULL REFERENCES users(id), uploaded_at TEXT NOT NULL)`);
  // Attendance taps: where the tap came from, and for session starts the cutoff / grace deadline that applied.
  addColumn('attendance', 'source', "TEXT NOT NULL DEFAULT 'manual'");
  addColumn('attendance', 'cutoff', 'TEXT'); addColumn('attendance', 'grace_deadline', 'TEXT'); addColumn('attendance', 'grace_minutes', 'INTEGER');
  db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES ('grace_minutes','10')");
  db.exec(`CREATE TABLE IF NOT EXISTS offline_inbox(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL,
    body TEXT NOT NULL, occurred TEXT NOT NULL, uploaded TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','needs_review','rejected')),
    result TEXT, error TEXT, reviewer INTEGER REFERENCES users(id), reviewed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_inbox_status ON offline_inbox(status, uploaded)');
}

// v2.6.1: Cashier records expenses paid out of the cash drawer.
function migrateV27(db) {
  const addColumn = (table, column, ddl) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
  addColumn('expenses', 'from_drawer', 'INTEGER NOT NULL DEFAULT 0');
}

// v2.6: separate Cashier role; Sales Clerk prepares orders, Cashier receives payment.
function migrateV26(db) {
  const addColumn = (table, column, ddl) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
  // Allow the 'cashier' role: rebuild users with the same columns and a wider CHECK (keeps ids and history).
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
  if (ddl && !ddl.includes("'cashier'")) {
    const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name).join(',');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(ddl.replace(/CREATE TABLE "?users"?/, 'CREATE TABLE users_new').replace(/'sales','stock'/, "'sales','cashier','stock'"));
      db.exec(`INSERT INTO users_new(${cols}) SELECT ${cols} FROM users`);
      db.exec('DROP TABLE users'); db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  addColumn('sales', 'clerk_id', 'INTEGER REFERENCES users(id)');
  addColumn('sales', 'order_id', 'INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, clerk INTEGER NOT NULL REFERENCES users(id), customer_id INTEGER REFERENCES customers(id),
    customer_name TEXT, note TEXT, lines TEXT NOT NULL, pricing_mode TEXT NOT NULL DEFAULT 'regular', tawad_amount INTEGER, tawad_reason TEXT,
    regular_subtotal INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','paid','cancelled')),
    sale_id INTEGER REFERENCES sales(id), cashier INTEGER REFERENCES users(id), cancel_reason TEXT, created TEXT NOT NULL, closed TEXT, day TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status, id)');
  db.exec(`CREATE TABLE IF NOT EXISTS cash_counts(id INTEGER PRIMARY KEY, cashier INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL, expected INTEGER NOT NULL,
    counted INTEGER NOT NULL, note TEXT, created TEXT NOT NULL)`);
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---- Demo seed ----------------------------------------------------------
export function seedDemo(db, password) {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
  const created = nowISO();
  const user = db.prepare('INSERT INTO users(username,name,password,role,created) VALUES (?,?,?,?,?)');
  transaction(db, () => {
    user.run('admin', 'Kuya Mac', hashPassword(password), 'admin', created);
    user.run('sales', 'Ana Reyes', hashPassword(password), 'sales', created);
    user.run('stock', 'Marco Santos', hashPassword(password), 'stock', created);
    user.run('both', 'Jomar Dela Cruz', hashPassword(password), 'sales+stock', created);
    const worker = db.prepare('INSERT INTO users(username,name,password,role,job_title,created) VALUES (?,?,?,?,?,?)');
    worker.run('driver', 'Rey Villanueva', hashPassword(password), 'attendance', 'Delivery Driver', created);
    worker.run('helper', 'Boyet Alcantara', hashPassword(password), 'attendance', 'Helper', created);
    worker.run('cement', 'Dodong Rabanes', hashPassword(password), 'attendance', 'Cement Worker', created);
    user.run('cashier', 'Lorna Cruz', hashPassword(password), 'cashier', created);
    const rate = db.prepare('UPDATE users SET daily_rate=?, shift_start=?, lunch_start=?, lunch_end=?, shift_end=? WHERE username=?');
    const rateHist = db.prepare("INSERT INTO rates(user_id,rate,effective,actor,created) SELECT id, ?, '0000-01-01', 1, ? FROM users WHERE username=?");
    for (const [u, r] of [['sales', 55000], ['cashier', 55000], ['stock', 55000], ['both', 60000], ['driver', 50000], ['helper', 45000], ['cement', 52000]]) { rate.run(r, '07:30', '11:30', '13:00', '17:00', u); rateHist.run(r, created, u); }

    const supplier = db.prepare('INSERT INTO suppliers(name,contact,address,created) VALUES (?,?,?,?)');
    supplier.run('Prosperidad Builders Depot', '0917 555 0101', 'Poblacion, Prosperidad', created);
    supplier.run('Caraga Steel & Cement', '0918 555 0202', 'San Francisco, Agusan del Sur', created);
    supplier.run('Mindanao Paint Center', '0919 555 0303', 'Butuan City', created);

    const cat = name => db.prepare('SELECT id FROM categories WHERE name=?').get(name).id;
    const material = db.prepare('INSERT INTO materials(sku,name,variant,unit,category_id,qty,low,high,price,discount,created,photo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const move = db.prepare("INSERT INTO movements(material_id,kind,delta,before_qty,after_qty,reference,actor,created,unit_cost,remaining) VALUES (?,'Opening stock',?,0,?,'Opening balance',1,?,?,?)");
    const items = [
      ['ELT-001', 'Electrical Tape', 'Black · 10m', 'rolls', 'Electrical', 30, 10, 60, 35.00, 0],
      ['WIR-014', 'THHN Wire', '#14 · per meter', 'meters', 'Electrical', 420.5, 100, 800, 18.50, 0],
      ['OUT-002', 'Duplex Outlet', 'Universal', 'pcs', 'Electrical', 48, 15, 80, 85.00, 5],
      ['BLB-009', 'LED Bulb', '9W Daylight', 'pcs', 'Electrical', 7, 12, 60, 120.00, 0],
      ['PVC-012', 'PVC Elbow', '½ in', 'pcs', 'Plumbing', 142, 40, 200, 12.00, 0],
      ['PVC-020', 'PVC Pipe', '½ in × 3m', 'pcs', 'Plumbing', 36, 20, 100, 95.00, 0],
      ['TFT-001', 'Teflon Tape', '½ in', 'rolls', 'Plumbing', 0, 20, 100, 15.00, 0],
      ['FCT-003', 'Faucet', 'Stainless · Standard', 'pcs', 'Plumbing', 14, 5, 30, 185.00, 10],
      ['CEM-001', 'Portland Cement', 'Type 1 · 40kg', 'bags', 'Cement & Masonry', 64, 30, 150, 265.00, 0],
      ['HBL-004', 'Hollow Blocks', '4 in', 'pcs', 'Cement & Masonry', 820, 300, 1500, 14.00, 0],
      ['SND-001', 'Fine Sand', 'per bag', 'bags', 'Cement & Masonry', 25, 20, 80, 45.00, 0],
      ['PNT-007', 'Paint Roller', '7 in', 'pcs', 'Paint & Accessories', 0, 10, 40, 85.00, 0],
      ['PNT-101', 'Latex Paint', 'White · 4L', 'pcs', 'Paint & Accessories', 22, 8, 40, 650.00, 0],
      ['BRS-002', 'Paint Brush', '2 in', 'pcs', 'Paint & Accessories', 55, 15, 60, 35.00, 0],
      ['NLS-002', 'Common Nails', '2 in', 'kg', 'Fasteners', 12.25, 10, 50, 80.00, 0],
      ['NLS-004', 'Common Nails', '4 in', 'kg', 'Fasteners', 38, 10, 50, 78.00, 0],
      ['SCR-001', 'Drywall Screws', '1 in · per box', 'boxes', 'Fasteners', 19, 6, 30, 145.00, 0],
      ['HMR-001', 'Claw Hammer', '16 oz', 'pcs', 'Tools & Equipment', 9, 3, 15, 320.00, 0],
      ['TPM-005', 'Tape Measure', '5m', 'pcs', 'Tools & Equipment', 16, 5, 25, 150.00, 0],
      ['DRL-001', 'Cordless Drill', '12V', 'pcs', 'Tools & Equipment', 3, 2, 8, 2450.00, 0],
      ['GLV-001', 'Work Gloves', 'Pair', 'pcs', 'Tools & Equipment', 40, 10, 60, null, 0],
    ];
    const photoDir = new URL('../demo-photos/', import.meta.url);
    const photoOf = sku => { const f = new URL(sku + '.jpg', photoDir); return existsSync(f) ? 'data:image/jpeg;base64,' + readFileSync(f).toString('base64') : null; };
    for (const [sku, name, variant, unit, category, qty, low, high, price, discount] of items) {
      const q = Math.round(qty * 1000);
      const result = material.run(sku, name, variant, unit, cat(category), q, low * 1000, high * 1000, price === null ? null : Math.round(price * 100), discount, created, photoOf(sku));
      if (q > 0) move.run(result.lastInsertRowid, q, q, created, price === null ? null : Math.round(price * 65), q);
    }

    const customer = db.prepare('INSERT INTO customers(name,phone,address,created) VALUES (?,?,?,?)');
    customer.run('Rodel Batiancila', '0920 555 1111', 'Purok 2, Patin-ay', created);
    customer.run('Mang Tonyo Cabrera', '0921 555 2222', 'Poblacion, Prosperidad', created);
    customer.run('Liza Montero', '0922 555 3333', 'San Vicente, Prosperidad', created);

    db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('store_name', 'JS ALAAN HARDWARE');
  });
}

// Realistic sales/expense history for the demo dashboard (last 60 days).
export function seedDemoHistory(db) {
  if (db.prepare('SELECT 1 FROM sales LIMIT 1').get()) return;
  const sellable = db.prepare('SELECT * FROM materials WHERE price IS NOT NULL AND qty > 0').all();
  const sale = db.prepare('INSERT INTO sales(actor,customer_id,kind,subtotal,discount_total,total,cash_received,change_due,paid_now,credit_added,reference,day,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const item = db.prepare('INSERT INTO sale_items(sale_id,material_id,name,unit,qty,unit_price,discount,line_total,regular_price,promo,savings,cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const alloc = db.prepare('INSERT INTO sale_allocations(sale_id,material_id,lot_id,qty,unit_cost) VALUES (?,?,?,?,?)');
  const lotOf = db.prepare("SELECT id, unit_cost FROM movements WHERE material_id=? AND kind='Opening stock' LIMIT 1");
  const move = db.prepare("INSERT INTO movements(material_id,kind,delta,before_qty,after_qty,sale_id,reference,actor,created) VALUES (?,'Sale',?,?,?,?,?,?,?)");
  const update = db.prepare('UPDATE materials SET qty=? WHERE id=?');
  const expense = db.prepare('INSERT INTO expenses(actor,amount,category,detail,reference,day,created) VALUES (1,?,?,?,?,?,?)');
  const payment = db.prepare('INSERT INTO payments(customer_id,sale_id,amount,reference,at_counter,actor,day,created) VALUES (?,?,?,?,1,?,?,?)');
  const collect = db.prepare('INSERT INTO payments(customer_id,sale_id,amount,reference,at_counter,actor,day,created) VALUES (?,NULL,?,?,0,?,?,?)');
  let seed = 7;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const today = dayOf();
  // Pass 1: plan every sale. Pass 2: raise the opening balance by what the
  // history consumes, so the final stock equals the designed demo quantities
  // (including the intentional low / out-of-stock items).
  const plan = [];
  {
    const nowHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
    for (let back = 420; back >= 0; back--) {
      const day = shiftDay(today, -back);
      const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
      const count = weekday === 0 ? 2 : 4 + Math.floor(rand() * 5);
      for (let s = 0; s < count; s++) {
        const hour = 8 + Math.floor(rand() * 9), minute = Math.floor(rand() * 60);
        if (back === 0 && hour >= nowHour) continue;
        const created = new Date(day + 'T' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':00+08:00').toISOString();
        const lines = 1 + Math.floor(rand() * 3);
        const chosen = new Set();
        const parts = [];
        for (let l = 0; l < lines; l++) {
          const m = sellable[Math.floor(rand() * sellable.length)];
          if (chosen.has(m.id)) continue;
          if (m.price > 100000 && rand() < 0.85) continue; // big-ticket items sell rarely
          chosen.add(m.id);
          const whole = !DECIMAL_UNITS.has(m.unit);
          const qty = whole ? (1 + Math.floor(rand() * (m.price > 20000 ? 2 : 5))) * 1000 : Math.round((0.5 + rand() * 6) * 1000);
          parts.push({ m, qty });
        }
        plan.push({ day, created, parts, credit: rand() < 0.09, actor: rand() < 0.5 ? 2 : 4, r1: rand(), r2: rand(), r3: rand(), expense: rand() });
      }
    }
  }
  const consumed = {};
  for (const p of plan) for (const part of p.parts) consumed[part.m.id] = (consumed[part.m.id] || 0) + part.qty;
  const fixOpening = db.prepare("UPDATE movements SET delta=?, after_qty=?, remaining=? WHERE material_id=? AND kind='Opening stock'");
  const insertOpening = db.prepare("INSERT INTO movements(material_id,kind,delta,before_qty,after_qty,reference,actor,created,unit_cost,remaining) VALUES (?,'Opening stock',?,0,?,'Opening balance',1,?,?,?)");
  transaction(db, () => {
    const stock = {};
    for (const m of sellable) {
      const opening = m.qty + (consumed[m.id] || 0);
      stock[m.id] = opening;
      if (fixOpening.run(opening, opening, m.qty, m.id).changes === 0) insertOpening.run(m.id, opening, opening, shiftDay(today, -421) + 'T00:00:00.000Z', Math.round(m.price * .65), m.qty);
    }
    for (const p of plan) {
      const { day, created, credit, actor } = p;
      let subtotal = 0, discountTotal = 0;
      const parts = [];
      for (const { m, qty } of p.parts) {
        const unitPrice = Math.round(m.price * (100 - m.discount) / 100);
        const gross = Number((BigInt(qty) * BigInt(m.price) + 500n) / 1000n);
        const lineTotal = Number((BigInt(qty) * BigInt(unitPrice) + 500n) / 1000n);
        subtotal += gross; discountTotal += gross - lineTotal;
        parts.push({ m, qty, unitPrice, lineTotal });
      }
      const total = subtotal - discountTotal;
      const customer = credit ? 1 + Math.floor(p.r1 * 3) : null;
      const paidNow = credit ? (p.r2 < 0.5 ? 0 : Math.round(total * 0.4 / 100) * 100) : total;
      const cash = credit ? null : total + [0, 0, 500, 1000, 2000, 10000][Math.floor(p.r3 * 6)];
      const id = sale.run(actor, customer, credit ? 'credit' : 'cash', subtotal, discountTotal, total, cash, cash === null ? null : cash - total, paidNow, credit ? total - paidNow : 0, '', day, created).lastInsertRowid;
      for (const q of parts) {
        const lot = lotOf.get(q.m.id); const cost = lot && lot.unit_cost !== null ? Number((BigInt(q.qty) * BigInt(lot.unit_cost) + 500n) / 1000n) : null;
        item.run(id, q.m.id, q.m.name + (q.m.variant ? ' · ' + q.m.variant : ''), q.m.unit, q.qty, q.unitPrice, q.m.discount, q.lineTotal, q.m.price, q.m.discount ? JSON.stringify({ type: 'percent', value: q.m.discount, label: q.m.discount + '% off', applied: true }) : null, Number((BigInt(q.qty) * BigInt(q.m.price) + 500n) / 1000n) - q.lineTotal, cost);
        if (lot) alloc.run(id, q.m.id, lot.id, q.qty, lot.unit_cost ?? -1);
        const before = stock[q.m.id]; stock[q.m.id] -= q.qty;
        move.run(q.m.id, -q.qty, before, stock[q.m.id], id, 'Sale #' + id, actor, created);
      }
      if (credit && paidNow > 0) payment.run(customer, id, paidNow, 'Paid at counter', actor, day, created);
      // Later collection on part of the credit (so Collections has data).
      if (credit && p.r3 < 0.6) {
        const payDay = shiftDay(day, 3 + Math.floor(p.r2 * 6));
        const amount = p.r1 < 0.5 ? total - paidNow : Math.floor((total - paidNow) * 0.5 / 100) * 100;
        if (payDay < today && amount > 0) collect.run(customer, amount, 'Cash', actor, payDay, new Date(payDay + 'T10:30:00+08:00').toISOString());
      }
      if (p.expense < 0.09) {
        const cats = ['Delivery', 'Utilities', 'Supplies', 'Other'];
        const c = cats[Math.floor(p.r1 * cats.length)];
        expense.run(Math.round((300 + p.r2 * 2500)) * 100, c, c === 'Other' ? 'Store repairs' : '', 'Demo expense', day, new Date(day + 'T15:00:00+08:00').toISOString());
      }
    }
    for (const m of sellable) update.run(stock[m.id], m.id);
    // Demo split: the Sales Clerk prepared each order, the Cashier received the payment.
    const cashier = db.prepare("SELECT id FROM users WHERE username='cashier'").get()?.id;
    if (cashier) { db.prepare('UPDATE sales SET clerk_id=actor, actor=? WHERE actor IN (2,4)').run(cashier); db.prepare('UPDATE payments SET actor=? WHERE actor IN (2,4)').run(cashier); }
  });
}

// Demo attendance, a pending excuse and a pending count so review screens have data.
export function seedDemoAttendance(db) {
  if (db.prepare('SELECT 1 FROM attendance LIMIT 1').get()) return;
  const staff = db.prepare("SELECT id FROM users WHERE role<>'admin'").all();
  const today = dayOf();
  const att = db.prepare('INSERT OR IGNORE INTO attendance(user_id,day,kind,occurred,received) VALUES (?,?,?,?,?)');
  const excuse = db.prepare('INSERT OR IGNORE INTO excuses(user_id,day,reason,status,note,reviewed_by,reviewed_at,created) VALUES (?,?,?,?,?,?,?,?)');
  let seed = 11; const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  transaction(db, () => {
    for (let back = 45; back >= 1; back--) {
      const day = shiftDay(today, -back);
      if (new Date(day + 'T00:00:00Z').getUTCDay() === 0) continue;
      for (const s of staff) {
        const r = rand();
        if (r < 0.06) { excuse.run(s.id, day, 'Medical check-up', 'Excused', 'Approved · get well', 1, new Date(day + 'T06:00:00+08:00').toISOString(), new Date(shiftDay(day, -1) + 'T18:00:00+08:00').toISOString()); continue; }
        if (r < 0.09) continue; // absent
        const four = back <= 20; // recent days use the four-tap format; older days stay legacy two-tap history
        const v = rand(); // most days are on schedule; a few leave early or stay late for the review queue
        const inMin = four ? 80 + Math.floor(rand() * 12) : 50 + Math.floor(rand() * 25);
        const outMin = four ? (v < 0.07 ? -90 : v < 0.12 ? 75 : Math.floor(rand() * 9)) : Math.floor(rand() * 40);
        const tin = new Date(new Date(`${day}T06:00:00+08:00`).getTime() + inMin * 60000), tout = new Date(new Date(`${day}T17:00:00+08:00`).getTime() + outMin * 60000);
        att.run(s.id, day, 'in', tin.toISOString(), tin.toISOString());
        if (four) {
          const lo = new Date(new Date(`${day}T11:30:00+08:00`).getTime() + Math.floor(rand() * 5) * 60000), li = new Date(new Date(`${day}T12:55:00+08:00`).getTime() + Math.floor(rand() * 5) * 60000);
          att.run(s.id, day, 'lunch_out', lo.toISOString(), lo.toISOString()); att.run(s.id, day, 'lunch_in', li.toISOString(), li.toISOString());
        }
        if (rand() > 0.03) att.run(s.id, day, 'out', tout.toISOString(), tout.toISOString());
      }
    }
    excuse.run(staff[0].id, shiftDay(today, 2), 'Barangay clearance appointment in the morning', 'Pending Approval', '', null, null, nowISO());
    // Earnings for every completed day, using each employee's rate; one sample salary payment for the driver.
    const users = db.prepare("SELECT * FROM users WHERE role<>'admin'").all();
    const ins = db.prepare('INSERT OR REPLACE INTO earnings(user_id,day,worked_minutes,scheduled_minutes,payable_minutes,rate,amount,status,format,flags,review,finalized) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const u of users) {
      // Earnings exist only for four-tap days (legacy two-tap history predates daily rates).
      const days = db.prepare("SELECT day FROM attendance WHERE user_id=? AND kind='out' AND day IN (SELECT day FROM attendance WHERE user_id=? AND kind='lunch_out')").all(u.id, u.id).map(r => r.day);
      for (const d of days) {
        const taps = {}; for (const r of db.prepare('SELECT kind, occurred FROM attendance WHERE user_id=? AND day=?').all(u.id, d)) taps[r.kind] = r.occurred;
        const w = compute(taps, { day: d, schedule: { start: '07:30', end: '17:00', lunchStart: '11:30', lunchEnd: '13:00' } });
        ins.run(u.id, d, w.minutes, w.scheduled, w.payable, u.daily_rate, payFor(u.daily_rate, w.payable), w.status, w.format, w.flags.join(','), w.review ? 1 : 0, nowISO());
      }
    }
    const driver = users.find(u => u.username === 'driver');
    if (driver) {
      const from = shiftDay(today, -20), to = shiftDay(today, -11);
      const rows = db.prepare('SELECT day, amount FROM earnings WHERE user_id=? AND day BETWEEN ? AND ?').all(driver.id, from, to);
      const total = rows.reduce((a, r) => a + r.amount, 0);
      const pid = db.prepare('INSERT INTO salary_payments(user_id,amount,from_day,to_day,pay_date,method,reference,days,actor,created) VALUES (?,?,?,?,?,?,?,?,1,?)').run(driver.id, total, from, to, shiftDay(today, -10), 'Cash', 'Demo payroll', rows.length, nowISO()).lastInsertRowid;
      const mark = db.prepare('INSERT INTO salary_payment_days(user_id,day,payment_id,amount) VALUES (?,?,?,?)');
      for (const r of rows) mark.run(driver.id, r.day, pid, r.amount);
    }
    const m = db.prepare("SELECT * FROM materials WHERE sku='PVC-012'").get();
    if (m) db.prepare('INSERT INTO counts(material_id,expected,counted,revision,note,actor,created) VALUES (?,?,?,?,?,?,?)').run(m.id, m.qty, m.qty - 3000, db.prepare('SELECT coalesce(max(id),0) AS r FROM movements WHERE material_id=?').get(m.id).r, 'Shelf count after delivery', staff[1].id, nowISO());
  });
}
