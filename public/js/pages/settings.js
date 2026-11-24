// Store settings (Admin): branding, audit log, device install help.
import { api } from '../api.js';
import { h, clear, toast, busy, errorOf, field, input, showError, photoPicker, empty, skeleton, dateTime } from '../ui.js';
import { icon } from '../icons.js';
import { go, reloadBoot } from '../app.js';
import { BRAND_PRESETS, DEFAULT_BRAND, applyBrand, validHex, palette, contrast } from '../brand.js';

// The installed app's icon and opening screen show the store logo: draw it centred on a white
// square (with the safe margin Android needs) as 512 px and 192 px PNGs.
function appIconsFrom(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const make = (size, pad) => {
        const c = document.createElement('canvas'); c.width = c.height = size;
        const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
        const box = size * (1 - 2 * pad), k = Math.min(box / img.width, box / img.height);
        const w = img.width * k, hh = img.height * k;
        g.imageSmoothingQuality = 'high'; g.drawImage(img, (size - w) / 2, (size - hh) / 2, w, hh);
        return c.toDataURL('image/png');
      };
      resolve({ appIcon512: make(512, 0.12), appIcon192: make(192, 0.08) });
    };
    img.onerror = () => reject(new Error('The app icon could not be made from this logo.'));
    img.src = dataUrl;
  });
}
export async function settings(ctx) {
  const { el, user, boot } = ctx;
  if (user.role !== 'admin') { go('dashboard'); return; }
  let logo, background;
  const name = input({ value: boot.storeName, maxlength: 60 });
  const appName = input({ value: boot.appName || '', maxlength: 30, placeholder: 'DLKM BizPulse' });
  const form = h('div.form', field('App name', appName, 'Name of the installed app on phones and laptops, and on the browser tab.'), field('Store name', name), h('div.grid.two', photoPicker({ current: '/media/logo?v=' + Date.now(), onPick: d => logo = d, label: 'Store logo (app icon, opening screen, welcome card & login)' }), photoPicker({ current: '/media/background?v=' + Date.now(), onPick: d => background = d, label: 'Login background (blurred storefront photo)' })),
    h('div.row.wrap', h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => { showError(form, ''); try { const icons = logo ? await appIconsFrom(logo) : {}; await api.action('settings.save', { appName: appName.value, storeName: name.value, logo, background, ...icons }); toast('Store settings saved', 'ok'); await reloadBoot(); ctx.refresh(); } catch (err) { showError(form, errorOf(err)); } }) }, 'Save settings'), h('button.btn.ghost', { onclick: async e => { try { await api.action('settings.save', { resetLogo: true, resetBackground: true }); toast('Default images restored', 'ok'); ctx.refresh(); } catch (err) { toast(errorOf(err), 'err'); } } }, 'Restore default images')));
  const auditBox = h('div', skeleton(1));
  // Daily automatic backups (kept 30 days) so the store data survives a broken disk or a mistake.
  const backupList = h('div', skeleton(1));
  const renderBackups = d => clear(backupList).append(d.items.length ? h('div.list', ...d.items.slice(0, 7).map((b, i) => h('div.list__item', h('span.ic' + (i ? '' : '.ok'), icon('shield')), h('span.body', h('b', b.name), h('span', `${(b.size / 1048576).toFixed(1)} MB${i ? '' : ' · latest'}`))))) : empty('No backup yet', 'shield'));
  const backupCard = h('div.card', h('div.card__head', h('div', h('h2', 'Backups'), h('p.sub', 'Automatic copy every day, last 30 days kept in data/backups. Copy that folder to a USB or Google Drive weekly.')),
    h('button.btn.sm', { onclick: e => busy(e.currentTarget, async () => { try { const r = await fetch('/api/backups', { method: 'POST', headers: { 'X-Alaan': '1' } }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Backup failed'); renderBackups(d); toast('Backup saved', 'ok'); } catch (err) { toast(errorOf(err), 'err'); } }) }, icon('download', 'sm'), 'Back up now')), backupList);
  api.get('backups').then(renderBackups).catch(() => clear(backupList).append(h('p.small.muted', 'Backups are available on the store server.')));
  el.append(h('div.page__head', h('div', h('p.eyebrow', 'Admin'), h('h1', 'Store Profile'))),
    h('div.grid.main.stagger', h('div.col', h('div.card', h('div.card__head', h('h2', 'Branding')), form), brandCard(ctx), backupCard),
      h('div.card.pad-0', h('div.card__head', { style: { padding: '18px 18px 0' } }, h('h2', 'Audit log'), h('span.sub', 'Price, stock, attendance and account changes')), auditBox)));
  const log = await api.get('audit', { limit: 150 });
  clear(auditBox).append(log.length ? h('div.table-wrap', h('table.t', h('thead', h('tr', h('th', 'Action'), h('th', 'Detail'), h('th', 'By'), h('th', 'When'))), h('tbody', ...log.map(a => h('tr', h('td', h('b.small', a.action)), h('td.small', a.detail), h('td.small.muted', a.actor), h('td.small.muted', dateTime(a.created))))))) : empty('No audit entries yet', 'shield'));
}

// Brand colour: one colour → the whole system (light and dark), previewed live before saving.
function brandCard(ctx) {
  const saved = ctx.boot.brandColor || DEFAULT_BRAND;
  let pick = saved;
  const custom = h('input.brand__custom', { type: 'color', value: saved, 'aria-label': 'Custom colour' });
  const hexIn = input({ value: saved, maxlength: 7, placeholder: '#0f7a52', style: { maxWidth: '120px', fontFamily: 'var(--mono)' } });
  const note = h('p.small.muted');
  const swatches = h('div.brand__swatches', ...BRAND_PRESETS.map(p => h('button.brand__sw', { type: 'button', title: p.name, 'aria-label': p.name, style: { '--sw': p.hex }, dataset: { hex: p.hex }, onclick: () => set(p.hex) }, h('span', p.name))));
  const preview = h('div.brand__preview',
    h('span.btn.primary.sm', 'New sale'), h('span.brand__pill', 'Overview'), h('span.tag.ok', 'Paid'), h('span.brand__bar', h('i')));
  const set = hex => {
    if (!validHex(hex)) return;
    pick = hex.toLowerCase(); custom.value = pick; hexIn.value = pick; applyBrand(pick);
    swatches.querySelectorAll('.brand__sw').forEach(b => b.classList.toggle('on', b.dataset.hex === pick));
    const pal = palette(pick), adjusted = pal.light['--primary'] !== pick;
    note.textContent = (adjusted ? `Made a little darker (${pal.light['--primary']}) so white text on buttons stays readable. ` : '') + `Contrast: ${contrast(pal.light['--primary'], '#ffffff').toFixed(1)}:1 light · ${contrast(pal.dark['--primary-ink'], pal.dark['--primary']).toFixed(1)}:1 dark (passes WCAG AA 4.5:1).`;
    save.disabled = pick === (ctx.boot.brandColor || DEFAULT_BRAND);
  };
  custom.oninput = () => set(custom.value);
  hexIn.oninput = () => { const v = hexIn.value.trim(); if (validHex(v)) set(v); };
  const save = h('button.btn.primary', { onclick: e => busy(e.currentTarget, async () => {
    try {
      await api.action('settings.save', { brandColor: pick === DEFAULT_BRAND ? 'default' : pick });
      await reloadBoot();
      toast('Brand colour saved for every account', 'ok');
      // reloadBoot rebuilds the app shell. Re-render this route too, or the new shell stays blank.
      ctx.refresh?.();
    } catch (err) { toast(errorOf(err), 'err'); }
  }) }, icon('check', 'sm'), 'Save colour');
  const reset = h('button.btn.ghost', { onclick: () => set(DEFAULT_BRAND) }, 'Default green');
  queueMicrotask(() => set(saved));
  return h('div.card', h('div.card__head', h('div', h('h2', 'Brand colour'), h('p.sub', 'Pick one colour; the whole system (light and dark mode) follows it for every account.'))),
    swatches, h('div.row.wrap', { style: { gap: '10px', marginTop: '12px', alignItems: 'center' } }, h('label.brand__customwrap', custom, h('span.small', 'Custom')), hexIn), preview, note,
    h('div.row.wrap', { style: { gap: '8px', justifyContent: 'flex-end' } }, reset, save));
}
