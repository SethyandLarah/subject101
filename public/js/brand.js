// Store brand colour. The Admin picks ONE colour; the full light and dark palettes are derived
// from it (buttons, active tabs, soft tints, and lightly tinted backgrounds), and every text /
// button colour is checked for readable contrast (WCAG AA 4.5:1) and corrected if needed.
// The generated CSS is also cached on the device so the next start paints in the right colours.
export const DEFAULT_BRAND = '#0f7a52';
export const BRAND_PRESETS = [
  { name: 'Hardware Green', hex: '#0f7a52' },
  { name: 'Ocean Blue', hex: '#1d5fbf' },
  { name: 'Hardware Red', hex: '#c2312b' },
  { name: 'Safety Orange', hex: '#c95a0c' },
  { name: 'Teal', hex: '#0e7c86' },
  { name: 'Royal Purple', hex: '#6941c6' },
  { name: 'Wood Brown', hex: '#8a5a2b' },
  { name: 'Charcoal', hex: '#334155' },
];
const KEY = 'alaan.brandcss';

const toRgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const toHex = rgb => '#' + rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = toRgb(a), y = toRgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = hex => { const c = toRgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const validHex = v => /^#[0-9a-f]{6}$/i.test(String(v || ''));

/** Light and dark token sets for a brand colour. */
export function palette(brand) {
  let p = brand.toLowerCase();
  // Light mode: the colour must carry white text and read on white cards.
  for (let i = 0; i < 24 && (contrast(p, '#ffffff') < 4.6 || contrast(p, mix('#f0f3f1', p, 0.05)) < 4.5); i++) p = mix(p, '#000000', 0.06);
  const light = {
    '--primary': p, '--primary-2': mix(p, '#000000', 0.22), '--primary-soft': mix('#ffffff', p, 0.15), '--primary-ink': '#ffffff', '--mint': mix('#ffffff', p, 0.26),
    '--bg': mix('#f0f3f1', p, 0.05), '--bg-2': mix('#e5eae7', p, 0.06), '--surface-2': mix('#f6f8f7', p, 0.03), '--surface-3': mix('#ebefed', p, 0.06),
    '--line': mix('#dfe5e2', p, 0.07), '--line-2': mix('#ccd5d0', p, 0.08), '--ok-text': mix(p, '#000000', 0.12),
  };
  // Dark mode: a lighter tint of the colour on near-black surfaces, with dark text on buttons.
  const surface = mix('#141917', brand, 0.08);
  let d = mix(brand, '#ffffff', 0.28);
  for (let i = 0; i < 20 && contrast(d, surface) < 5; i++) d = mix(d, '#ffffff', 0.1);
  let ink = mix(d, '#000000', 0.84); if (contrast(ink, d) < 4.6) ink = '#000000';
  const dark = {
    '--primary': d, '--primary-2': mix(d, '#ffffff', 0.3), '--primary-soft': mix(surface, brand, 0.28), '--primary-ink': ink, '--mint': mix(surface, brand, 0.4),
    '--bg': mix('#0b0e0d', brand, 0.06), '--bg-2': mix('#0e1211', brand, 0.07), '--surface': surface, '--surface-2': mix('#19201d', brand, 0.08), '--surface-3': mix('#1f2724', brand, 0.1),
    '--line': mix('#232c29', brand, 0.1), '--line-2': mix('#2d3834', brand, 0.12), '--ok-text': mix(d, '#ffffff', 0.15),
  };
  return { light, dark };
}
export function brandCss(brand) {
  if (!validHex(brand) || brand.toLowerCase() === DEFAULT_BRAND) return '';
  const { light, dark } = palette(brand);
  const block = o => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');
  // html:root is more specific than the stylesheet's :root, so the brand wins wherever the tag sits.
  return `html:root{${block(light)};background:${light['--bg']}}html:root[data-theme="dark"]{${block(dark)};background:${dark['--bg']}}`;
}
/** Applies (and remembers) the brand colour on this device. Empty / default = original palette. */
export function applyBrand(brand) {
  const css = brandCss(brand);
  let el = document.getElementById('brand-style');
  if (!css) { el?.remove(); try { localStorage.removeItem(KEY); } catch { /* blocked */ } return; }
  if (!el) { el = document.createElement('style'); el.id = 'brand-style'; document.head.append(el); }
  if (el.textContent !== css) el.textContent = css;
  try { localStorage.setItem(KEY, css); } catch { /* blocked */ }
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = palette(brand).light['--bg'];
}
