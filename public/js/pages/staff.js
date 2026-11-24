// Staff Accounts (Admin): directory, create/edit, reset password, deactivate.
import { api } from '../api.js';
import { h, clear, peso, minutesText, todayPH, dateText, modal, confirm, toast, busy, errorOf, field, input, select, showError, empty, skeleton, tag, roleName, titleOf, initials, photoPicker } from '../ui.js';
import { icon } from '../icons.js';
import { go, avatarEl } from '../app.js';

export async function staff(ctx) {
  const { el, user, params } = ctx;
  if (user.role !== 'admin') { go('profile'); return; }
  if (params[0]) return employeeProfile(ctx, Number(params[0]));
  const q = h('input', { placeholder: 'Search name, username or role…', oninput: () => render() });
  const list = h('div');
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Admin'), h('h1', 'Staff Accounts')), h('div.page__actions', h('button.btn.primary', { onclick: () => staffForm(null, ctx) }, icon('plus', 'sm'), 'New account'))), h('div.card', { style: { marginBottom: '14px' } }, h('div.search', icon('search', 'sm'), q)), list);
  let all = [];
  const render = () => {
    const s = q.value.trim().toLowerCase();
    const items = all.filter(p => !s || (p.name + ' ' + p.username + ' ' + titleOf(p)).toLowerCase().includes(s));
    clear(list);
    if (!items.length) return list.append(h('div.card', empty('No staff found', 'users')));
    list.append(h('div.grid.three.stagger', ...items.map((p, i) => h('div.card', { style: { '--i': i, opacity: p.active ? 1 : .6 } },
      h('div.row', { style: { alignItems: 'flex-start' } }, avatarEl(p, 'lg'), h('div.grow', h('b', p.name), h('div.small.muted', `@${p.username}`), h('div.row', { style: { marginTop: '6px', gap: '6px' } }, tag(titleOf(p), p.isMain ? 'Present' : p.role === 'admin' ? 'info' : p.role === 'attendance' ? 'neutral' : 'ok'), p.role === 'attendance' ? h('span.small.muted', 'Attendance only') : null, !p.active ? tag('Deactivated', 'danger') : p.temporary ? tag('Temp password', 'warn') : null))),
      h('div.small.muted', { style: { marginTop: '12px' } }, `Shift ${p.shift.start}–${p.shift.end}${p.lastIn ? ' · last time in ' + dateText(p.lastIn) : ''}`),
      p.role === 'admin' ? null : h('div.small', { style: { marginTop: '6px' } }, p.hasRate ? h('span', 'Daily rate ', h('b', peso(p.rate))) : tag('Daily rate not set', 'warn plain')),
      p.isMain ? h('p.small.muted', { style: { marginTop: '12px' } }, 'Main Admin — cannot be demoted or deactivated.') : p.role === 'admin' && !ctx.user.isMain ? h('p.small.muted', { style: { marginTop: '12px' } }, 'Only the Main Admin manages Admin accounts.') : h('div.row.wrap', { style: { marginTop: '12px', gap: '6px' } }, h('button.btn.sm', { onclick: () => staffForm(p, ctx) }, icon('edit', 'sm'), 'Edit'), h('button.btn.sm', { onclick: () => resetForm(p, ctx) }, icon('lock', 'sm'), 'Reset password'), h('button.btn.sm', { onclick: () => validIdModal(p, ctx) }, icon('shield', 'sm'), p.validId ? 'Valid ID ✓' : 'Valid ID'), h('button.btn.sm' + (p.active ? '.danger' : '.soft'), { onclick: async () => { const ok = await confirm({ title: p.active ? `Deactivate ${p.name}?` : `Reactivate ${p.name}?`, message: p.active ? 'They will be signed out everywhere. Their history stays intact.' : 'They can sign in again.', okText: p.active ? 'Deactivate' : 'Reactivate', danger: p.active }); if (!ok) return; try { await api.action('staff.active', { id: p.id, active: !p.active }); toast(p.active ? 'Account deactivated' : 'Account reactivated', 'ok'); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); } } }, p.active ? 'Deactivate' : 'Reactivate'), p.role === 'admin' ? null : h('button.btn.sm.primary', { onclick: () => go('staff/' + p.id) }, icon('coins', 'sm'), 'Earnings & pay'), p.role === 'admin' ? null : h('button.btn.sm.ghost', { onclick: () => go('attendance/monthly?user=' + p.id) }, 'Attendance'))))));
  };
  list.append(skeleton(1)); all = await api.get('staff'); render();
}
function staffForm(existing, ctx) {
  const titles = ctx.boot.attendanceTitles || ['Staff', 'Cement Worker', 'Delivery Driver', 'Helper', 'Loader'];
  // One dropdown: clerk roles first, then the attendance-only job titles, then Other.
  const options = [
    ...(ctx.user.isMain ? [{ value: 'admin', label: 'Admin (full work access)' }] : []),
    { value: 'sales', label: 'Sales Clerk' }, { value: 'cashier', label: 'Cashier' }, { value: 'stock', label: 'Stock Clerk' }, { value: 'sales+stock', label: 'Sales & Stock Clerk (both)' },
    ...titles.map(t => ({ value: 'title:' + t, label: t === 'Staff' ? 'Staff (Multitasking)' : t })), { value: 'title:Other', label: 'Other (attendance only)' },
  ];
  const currentValue = existing ? (existing.role === 'attendance' ? (titles.includes(existing.jobTitle) ? 'title:' + existing.jobTitle : 'title:Other') : existing.role) : 'sales';
  const name = input({ value: existing?.name || '', placeholder: 'Full name' }), username = input({ value: existing?.username || '', placeholder: 'username', autocapitalize: 'none' });
  const role = select(options, { value: currentValue }), other = input({ value: existing?.role === 'attendance' && !titles.includes(existing.jobTitle) ? existing.jobTitle : '', placeholder: 'e.g. Welder', maxlength: 60 });
  const password = input({ type: 'text', placeholder: 'Temporary password (8+ characters)', autocomplete: 'new-password' });
  // Profile photos are set here by the Admin; staff cannot change their own.
  let photo; const pick = photoPicker({ current: existing?.photo ? `/media/staff/${existing.id}?v=${Date.now()}` : null, onPick: d => photo = d, label: 'Profile photo' });
  const otherField = field('Specify job title', other, 'Required when Other is selected'); const access = h('p.small.muted');
  const sync = () => { otherField.style.display = role.value === 'title:Other' ? '' : 'none'; access.textContent = role.value.startsWith('title:') ? 'Access: My Attendance only (Time In/Out, earnings, excuse requests).' : role.value === 'admin' ? 'Access: all Admin work screens. Only the Main Admin can create Admins, change roles of Admins or deactivate them.' : 'Access: work screens for this role plus personal attendance.'; if (role.value === 'title:Other') other.focus(); };
  role.onchange = sync; sync();
  const body = h('div.form', pick, field('Full name', name), h('div.form.two', field('Username', username), field('Role / job title', role)), otherField, access, existing ? null : field('Temporary password', password, 'Staff must change it on first sign-in'));
  modal({ title: existing ? 'Edit staff account' : 'New staff account', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => {
    showError(body, '');
    const v = role.value; const isTitle = v.startsWith('title:');
    if (v === 'title:Other' && !other.value.trim()) { other.classList.add('err'); setTimeout(() => other.classList.remove('err'), 500); return showError(body, 'Specify the job title.'); }
    try { await api.action('staff.save', { id: existing?.id, name: name.value, username: username.value, role: isTitle ? 'attendance' : v, jobTitle: isTitle ? v.slice(6) : undefined, jobTitleOther: v === 'title:Other' ? other.value.trim() : undefined, password: password.value, photo }); toast(existing ? 'Account updated' : 'Account created', 'ok'); close(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); }
  }) }, existing ? 'Save' : 'Create account') });
}
// Private valid ID: fetched with the session cookie into memory only (no URL to share, nothing cached or stored offline).
async function validIdModal(p, ctx) {
  const view = h('div.idview'); let objectUrl = null;
  const load = async () => {
    clear(view);
    if (!p.validId) return view.append(empty('No valid ID on file', 'shield'));
    view.append(skeleton(1));
    try {
      const res = await fetch('/api/staff-id/' + p.id, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not open the ID.');
      if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = URL.createObjectURL(await res.blob());
      clear(view).append(p.validId.mime === 'application/pdf' ? h('a.btn', { href: objectUrl, target: '_blank', rel: 'noopener' }, icon('receipt', 'sm'), `Open ${p.validId.name} (PDF)`) : h('img', { src: objectUrl, alt: 'Valid ID', style: { maxWidth: '100%', borderRadius: '14px', display: 'block' } }), h('p.small.muted', { style: { marginTop: '8px' } }, `${p.validId.name} · ${Math.round(p.validId.size / 1024)} KB · uploaded ${dateText(p.validId.uploaded)}`));
    } catch (e) { clear(view).append(h('p.small', errorOf(e))); }
  };
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf', style: { display: 'none' } });
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    if (f.size > 1_400_000) return toast('The ID file must be 1.4 MB or smaller.', 'err');
    const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(f); });
    try { const r = await api.action('staff.idUpload', { id: p.id, file: data, name: f.name }); toast(r.replaced ? 'Valid ID replaced' : 'Valid ID uploaded', 'ok'); p.validId = { mime: f.type, name: f.name, size: f.size, uploaded: new Date().toISOString() }; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); setTimeout(() => validIdModal(p, ctx), 260); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); }
    file.value = '';
  };
  modal({ title: 'Valid ID', subtitle: `${p.name} · private — visible to Admin only`, body: h('div.col', view, file), onClose: () => objectUrl && URL.revokeObjectURL(objectUrl),
    foot: close => h('div.row', p.validId ? h('button.btn.danger', { onclick: async () => { const ok = await confirm({ title: 'Remove valid ID?', message: p.name, okText: 'Remove', danger: true }); if (!ok) return; try { await api.action('staff.idRemove', { id: p.id }); toast('Valid ID removed', 'ok'); close(); ctx.refresh(); } catch (e) { toast(errorOf(e), 'err'); } } }, 'Remove') : null, h('button.btn.primary', { onclick: () => file.click() }, icon('upload', 'sm'), p.validId ? 'Replace' : 'Upload')) });
  load();
}
function resetForm(p, ctx) {
  const password = input({ type: 'text', placeholder: 'New temporary password', autocomplete: 'new-password' });
  const body = h('div.form', field('Temporary password', password, `${p.name} will be signed out and asked to set a new password.`));
  modal({ title: 'Reset password', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('staff.reset', { id: p.id, password: password.value }); toast('Password reset', 'ok'); close(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Reset') });
}

// ---- Employee profile: private daily rate, earnings, pay periods, salary payments ----
const STATUS = { complete: ['Complete', 'Present'], short: ['Short / late', 'warn'], overtime: ['Overtime', 'info'], incomplete: ['Incomplete', 'Absent'], review: ['Needs review', 'warn'], excused: ['Excused', 'Excused'] };
const stTag = s => STATUS[s] ? tag(STATUS[s][0], STATUS[s][1]) : tag(s, 'neutral');
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
async function employeeProfile(ctx, id) {
  const { el } = ctx;
  el.append(skeleton(2));
  let data = await api.get('earnings', { user: id });
  clear(el);
  const u = data.user;
  // Default the period to start after the last paid day (or the oldest unpaid earning).
  const unpaid = data.earnings.filter(e => !e.paid).map(e => e.day).sort();
  const lastPaid = data.payments[0]?.to;
  const startDefault = lastPaid ? addDays(lastPaid, 1) : unpaid[0] || todayPH();
  const mode = select([{ value: '1', label: 'Daily' }, { value: '15', label: 'Kinsena (15 days)' }, { value: '30', label: 'Monthly (30 days)' }, { value: 'custom', label: 'Custom' }], { value: '15' });
  const from = input({ type: 'date', value: startDefault, max: todayPH() }), to = input({ type: 'date', max: todayPH() });
  const previewBox = h('div');
  previewBox.append = (...n) => Element.prototype.append.apply(previewBox, n.filter(x => x !== null && x !== undefined && x !== false));
  let manualEnd = false;
  const syncTo = () => { if (mode.value !== 'custom' && !manualEnd) { let t = addDays(from.value, Number(mode.value) - 1); if (t > todayPH()) t = todayPH(); to.value = t; } };
  const loadPreview = async () => {
    syncTo(); if (to.value > todayPH()) to.value = todayPH(); if (from.value > todayPH()) from.value = todayPH(); clear(previewBox);
    if (!from.value || !to.value || from.value > to.value) return previewBox.append(h('p.small.muted', 'Choose a valid period.'));
    previewBox.append(skeleton(1));
    let p; try { p = (await api.get('earnings', { user: id, from: from.value, to: to.value })).preview; } catch (e) { clear(previewBox); return previewBox.append(h('p.small', errorOf(e))); }
    clear(previewBox);
    previewBox.append(
      h('div.receipt', h('div.r', h('span', 'Coverage dates'), h('b', p.from === p.to ? dateText(p.from) : `${dateText(p.from)} – ${dateText(p.to)}`)), h('div.r', h('span', 'Included days'), h('b', String(p.days.length))), h('div.r', h('span', 'Rates applied'), h('b', p.ratesApplied?.length ? p.ratesApplied.map(peso).join(', ') : '—')), p.pendingReview ? h('div.r', h('span', 'Days pending review'), h('b', { style: { color: 'var(--warn)' } }, String(p.pendingReview))) : null, h('div.r', h('span', 'Days already paid'), h('b', String(p.alreadyPaid.length))), p.rateMissing ? h('div.r', h('span', 'Days without a rate (₱0)'), h('b', { style: { color: 'var(--warn)' } }, String(p.rateMissing))) : null, h('hr'), h('div.r', h('b', 'Amount due'), h('b', { style: { fontSize: '20px' } }, peso(p.amount)))),
      p.alreadyPaid.length ? h('div.card.flat', { style: { marginTop: '10px', background: 'var(--danger-soft)', color: 'var(--danger)', fontWeight: 600 } }, `Already paid: ${p.alreadyPaid.map(a => dateText(a.day) + ' (paid ' + dateText(a.payDate) + ')').join(', ')}. Choose a period that does not overlap.`) : null,
      p.unsettled?.length ? h('p.small', { style: { color: 'var(--warn)', marginTop: '8px' } }, `Not finalized yet (missing taps): ${p.unsettled.map(d => dateText(d)).join(', ')}`) : null,
      p.days.length ? h('div.table-wrap', { style: { marginTop: '10px', maxHeight: '240px', overflow: 'auto' } }, h('table.t', h('thead', h('tr', h('th', 'Date'), h('th', 'Paid time'), h('th', 'Status'), h('th.right', 'Rate'), h('th.right', 'Amount'))), h('tbody', ...p.days.map(d => h('tr', h('td', dateText(d.day, { weekday: 'short', month: 'short', day: 'numeric' })), h('td', minutesText(d.payable ?? d.minutes)), h('td', stTag(d.status)), h('td.num.small.muted', d.rateMissing ? 'no rate' : '@ ' + peso(d.rate)), h('td.num', peso(d.amount))))))) : h('p.small.muted', { style: { marginTop: '10px' } }, 'No finalized days in this period.'),
      h('div.row', { style: { justifyContent: 'flex-end', marginTop: '12px' } }, h('button.btn.primary', { disabled: p.blocked || !p.days.length, onclick: () => payForm(ctx, u, p) }, icon('coins', 'sm'), 'Record salary payment')));
  };
  mode.onchange = () => { manualEnd = false; loadPreview(); }; from.onchange = () => { manualEnd = false; loadPreview(); }; to.onchange = () => { manualEnd = true; loadPreview(); };
  const rateInput = input({ type: 'number', min: 0, step: '0.01', value: u.rate ?? '', placeholder: 'e.g. 550.00' });
  const effInput = input({ type: 'date', value: todayPH() });
  const saveRate = e => busy(e.currentTarget, async () => { try { const r = await api.action('staff.rate', { id: u.id, rate: rateInput.value, effective: effInput.value }); toast(`Rate ${peso(r.rate)} from ${dateText(r.effective)} · ${r.recomputed} unpaid day${r.recomputed === 1 ? '' : 's'} recomputed`, 'ok'); ctx.refresh(); } catch (err) { toast(errorOf(err), 'err'); } });
  el.append(h('div.page__head', h('div', h('p.eyebrow', h('a', { href: '#/staff' }, 'Staff'), ' › Employee'), h('h1', u.name), h('p.sub', `${u.title} · Shift ${u.shift.start}–${u.shift.lunchStart || '11:30'} · ${u.shift.lunchEnd || '13:00'}–${u.shift.end}`)), h('div.page__actions', h('a.btn', { href: '#/attendance/monthly?user=' + u.id }, icon('calendar', 'sm'), 'Attendance'))));
  el.append(h('div.grid.three.stagger',
    h('div.card', h('div.kpi__label', h('span.ic', icon('lock', 'sm')), 'Daily rate (private)'), h('div.form.two', { style: { marginTop: '8px' } }, field('Daily rate (₱)', rateInput), field('Effective date', effInput)), h('div.row.between', { style: { marginTop: '8px' } }, h('span.small.muted', 'Paid days keep their rate.'), h('button.btn.sm.primary', { onclick: saveRate }, 'Save rate')), data.rates?.length ? h('div.list', { style: { marginTop: '8px' } }, ...data.rates.slice(0, 4).map((r, i) => h('div.row.between.small', { style: { padding: '4px 0', opacity: i ? .7 : 1 } }, h('span', r.effective ? `From ${dateText(r.effective)}` : 'From the start'), h('b', peso(r.rate))))) : h('p.small', { style: { color: 'var(--warn)', marginTop: '6px' } }, 'No rate yet — earnings show ₱0 until set.')),
    h('div.card', h('div.kpi__label', h('span.ic', icon('coins', 'sm')), 'Unpaid earnings'), h('div.kpi__value', peso(data.unpaidTotal)), h('p.small.muted', `${unpaid.length} unpaid day${unpaid.length === 1 ? '' : 's'}`)),
    h('div.card', h('div.kpi__label', h('span.ic', icon('check', 'sm')), 'Last salary payment'), h('div.kpi__value', data.payments[0] ? peso(data.payments[0].amount) : '—'), h('p.small.muted', data.payments[0] ? `${dateText(data.payments[0].payDate)} · ${data.payments[0].method}` : 'No payments yet'))));
  el.append(h('div.grid.two.stagger', { style: { marginTop: '14px' } },
    h('div.card', h('div.card__head', h('h2', 'Pay period')), h('div.form', field('Cutoff', mode), h('div.form.two', field('Start date', from), field('End date', to, 'Edit to move the cutoff'))), h('div', { style: { marginTop: '12px' } }, previewBox)),
    h('div.card', h('div.card__head', h('h2', 'Salary payment history')), data.payments.length ? h('div.list', ...data.payments.map(p => h('div.list__item', h('span.ic.ok', icon('coins')), h('span.body', h('b', peso(p.amount)), h('span', `${p.from === p.to ? dateText(p.from) : dateText(p.from) + ' – ' + dateText(p.to)} · ${p.days} day${p.days === 1 ? '' : 's'}`), h('span', `Paid ${dateText(p.payDate)} · ${p.method}${p.reference ? ' · Ref ' + p.reference : ''} · by ${p.actor}`))))) : empty('No salary payments yet', 'coins'))));
  el.append(h('div.card.stagger', { style: { marginTop: '14px' } }, h('div.card__head', h('h2', 'Daily earnings')), data.earnings.length ? h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Date'), h('th', 'Worked'), h('th', 'Paid time'), h('th', 'Status'), h('th.right', 'Rate'), h('th.right', 'Amount'), h('th', 'Paid'))), h('tbody', ...data.earnings.map(e => h('tr', h('td', dateText(e.day, { weekday: 'short', month: 'short', day: 'numeric' })), h('td', minutesText(e.minutes)), h('td.small', minutesText(e.payable ?? e.minutes)), h('td', stTag(e.status), e.review ? h('span.small', { style: { color: 'var(--warn)' } }, ' review') : null), h('td.num.small', e.rateMissing ? tag('No rate', 'warn plain') : peso(e.rate)), h('td.num', h('b', peso(e.amount))), h('td', e.paid ? tag(`Paid ${dateText(e.paid.payDate)}`, 'Present') : tag('Unpaid', 'neutral'))))))) : empty('Earnings appear after each Final Time Out', 'clock')));
  loadPreview();
}
function payForm(ctx, u, p) {
  const payDate = input({ type: 'date', value: todayPH(), max: todayPH() });
  const method = select(ctx.boot.payMethods || ['Cash', 'GCash', 'Maya', 'Bank transfer', 'Other']);
  const reference = input({ placeholder: 'Optional reference no.', maxlength: 120 });
  const body = h('div.form', h('div.receipt', h('div.r', h('span', 'Employee'), h('b', u.name)), h('div.r', h('span', 'Coverage dates'), h('b', p.from === p.to ? dateText(p.from) : `${dateText(p.from)} – ${dateText(p.to)}`)), h('div.r', h('span', 'Days'), h('b', String(p.days.length))), h('hr'), h('div.r', h('b', 'Amount'), h('b', peso(p.amount)))), h('div.form.two', field('Payout date', payDate), field('Method', method)), field('Reference', reference), h('p.small.muted', `Only ${u.name} will be notified.`));
  modal({ title: 'Record salary payment', body, foot: close => h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(body, ''); try { await api.action('salary.pay', { userId: u.id, from: p.from, to: p.to, amount: p.amount, payDate: payDate.value, method: method.value, reference: reference.value }); toast('Salary payment recorded', 'ok'); close(); ctx.refresh(); } catch (err) { showError(body, errorOf(err)); } }) }, 'Record payment') });
}
