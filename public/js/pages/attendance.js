// Attendance: one-tap Time In/Out, calendar, excuses; Admin review, corrections, schedules.
import { api } from '../api.js';
import { h, clear, peso, minutesText, payableAt, estimateFor, reducedMotion, timeText, dateText, dateLong, dateTime, ago, modal, confirm, toast, busy, errorOf, field, input, select, showError, empty, skeleton, tag, segmented, todayPH, monthPH, roleName, titleOf } from '../ui.js';
import { queue } from '../api.js';
import { signOut, enablePush } from '../app.js';
import { icon } from '../icons.js';
import { sound } from '../sound.js';
import { go, avatarEl } from '../app.js';

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const TAPS = ['in', 'lunch_out', 'lunch_in', 'out'];
const TAP_LABELS = { in: 'Morning Time In', lunch_out: 'Lunch Time Out', lunch_in: 'Afternoon Time In', out: 'Final Time Out' };
const TAP_SHORT = { in: 'In', lunch_out: 'Lunch out', lunch_in: 'Back in', out: 'Out' };
const WORK_TAG = { complete: ['Complete', 'Present'], short: ['Short / late', 'warn'], overtime: ['Overtime', 'info'], incomplete: ['Incomplete', 'Absent'], review: ['Needs review', 'warn'], excused: ['Excused', 'Excused'] };
const FLAG_TEXT = { missing_taps: 'Missing taps', morning_absence_unconfirmed: 'Morning absence not confirmed', overtime: 'Overtime', late: 'Late arrival', short: 'Short hours' };
const flagText = f => (f || []).map(x => FLAG_TEXT[x] || x).join(' · ');
const COVERAGE = [{ value: 'whole', label: 'Whole Day' }, { value: 'morning', label: 'Morning Only' }, { value: 'afternoon', label: 'Afternoon Only' }];
const paidTag = p => p === null || p === undefined ? null : tag(p ? 'Paid excuse' : 'Unpaid excuse', p ? 'Present' : 'neutral');
const workTag = st => st && WORK_TAG[st] ? tag(WORK_TAG[st][0], WORK_TAG[st][1]) : null;
const statusKind = s => String(s).startsWith('Excused') ? 'Excused' : ({ Present: 'Present', Absent: 'Absent', Excused: 'Excused', 'Pending Approval': 'pending', 'Rest day': 'neutral', Upcoming: 'neutral', 'No record yet': 'neutral' }[s] || 'neutral');

export async function attendance(ctx) {
  const { el, params, user, query } = ctx;
  const isAdmin = user.role === 'admin';
  const month = query.get('month') || monthPH(), day = query.get('day') || todayPH();
  el.append(skeleton(2));
  // Offline: fall back to the last attendance data this device saw, so Time In/Out
  // still works (entries queue as "Pending sync") and history stays visible.
  // The last good copy is kept on the device (survives restarts) so taps still work without connection.
  const data = await api.get('attendance', { month, day, user: query.get('user') });
  const offline = !!data._cachedAt;
  if (!isAdmin) { const box = await api.get('offline').catch(() => ({ mine: [] })); data.inbox = box.mine || []; }
  clear(el);
  if (offline) el.append(h('div.card.flat', { style: { marginBottom: '12px', background: 'var(--warn-soft)', color: 'var(--warn)', fontWeight: 600 } }, `Offline — showing data saved ${ago(new Date(data._cachedAt).toISOString())}. New taps stay on this device (Pending upload), then go to Admin for approval.`));
  let sub = params[0] || (isAdmin ? 'daily' : 'mine'); if (isAdmin && (sub === 'mine' || sub === 'pay' || sub === 'history')) sub = 'daily';
  const tabs = isAdmin ? [{ value: 'daily', label: 'Daily' }, { value: 'monthly', label: 'Monthly' }, { value: 'review', label: `Review${data.review?.length ? ' · ' + data.review.length : ''}` }, { value: 'excuses', label: 'Excuses' }, { value: 'schedules', label: 'Schedules' }, { value: 'settings', label: 'Settings' }] : [{ value: 'mine', label: 'Today' }, { value: 'history', label: 'My history' }, { value: 'pay', label: 'Earnings & pay' }];
  const attendanceOnly = user.role === 'attendance';
  el.append(h('div.page__head', h('div', h('p.eyebrow', attendanceOnly ? `${user.name} · ${titleOf(user)}` : 'Attendance'), h('h1', isAdmin ? 'Staff attendance' : 'My attendance')), isAdmin ? h('div.page__actions', h('button.btn', { onclick: () => correctionForm(ctx, data) }, icon('edit', 'sm'), 'Correct entry'), h('button.btn', { onclick: () => scheduleForm(ctx, data) }, icon('clock', 'sm'), 'Set schedule')) : h('div.page__actions', h('button.btn', { onclick: () => excuseForm(ctx) }, icon('calendar', 'sm'), 'Request excuse'), attendanceOnly ? h('button.btn.danger', { onclick: signOut }, icon('logout', 'sm'), 'Sign out') : null)));
  el.append(h('div', { style: { margin: '0 4px 14px' } }, segmented(tabs, sub, v => go('attendance/' + v + (query.toString() ? '?' + query : '')))));
  const body = h('div'); el.append(body);
  if (sub === 'mine') return mineTab(body, ctx, data);
  if (sub === 'history') return historyTab(body, ctx, data, month);
  if (sub === 'daily') return dailyTab(body, ctx, data, day);
  if (sub === 'monthly') return monthlyTab(body, ctx, data, month, query.get('user'));
  if (sub === 'pay') return payTab(body, ctx, data);
  if (sub === 'review') return reviewTab(body, ctx, data);
  if (sub === 'settings') return settingsTab(body, ctx, data);
  if (sub === 'excuses') return excusesTab(body, ctx, data);
  if (sub === 'schedules') return schedulesTab(body, ctx, data);
}

function tapList(t, ctx, pending) {
  const allowed = pending.length ? (pending[pending.length - 1].kind === 'out' ? [] : [TAPS[TAPS.indexOf(pending[pending.length - 1].kind) + 1]]) : (t.allowed || (t.next ? [t.next] : []));
  const next = allowed[0];
  const pendingOf = k => pending.find(q => q.kind === k);
  return h('div.taps', ...TAPS.map((k, i) => {
    const at = t.taps?.[k], pend = pendingOf(k), isNext = !at && !pend && k === next, isAlt = !at && !pend && !isNext && allowed.includes(k);
    const label = at ? `Recorded ${timeText(at)}` : pend ? `${pend.label} · tapped ${timeText(pend.occurred)}` : isNext ? 'Tap to record now' : isAlt ? (t.excuse?.coverage === 'morning' && t.excuse?.status === 'Excused' ? 'Morning excused — start here' : 'Missed the morning? Start here (Admin will review)') : (k === 'in' || k === 'lunch_out') && t.taps?.lunch_in ? 'Skipped' : (k === 'lunch_in' || k === 'out') && !allowed.length && t.taps?.lunch_out && !t.taps?.lunch_in ? 'Afternoon excused' : 'Waiting';
    return h('button.tap' + (at || pend ? '.done' : '') + (isNext ? '.next' : '') + (isAlt ? '.alt' : '') + (k === 'out' ? '.final' : ''), { disabled: !isNext && !isAlt, style: { '--i': i }, onclick: async () => {
      const ok = await confirm({ title: `${TAP_LABELS[k]} now?`, message: `The time will be recorded as ${timeText(new Date().toISOString())} (Philippine time).`, okText: TAP_LABELS[k] });
      if (!ok) return;
      try {
        const r = await api.action('attendance.clock', { kind: k, occurred: new Date().toISOString() }, { offlineOk: true });
        sound.play('success');
        if (r.queued) toast('Saved on this device · Pending upload', 'ok');
        else if (r.earnings) modal({ title: 'Day complete', size: 'narrow', body: h('div.col', h('div.row.between', h('span.muted', 'Worked'), h('b', minutesText(r.earnings.workedMinutes))), h('div.row.between', h('span.muted', 'Scheduled'), h('b', minutesText(r.earnings.scheduledMinutes))), h('div.row.between', h('span.muted', 'Paid time'), h('b', minutesText(r.earnings.payableMinutes))), h('div.row.between', h('span.muted', 'Status'), workTag(r.earnings.status)), h('div.row.between', h('span.muted', 'Estimated earnings'), h('b', { style: { fontSize: '20px' } }, !r.earnings.rateSet ? 'Rate not set' : peso(r.earnings.amount))), r.earnings.flags?.length ? h('p.small.muted', flagText(r.earnings.flags)) : null, r.earnings.review ? h('p.small.muted', 'This day was sent to Admin for review.') : null) });
        else toast(`${TAP_LABELS[k]} recorded · ${r.time || ''}`, 'ok');
        ctx.refresh();
      } catch (err) { toast(errorOf(err), 'err'); }
    } }, h('span.n', at || pend ? icon('check', 'sm') : String(i + 1)), h('div', h('b', TAP_LABELS[k]), h('span', label)));
  }));
}
function mineTab(box, ctx, data) {
  const m = data.mine; let t = m.today; const t0 = m.today;
  // Offline taps waiting for the server show as "Pending sync" until confirmed.
  const dayOf = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(iso));
  const local = queue.all().filter(q => q.action === 'attendance.clock' && q.userId === ctx.user.id && dayOf(q.occurred || Date.now()) === todayPH() && !t.taps?.[q.kind]).map(q => ({ kind: q.kind, occurred: q.occurred, label: 'Pending upload' }));
  const uploaded = (data.inbox || []).filter(e => e.action === 'attendance.clock' && (e.status === 'pending' || e.status === 'needs_review') && dayOf(e.occurred) === todayPH()).map(e => ({ kind: TAPS.find(k => TAP_LABELS[k] === e.title), occurred: e.occurred, label: e.statusLabel })).filter(e => e.kind && !t.taps?.[e.kind]);
  const pending = [...uploaded, ...local].sort((a, b) => TAPS.indexOf(a.kind) - TAPS.indexOf(b.kind));
  // Local estimate while offline: include the pending taps, using the saved rate, schedule and grace.
  if (pending.length) {
    const taps = { ...t.taps }; for (const p of pending) taps[p.kind] = p.occurred;
    const open = (taps.in && !taps.lunch_out && !taps.lunch_in && !taps.out) ? 'in' : (taps.lunch_in && !taps.out) ? 'lunch_in' : null;
    const at = hhmm => new Date(`${todayPH()}T${hhmm}:00+08:00`).toISOString();
    const cutoff = open ? at(open === 'in' ? m.shift.lunchStart : m.shift.end) : null;
    t = { ...t, taps, clock: open ? 'Working · pending upload' : t.clock, live: t.live || { schedule: m.shift, excuse: t.excuse }, session: open ? { kind: open, closes: open === 'in' ? 'lunch_out' : 'out', cutoff, deadline: new Date(Date.parse(cutoff) + (m.graceMinutes ?? 10) * 60000).toISOString() } : null, allowed: [] };
  }
  const nextKind = pending.length ? TAPS[TAPS.indexOf(pending[pending.length - 1].kind) + 1] : t.next;
  const sh = m.shift;
  const summary = t.earnings ? h('div.row.wrap', { style: { marginTop: '14px', gap: '10px' } }, tag(`Worked ${minutesText(t.earnings.minutes)}`, 'Present'), tag(`Paid time ${minutesText(t.earnings.payable)}`, 'neutral'), workTag(t.earnings.status), tag(t.earnings.rateMissing ? 'Rate not set' : `Est. ${peso(t.earnings.amount)}`, 'info'))
    : h('div', { style: { marginTop: '12px' } }, h('p.small.muted', `${t.clock || ''}${nextKind ? ' · Next: ' + TAP_LABELS[nextKind] : ''}`), t.session?.state === 'grace' ? h('div.due', icon('clock', 'sm'), h('span', h('b', 'Time Out due'), ` — tap ${TAP_LABELS[t.session.closes]} by ${timeText(t.session.deadline)} or it closes automatically. Pay already stopped at ${timeText(t.session.cutoff)}.`)) : null);
  box.append(liveCard(t, m, ctx));
  box.append(h('div.grid.two.stagger', { style: { marginTop: '14px' } },
    h('div.card', h('div.card__head', h('div', h('h2', dateLong(todayPH())), h('p.sub', `${ctx.user.name} · ${titleOf(ctx.user)}`), h('p.sub', `Schedule ${sh.start}–${sh.lunchStart || '11:30'} · ${sh.lunchEnd || '13:00'}–${sh.end} (${minutesText(m.scheduledMinutes)})`)), pending.length ? tag(pending[0].label, 'pending') : tag(t.status, statusKind(t.status))), tapList(t0, ctx, pending), summary, t.excuse ? h('p.small.muted', { style: { marginTop: '12px' } }, `Excuse filed: ${t.excuse.reason} · ${t.excuse.status}`) : null),
    h('div.col', { style: { gap: '14px' } },
      h('div.card', h('div.card__head', h('h2', 'Earnings'), h('a.small', { href: '#/attendance/pay' }, 'Details →')), h('div.kpi__value', peso(m.unpaidTotal)), h('p.small.muted', 'Estimated earnings not yet paid'), m.payments[0] ? h('p.small', { style: { marginTop: '8px' } }, `Last payment ${peso(m.payments[0].amount)} on ${dateText(m.payments[0].payDate)} · ${m.payments[0].method}`) : null),
      h('div.card', h('div.card__head', h('h2', 'My excuse requests'), h('button.btn.sm', { onclick: () => excuseForm(ctx) }, icon('plus', 'sm'), 'Request')), m.excuses.length ? h('div.list', ...m.excuses.slice(0, 6).map(e => h('div.list__item', h('span.ic.' + (e.status === 'Excused' ? 'ok' : e.status === 'Declined' ? 'danger' : 'warn'), icon('calendar')), h('span.body', h('b', dateLong(e.day)), h('span', `${e.coverageLabel || 'Whole Day'}${e.emergency ? ' · same-day' : ''} · ${e.reason}`), e.note ? h('span', `Admin: ${e.note}`) : null), h('div.col', { style: { alignItems: 'flex-end', gap: '4px' } }, tag(e.status, e.status === 'Pending Approval' ? 'pending' : e.status), e.status === 'Excused' ? paidTag(e.paid) : null)))) : empty('No requests yet', 'calendar')))));
  box.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('h2', 'This month'), h('a.small', { href: '#/attendance/history' }, 'Full history →')), calendar(m.days, m.month, d => dayDetail(d))));
}
// Today's Estimated Earnings: derived from the tap timestamps every second, so a refresh shows the same amount.
// Pauses at lunch, freezes at the scheduled cutoff (grace adds nothing) and stops at Time Out.
let liveTimer = null;
function liveCard(t, m, ctx) {
  clearInterval(liveTimer);
  const amount = h('div.live__amount'), state = h('span.live__state'), payable = h('b'), clockEl = h('b');
  const finalized = t.earnings, paid = t.paid;
  const card = h('div.card.live' + (finalized ? '.final' : ''), h('div.card__head', h('div', h('p.eyebrow', "Today's Estimated Earnings"), h('h2', amount)), state),
    h('div.live__grid', h('div', h('span', 'Daily rate'), h('b', m.rate === null ? 'Not set' : peso(m.rate))), h('div', h('span', 'Clock status'), clockEl), h('div', h('span', 'Paid time today'), payable), h('div', h('span', 'Status'), h('b', paid ? 'Paid' : finalized ? 'Finalized' : 'Estimated'))));
  const ctxLive = t.live || {};
  const skew = ctxLive.serverNow ? Date.parse(ctxLive.serverNow) - Date.now() : 0;
  const reduce = reducedMotion();
  const tick = () => {
    if (todayPH() !== m.day) { clearInterval(liveTimer); ctx.refresh(); return; } // a new Manila workday starts a new tracker
    if (!document.body.contains(card)) { clearInterval(liveTimer); return; }
    let mins, pesos, label, cls;
    if (finalized) { mins = t.earnings.payable; pesos = t.earnings.amount; label = paid ? 'Paid' : 'Finalized'; cls = 'done'; }
    else if (!Object.values(t.taps || {}).some(Boolean) && !t.live) { mins = 0; pesos = m.rate === null ? null : 0; label = 'Starts at Time In'; cls = 'idle'; }
    else {
      const now = Date.now() + skew;
      mins = payableAt({ day: m.day, taps: t.taps, schedule: ctxLive.schedule || m.shift, excuse: ctxLive.excuse, nowMs: now });
      pesos = estimateFor(m.rate, reduce ? Math.floor(mins) : mins);
      const s = t.session, inGrace = s && s.cutoff && now >= Date.parse(s.cutoff);
      label = !s ? (t.taps?.lunch_out && !t.taps?.lunch_in && t.allowed?.includes('lunch_in') ? 'Paused — lunch' : 'Stopped') : inGrace ? `Frozen — Time Out due by ${timeText(s.deadline)}` : 'Accruing';
      cls = !s ? 'paused' : inGrace ? 'grace' : 'on';
    }
    amount.textContent = pesos === null ? 'Rate not set' : peso(pesos);
    payable.textContent = minutesText(Math.floor(mins));
    clockEl.textContent = t.clock || '—';
    state.className = 'live__state ' + cls; state.textContent = label;
  };
  tick(); liveTimer = setInterval(tick, reduce ? 60000 : 1000);
  return card;
}
function payTab(box, ctx, data) {
  const m = data.mine;
  box.append(h('div.grid.three.stagger',
    h('div.card', h('div.kpi__label', h('span.ic', icon('coins', 'sm')), 'Unpaid estimated earnings'), h('div.kpi__value', peso(m.unpaidTotal))),
    h('div.card', h('div.kpi__label', h('span.ic', icon('check', 'sm')), 'Salary payments received'), h('div.kpi__value', String(m.payments.length))),
    h('div.card', h('div.kpi__label', h('span.ic', icon('clock', 'sm')), 'Days with earnings'), h('div.kpi__value', String(m.earnings.length)))));
  box.append(h('div.grid.two.stagger', { style: { marginTop: '14px' } },
    h('div.card', h('div.card__head', h('h2', 'Salary payments'), 'Notification' in window && Notification.permission !== 'granted' ? h('button.btn.sm', { onclick: async () => { const r = await enablePush(); toast(r === 'granted' ? 'Phone alerts enabled' : 'Alerts not enabled', r === 'granted' ? 'ok' : 'err'); } }, icon('bell', 'sm'), 'Alert me') : null), m.payments.length ? h('div.list', ...m.payments.map(p => h('div.list__item', h('span.ic.ok', icon('coins')), h('span.body', h('b', peso(p.amount)), h('span', `${p.from === p.to ? dateText(p.from) : dateText(p.from) + ' – ' + dateText(p.to)} · ${p.days} day${p.days === 1 ? '' : 's'}`), h('span', `Paid ${dateText(p.payDate)} · ${p.method}${p.reference ? ' · Ref ' + p.reference : ''}`))))) : empty('No salary payments yet', 'coins')),
    h('div.card', h('div.card__head', h('h2', 'Daily earnings')), m.earnings.length ? h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Date'), h('th', 'Paid time'), h('th', 'Status'), h('th.right', 'Earnings'), h('th'))), h('tbody', ...m.earnings.map(e => h('tr', h('td', dateText(e.day, { weekday: 'short', month: 'short', day: 'numeric' })), h('td', minutesText(e.payable ?? e.minutes)), h('td', workTag(e.status)), h('td.num', e.rateMissing ? h('span.small.muted', 'Rate not set') : peso(e.amount)), h('td', e.paid ? tag('Paid', 'Present') : tag('Finalized', 'neutral'))))))) : empty('Earnings appear after each Final Time Out', 'clock'))));
}
function historyTab(box, ctx, data, month) {
  const m = data.mine;
  const picker = input({ type: 'month', value: month, onchange: e => go('attendance/history?month=' + e.target.value) });
  const present = m.days.filter(d => d.status === 'Present').length, absent = m.days.filter(d => d.status === 'Absent').length, excused = m.days.filter(d => d.status === 'Excused').length;
  box.append(h('div.card.stagger', h('div.card__head', h('div.row', h('h2', 'Monthly record'), picker), h('div.row', tag(`${present} present`, 'Present'), tag(`${absent} absent`, 'Absent'), tag(`${excused} excused`, 'Excused'))), calendar(m.days, month, d => dayDetail(d)),
    h('div.table-wrap', { style: { marginTop: '16px' } }, h('table.t', h('thead', h('tr', h('th', 'Date'), ...tapHeads(), h('th', 'Worked'), h('th', 'Status'))), h('tbody', ...m.days.filter(d => d.day <= todayPH() && d.status !== 'Rest day').reverse().map(d => h('tr', h('td', dateText(d.day, { weekday: 'short', month: 'short', day: 'numeric' })), ...tapCells(d), h('td', minutesText(d.worked?.minutes)), h('td', tag(d.status, statusKind(d.status)), ' ', d.incomplete ? tag('Incomplete', 'warn') : workTag(d.worked?.status === 'complete' ? null : d.worked?.status)))))))));
}
const tapHeads = () => TAPS.map(k => h('th', TAP_SHORT[k]));
const SRC = { auto: 'Auto Time Out', admin: 'Admin correction', offline: 'Offline tap' };
const srcTag = (d, k) => d.sources?.[k] && d.sources[k] !== 'manual' ? h('div', h('span.src.' + d.sources[k], d.sources[k] === 'auto' ? 'Auto' : d.sources[k] === 'admin' ? 'Corrected' : 'Offline')) : null;
const tapCells = d => TAPS.map(k => h('td', d.taps?.[k] ? [timeText(d.taps[k]), srcTag(d, k)] : k === 'out' && d.missingOut ? tag('Missing', 'warn') : (k === 'lunch_out' || k === 'lunch_in') && d.taps?.in && d.taps?.out && !d.taps?.lunch_out ? h('span.small.muted', 'Legacy') : '—'));
function calendar(days, month, onPick) {
  const first = new Date(month + '-01T00:00:00Z').getUTCDay();
  const cal = h('div.cal', ...DOW.map(d => h('div.dow', d)));
  for (let i = 0; i < first; i++) cal.append(h('div.day.empty'));
  let idx = 0;
  for (const d of days) cal.append(h('button.day.' + d.status.replace(/ /g, '.') + (d.day === todayPH() ? '.today' : '') + (d.missingOut ? '.missing' : ''), { title: d.status, style: { '--i': idx++ }, onclick: () => onPick(d) }, Number(d.day.slice(8)), h('i')));
  return cal;
}
function dayDetail(d, ctx, uid) {
  const ex = d.excuse;
  modal({ title: dateLong(d.day), size: 'narrow', body: close => h('div.col', h('div.row.between', h('span.muted', 'Status'), tag(d.status, statusKind(d.status))),
    ...TAPS.map(k => h('div.row.between', h('span.muted', TAP_LABELS[k]), h('span', h('b', d.taps?.[k] ? timeText(d.taps[k]) : k === 'out' && d.missingOut ? 'Missing' : '—'), d.sources?.[k] && d.sources[k] !== 'manual' ? h('span.small.muted', ` · ${SRC[d.sources[k]]}`) : null))),
    d.worked ? h('div.row.between', h('span.muted', 'Worked · paid time'), h('span', h('b', `${minutesText(d.worked.minutes)} · ${minutesText(d.earnings?.payable ?? d.worked.payable)}`), ' ', workTag(d.earnings?.status || d.worked.status))) : null,
    (d.earnings?.flags || d.worked?.flags || []).length ? h('p.small.muted', flagText(d.earnings?.flags || d.worked?.flags)) : null,
    d.earnings ? h('div.row.between', h('span.muted', 'Earnings'), h('b', d.earnings.rateMissing ? 'Rate not set' : peso(d.earnings.amount))) : d.live ? h('div.row.between', h('span.muted', 'Live estimate'), h('b', peso(d.live.estimate))) : null,
    d.paid ? h('div.row.between', h('span.muted', 'Salary'), tag(`Paid ${dateText(d.paid.payDate)}`, 'Present')) : null,
    d.morningConfirmed ? h('p.small.muted', 'Morning absence confirmed by Admin — afternoon session counted.') : null,
    ex ? h('div.card.flat', { style: { marginTop: '8px' } }, h('div.row.between', h('b', `Excuse · ${ex.coverageLabel}`), h('div.row', { style: { gap: '6px' } }, tag(ex.status, ex.status === 'Pending Approval' ? 'pending' : ex.status), ex.status === 'Excused' ? paidTag(ex.paid) : null)), h('p', { style: { margin: '6px 0' } }, ex.reason), h('p.small.muted', `${ex.emergency ? 'Same-day emergency' : 'Advance request'}${ex.reviewer ? ` · decided by ${ex.reviewer}` : ''}${ex.note ? ' · ' + ex.note : ''}`)) : null,
    d.mark ? h('p.small.muted', `Marked ${d.mark.status} by Admin: ${d.mark.reason}`) : null,
    ctx && uid && !d.taps?.in && d.taps?.lunch_in && !d.morningConfirmed && !(ex?.status === 'Excused' && ex.coverage !== 'afternoon') ? h('button.btn.sm', { style: { marginTop: '8px' }, onclick: () => { close(); confirmMorning(ctx, { userId: uid, day: d.day }); } }, 'Confirm morning absence') : null) });
}
async function confirmMorning(ctx, r) {
  const reason = await confirm({ title: 'Confirm morning absence?', message: `${r.name || ''} ${dateLong(r.day)}\nThe valid afternoon session will be counted; the morning is not paid.`, okText: 'Confirm', requireReason: true });
  if (!reason) return;
  try { const x = await api.action('attendance.morningAbsent', { userId: r.userId, day: r.day, reason }); toast(x.earnings ? `Confirmed · ${peso(x.earnings.amount)}` : 'Morning absence confirmed', 'ok'); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); }
}
function excuseForm(ctx) {
  const day = input({ type: 'date', min: todayPH(), value: todayPH() }), reason = h('textarea.textarea', { placeholder: 'Reason for the excuse' });
  const coverage = select(COVERAGE, { value: 'whole' });
  const note = h('p.small.muted');
  const upd = () => { note.textContent = day.value === todayPH() ? 'Same-day emergency — Admin is notified right away.' : 'Advance request — Admin will approve or decline before the date.'; };
  day.onchange = upd; upd();
  const body = h('div.form', h('div.form.two', field('Date', day), field('Coverage', coverage)), note, field('Reason', reason));
  modal({ title: 'Request excuse', subtitle: 'Whole day, morning only or afternoon only.', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('excuse.request', { day: day.value, reason: reason.value, coverage: coverage.value }); toast('Request sent · Pending Approval', 'ok'); close(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Submit request') });
}

// ---- Admin tabs --------------------------------------------------------
// Admin live view uses the same timestamp-based calculation as My Attendance.
let adminLiveTimer = null;
function startAdminLive(box, rows, day) {
  clearInterval(adminLiveTimer);
  const live = rows.filter(r => r.live && r.live.accruing); if (!live.length || reducedMotion()) return;
  const skew = Date.parse(live[0].live.serverNow) - Date.now();
  adminLiveTimer = setInterval(() => {
    if (!document.body.contains(box)) return clearInterval(adminLiveTimer);
    for (const r of live) { const el = box.querySelector(`[data-live="${r.userId}"]`); if (!el) continue; const mins = payableAt({ day, taps: r.taps, schedule: r.live.schedule, excuse: r.live.excuse, nowMs: Date.now() + skew }); const v = estimateFor(r.live.rate, mins); if (v !== null) el.textContent = peso(v); }
  }, 1000);
}
function dailyTab(box, ctx, data, day) {
  const picker = input({ type: 'date', value: day, max: todayPH(), onchange: e => go('attendance/daily?day=' + e.target.value) });
  const counts = { Present: 0, Absent: 0, Excused: 0, 'Pending Approval': 0 }; for (const r of data.daily) { const k = statusKind(r.status) === 'Excused' ? 'Excused' : r.status; if (counts[k] !== undefined) counts[k]++; }
  const markAbsent = async r => { const reason = await confirm({ title: `Mark ${r.name} absent?`, message: dateLong(day), okText: 'Mark absent', danger: true, requireReason: true }); if (!reason) return; try { await api.action('attendance.mark', { userId: r.userId, day, status: 'Absent', reason }); toast('Marked absent', 'ok'); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); } };
  const isToday = day === todayPH();
  const pay = r => r.earnings ? h('div', h('b', r.earnings.rateMissing ? 'No rate' : peso(r.earnings.amount)), h('div.small.muted', `rate ${r.earnings.rateMissing ? '—' : peso(r.earnings.rate)}`))
    : r.live ? h('div', h('b.live', { dataset: { live: r.userId } }, peso(r.live.estimate)), r.live.accruing ? h('span.live-dot') : null, h('div.small.muted', `${r.session?.state === 'grace' ? 'Time Out due · frozen' : r.live.accruing ? 'accruing' : 'paused'} · rate ${r.live.rate === null ? '—' : peso(r.live.rate)}`)) : h('span.small.muted', '—');
  box.append(h('div.card.stagger', h('div.card__head', h('div.row', h('h2', dateLong(day)), picker), h('div.row', tag(`${counts.Present} present`, 'Present'), tag(`${counts.Absent} absent`, 'Absent'), tag(`${counts.Excused} excused`, 'Excused'), counts['Pending Approval'] ? tag(`${counts['Pending Approval']} pending`, 'pending') : null)),
    isToday ? h('p.small.muted', { style: { margin: '-4px 0 10px' } }, 'Live estimate = daily rate × paid minutes so far ÷ 480. It pauses at lunch and after clocking out.') : null,
    data.daily.length ? h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Staff'), h('th', 'Shift'), ...tapHeads(), h('th', 'Worked'), h('th', isToday ? 'Pay today' : 'Pay'), h('th', 'Status'), h('th'))), h('tbody', ...data.daily.map(r => h('tr', h('td', h('div.row', avatarEl({ id: r.userId, name: r.name, photo: r.photo }), h('div', h('b', r.name), h('div.small.muted', titleOf(r))))), h('td.small.muted', `${r.shift.start}–${r.shift.lunchStart || '11:30'} · ${r.shift.lunchEnd || '13:00'}–${r.shift.end}`), ...tapCells(r), h('td', minutesText(r.worked?.minutes), r.worked ? h('div.small.muted', `paid ${minutesText(r.earnings?.payable ?? r.worked.payable)}`) : null), h('td', pay(r)), h('td', tag(r.status, statusKind(r.status)), isToday && r.clock ? h('div.small.muted', r.clock) : null, r.earnings?.review ? h('div', workTag(r.earnings.status)) : null, r.excuse ? h('div.small.muted', `${r.excuse.coverageLabel} · ${r.excuse.reason}`) : null), h('td', h('div.row', { style: { justifyContent: 'flex-end' } }, h('button.btn.sm.ghost', { onclick: () => dayDetail(r, ctx, r.userId) }, 'Open'), h('button.btn.sm.ghost', { onclick: () => go('attendance/monthly?user=' + r.userId + '&month=' + day.slice(0, 7)) }, 'Month'), h('button.btn.sm.ghost', { onclick: () => correctionForm(ctx, data, { userId: r.userId, day }) }, 'Correct'), day < todayPH() && r.status !== 'Present' && r.status !== 'Absent' && statusKind(r.status) !== 'Excused' ? h('button.btn.sm.danger', { onclick: () => markAbsent(r) }, 'Absent') : null))))))) : empty('No active staff', 'users')));
  if (isToday) startAdminLive(box, data.daily, day);
}
function monthlyTab(box, ctx, data, month, userId) {
  const person = select([{ value: '', label: 'Choose staff…' }, ...data.staff.map(s => ({ value: s.id, label: `${s.name} · ${titleOf(s)}` + (s.active ? '' : ' (inactive)') }))], { value: userId || '', onchange: e => go(`attendance/monthly?user=${e.target.value}&month=${month}`) });
  const picker = input({ type: 'month', value: month, onchange: e => go(`attendance/monthly?user=${userId || ''}&month=${e.target.value}`) });
  const head = h('div.card__head', h('div.row.wrap', h('h2', 'Monthly by person'), person, picker));
  if (!data.monthly) return box.append(h('div.card.stagger', head, empty('Choose a staff member to see their month', 'calendar')));
  const m = data.monthly, s = m.summary;
  box.append(h('div.card.stagger', head, h('div.row.between', { style: { marginBottom: '10px' } }, h('p.small.muted', `${m.name} · ${m.title || ''}`), h('a.btn.sm', { href: '#/staff/' + m.userId }, icon('coins', 'sm'), 'Earnings & salary')), h('div.row.wrap', { style: { marginBottom: '14px' } }, tag(`${s.present} present`, 'Present'), tag(`${s.absent} absent`, 'Absent'), tag(`${s.excused} excused`, 'Excused'), s.pending ? tag(`${s.pending} pending`, 'pending') : null, s.missingOut ? tag(`${s.missingOut} missing time out`, 'warn') : null), calendar(m.days, month, d => dayDetail(d, ctx, m.userId)),
    h('div.table-wrap', { style: { marginTop: '16px' } }, h('table.t', h('thead', h('tr', h('th', 'Date'), ...tapHeads(), h('th', 'Worked'), h('th', 'Status'), h('th'))), h('tbody', ...m.days.filter(d => d.day <= todayPH() && d.status !== 'Rest day').reverse().map(d => h('tr', h('td', dateText(d.day, { weekday: 'short', month: 'short', day: 'numeric' })), ...tapCells(d), h('td', minutesText(d.worked?.minutes), d.earnings && !d.earnings.rateMissing ? h('div.small.muted', peso(d.earnings.amount)) : null), h('td', tag(d.status, statusKind(d.status)), d.incomplete ? h('div', tag('Incomplete', 'warn')) : d.taps?.out && d.worked?.status !== 'complete' ? h('div', workTag(d.worked?.status)) : null, d.paid ? h('div', tag('Paid', 'Present')) : null, d.excuse ? h('div.small.muted', d.excuse.reason) : null), h('td.right', h('button.btn.sm.ghost', { onclick: () => correctionForm(ctx, data, { userId: m.userId, day: d.day }) }, 'Correct'))))))),
    data.corrections.length ? h('div', { style: { marginTop: '18px' } }, h('h3', 'Corrections this month'), h('div.list', ...data.corrections.map(c => h('div.list__item', h('span.ic.info', icon('edit')), h('span.body', h('b', `${c.name} · ${dateText(c.day)} · ${TAP_LABELS[c.kind] || c.kind}`), h('span', `${c.original ? timeText(c.original) : 'Missing'} → ${timeText(c.corrected)} · ${c.reason} · by ${c.actor} ${ago(c.created)}`)))))) : null));
}
function settingsTab(box, ctx, data) {
  const grace = input({ type: 'number', min: 0, max: 120, step: 1, value: data.settings?.graceMinutes ?? 10, inputmode: 'numeric', style: { maxWidth: '140px' } });
  const ex = h('div.receipt');
  const upd = () => { const g = Math.max(0, Math.floor(Number(grace.value) || 0)); const add = (t, m) => { const [a, b] = t.split(':').map(Number); const x = a * 60 + b + m; return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; }; clear(ex).append(h('div.r', h('span', 'Morning cutoff 11:30 → auto Time Out'), h('b', add('11:30', g))), h('div.r', h('span', 'Afternoon cutoff 17:00 → auto Time Out'), h('b', add('17:00', g))), h('div.r', h('span', 'Pay added by grace'), h('b', '₱0.00 (always)'))); };
  grace.oninput = upd; upd();
  const save = e => busy(e.currentTarget, async () => { try { const r = await api.action('attendance.settings', { graceMinutes: grace.value }); toast(`Time Out grace set to ${r.graceMinutes} minutes`, 'ok'); ctx.refresh(); } catch (err) { toast(errorOf(err), 'err'); } });
  box.append(h('div.card.stagger', { style: { maxWidth: '640px' } }, h('div.card__head', h('div', h('h2', 'Time Out grace period'), h('p.sub', 'Applies after each scheduled morning and afternoon Time Out.'))),
    h('div.form', field('Grace (whole minutes)', grace, 'Default 10. Regular pay stops at the scheduled cutoff; the grace only keeps the session open for a manual Time Out.'), ex, h('div.row', { style: { justifyContent: 'flex-end' } }, h('button.btn.primary', { onclick: save }, 'Save setting')))));
}
function reviewTab(box, ctx, data) {
  const recompute = async r => { try { const x = await api.action('earnings.finalize', { userId: r.userId, day: r.day }); toast(x.locked ? 'Already paid — unchanged' : `Recomputed · ${WORK_TAG[x.status]?.[0] || x.status} · ${peso(x.amount)}`, 'ok'); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); } };
  const list = data.review || [];
  box.append(h('div.card.stagger', h('div.card__head', h('div', h('h2', 'Needs review'), h('p.sub', 'Missing taps, overtime and unconfirmed morning absences that are not yet paid. Lateness and early departure are deducted automatically.'))),
    list.length ? h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Staff'), h('th', 'Date'), h('th', 'Issue'), h('th', 'Worked · paid'), h('th.right', 'Earnings'), h('th'))), h('tbody', ...list.map(r => h('tr', h('td', h('b', r.name)), h('td', dateText(r.day, { weekday: 'short', month: 'short', day: 'numeric' })), h('td', workTag(r.status), h('div.small.muted', flagText(r.flags))), h('td', r.minutes === null ? '—' : `${minutesText(r.minutes)} · ${minutesText(r.payable)}`), h('td.num', r.amount === null ? '—' : r.rateMissing ? h('span.small.muted', 'Rate not set') : peso(r.amount)), h('td', h('div.row', { style: { justifyContent: 'flex-end' } }, r.flags?.includes('morning_absence_unconfirmed') ? h('button.btn.sm.primary', { onclick: () => confirmMorning(ctx, r) }, 'Confirm morning absence') : null, h('button.btn.sm.ghost', { onclick: () => correctionForm(ctx, data, { userId: r.userId, day: r.day, kind: r.status === 'incomplete' ? 'out' : undefined }) }, 'Correct'), r.status !== 'incomplete' ? h('button.btn.sm', { onclick: () => recompute(r) }, 'Recompute') : null, h('a.btn.sm.ghost', { href: '#/staff/' + r.userId }, 'Profile')))))))) : empty('Nothing needs review', 'check')));
}
function excusesTab(box, ctx, data) {
  const approve = e => {
    const paid = select([{ value: 'paid', label: 'Paid — counts as paid time' }, { value: 'unpaid', label: 'Unpaid — no pay for the excused time' }], { value: 'unpaid' }), note = input({ placeholder: 'Optional note to the employee' });
    const body = h('div.form', h('p', h('b', `${e.name} · ${dateLong(e.day)}`), h('br'), `${e.coverageLabel}${e.emergency ? ' · same-day emergency' : ''} — ${e.reason}`), field('Pay for the excused time', paid), field('Note', note));
    modal({ title: 'Approve excuse', size: 'narrow', body, foot: close => h('button.btn.primary', { onclick: ev => busy(ev.currentTarget, async () => { showError(body, ''); try { await api.action('excuse.review', { id: e.id, decision: 'Excused', paid: paid.value, note: note.value }); toast(`Excuse approved · ${paid.value === 'paid' ? 'Paid' : 'Unpaid'}`, 'ok'); close(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Approve') });
  };
  const decline = async e => { const note = await confirm({ title: 'Decline excuse', message: `${e.name} · ${dateLong(e.day)}\n${e.reason}`, okText: 'Decline', danger: true, requireReason: true }); if (note === null || note === false) return; try { await api.action('excuse.review', { id: e.id, decision: 'Declined', note: typeof note === 'string' ? note : '' }); toast('Excuse declined', 'ok'); ctx.refresh(); } catch (err) { toast(errorOf(err), 'err'); } };
  const togglePaid = async e => { try { await api.action('excuse.pay', { id: e.id, paid: e.paid ? 'unpaid' : 'paid' }); toast(`Marked ${e.paid ? 'Unpaid' : 'Paid'}`, 'ok'); ctx.refresh(); } catch (err) { toast(errorOf(err), 'err'); } };
  box.append(h('div.grid.two.stagger', h('div.card', h('div.card__head', h('h2', 'Pending approval'), h('span.badge', { style: { background: data.pendingExcuses.length ? 'var(--warn)' : 'var(--line-2)' } }, data.pendingExcuses.length)), data.pendingExcuses.length ? h('div.list', ...data.pendingExcuses.map(e => h('div.list__item', h('span.ic.warn', icon('calendar')), h('span.body', h('b', `${e.name} · ${dateLong(e.day)}`), h('span', `${e.coverageLabel}${e.emergency ? ' · same-day emergency' : ''}`), h('span', e.reason), h('span', `Filed ${ago(e.created)}`)), h('div.row', h('button.btn.sm.danger', { onclick: () => decline(e) }, 'Decline'), h('button.btn.sm.primary', { onclick: () => approve(e) }, 'Approve'))))) : empty('Nothing to review', 'check')),
    h('div.card', h('div.card__head', h('h2', 'Recent decisions')), data.recentExcuses.length ? h('div.list', ...data.recentExcuses.map(e => h('div.list__item', h('span.ic.' + (e.status === 'Excused' ? 'ok' : 'danger'), icon('calendar')), h('span.body', h('b', `${e.name} · ${dateLong(e.day)}`), h('span', `${e.coverageLabel} · ${e.reason}`), e.note ? h('span', `Note: ${e.note}`) : null), h('div.col', { style: { alignItems: 'flex-end', gap: '4px' } }, tag(e.status, e.status), e.status === 'Excused' ? paidTag(e.paid) : null, e.status === 'Excused' && !e.locked ? h('button.btn.sm.ghost', { onclick: () => togglePaid(e) }, e.paid ? 'Make unpaid' : 'Make paid') : null, h('span.small.muted', e.reviewer))))) : empty('No decisions yet', 'calendar'))));
}
function schedulesTab(box, ctx, data) {
  box.append(h('div.grid.two.stagger', h('div.card', h('div.card__head', h('h2', 'Current shifts'), h('button.btn.sm.primary', { onclick: () => scheduleForm(ctx, data) }, icon('plus', 'sm'), 'New schedule')), h('div.list', ...data.staff.map(s => h('div.list__item', h('span.ic', icon('clock')), h('span.body', h('b', s.name), h('span', titleOf(s) + (s.active ? '' : ' · inactive'))), h('b.num', `${s.shift.start}–${s.shift.lunchStart || '11:30'} · ${s.shift.lunchEnd || '13:00'}–${s.shift.end}`))))),
    h('div.card', h('div.card__head', h('h2', 'Schedule history')), data.schedules.length ? h('div.list', ...data.schedules.map(s => h('div.list__item', h('span.ic.info', icon('calendar')), h('span.body', h('b', s.name), h('span', `Effective ${dateLong(s.effective)}`)), h('b.num', `${s.start}–${s.lunchStart || '—'} · ${s.lunchEnd || '—'}–${s.end}`)))) : empty('Default 07:00 – 17:00 for everyone', 'clock'))));
}
function scheduleForm(ctx, data) {
  const people = h('div.col', { style: { gap: '6px', maxHeight: '180px', overflow: 'auto' } }, ...data.staff.filter(s => s.active).map(s => h('label.row', h('input', { type: 'checkbox', value: s.id }), s.name)));
  const start = input({ type: 'time', value: '07:30' }), lunchStart = input({ type: 'time', value: '11:30' }), lunchEnd = input({ type: 'time', value: '13:00' }), end = input({ type: 'time', value: '17:00' }), total = h('p.small.muted'), effective = input({ type: 'date', value: todayPH() });
  const body = h('div.form', field('Staff', people, 'Select one or more'), h('div.form.two', field('Morning start', start), field('Lunch starts', lunchStart)), h('div.form.two', field('Lunch ends', lunchEnd), field('Shift end', end)), total, field('Effective date', effective, 'Earlier days keep their old schedule'));
  const mins = t => { const [a, b] = (t || '0:0').split(':').map(Number); return a * 60 + b; };
  const upd = () => { const m = Math.max(0, mins(lunchStart.value) - mins(start.value)) + Math.max(0, mins(end.value) - mins(lunchEnd.value)); total.textContent = `Scheduled work: ${minutesText(m)} per day (lunch not counted)`; };
  for (const x of [start, lunchStart, lunchEnd, end]) x.oninput = upd; upd();
  modal({ title: 'Set work schedule', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); const ids = [...people.querySelectorAll('input:checked')].map(i => Number(i.value)); if (!ids.length) return showError(body, 'Select at least one staff member.'); try { await api.action('schedule.set', { userIds: ids, start: start.value, end: end.value, lunchStart: lunchStart.value, lunchEnd: lunchEnd.value, effective: effective.value }); toast('Schedule saved', 'ok'); close(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Save schedule') });
}
function correctionForm(ctx, data, preset = {}) {
  const person = select([{ value: '', label: 'Choose staff…' }, ...data.staff.map(s => ({ value: s.id, label: s.name }))], { value: preset.userId || '' });
  const day = input({ type: 'date', value: preset.day || todayPH(), max: todayPH() }), kind = select(TAPS.map(k => ({ value: k, label: TAP_LABELS[k] })), { value: preset.kind || 'in' }), time = input({ type: 'time' }), reason = h('textarea.textarea', { placeholder: 'Why is this entry being corrected? (required)' });
  const body = h('div.form', field('Staff', person), h('div.form.two', field('Date', day), field('Entry', kind)), field('Corrected time', time), field('Reason', reason, 'The original value, corrected value, who changed it and when are kept for audit.'));
  modal({ title: 'Correct attendance entry', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('attendance.correct', { userId: person.value, day: day.value, kind: kind.value, time: time.value, reason: reason.value }); toast('Entry corrected', 'ok'); close(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Save correction') });
}
