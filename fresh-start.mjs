// Go live with zero data.
//   npm.cmd run go-live        (Windows) · npm run go-live       → ONLY the Admin account stays, with a
//                                                                   new private password you type in
//   npm.cmd run fresh-start    (Windows) · npm run fresh-start   → zero data, every account stays
//   node fresh-start.mjs [--admin-only] [--from data/demo.sqlite] [--to data/store.sqlite] [--no-categories] [--yes]
// Source: data/store.sqlite if it exists, otherwise data/demo.sqlite. Result: data/store.sqlite,
// used by `npm start` (the real store). Stop the server first. The old store database is kept in
// data/backups/before-fresh-start-….sqlite, and the source file is never changed.
// Kept in both modes: store name, logo, background, brand colour, attendance settings and categories.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline/promises';
import { freshStart, KEEP, KNOWN_PASSWORDS } from './src/fresh.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const to = arg('--to') || 'data/store.sqlite';
// The store is the source only when it really holds an Admin (an empty file left by a failed start
// is ignored); otherwise the starting (demo) database is used and built if missing.
const hasAdmin = file => { try { const d = new DatabaseSync(file, { readOnly: true }); const ok = !!d.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1").get(); d.close(); return ok; } catch { return false; } };
const from = arg('--from') || (existsSync('data/store.sqlite') && hasAdmin('data/store.sqlite') ? 'data/store.sqlite' : 'data/demo.sqlite');
const keepCategories = !process.argv.includes('--no-categories');
const adminOnly = process.argv.includes('--admin-only');

/** Reads a line without showing what is typed (passwords). */
async function hidden(question) {
  if (!process.stdin.isTTY) { const rl = createInterface({ input: process.stdin }); const it = rl[Symbol.asyncIterator](); process.stdout.write(question); const { value } = await it.next(); rl.close(); process.stdout.write('\n'); return String(value ?? ''); }
  process.stdout.write(question);
  return new Promise(resolve => {
    let value = '';
    const { stdin } = process; stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(value); }
        if (c === '\u0003') { process.stdout.write('\nCancelled. Nothing was changed.\n'); process.exit(0); }
        if (c === '\u007f' || c === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        value += c; process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

console.log(`\nJS ALAAN HARDWARE · ${adminOnly ? 'Go live (Admin only)' : 'Fresh start'}\n  from: ${from}\n  to:   ${to}`);
console.log(`  keeps: ${adminOnly ? 'the Admin account only, ' : 'all accounts, '}store settings${keepCategories ? ', categories' : ''}`);
console.log('  empties: materials, sales, utang & payments, customers, suppliers, stock movements, attendance,');
console.log('           earnings & salary payments, excuses, expenses, orders, cash counts, notifications, logs');
if (adminOnly) console.log('  removes: every staff account (Sales Clerk, Cashier, Stock Clerk, helpers…) — the Admin adds real staff later\n');
else console.log('');

let adminPassword = null;
if (adminOnly) {
  adminPassword = process.env.ALAAN_NEW_ADMIN_PASSWORD || null;
  if (!adminPassword) {
    console.log('Choose the NEW Admin password (8+ characters, not the demo password). Only the store owner should know it.');
    for (let tries = 0; ; tries++) {
      const a = await hidden('  New Admin password:    ');
      const b = await hidden('  Type it again:         ');
      const problem = a !== b ? 'The two passwords are different.' : a.length < 8 ? 'Use at least 8 characters.' : KNOWN_PASSWORDS.includes(a.toLowerCase()) ? 'That password is known (demo / common). Choose a private one.' : null;
      if (!problem) { adminPassword = a; break; }
      console.log('  ' + problem);
      if (tries >= 4) { console.log('Cancelled. Nothing was changed.'); process.exit(1); }
    }
  }
}
if (!process.argv.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nType RESET to continue (make sure the server is stopped): '); rl.close();
  if (answer.trim() !== 'RESET') { console.log('Cancelled. Nothing was changed.'); process.exit(0); }
}
// A brand-new copy (just unzipped) has no database yet: build the starting database first, so
// the categories, store settings and the Admin account exist to carry over.
if (!existsSync(from) && !arg('--from')) {
  const { createApp } = await import('./server.mjs');
  const app = createApp({ dbPath: from, demoData: true });
  app.close(); app.db.close();
}
try {
  const r = freshStart(from, to, { keepCategories, adminOnly, adminPassword });
  console.log('\nDone. Accounts kept:');
  for (const a of r.accounts) console.log(`  · ${a.username.padEnd(12)} ${a.name.padEnd(22)} ${a.role}${a.main ? ' (Main Admin)' : ''}${a.active ? '' : ' · inactive'}`);
  const left = Object.entries(r.after).filter(([t, n]) => n && !KEEP.includes(t));
  console.log(`\nBusiness data left: ${left.length ? left.map(([t, n]) => t + '=' + n).join(', ') : 'none (all zero)'}`);
  if (r.previous) console.log('Previous store database saved to: ' + r.previous);
  if (adminOnly) console.log(`\nSign in as "${r.accounts[0]?.username}" with your new password, then add your real staff in Staff Accounts.`);
  console.log('\nStart the real store with:  npm.cmd start   (Windows)  ·  npm start\n');
} catch (e) { console.error('\nFresh start failed: ' + e.message + '\nThe source database was not changed; any replaced store database is in data/backups.'); process.exit(1); }
