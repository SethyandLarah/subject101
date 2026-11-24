// Admin › Sync inbox: entries recorded offline wait here until approved.
// Approval re-checks stock, pricing and attendance rules with the original time and employee.
import { api } from '../api.js';
import { h, clear, peso, dateTime, ago, toast, busy, errorOf, empty, skeleton, tag, confirm, segmented } from '../ui.js';
import { icon } from '../icons.js';
import { go, reloadBoot } from '../app.js';

const ICON = { 'attendance.clock': 'clock', 'sale.checkout': 'receipt', 'stock.in': 'download', 'stock.out': 'upload', 'count.submit': 'clipboard' };
const CONFLICT = { TOTAL_CHANGED: 'Price or promo changed since it was recorded', SUBTOTAL_CHANGED: 'Regular price changed since the Tawad was agreed' };

export async function sync(ctx) {
  const { el, user, params } = ctx;
  if (user.role !== 'admin') { go('profile'); return; }
  const tab = params[0] || 'pending';
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Admin'), h('h1', 'Sync inbox'), h('p.muted', 'Offline attendance taps, sales and Stock In wait here. Nothing counts in sales, stock or payroll until you approve it.'))));
  const body = h('div'); el.append(body); body.append(skeleton(2));
  const d = await api.get('offline');
  clear(body);
  const tabs = [{ value: 'pending', label: `Pending · ${d.pending.length}` }, { value: 'review', label: `Needs review · ${d.review.length}` }, { value: 'recent', label: 'Approved & rejected' }];
  body.append(h('div', { style: { margin: '0 4px 14px' } }, segmented(tabs, tab, v => go('sync/' + v))));
  const after = async msg => { toast(msg, 'ok'); await reloadBoot(); ctx.refresh(); };
  const approve = (ids, extra = {}) => api.action('offline.approve', { ids, ...extra });
  const summary = r => r.needsReview ? `${r.approved} approved · ${r.needsReview} need review (shown in the Needs review tab)` : `${r.approved} approved`;
  const reject = async e => { const reason = await confirm({ title: 'Reject this entry?', message: `${e.name} · ${e.title}`, okText: 'Reject', danger: true, requireReason: true }); if (!reason) return; try { await api.action('offline.reject', { id: e.id, reason }); after('Entry rejected · employee notified'); } catch (err) { toast(errorOf(err), 'err'); } };
  const row = (e, { selectable, actions }) => h('div.list__item.inbox', selectable ? h('input', { type: 'checkbox', class: 'pick', value: e.id, 'aria-label': 'Select entry' }) : null,
    h('span.ic.' + (e.status === 'needs_review' ? 'danger' : e.status === 'approved' ? 'ok' : e.status === 'rejected' ? '' : 'warn'), icon(ICON[e.action] || 'refresh')),
    h('span.body', h('b', `${e.title}`), h('span', `${e.name} · recorded ${dateTime(e.occurred)} · uploaded ${ago(e.uploaded)}`), e.detail ? h('span', e.detail + (e.total !== null && e.total !== undefined ? ` · ${peso(e.total)}` : '')) : null,
      e.error ? h('span', { style: { color: e.status === 'rejected' ? 'var(--muted)' : 'var(--danger)' } }, (e.conflict ? CONFLICT[e.conflict] + ' — ' : '') + e.error) : null, e.reviewer ? h('span', `${e.statusLabel} by ${e.reviewer} · ${ago(e.reviewedAt)}`) : null),
    h('div.row.wrap', { style: { gap: '6px', justifyContent: 'flex-end' } }, tag(e.statusLabel, e.status === 'approved' ? 'Present' : e.status === 'needs_review' ? 'Absent' : e.status === 'rejected' ? 'neutral' : 'pending'), ...(actions ? actions(e) : [])));

  if (tab === 'pending') {
    const list = h('div.list', ...d.pending.map(e => row(e, { selectable: true, actions: e => [h('button.btn.sm.ghost', { onclick: () => reject(e) }, 'Reject'), h('button.btn.sm.primary', { onclick: ev => busy(ev.currentTarget, async () => { try { after(summary(await approve([e.id]))); } catch (err) { toast(errorOf(err), 'err'); } }) }, 'Approve')] })));
    const selected = () => [...list.querySelectorAll('.pick:checked')].map(x => Number(x.value));
    body.append(h('div.card.stagger', h('div.card__head', h('div', h('h2', 'Waiting for approval'), h('p.sub', 'Approved in the order they were recorded. Conflicts (sold-out stock, changed prices, duplicate taps) move to Needs review; the rest still go through.')),
      d.pending.length ? h('div.row', h('button.btn.sm', { onclick: () => list.querySelectorAll('.pick').forEach(x => { x.checked = !x.checked; }) }, 'Select all'), h('button.btn.sm', { onclick: e => busy(e.currentTarget, async () => { const ids = selected(); if (!ids.length) return toast('Select entries first', 'warn'); try { after(summary(await approve(ids))); } catch (err) { toast(errorOf(err), 'err'); } }) }, 'Approve selected'), h('button.btn.sm.primary', { onclick: e => busy(e.currentTarget, async () => { try { after(summary(await api.action('offline.approve', { all: true }))); } catch (err) { toast(errorOf(err), 'err'); } }) }, icon('check', 'sm'), 'Approve all')) : null),
      d.pending.length ? list : empty('Nothing waiting', 'check')));
  } else if (tab === 'review') {
    body.append(h('div.card.stagger', h('div.card__head', h('div', h('h2', 'Needs review'), h('p.sub', 'Fix the cause (e.g. receive stock, correct attendance) and retry, approve a sale at today’s prices, or reject it.'))),
      d.review.length ? h('div.list', ...d.review.map(e => row(e, { actions: e => [h('button.btn.sm.ghost', { onclick: () => reject(e) }, 'Reject'), e.conflict ? h('button.btn.sm', { onclick: ev => busy(ev.currentTarget, async () => { try { after(summary(await approve([e.id], { atCurrentPrices: true }))); } catch (err) { toast(errorOf(err), 'err'); } }) }, 'Approve at current prices') : null, h('button.btn.sm.primary', { onclick: ev => busy(ev.currentTarget, async () => { try { after(summary(await approve([e.id]))); } catch (err) { toast(errorOf(err), 'err'); } }) }, 'Retry')].filter(Boolean) }))) : empty('No conflicts', 'check')));
  } else {
    body.append(h('div.card.stagger', d.recent.length ? h('div.list', ...d.recent.map(e => row(e, {}))) : empty('No decisions yet', 'refresh')));
  }
}
