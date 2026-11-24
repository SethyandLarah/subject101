// JS ALAAN HARDWARE — store server.
// Run:  node server.mjs --demo        (sample data, demo accounts)
//       node server.mjs               (clean store; set ALAAN_ADMIN_PASSWORD first)
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync, existsSync, statSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { freshStart } from './src/fresh.mjs';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { openDatabase, transaction, seedDemo, seedDemoHistory, seedDemoAttendance, checkPassword, hashPassword, nowISO } from './src/db.mjs';
import { HttpError, need, fail, publicUser, username, text, attendanceOnly, DEFAULT_APP_NAME } from './src/common.mjs';
// Attendance-only employees may only reach these endpoints, whatever URL or API call they try.
const ATTENDANCE_GETS = new Set(['bootstrap', 'attendance', 'notifications', 'staff', 'me', 'earnings', 'offline']);
// Entries that may be recorded without connection and are uploaded for Admin approval.
// Entries a phone may save while the store server cannot be reached (brownout / no internet).
// Stock Out and physical counts were saved offline by the app but refused here at sync — now accepted.
const canStockRole = u => u.role === 'admin' || u.role.includes('stock');
const OFFLINE_ACTIONS = { 'attendance.clock': () => true, 'sale.checkout': u => u.role === 'admin', 'stock.in': canStockRole, 'stock.out': canStockRole, 'count.submit': canStockRole };
const ATTENDANCE_ACTIONS = new Set(['attendance.clock', 'excuse.request', 'profile.update', 'profile.lang', 'notifications.read']);
import { createActions, AUTO_CLOSE } from './src/actions.mjs';
import { createQueries } from './src/queries.mjs';
import { createMaintenance } from './src/maintenance.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const demo = process.argv.includes('--demo');
// --online (npm run online): for the phone app behind the HTTPS tunnel — only the tunnel reaches it.
const online = process.argv.includes('--online');
const host = process.env.ALAAN_HOST || (online ? '127.0.0.1' : '0.0.0.0');
// Cloud hosts (Railway, Render…) give the port in PORT.
const port = Number(process.env.ALAAN_PORT || process.env.PORT || 8787);
// Behind an HTTPS tunnel / reverse proxy (Cloudflare Tunnel, Caddy, Nginx, Render…): set
// ALAAN_TRUST_PROXY=1 so the real phone address is used for sign-in limits and cookies are Secure.
const trustProxy = ['1', 'cloudflare'].includes(process.env.ALAAN_TRUST_PROXY) || online;
const tls = process.env.ALAAN_CERT && process.env.ALAAN_KEY ? { cert: readFileSync(process.env.ALAAN_CERT), key: readFileSync(process.env.ALAAN_KEY) } : null;

function createCloudStore(dbPath, adminPassword) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const seed = dbPath + '.seed-tmp';
  const drop = f => { for (const x of [f, f + '-wal', f + '-shm']) if (existsSync(x)) unlinkSync(x); };
  drop(seed);
  const s = openDatabase(seed); seedDemo(s, 'Alaan2026!'); s.close();
  try { freshStart(seed, dbPath, { adminOnly: true, adminPassword }); } finally { drop(seed); }
  // The start-up password is visible to whoever set up the host: the owner must replace it at
  // the first sign-in, so only the owner knows the real Admin password.
  const db = openDatabase(dbPath); db.exec("UPDATE users SET temporary=1 WHERE role='admin'"); db.close();
  console.log('New cloud store created: sign in as "admin" with ALAAN_ADMIN_PASSWORD, then choose a private password.');
}
export function createApp({ dbPath = process.env.ALAAN_DB || join(root, 'data', demo ? 'demo.sqlite' : 'store.sqlite'), demoData = demo, adminPassword = process.env.ALAAN_ADMIN_PASSWORD } = {}) {
  // No store yet and no first password: stop before creating an empty database file (an empty
  // file would otherwise be picked up later by go-live as if it were the store).
  if (!demoData && !(adminPassword && adminPassword.length >= 8) && !existsSync(dbPath)) fail(500, 'No store database yet. Run this first:  npm.cmd run go-live');
  // First start in the cloud (no database yet, ALAAN_ADMIN_PASSWORD set): make the same clean
  // store as go-live — store settings and categories, only the Admin account, zero business data.
  if (!demoData && adminPassword && !existsSync(dbPath)) createCloudStore(dbPath, adminPassword);
  const db = openDatabase(dbPath);
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    const pw = adminPassword || (demoData ? 'Alaan2026!' : '');
    need(pw.length >= 8, 'Set ALAAN_ADMIN_PASSWORD (8+ characters) before starting a new store database.', 500);
    if (demoData) { seedDemo(db, pw); seedDemoHistory(db); seedDemoAttendance(db); }
    // A brand-new store: the start-up password is only a first key (it may be the one written in
    // Start Store.cmd), so the owner must choose a private password at the first sign-in.
    else transaction(db, () => db.prepare('INSERT INTO users(username,name,password,role,temporary,created) VALUES (?,?,?,?,1,?)').run(process.env.ALAAN_ADMIN_USER || 'admin', 'Store Admin', hashPassword(pw), 'admin', nowISO()));
  }
  // The first Admin is the Main Admin (store owner) on fresh and upgraded databases.
  if (!db.prepare('SELECT 1 FROM users WHERE is_main=1').get()) db.exec("UPDATE users SET is_main=1 WHERE id=(SELECT min(id) FROM users WHERE role='admin')");
  const sql = s => db.prepare(s);
  const actions = createActions(db);
  // Auto Time Out runs on a timer and before every API request, and catches up on start-up
  // (recovery after downtime) using each session's saved cutoff and grace deadline.
  const autoClose = actions[AUTO_CLOSE];
  const runAutoClose = () => { try { transaction(db, () => autoClose.run()); } catch (e) { console.error('auto time out', e); } };
  runAutoClose();
  const autoTimer = setInterval(runAutoClose, 30_000); autoTimer.unref?.();
  // Daily backup + clean-up of short-lived records + optimize, at start-up and every hour.
  const maintenance = createMaintenance(db, dbPath);
  maintenance.run();
  const careTimer = setInterval(() => maintenance.run(), 3_600_000); careTimer.unref?.();
  const queries = createQueries(db);
  const digest = v => createHash('sha256').update(v).digest('hex');
  const attempts = new Map(), userFails = new Map(), hits = new Map();
  // Old entries are dropped every 5 minutes, so these maps can never grow without limit.
  const pruneTimer = setInterval(() => { const now = Date.now(); for (const m of [attempts, userFails]) for (const [k, v] of m) if (v.until < now) m.delete(k); hits.clear(); }, 5 * 60_000); pruneTimer.unref?.();
  // Behind a proxy the real address is the LAST X-Forwarded-For entry (added by the proxy itself);
  // earlier entries and CF-Connecting-IP could be sent by anyone, so they are trusted only when
  // ALAAN_TRUST_PROXY=cloudflare says the store really sits behind Cloudflare.
  const clientIp = req => (trustProxy && (process.env.ALAAN_TRUST_PROXY === 'cloudflare' && req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim())) || req.socket.remoteAddress || '?';
  const isHttps = req => !!tls || (trustProxy && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()));
  const dummyHash = hashPassword(randomBytes(12).toString('hex'));

  // ---- Static files -----------------------------------------------------
  const publicDir = join(root, 'public');
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon' };
  const staticCache = new Map();
  const appName = () => db.prepare("SELECT value FROM settings WHERE key='app_name'").get()?.value || DEFAULT_APP_NAME;
  const appIcon = size => db.prepare('SELECT value FROM settings WHERE key=?').get('app_icon_' + size)?.value || null;
  const escHtml = v => String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  // Every app file is served under a version tag (app.js?v=…) taken from the files' contents.
  // After an update the addresses change, so a browser can never mix old cached files with
  // new ones — whatever version it ran before. (This mix sent POS/Sales back to Overview.)
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(join(dir, d.name)) : /\.(js|css|html)$/.test(d.name) ? [join(dir, d.name)] : []);
  const ASSET_V = (() => { const h = createHash('sha1'); for (const f of walk(publicDir).sort()) h.update(f.slice(publicDir.length)).update(readFileSync(f)); return h.digest('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10); })();
  const tag = p => `${p}?v=${ASSET_V}`;
  const versioned = (rel, body) => {
    const name = rel.replace(/\\/g, '/');
    if (name.endsWith('.html')) return Buffer.from(String(body).replace(/(src|href)="(\/(?:js|css)\/[^"?]+\.(?:js|css))"/g, (m, a, p) => `${a}="${tag(p)}"`));
    if (name === '/sw.js') return Buffer.from(String(body).replace(/'(\/(?:js|css)\/[^'?]+\.(?:js|css))'/g, (m, p) => `'${tag(p)}'`).replace(/const CACHE = '([^']+)'/, (m, c) => `const CACHE = '${c}-${ASSET_V}'`));
    if (name.startsWith('/js/') && name.endsWith('.js')) return Buffer.from(String(body).replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g, (m, a, q, p) => `${a}${q}${tag(p)}${q}`));
    return body;
  };
  function serveStatic(res, pathname, req) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(publicDir, rel);
    if (!file.startsWith(publicDir) || !existsSync(file)) return false;
    const st = statSync(file); if (!st.isFile()) return false;
    // Files are kept in memory and revalidated with an ETag, so phones get a fast 304.
    let c = staticCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) { const body = versioned(rel, readFileSync(file)); c = { mtime: st.mtimeMs, body, etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"' }; staticCache.set(file, c); }
    // The page carries the app name the Admin chose (browser tab, iPhone home-screen name).
    if (rel.replace(/\\/g, '/') === '/index.html') {
      const name = escHtml(appName());
      const body = Buffer.from(String(c.body).replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`).replace(/(name="apple-mobile-web-app-title" content=")[^"]*/, `$1${name}`).replace(/(name="application-name" content=")[^"]*/, `$1${name}`));
      c = { ...c, body, etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"' };
    }
    const headers = { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': /\.(html|js|css|webmanifest)$/.test(rel) ? 'no-cache' : 'public, max-age=3600', ETag: c.etag };
    if (req?.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, headers);
    res.end(c.body);
    return true;
  }

  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const setCookie = (res, token, maxAge, secure) => res.setHeader('Set-Cookie', `alaan=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  const tokenOf = req => /(?:^|; *)alaan=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1] || '';
  const sessionUser = req => { const t = tokenOf(req); return t ? sql('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>? AND u.active=1').get(digest(t), Date.now()) : null; };
  async function readBody(req) {
    need(/^application\/json/i.test(req.headers['content-type'] || ''), 'Send JSON.', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; need(size <= 2 * 1024 * 1024, 'Request too large.', 413); chunks.push(chunk); }
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed; try { parsed = JSON.parse(raw); } catch { fail(400, 'Invalid JSON.'); }
    need(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Invalid request.');
    return { raw, parsed };
  }
  const sendImage = (res, dataUrl, fallbackFile) => {
    if (dataUrl) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-cache' }); res.end(Buffer.from(dataUrl.slice(23), 'base64')); return; }
    if (fallbackFile && existsSync(fallbackFile)) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' }); res.end(readFileSync(fallbackFile)); return; }
    fail(404, 'No image.');
  };

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=(), camera=(self)');
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      // Android app (PWABuilder / TWA): put the assetlinks.json from the PWABuilder download in the
      // main folder; it proves the app belongs to this site, so the app opens without an address bar.
      if (req.method === 'GET' && path === '/.well-known/assetlinks.json') {
        const f = join(root, 'assetlinks.json');
        if (!existsSync(f)) fail(404, 'Not found.');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(readFileSync(f));
      }
      // The install manifest carries the app name the Admin chose (name under the phone icon).
      if (req.method === 'GET' && path === '/manifest.webmanifest') {
        const m = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8')), name = appName();
        m.name = name; m.short_name = name.length <= 15 ? name : name.split(/\s+/)[0].slice(0, 15);
        // Icon and splash screen show the store's own logo; ?v= changes when the logo changes.
        const iv = createHash('sha1').update(appIcon(512) || 'default').digest('hex').slice(0, 10);
        m.icons = [
          { src: `/media/app-icon-192.png?v=${iv}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `/media/app-icon-512.png?v=${iv}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `/media/app-icon-512.png?v=${iv}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ];
        m.background_color = '#ffffff';
        const body = JSON.stringify(m), etag = '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"';
        const headers = { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache', ETag: etag };
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
        res.writeHead(200, headers); return res.end(body);
      }
      if (req.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/media/')) {
        if (serveStatic(res, path, req)) return;
        if (!extname(path)) { serveStatic(res, '/', req); return; }
        fail(404, 'Not found.');
      }
      // Public branding images (login screen).
      if (req.method === 'GET' && (path === '/media/app-icon-512.png' || path === '/media/app-icon-192.png')) {
        const size = path.includes('512') ? 512 : 192, v = appIcon(size);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        return res.end(v ? Buffer.from(v.slice(22), 'base64') : readFileSync(join(publicDir, `icon-${size}.png`)));
      }
      if (req.method === 'GET' && path === '/media/logo') return sendImage(res, sql("SELECT value FROM settings WHERE key='logo'").get()?.value, join(publicDir, 'img', 'store-logo.jpg'));
      if (req.method === 'GET' && path === '/media/background') return sendImage(res, sql("SELECT value FROM settings WHERE key='background'").get()?.value, join(publicDir, 'img', 'storefront.jpg'));
      if (req.method === 'GET' && path === '/api/branding') return json(res, 200, { appName: appName(), storeName: sql("SELECT value FROM settings WHERE key='store_name'").get()?.value || 'JS ALAAN HARDWARE', brandColor: sql("SELECT value FROM settings WHERE key='brand_color'").get()?.value || null, demo: demoData });

      // Flood guard: one address may make at most 3,000 API calls in 5 minutes. A whole store on one
      // Wi-Fi shares an address, so this is far above normal use but stops scripts hammering the server.
      // The computer itself (or a tunnel without ALAAN_TRUST_PROXY) is never counted.
      if (path.startsWith('/api/') && !/^(127\.|::1$|::ffff:127\.)/.test(clientIp(req))) {
        const ip = clientIp(req), n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
        need(n <= 3000, 'Too many requests. Wait a few minutes and try again.', 429);
      }
      // CSRF: writes must come from this app (custom header + same origin).
      if (req.method === 'POST') {
        need(req.headers['x-alaan'] === '1', 'Request must come from the app.', 403);
        if (req.headers.origin) {
          let o = null; try { o = new URL(req.headers.origin); } catch { /* bad origin */ }
          const host = trustProxy && req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',')[0].trim() : req.headers.host;
          need(o && o.host === host && (o.protocol === 'https:' || (o.protocol === 'http:' && !tls)), 'Cross-origin request blocked.', 403);
        }
      }
      if (req.method === 'POST' && path === '/api/login') {
        const { parsed: b } = await readBody(req);
        // Two locks: 30 wrong tries from one address (staff may share the shop Wi-Fi), or 8 wrong tries on one username (from anywhere),
        // stop sign-in for 15 minutes — a password cannot be guessed by trying many times.
        const key = clientIp(req), rec = attempts.get(key);
        need(!rec || rec.until < Date.now() || rec.count < 30, 'Too many attempts. Try again in 15 minutes.', 429);
        const uname = username(b.username), urec = userFails.get(uname);
        need(!urec || urec.until < Date.now() || urec.count < 8, 'Too many attempts. Try again in 15 minutes.', 429);
        const user = sql('SELECT * FROM users WHERE username=?').get(uname);
        const ok = checkPassword(String(b.password ?? '').slice(0, 128), user?.password || dummyHash);
        if (!user || !ok || !user.active) {
          attempts.set(key, { count: (rec && rec.until > Date.now() ? rec.count : 0) + 1, until: Date.now() + 15 * 60_000 });
          userFails.set(uname, { count: (urec && urec.until > Date.now() ? urec.count : 0) + 1, until: Date.now() + 15 * 60_000 });
          if ((userFails.get(uname).count) === 8) try { sql('INSERT INTO audit(actor,action,detail,created) VALUES (?,?,?,?)').run(user?.id ?? null, 'login.locked', `${uname} · ${key}`, nowISO()); } catch { /* audit is best-effort */ }
          fail(401, 'Username or password is incorrect.');
        }
        attempts.delete(key); userFails.delete(uname);
        const token = randomBytes(32).toString('hex');
        sql('DELETE FROM sessions WHERE expires<=?').run(Date.now());
        sql('INSERT INTO sessions(token,user_id,expires,created) VALUES (?,?,?,?)').run(digest(token), user.id, Date.now() + 12 * 3_600_000, nowISO());
        setCookie(res, token, 12 * 3600, isHttps(req));
        return json(res, 200, { user: publicUser(user) });
      }
      const user = sessionUser(req);
      if (path.startsWith('/api/')) runAutoClose();
      if (req.method === 'GET' && path === '/api/me') return json(res, 200, { user: user ? publicUser(user) : null });
      need(user, 'Please sign in to continue.', 401);
      if (req.method === 'POST' && path === '/api/logout') { sql('DELETE FROM sessions WHERE token=?').run(digest(tokenOf(req))); setCookie(res, '', 0, isHttps(req)); return json(res, 200, {}); }
      if (req.method === 'POST' && path === '/api/password') {
        const { parsed: b } = await readBody(req);
        transaction(db, () => actions['password.change'](user, { ...b, _sessionDigest: digest(tokenOf(req)) }));
        return json(res, 200, {});
      }
      need(!user.temporary, 'Change your temporary password first.', 403);

      // Private valid ID: Admin only, never cached, never shown inline to other origins.
      if (req.method === 'GET' && /^\/api\/staff-id\/\d+$/.test(path)) {
        need(user.role === 'admin', 'Only Admin can view valid IDs.', 403);
        const row = sql('SELECT * FROM staff_ids WHERE user_id=?').get(Number(path.split('/').pop()));
        need(row, 'No valid ID on file.', 404);
        sql('INSERT INTO audit(actor,action,detail,created) VALUES (?,?,?,?)').run(user.id, 'staffid.view', `user #${row.user_id}`, nowISO());
        res.writeHead(200, { 'Content-Type': row.mime, 'Cache-Control': 'no-store, private', 'Content-Disposition': `inline; filename="${row.name.replace(/"/g, '')}"`, 'Cross-Origin-Resource-Policy': 'same-origin' });
        return res.end(Buffer.from(row.data));
      }
      if (req.method === 'GET' && /^\/media\/(item|staff)\/\d+$/.test(path)) {
        const [, , type, pid] = path.split('/');
        if (type === 'staff') { need(user.role === 'admin' || Number(pid) === user.id, 'This photo is private.', 403); return sendImage(res, sql('SELECT photo FROM users WHERE id=?').get(Number(pid))?.photo); }
        need(!attendanceOnly(user), 'Your account can only use My Attendance.', 403);
        return sendImage(res, sql('SELECT photo FROM materials WHERE id=?').get(Number(pid))?.photo);
      }
      // Backups (Admin): list the daily copies and make one now.
      if (path === '/api/backups') {
        need(user.role === 'admin', 'Only Admin manages backups.', 403);
        if (req.method === 'POST') { const made = maintenance.backup(true); sql('INSERT INTO audit(actor,action,detail,created) VALUES (?,?,?,?)').run(user.id, 'backup.now', made ? made.split(/[\\/]/).pop() : 'memory', nowISO()); }
        return json(res, 200, { items: maintenance.list(), keep: 30, folder: maintenance.dir ? 'data/backups' : null });
      }
      if (req.method === 'GET' && path.startsWith('/api/')) {
        const name = path.slice(5);
        need(Object.hasOwn(queries, name), 'Not found.', 404);
        need(!attendanceOnly(user) || ATTENDANCE_GETS.has(name), 'Your account can only use My Attendance.', 403);
        return json(res, 200, queries[name](user, url.searchParams));
      }
      // Offline upload: stored in the Admin approval inbox (retries with the same key return the same entry).
      if (req.method === 'POST' && path === '/api/offline') {
        const { parsed: b } = await readBody(req);
        need(typeof b.action === 'string' && Object.hasOwn(OFFLINE_ACTIONS, b.action) && OFFLINE_ACTIONS[b.action](user), 'This entry cannot be recorded offline for your account.', 403);
        const key = text(b.key, 'Request key', 64);
        const occurred = new Date(String(b.occurred ?? ''));
        need(Number.isFinite(+occurred) && +occurred <= Date.now() + 2 * 60_000, 'The entry timestamp needs review.');
        const result = transaction(db, () => {
          const prior = sql('SELECT * FROM offline_inbox WHERE key=?').get(key);
          if (prior) { need(prior.user_id === user.id, 'This request key belongs to another account.', 409); return { id: prior.id, status: prior.status, duplicate: true }; }
          const { action, key: _k, occurred: _o, _offline, ...fields } = b;
          const r = sql('INSERT INTO offline_inbox(key,user_id,action,body,occurred,uploaded) VALUES (?,?,?,?,?,?)').run(key, user.id, action, JSON.stringify(fields), occurred.toISOString(), nowISO());
          const n = sql("SELECT count(*) AS n FROM offline_inbox WHERE status='pending'").get().n;
          sql('INSERT INTO notifications(actor,recipient,kind,title,detail,link,created) VALUES (?,NULL,?,?,?,?,?)').run(user.id, 'sync', 'Offline entries to approve', `${user.name} uploaded an offline entry · ${n} pending`, '#/sync', nowISO());
          return { id: Number(r.lastInsertRowid), status: 'pending' };
        });
        return json(res, 200, result);
      }
      // All writes: POST /api/action {action, key, ...fields}. The key makes
      // retries safe — the same key returns the stored first result.
      if (req.method === 'POST' && path === '/api/action') {
        const { raw, parsed: b } = await readBody(req);
        delete b._offline; // only set internally when an approved offline entry runs
        delete b._order;
        need(typeof b.action === 'string' && Object.hasOwn(actions, b.action), 'Unknown action.', 404);
        need(!attendanceOnly(user) || ATTENDANCE_ACTIONS.has(b.action), 'Your account can only use My Attendance.', 403);
        const key = text(b.key, 'Request key', 64);
        const result = transaction(db, () => {
          const prior = sql('SELECT digest, result FROM requests WHERE actor=? AND key=?').get(user.id, key);
          if (prior) { need(prior.digest === digest(raw), 'This request key was already used for a different request.', 409); return JSON.parse(prior.result); }
          const out = actions[b.action](user, b) || {};
          sql('INSERT INTO requests(actor,key,digest,result,created) VALUES (?,?,?,?,?)').run(user.id, key, digest(raw), JSON.stringify(out), nowISO());
          return out;
        });
        return json(res, 200, result);
      }
      fail(404, 'Not found.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'The server could not complete this request.' : error.message, ...(error.payload || {}) });
      else res.end();
    }
  }
  return { db, handle, actions, queries, maintenance, close: () => { clearInterval(autoTimer); clearInterval(careTimer); clearInterval(pruneTimer); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let app;
  try { app = createApp(); } catch (e) { console.error('\n' + e.message + '\n'); process.exit(1); }
  const server = tls ? createSecureServer(tls, app.handle) : createServer(app.handle);
  server.requestTimeout = 20_000;      // slow / stuck uploads are cut off
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 10_000;
  server.maxHeadersCount = 60;
  server.listen(port, host, () => {
    const scheme = tls ? 'https' : 'http';
    const actualPort = server.address()?.port || port;
    console.log(`JS ALAAN HARDWARE ready → ${scheme}://localhost:${actualPort}`);
    if (host === '0.0.0.0' || host === '::') {
      const all = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries || [])
        .filter(x => (x.family === 'IPv4' || x.family === 4) && !x.internal && !x.address.startsWith('169.254.'))
        .map(x => ({ name, address: x.address })));
      const wifi = all.filter(x => /wi-?fi|wireless|wlan/i.test(x.name));
      const candidates = wifi.length ? wifi : all.filter(x => !/virtual|vmware|virtualbox|loopback|bluetooth|vethernet/i.test(x.name));
      const addresses = [...new Set(candidates.map(x => x.address))];
      if (addresses.length) for (const address of addresses) console.log(`Mobile (same Wi-Fi): ${scheme}://${address}:${actualPort}`);
      else console.log('Mobile link unavailable: connect this computer to Wi-Fi, then restart the server.');
    } else console.log('Mobile access needs ALAAN_HOST=0.0.0.0 before starting the server.');
    if (demo) console.log('DEMO DATA · admin / sales / stock / both · password Alaan2026!\n⚠  Never put --demo on the internet: everyone knows the demo password. Use  npm start  for the real store.');
    if (trustProxy) console.log('Behind an HTTPS tunnel / proxy (ALAAN_TRUST_PROXY=1): Secure cookies and real client addresses are on.');
  });
}
