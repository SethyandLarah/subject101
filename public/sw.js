// Service worker: caches the app shell so the app opens on the shop Wi-Fi even
// when the server is briefly unreachable. API calls always go to the network.
const CACHE = 'alaan-shell-v33';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/api.js', '/js/ui.js', '/js/icons.js', '/js/theme-init.js', '/js/sound.js', '/js/brand.js', '/js/i18n.js', '/js/i18n-fil.js', '/sounds/click.wav', '/js/pages/index.js', '/js/pages/dashboard.js', '/js/pages/materials.js', '/js/pages/pos.js', '/js/pages/sales.js', '/js/pages/utang.js', '/js/pages/attendance.js', '/js/pages/expenses.js', '/js/pages/reports.js', '/js/pages/staff.js', '/js/pages/profile.js', '/js/pages/settings.js', '/js/pages/sync.js', '/js/pages/orders.js', '/js/pages/cash.js', '/js/pages/summary.js', '/manifest.webmanifest', '/media/app-icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Store branding (logo / background) is public and kept for offline use; staff photos, item photos and IDs are not.
  const branding = url.pathname === '/media/logo' || url.pathname === '/media/background';
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || (url.pathname.startsWith('/media/') && !branding)) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});


