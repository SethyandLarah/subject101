// My Profile: display name, photo, password, sign out.
import { api, queue } from '../api.js';
import { h, toast, busy, errorOf, field, input, showError, photoPicker, roleName, titleOf, tag, empty, ago, sound } from '../ui.js';
import { icon } from '../icons.js';
import { signOut, reloadBoot, avatarEl, enablePush, langSwitch, changeLanguage } from '../app.js';

export async function profile(ctx) {
  const { el, user, boot } = ctx;
  let photo;
  const name = input({ value: user.name });
  const saveBtn = h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(pf, ''); try { await api.action('profile.update', { name: name.value, photo }); toast('Profile saved', 'ok'); await reloadBoot(); ctx.refresh(); } catch (err) { showError(pf, errorOf(err)); } }) }, 'Save profile');
  const isAdmin = user.role === 'admin';
  const pf = h('div.form', isAdmin ? photoPicker({ current: user.photo ? `/media/staff/${user.id}?v=${Date.now()}` : null, onPick: d => photo = d, label: 'My photo' }) : h('p.small.muted.row', { style: { gap: '8px' } }, icon('camera', 'sm'), 'The Admin adds and changes your profile photo.'), field('Display name', name, 'Used in greetings and records'), h('div', saveBtn));
  const cur = input({ type: 'password', autocomplete: 'current-password', placeholder: 'Current password' }), next = input({ type: 'password', autocomplete: 'new-password', placeholder: 'New password (8+)' }), again = input({ type: 'password', autocomplete: 'new-password', placeholder: 'Repeat new password' });
  const pw = h('div.form', field('Current password', cur), h('div.form.two', field('New password', next), field('Repeat', again)), h('div', h('button.btn', { onclick: e => busy(e.currentTarget, async () => { showError(pw, ''); if (next.value !== again.value) return showError(pw, 'New passwords do not match.'); try { await api.password(cur.value, next.value); toast('Password changed', 'ok'); cur.value = next.value = again.value = ''; } catch (err) { showError(pw, errorOf(err)); } }) }, icon('lock', 'sm'), 'Change password')));
  const pending = queue.all();
  const ACTION = { 'attendance.clock': 'Attendance tap', 'sale.checkout': 'Sale', 'order.create': 'Order for the Cashier', 'stock.in': 'Stock In', 'stock.out': 'Stock Out', 'count.submit': 'Stock count' };
  const uploads = user.role === 'admin' ? [] : ((await api.get('offline').catch(() => ({ mine: [] }))).mine || []);
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Account'), h('h1', 'My Profile')), h('div.page__actions', h('button.btn.danger', { onclick: signOut }, icon('logout', 'sm'), 'Sign out'))),
    // The hardware's profile, shown the same way in every portal (Admin edits it in Store Profile).
    h('div.card.storecard.stagger', h('img.storecard__logo', { src: '/media/logo', alt: '' }),
      h('div.storecard__body', h('p.eyebrow', 'Hardware'), h('h2', boot.storeName), h('p.small.muted', user.role === 'admin' ? 'Logo, name, background and brand colour are set in Store Profile.' : `You work here as ${titleOf(user)} · shift ${boot.shift.start}–${boot.shift.end}`)),
      user.role === 'admin' ? h('a.btn.sm', { href: '#/settings' }, icon('settings', 'sm'), 'Store Profile') : h('span.tag.ok.plain', titleOf(user))),
    h('div.grid.two.stagger', { style: { marginTop: '14px' } },
      h('div.card', h('div.row', { style: { gap: '16px', marginBottom: '18px' } }, avatarEl(user, 'xl'), h('div', h('h2', user.name), h('p.muted', `@${user.username} · ${titleOf(user)}`), h('div.row', { style: { marginTop: '6px' } }, tag(titleOf(user), 'ok'), h('span.small.muted', `Shift ${boot.shift.start}–${boot.shift.end}`)))), pf),
      h('div.col', h('div.card.langcard', h('div.card__head', h('h2.row', { style: { gap: '8px' } }, icon('globe', 'sm'), 'Language'), langSwitch(changeLanguage)), h('p.small.muted', 'Choose the language of the whole app on this account. The app reloads after you pick one.')),
        h('div.card', h('div.card__head', h('h2', 'Security')), pw),
        (() => { const tg = h('button.toggle' + (sound.enabled ? '.on' : ''), { 'aria-label': 'UI sounds', 'data-silent-click': 'true', onclick: () => { sound.enabled = !sound.enabled; tg.classList.toggle('on', sound.enabled); if (sound.enabled) sound.play('pop'); } });
          const vol = h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: sound.volume, style: { width: '100%', accentColor: 'var(--primary)' }, oninput: e => { sound.volume = Number(e.target.value); }, onchange: () => sound.play('pop') });
          return h('div.card', h('div.card__head', h('h2', 'Sounds'), tg), h('p.small.muted', 'Soft clicks, pops and chimes on this device only. Automatically silent when the phone is on silent / Do Not Disturb, follows the laptop volume, and never plays while the app is in the background.'), h('div.row', { style: { marginTop: '10px', gap: '12px' } }, h('span.small.muted', 'Volume'), vol), h('div.row.wrap', { style: { marginTop: '10px', gap: '6px' } }, ...['tap', 'tab', 'pop', 'success', 'coin', 'notify', 'error'].map(n => h('button.btn.sm', { 'data-silent-click': 'true', onclick: () => sound.play(n) }, n)))); })(),
        (() => { const st = h('span.small.muted', 'Notification' in window ? `Status: ${Notification.permission}` : 'Not supported on this browser'); return h('div.card', h('div.card__head', h('h2', 'Phone alerts'), h('button.btn.sm', { onclick: async () => { const r = await enablePush(); st.textContent = `Status: ${r}`; toast(r === 'granted' ? 'Alerts enabled on this device' : 'Alerts not enabled', r === 'granted' ? 'ok' : 'err'); } }, icon('bell', 'sm'), 'Enable')), h('p.small.muted', 'Shows a short private alert (no amounts) when a salary payment is recorded for you.'), st); })(),
        h('div.card', h('div.card__head', h('h2', 'Sync Center'), h('button.btn.sm', { onclick: e => busy(e.currentTarget, () => queue.sync()).then(() => ctx.refresh()) }, icon('refresh', 'sm'), 'Sync now')),
          h('p.small.muted', `${navigator.onLine ? 'Online' : 'Offline'} · ${pending.length ? pending.length + ' on this device' : 'nothing waiting on this device'}`),
          pending.length || uploads.length ? h('div.list', ...pending.map(p => h('div.list__item', h('span.ic.' + (p.error ? 'danger' : 'warn'), icon(p.error ? 'alert' : 'clock')), h('span.body', h('b', ACTION[p.action] || p.action), h('span', p.error || `Pending upload · recorded ${ago(p.occurred)}`)), p.error ? h('button.btn.sm.ghost', { onclick: () => { queue.remove(p.key); ctx.refresh(); } }, 'Discard') : tag('Pending upload', 'pending'))),
            ...uploads.slice(0, 15).map(p => h('div.list__item', h('span.ic.' + (p.status === 'approved' ? 'ok' : p.status === 'needs_review' || p.status === 'rejected' ? 'danger' : 'warn'), icon(p.status === 'approved' ? 'check' : 'refresh')), h('span.body', h('b', p.title), h('span', `Recorded ${ago(p.occurred)}${p.error ? ' · ' + p.error : ''}`)), tag(p.statusLabel, p.status === 'approved' ? 'Present' : p.status === 'pending' ? 'pending' : 'Absent')))) : h('p.small.muted', 'Everything is synced.')))));
}
