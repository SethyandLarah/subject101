// Long-term care of the store database. Runs at start-up and every hour:
//   • a daily backup copy (VACUUM INTO data/backups/<name>-YYYY-MM-DD.sqlite), last 30 kept;
//   • clean-up of data that only grows and is no longer needed (expired sign-ins, old
//     retry keys, read notifications older than a year, reviewed offline entries);
//   • PRAGMA optimize + WAL checkpoint so queries stay fast as the years of data grow.
// Sales, stock, attendance, payroll, utang and the audit log are NEVER deleted.
import { mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const KEEP_BACKUPS = 30;
const phDay = (ms = Date.now()) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

export function createMaintenance(db, dbPath) {
  const file = dbPath && dbPath !== ':memory:' ? dbPath : null;
  const dir = file ? join(dirname(file), 'backups') : null;
  const stem = file ? basename(file).replace(/\.sqlite$/, '') : 'store';

  /** One backup per day. Returns the backup path (or null when there is nothing to do). */
  function backup(force = false) {
    if (!dir) return null;
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${stem}-${phDay()}.sqlite`);
    if (existsSync(target) && !force) return null;
    if (existsSync(target)) unlinkSync(target);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const old = readdirSync(dir).filter(f => f.startsWith(stem + '-') && f.endsWith('.sqlite')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) { try { unlinkSync(join(dir, f)); } catch { /* in use */ } }
    return target;
  }
  function list() {
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.startsWith(stem + '-') && f.endsWith('.sqlite')).sort().reverse()
      .map(f => ({ name: f, size: statSync(join(dir, f)).size }));
  }
  /** Removes only short-lived or already-handled records. */
  function clean() {
    const run = (q, ...a) => Number(db.prepare(q).run(...a).changes);
    const out = {
      sessions: run('DELETE FROM sessions WHERE expires < ?', Date.now()),
      requests: run('DELETE FROM requests WHERE created < ?', daysAgo(90)),
      notifications: 0, offline: 0,
    };
    const oldNotes = `SELECT id FROM notifications WHERE created < ?`;
    db.prepare(`DELETE FROM notification_reads WHERE notification_id IN (${oldNotes})`).run(daysAgo(365));
    out.notifications = run('DELETE FROM notifications WHERE created < ?', daysAgo(365));
    out.offline = run("DELETE FROM offline_inbox WHERE status IN ('approved','rejected') AND uploaded < ?", daysAgo(180));
    return out;
  }
  function run() {
    const r = { backup: null, cleaned: null };
    try { r.cleaned = clean(); } catch (e) { console.error('maintenance clean', e.message); }
    try { r.backup = backup(); } catch (e) { console.error('maintenance backup', e.message); }
    try { db.exec('PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);'); } catch { /* busy: next hour */ }
    return r;
  }
  return { run, backup, clean, list, dir };
}
