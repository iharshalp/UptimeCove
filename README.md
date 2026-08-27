<div align="center">

# UptimeCove

<p>
  <a href="https://github.com/iharshalp/UptimeCove"><img src="https://img.shields.io/github/stars/iharshalp/UptimeCove?style=social" alt="GitHub stars" /></a>
  <a href="https://github.com/iharshalp/UptimeCove/blob/main/LICENSE"><img src="https://img.shields.io/github/license/iharshalp/UptimeCove" alt="License" /></a>
  <a href="https://github.com/iharshalp/UptimeCove/actions"><img src="https://img.shields.io/github/actions/workflow/status/iharshalp/UptimeCove/ci.yml?branch=main" alt="CI" /></a>
  <a href="https://github.com/iharshalp"><img src="https://img.shields.io/badge/author-iharshalp-black" alt="Author" /></a>
  <img src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020" alt="Cloudflare" />
  <img src="https://img.shields.io/badge/Astro-7.x-FF5D01" alt="Astro" />
</p>

**Edge-native uptime monitoring and status pages — run on _your own_ Cloudflare account.**

Self-hosted • Free tier • D1 + Workers • Astro • Tailwind • MIT • No vendor lock-in

[⭐ Star on GitHub](https://github.com/iharshalp/UptimeCove) • [👤 @iharshalp](https://github.com/iharshalp) • [🚀 Demo](https://uptimecove.com/demo) • [📖 Docs](#-quick-start-30-seconds) • [🐛 Issues](https://github.com/iharshalp/UptimeCove/issues)

</div>

---

<div align="center">

### ✦ Beautiful • Fast • Private ✦

*Your data stays in your D1. Your checks run at the edge. Your status page is yours.*

</div>

### 🔥 Why UptimeCove?

> **UptimeRobot charges $29/mo for what your free Cloudflare plan already includes.**

|  | UptimeCove (Self-Hosted) | UptimeRobot / Statuspage |
|---|---|---|
| **Cost** | $0 on Cloudflare free tier | $29–$29/mo |
| **Data** | Your D1, your KV | Their DB |
| **Checks** | Edge, per-minute, claimed | Central |
| **Status Page** | `/status/default` + JSON + RSS + badge | Hosted |
| **Deploy** | `wrangler deploy` | Their infra |

### ✨ Features

<table>
<tr>
<td>

**🛰️ Monitoring**
- `GET` / `HEAD` with `expected_status`
- Body must/must-not contain
- Max response time
- Custom headers, redirects validated
- Timeout + SSRF protection
- Heartbeat (`/api/heartbeat/:id/ping`)

</td>
<td>

**📊 Status & Uptime**
- 90-day bars, sparklines
- Correct weighted uptime (not daily avg)
- p50/p95/p99 latency
- Polling every 30s (no full reload)
- RSS + badge SVG + public JSON

</td>
</tr>
<tr>
<td>

**🚨 Incidents & Maintenance**
- Auto open on 2 failures
- Manual resolve + timeline updates
- Maintenance windows (global/per-monitor)
- Suppression during maintenance

</td>
<td>

**🔐 Private by Design**
- Your instance, your `ADMIN_TOKEN`
- Opaque `uc_session` + API keys (`uc_...`)
- Demo is public & read-only
- Fork → your Cloudflare → your data

</td>
</tr>
</table>

---

## 🚀 Quick Start — 30 Seconds

**One command to try locally (no Cloudflare account needed for dev):**

```bash
git clone https://github.com/iharshalp/UptimeCove.git
cd UptimeCove
npm install
cp .dev.vars.example .dev.vars   # set a long random ADMIN_TOKEN
npm run db:migrate               # auto-creates local D1 (0001..0004)
npm run dev                      # http://localhost:4321
```

**Open:**
- `http://localhost:4321` — landing + **Demo** at `/demo`
- `http://localhost:4321/login` — paste `ADMIN_TOKEN`
- `http://localhost:4321/dashboard` — your private dashboard (add monitors)
- `http://localhost:4321/status/default` — your public status page

**Scripts:**

```bash
npm run check        # astro check
npm run typecheck    # tsc --noEmit
npm run test         # vitest 20 tests
npm run build        # astro build (Cloudflare)
npm run deploy:dry   # wrangler --dry-run
```

<details>
<summary><b>🔧 Configuration</b> (click to expand)</summary>

- `PUBLIC_SITE_NAME` in `wrangler.jsonc:vars`
- `ADMIN_TOKEN` → `.dev.vars` locally, `npx wrangler secret put ADMIN_TOKEN` in production
- Bindings (`DB`, `CACHE`, `ASSETS`) are **auto-provisioned** — no manual `database_id` needed for fresh clones. If you rename them, run `npx wrangler types`.

</details>

<details>
<summary><b>🗃️ Database</b></summary>

- `migrations/0001_init.sql` — monitors, checks, incidents, status_pages
- `migrations/0002_phase0.sql` — leases + indexes (idempotent, safe to re-run)
- `migrations/0003_phase1.sql` — body assertions, channels, maintenance, sessions
- `migrations/0004_phase3.sql` — monitor_type, on-call, postmortems, templates

Local: `npm run db:migrate`  
Remote: see Deployment below.

</details>

---

## ☁️ Deploy to Cloudflare — 2 Minutes

> **Your instance is private.** Only you know `ADMIN_TOKEN`. Status page is public, dashboard is not.

```bash
# 1 — Deploy (first run creates D1/KV)
npm run build
npx wrangler deploy

# 2 — Apply migrations remotely (once). 0002 “duplicate column” is safe to ignore — 0001 already has it.
npx wrangler d1 execute uptimecove-db --remote --file=migrations/0001_init.sql
npx wrangler d1 execute uptimecove-db --remote --file=migrations/0002_phase0.sql  # may say duplicate column — ignore
npx wrangler d1 execute uptimecove-db --remote --file=migrations/0003_phase1.sql
npx wrangler d1 execute uptimecove-db --remote --file=migrations/0004_phase3.sql

# 3 — Secret
npx wrangler secret put ADMIN_TOKEN

# 4 — Verify
curl -s https://uptimecove.com/api/status/default | jq .
# open https://uptimecove.com/status/default  (public)
# open https://uptimecove.com/login            (private — your token)
```

**Crons** (`wrangler.jsonc`):
- `* * * * *` — claim up to 50 due monitors, concurrency 5, lease 45s
- `30 3 * * *` — prune checks >90d + clean expired sessions

**Custom domain:** Cloudflare Dashboard → Workers → `uptimecove` → Settings → Triggers → Custom Domains → `status.yourdomain.com` (or set per status page in dashboard).

**Demo:** After deploy, visit `/demo` — prefilled, read-only, no login, with fork instructions. Share `/status/default` publicly, keep `/dashboard` private.

---

## 🔐 Security

- Single admin token → opaque `uc_session` (`HttpOnly`, `SameSite=Lax`, `Secure` in prod, 7d, `sessions` table)
- API keys: `uc_...` `SHA-256` hashed (`src/lib/auth.ts:331`), `Authorization: Bearer` (`src/middleware.ts:23`)
- URL validation: private/reserved networks, bad ports, credentials, fragments blocked; redirects re-validated (`src/lib/validation.ts:24`)
- Incident `cause` normalized before public display
- Report privately: [SECURITY.md](./SECURITY.md) — **do not** open public issues for vulnerabilities

---

## 📡 How Checks Work

```
GET/HEAD → validate URL → fetch (manual redirects, max 5, each validated) → check status → check body → check max time
  ├─ first failure: keep previous status
  ├─ second consecutive failure: open incident + notify (if not in maintenance)
  └─ success after `down`: resolve incident + notify
Heartbeats: POST /api/heartbeat/:id/ping must arrive within grace window
```

---

## 📁 Structure

```
src/
  worker.ts                    # fetch + scheduled (checks + retention + session cleanup)
  middleware.ts                # session / API-key gate
  lib/validation.ts            # SSRF-safe URL validation
  lib/monitor.ts               # claim → fetch → batch → incident
  lib/queries.ts               # D1 + correct weighted uptime
  lib/auth.ts                  # orgs / users / API keys / audit
  lib/sessions.ts              # opaque sessions
  lib/advancedChecks.ts        # TLS/DNS/TCP/synthetic
  components/StatusDot.astro / Sparkline.astro / UptimeBar.astro
  layouts/Base.astro / DashboardLayout.astro
  pages/index.astro            # landing
  pages/demo.astro             # ★ public demo (prefilled, read-only)
  pages/login.astro            # minimal, generic
  pages/dashboard.astro        # private
  pages/status/[slug].astro    # public (polls every 30s)
  pages/api/*                  # monitors, checks, status, etc.
migrations/0001_init.sql .. 0004_phase3.sql
```

---

## 🧪 Dev Workflow

```bash
npm run check
npm run typecheck
npm run test
npm run build
npx wrangler deploy --dry-run
npx wrangler d1 execute uptimecove-db --local --command "SELECT name FROM sqlite_master WHERE type='table';"
```

---

## 🗺️ Roadmap

- **Phase 0** — leases, SSRF, retention, route fixes — ✅
- **Phase 1** — body assertions, notifications, status CRUD, incidents, maintenance, weighted uptime, polling, sessions, docs — ✅
- **Phase 2** — orgs/users, API keys, audit, subscribers/RSS/badges, queues — ✅
- **Phase 3** — TLS/DNS/TCP/heartbeat/synthetic, on-call, postmortems, analytics, Workers AI, templates, private agents — ✅ scaffolded

See [CONTRIBUTING.md](./CONTRIBUTING.md) to propose the next slice.

---

## 🤝 Contributing

We love PRs! See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

```bash
# 1. Fork https://github.com/iharshalp/UptimeCove
git checkout -b feat/my-feature
npm run check && npm run test && npm run build
# 2. Open PR — template guides you
```

---

## 🔒 Security

See [SECURITY.md](./SECURITY.md). Please **do not** open public issues for vulnerabilities.

---

## 📄 License

MIT — see [LICENSE](./LICENSE).

<div align="center">

**Star it if it helps you — it helps others find it.**

[⭐ Star on GitHub](https://github.com/iharshalp/UptimeCove) • Built with ❤️ by [iharshalp](https://github.com/iharshalp) • [Demo](https://uptimecove.com/demo)

</div>
