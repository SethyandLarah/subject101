// Time Out grace and Auto Time Out (Asia/Manila).
//
// Each session start (Morning Time In / Afternoon Time In) stores the scheduled cutoff and
// the grace deadline that applied at that moment, so later setting changes never rewrite
// past records. Regular pay stops at the cutoff (payable minutes are clipped to the
// schedule); the session stays open for a manual Time Out until the grace deadline, after
// which it is closed automatically at the deadline with source "auto".
import { nowISO } from './db.mjs';

export const DEFAULT_GRACE = 10;
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+08:00`);
export const CLOSES = { in: 'lunch_out', lunch_in: 'out' };

export function createAutoClose(db, payroll, shiftFor) {
  const sql = s => db.prepare(s);
  const graceMinutes = () => { const v = Number(sql("SELECT value FROM settings WHERE key='grace_minutes'").get()?.value); return Number.isInteger(v) && v >= 0 ? v : DEFAULT_GRACE; };
  /** Cutoff + deadline for a session that starts with `kind` on `day` for `user`. */
  function windowFor(user, day, kind, grace = graceMinutes()) {
    const s = shiftFor(user, day);
    const cutoff = at(day, kind === 'in' ? s.lunchStart : s.end);
    return { cutoff: cutoff.toISOString(), deadline: new Date(+cutoff + grace * 60000).toISOString(), grace };
  }
  /** Close every open session whose saved grace deadline has passed (also used for recovery after downtime). */
  function run(nowMs = Date.now()) {
    const now = new Date(nowMs).toISOString();
    // Only recent days are scanned (40 days covers any realistic downtime), so this stays fast
    // no matter how many years of attendance the store keeps.
    const since = new Date(nowMs - 40 * 86400000).toISOString().slice(0, 10);
    const open = sql(`SELECT a.* FROM attendance a WHERE a.day>=? AND a.kind IN ('in','lunch_in') AND a.grace_deadline IS NOT NULL AND a.grace_deadline<=?
      AND NOT EXISTS (SELECT 1 FROM attendance c WHERE c.user_id=a.user_id AND c.day=a.day AND c.kind=CASE a.kind WHEN 'in' THEN 'lunch_out' ELSE 'out' END)
      AND NOT (a.kind='in' AND EXISTS (SELECT 1 FROM attendance c WHERE c.user_id=a.user_id AND c.day=a.day AND c.kind IN ('lunch_in','out')))`).all(since, now);
    let closed = 0;
    for (const s of open) {
      sql('INSERT INTO attendance(user_id,day,kind,occurred,received,source,cutoff,grace_deadline,grace_minutes) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(s.user_id, s.day, CLOSES[s.kind], s.grace_deadline, nowISO(), 'auto', s.cutoff, s.grace_deadline, s.grace_minutes);
      closed++;
      const u = sql('SELECT * FROM users WHERE id=?').get(s.user_id);
      if (s.kind === 'lunch_in' || CLOSES[s.kind] === 'out') payroll.settle(u, s.day);
      else payroll.settle(u, s.day); // a morning-only day (afternoon excused) may now be complete
    }
    return closed;
  }
  return { graceMinutes, windowFor, run };
}
