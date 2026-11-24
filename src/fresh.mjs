// Fresh start for going live (e.g. before turning the system into the app).
// Makes a NEW store database that keeps the set-up — accounts (with their passwords, roles,
// photos and Valid IDs), pay rates, schedules, store settings (name, logo, background, brand
// colour, grace period) and categories — and has ZERO business data: no materials, sales,
// utang, customers, suppliers, attendance, payroll, expenses, orders, notifications or logs.
// The source database is never changed; it is copied first.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashPassword } from './db.mjs';

/** Passwords that everyone knows (demo) can never be the live Admin password. */
export const KNOWN_PASSWORDS = ['alaan2026!', 'password', 'password1', 'admin123', '12345678', '123456789', 'qwerty123'];

/** Tables that are kept as they are (the store's set-up). Everything else is emptied. */
export const KEEP = ['users', 'rates', 'schedules', 'staff_ids', 'settings', 'categories'];

export function freshStart(source, dest, { keepCategories = true, adminOnly = false, adminPassword = null } = {}) {
  // Go-live mode: only the Main Admin account stays, and it must get a new, private password.
  if (adminOnly) {
    const pw = String(adminPassword ?? '');
    if (pw.length < 8) throw new Error('The new Admin password needs at least 8 characters.');
    if (pw.length > 128) throw new Error('The new Admin password is too long (128 characters at most).');
    if (KNOWN_PASSWORDS.includes(pw.toLowerCase())) throw new Error('That password is known (demo / common). Choose a private password.');
  }
  if (!existsSync(source)) throw new Error('Source database not found: ' + source);
  const tmp = dest + '.fresh-tmp';
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) if (existsSync(f)) unlinkSync(f);
  mkdirSync(dirname(dest), { recursive: true });
  const src = new DatabaseSync(source);
  src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);   // consistent copy, even while the server runs
  src.close();

  const db = new DatabaseSync(tmp);
  const keep = new Set(keepCategories ? KEEP : KEEP.filter(t => t !== 'categories'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  const before = Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n]));
  db.exec('PRAGMA foreign_keys = OFF; BEGIN');
  for (const t of tables) if (!keep.has(t)) db.exec(`DELETE FROM "${t}"`);
  if (tables.includes('sqlite_sequence')) db.exec('DELETE FROM sqlite_sequence');
  // Staff start clean: no open sign-ins, no "must review" leftovers; accounts and passwords stay.
  if (adminOnly) {
    const main = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY is_main DESC, id LIMIT 1").get();
    if (!main) { db.exec('ROLLBACK'); db.close(); unlinkSync(tmp); throw new Error('No active Admin account found in ' + source); }
    for (const t of ['rates', 'schedules', 'staff_ids']) if (tables.includes(t)) db.prepare(`DELETE FROM "${t}" WHERE user_id<>?`).run(main.id);
    if (tables.includes('rates')) db.prepare('UPDATE rates SET actor=NULL WHERE actor IS NOT NULL AND actor<>?').run(main.id);
    if (tables.includes('staff_ids')) db.prepare('UPDATE staff_ids SET uploaded_by=? WHERE uploaded_by<>?').run(main.id, main.id);
    db.prepare('DELETE FROM users WHERE id<>?').run(main.id);
    db.prepare('UPDATE users SET is_main=1, active=1, temporary=0, password=? WHERE id=?').run(hashPassword(String(adminPassword)), main.id);
  }
  db.exec('COMMIT; PRAGMA foreign_keys = ON;');
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) { db.close(); unlinkSync(tmp); throw new Error('Fresh start check failed: ' + JSON.stringify(broken.slice(0, 3))); }
  db.exec('VACUUM');
  const after = Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n]));
  const accounts = db.prepare("SELECT username, name, role, is_main AS main, active FROM users ORDER BY id").all();
  db.close();

  // Keep the previous store database (if any) as a dated backup, then put the fresh one in place.
  let previous = null;
  if (existsSync(dest)) {
    const dir = join(dirname(dest), 'backups'); mkdirSync(dir, { recursive: true });
    previous = join(dir, `before-fresh-start-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.sqlite`);
    const old = new DatabaseSync(dest); old.exec(`VACUUM INTO '${previous.replace(/'/g, "''")}'`); old.close();
    for (const f of [dest, dest + '-wal', dest + '-shm']) if (existsSync(f)) unlinkSync(f);
  }
  renameSync(tmp, dest);
  return { dest, previous, before, after, accounts };
}
