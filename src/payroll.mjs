// Worked time, payable minutes and earnings (Asia/Manila).
//
// A day has a morning window (start → lunchStart) and an afternoon window
// (lunchEnd → end). Payable regular minutes are the parts of the employee's
// sessions that fall inside those windows, so lunch is never paid, lateness and
// early departure are deducted automatically, and time outside the schedule is
// flagged as overtime for Admin review. An approved PAID excuse counts its window
// once; an approved UNPAID excuse adds nothing.
//
//   earnings = daily rate × payable regular minutes ÷ 480, rounded once per day.
import { nowISO } from './db.mjs';

export const TAPS = ['in', 'lunch_out', 'lunch_in', 'out'];
export const TAP_LABELS = { in: 'Morning Time In', lunch_out: 'Lunch Time Out', lunch_in: 'Afternoon Time In', out: 'Final Time Out' };
export const DAY_MINUTES = 480;
const OVERTIME_MIN = 30; // minutes outside the schedule before a day is flagged as overtime
const minutesOf = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const scheduledMinutes = s => Math.max(0, minutesOf(s.lunchStart) - minutesOf(s.start)) + Math.max(0, minutesOf(s.end) - minutesOf(s.lunchEnd));
const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+08:00`);
const overlap = (a, b, w) => Math.max(0, Math.min(b, w[1]) - Math.max(a, w[0]));
const mins = ms => Math.round(ms / 60000);
/** Pay for a day in centavos, rounded once to the nearest centavo (half up). */
export const payFor = (rate, payable) => rate === null || rate === undefined ? null : Math.floor((rate * payable * 2 + DAY_MINUTES) / (2 * DAY_MINUTES));

const isLegacy = t => !!(t.in && t.out && !t.lunch_out && !t.lunch_in);
/** Sessions as [startMs, endMs] pairs; an open session ends at `now` (live estimate) or is dropped. */
function sessions(t, now) {
  const p = k => t[k] ? Date.parse(t[k]) : null, out = [];
  if (isLegacy(t)) return [[p('in'), p('out')]];
  if (t.in) { const end = p('lunch_out') ?? (!t.lunch_in ? p('out') : null) ?? now; if (end) out.push([p('in'), end]); }
  if (t.lunch_in) { const end = p('out') ?? now; if (end) out.push([p('lunch_in'), end]); }
  return out.filter(([a, b]) => b > a);
}
/** Kept for older callers: actual worked minutes and tap format. */
export function workedMinutes(t) {
  return { minutes: sessions(t, null).reduce((s, [a, b]) => s + mins(b - a), 0), format: isLegacy(t) ? 'two-tap' : 'four-tap' };
}

/**
 * Which taps are allowed next. ctx: { excuse: {coverage, status}, schedule, nowMs, day }.
 * - Approved morning excuse (or arriving after the morning window ends) → may start with Afternoon Time In.
 * - Approved afternoon excuse → the day ends at Lunch Time Out.
 */
export function allowedTaps(t, ctx = {}) {
  const ex = ctx.excuse && ctx.excuse.status === 'Excused' ? ctx.excuse.coverage : null;
  if (isLegacy(t) || t.out) return [];
  if (t.lunch_in) return ['out'];
  if (t.lunch_out) return ex === 'afternoon' || ex === 'whole' ? [] : ['lunch_in'];
  if (t.in) return ['lunch_out'];
  const afterMorning = ctx.schedule && ctx.nowMs && ctx.day && ctx.nowMs >= at(ctx.day, ctx.schedule.lunchStart);
  // A morning session cannot start once the morning cutoff has passed (it would pay nothing and close at once).
  if (afterMorning) return ctx.nowMs >= at(ctx.day, ctx.schedule.end) ? [] : ['lunch_in'];
  return ex === 'morning' || ex === 'whole' ? ['in', 'lunch_in'] : ['in'];
}
export function nextTap(t, ctx) { return allowedTaps(t, ctx)[0] ?? null; }

/**
 * Full day computation. ctx: { day, schedule, excuse:{coverage,status,paid}, morningConfirmed, nowMs (live) }
 * Returns { minutes (worked), payable, scheduled, extra, status, review, flags[], format, done }.
 */
export function compute(t, ctx) {
  const { day, schedule: s } = ctx;
  const W = { morning: [at(day, s.start), at(day, s.lunchStart)], afternoon: [at(day, s.lunchEnd), at(day, s.end)] };
  const ses = sessions(t, ctx.nowMs ?? null);
  const worked = ses.reduce((x, [a, b]) => x + mins(b - a), 0);
  const ex = ctx.excuse && ctx.excuse.status === 'Excused' ? ctx.excuse : null;
  const covers = w => ex && (ex.coverage === 'whole' || ex.coverage === w);
  let payable = 0, inside = 0; const flags = [];
  for (const w of ['morning', 'afternoon']) {
    const actual = mins(ses.reduce((x, [a, b]) => x + overlap(a, b, W[w]), 0));
    inside += actual;
    const full = mins(W[w][1] - W[w][0]);
    payable += covers(w) && ex.paid ? full : actual; // paid excuse counts its window once
  }
  const scheduled = scheduledMinutes(s), extra = Math.max(0, worked - inside);
  const anyTap = Object.values(t).some(Boolean);
  const done = anyTap ? allowedTaps(t, { excuse: ex, schedule: s, day }).length === 0 : !!ex && ex.coverage === 'whole';
  const noMorning = !t.in && !isLegacy(t);
  if (!done && !ctx.nowMs) flags.push('missing_taps');
  if (noMorning && t.lunch_in && !covers('morning') && !ctx.morningConfirmed) flags.push('morning_absence_unconfirmed');
  if (extra >= OVERTIME_MIN) flags.push('overtime');
  const excusedUnpaid = ['morning', 'afternoon'].filter(w => covers(w) && !ex.paid).reduce((x, w) => x + mins(W[w][1] - W[w][0]), 0);
  const confirmedOff = noMorning && ctx.morningConfirmed ? mins(W.morning[1] - W.morning[0]) : 0;
  if (payable + excusedUnpaid + confirmedOff < scheduled) flags.push(t.in && Date.parse(t.in) > W.morning[0] + 60000 ? 'late' : 'short');
  const review = flags.some(f => f === 'missing_taps' || f === 'morning_absence_unconfirmed' || f === 'overtime');
  const status = flags.includes('missing_taps') ? 'incomplete' : flags.includes('morning_absence_unconfirmed') ? 'review'
    : flags.includes('overtime') ? 'overtime' : !Object.values(t).some(Boolean) && ex ? 'excused' : payable < scheduled ? 'short' : 'complete';
  return { minutes: worked, payable, scheduled, extra, status, review, flags, format: isLegacy(t) ? 'two-tap' : 'four-tap', done };
}
/** Back-compat wrapper used by list views (day derived from the first tap when not given). */
const phDay = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(iso ? new Date(iso) : new Date());
export function dayStatus(t, schedule, day, extra = {}) {
  return compute(t, { day: day || phDay(t.in || t.lunch_in || t.lunch_out || t.out), schedule, ...extra });
}

export function createPayroll(db, shiftFor) {
  const sql = s => db.prepare(s);
  const tapsFor = (userId, day) => { const t = { in: null, lunch_out: null, lunch_in: null, out: null }; for (const r of sql('SELECT kind, occurred FROM attendance WHERE user_id=? AND day=?').all(userId, day)) t[r.kind] = r.occurred; return t; };
  const rateFor = (user, day) => { const r = sql('SELECT rate FROM rates WHERE user_id=? AND effective<=? ORDER BY effective DESC, id DESC LIMIT 1').get(user.id, day); return r ? r.rate : (user.daily_rate ?? null); };
  const excuseFor = (userId, day) => sql('SELECT * FROM excuses WHERE user_id=? AND day=?').get(userId, day) || null;
  const morningConfirmed = (userId, day) => !!sql('SELECT 1 FROM morning_absences WHERE user_id=? AND day=?').get(userId, day);
  const ctxFor = (user, day, nowMs) => ({ day, schedule: shiftFor(user, day), excuse: excuseFor(user.id, day), morningConfirmed: morningConfirmed(user.id, day), nowMs });
  const isPaid = (userId, day) => !!sql('SELECT 1 FROM salary_payment_days WHERE user_id=? AND day=?').get(userId, day);

  /** Live view for today: completed sessions + elapsed payable time of the open session (paused at lunch / when out). */
  function live(user, day, nowMs = Date.now()) {
    const c = compute(tapsFor(user.id, day), ctxFor(user, day, nowMs));
    const rate = rateFor(user, day);
    return { ...c, rate, estimate: payFor(rate, c.payable) };
  }
  /** Compute and store the day's earnings with the rate that applies to that date. Paid days never change. */
  function finalize(user, day) {
    const c = compute(tapsFor(user.id, day), ctxFor(user, day, null));
    const rate = rateFor(user, day), amount = payFor(rate, c.payable);
    if (isPaid(user.id, day)) return { ...c, rate, amount, locked: true };
    sql(`INSERT INTO earnings(user_id,day,worked_minutes,scheduled_minutes,payable_minutes,rate,amount,status,format,flags,review,finalized) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,day) DO UPDATE SET worked_minutes=excluded.worked_minutes, scheduled_minutes=excluded.scheduled_minutes, payable_minutes=excluded.payable_minutes, rate=excluded.rate, amount=excluded.amount, status=excluded.status, format=excluded.format, flags=excluded.flags, review=excluded.review, finalized=excluded.finalized`)
      .run(user.id, day, c.minutes, c.scheduled, c.payable, rate, amount, c.status, c.format, c.flags.join(','), c.review ? 1 : 0, nowISO());
    return { ...c, rate, amount, locked: false };
  }
  /** Finalize when the day is over (all taps done) or covered by an approved excuse; otherwise leave it open. */
  function settle(user, day) {
    const t = tapsFor(user.id, day), cx = ctxFor(user, day, null);
    const c = compute(t, cx);
    if (c.done || (cx.excuse?.status === 'Excused' && !Object.values(t).some(Boolean))) return finalize(user, day);
    return null;
  }
  return { tapsFor, rateFor, excuseFor, ctxFor, compute: (user, day, nowMs) => compute(tapsFor(user.id, day), ctxFor(user, day, nowMs)), live, finalize, settle, isPaid };
}
