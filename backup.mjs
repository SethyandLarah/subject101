// Safe backup:  node backup.mjs [source.sqlite] [destination.sqlite]
// Uses SQLite's online backup so a running server is never interrupted.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const [source = 'data/store.sqlite', dest = `backups/store-${new Date().toISOString().slice(0, 10)}.sqlite`] = process.argv.slice(2);
if (!existsSync(source)) { console.error('Source database not found:', source); process.exit(1); }
if (existsSync(dest)) { console.error('Refusing to overwrite existing backup:', dest); process.exit(1); }
mkdirSync(dirname(dest), { recursive: true });
const db = new DatabaseSync(source);
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
const check = new DatabaseSync(dest);
const counts = Object.fromEntries(['users', 'materials', 'sales', 'payments', 'attendance', 'expenses'].map(t => [t, check.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
console.log('Backup written to', dest, counts);
