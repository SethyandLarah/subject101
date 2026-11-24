# DLKM BizPulse — Store System v2.9.11

Private store system: POS, inventory, utang, attendance, expenses, staff accounts.
Node.js 22.5+ only (no other installs needed).

## Setup on the store computer (Windows: double-click, in order)

1. **1 Go Live.cmd** — zero data, only the Admin account; choose the new Admin password.
2. **2 Start Online.cmd** — runs the system (keep this window open).
3. **3 Install Tailscale.cmd** — installs Tailscale and signs in (first time only).
4. **4 Share Online.cmd** — shows the `https://….ts.net` address for the phone app (first time only).

**Start Demo.cmd** opens the sample-data demo (password `Alaan2026!`) — never put the demo on the internet.

## Commands (Windows: `npm.cmd`, Mac/Linux: `npm`)

| Command | What it does |
| --- | --- |
| `npm.cmd run demo` | Try the system with sample data (password `Alaan2026!`). Never put this on the internet. |
| `npm.cmd run go-live` | Make the real store: zero data, only the Admin account, new private password. |
| `npm.cmd start` | Run the real store (`data/store.sqlite`). |
| `npm.cmd run online` | Run the real store for the phone app (behind Tailscale Funnel / HTTPS tunnel). |
| `npm.cmd run backup` | Make a backup now (automatic backups are made every day in `data/backups`). |

## Cloud (Railway)

- Deploy the repo; `railway.json` starts `node server.mjs` and checks `/api/branding`.
- Add a **Volume** mounted at `/data` and these variables:
  `ALAAN_DB=/data/store.sqlite`, `ALAAN_TRUST_PROXY=1`, `ALAAN_ADMIN_PASSWORD=<first key, 8+ characters>`.
- First start creates a clean store (Admin only, zero data). Sign in as `admin` with the first key;
  the app then asks the owner to choose a private password. Daily backups go to `/data/backups`.
- Keep **one** replica (SQLite is one file on one disk).

