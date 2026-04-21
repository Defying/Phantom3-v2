# Phantom3 v2

Phantom3 v2 is the controlled rebuild of the original Phantom3 bot.

This repo is the **v2 bootstrap**: a TypeScript modular-monolith skeleton with a phone-friendly dashboard, strict safety defaults, and a bounded control API.

## Current status

This repo is still the **Milestone 1 read-only observer**.

The paper-safe strategy materials below define the gate for the next milestone. They are a plan and verification pack, **not** a claim that the strategy milestone is already done.

Implemented today:
- TypeScript runtime
- phone-accessible dashboard
- WebSocket runtime stream (`/api/ws`)
- read-only Polymarket market snapshot (Gamma + CLOB midpoint data)
- pure paper-trading risk evaluation module
- bounded control API
- file-backed bootstrap runtime state
- safe defaults (paper mode, live disarmed)

Not implemented yet:
- strategy engine runtime wiring
- append-only paper ledger
- paper execution adapter
- replay / comparison harness
- live execution

## Quick start

```bash
cp .env.example .env
# set a real PHANTOM3_V2_CONTROL_TOKEN first
npm run runtime:preflight
npm run runtime:start
npm run runtime:status
```

The local runtime helper reads `.env`, resolves data and log directories relative to the repo, rebuilds the dashboard before startup, and checks `/api/health` instead of trusting a stale pid file.

Useful follow-ups:

```bash
npm run runtime:logs
npm run runtime:restart
npm run runtime:stop
```

You can still run `npm run start` directly if you want a foreground process without the helper.

Then open the dashboard at the configured public URL.

Examples:
- local machine: `http://127.0.0.1:4317`
- phone on same LAN: `http://<your-server-host-or-lan-ip>:4317`

### Optional macOS launchd autostart

Render a repo-aware launchd plist with your current checkout path and env file:

```bash
mkdir -p ~/Library/LaunchAgents
npm run runtime:launchd:print > ~/Library/LaunchAgents/io.phantom3.v2.paper-runtime.plist
plutil -lint ~/Library/LaunchAgents/io.phantom3.v2.paper-runtime.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.phantom3.v2.paper-runtime.plist
launchctl kickstart -k gui/$(id -u)/io.phantom3.v2.paper-runtime
```

To remove it later:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.phantom3.v2.paper-runtime.plist
rm ~/Library/LaunchAgents/io.phantom3.v2.paper-runtime.plist
```

## Docker Compose example

A local Compose example lives at `docker-compose.example.yml`.

```bash
cp .env.example .env
# set a real PHANTOM3_V2_CONTROL_TOKEN
# set PHANTOM3_V2_PUBLIC_BASE_URL to your actual local/LAN URL

docker compose -f docker-compose.example.yml up -d
```

Notes:
- still paper-only, still not live-trading ready
- keeps runtime logs and data in Docker-managed named volumes
- intended for localhost, LAN, or a trusted private tunnel, not the public internet
- first boot may take a minute because it installs deps and builds the web bundle inside the container

## Paper-safe strategy docs

- milestone definition: `docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md`
- QA checklist: `docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md`
- operator runbook and warnings: `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md`

## Important safety notes

- this milestone is observer-first and paper-only
- dashboard runtime updates stream over WebSocket at `/api/ws`
- market discovery is read-only and refreshes from Polymarket Gamma + CLOB on a timed cadence
- control endpoints require `X-Phantom3-Token` or `Authorization: Bearer <token>`
- change `PHANTOM3_V2_CONTROL_TOKEN` before any shared use
- do **not** expose this app to the public internet, keep it on localhost, LAN, or a trusted private tunnel
- live mode is not implemented in this bootstrap
- a passing `npm run verify:paper-safe` only confirms static guardrails and docs markers, not trading safety or readiness

## Repo layout

```text
apps/
  api/         Fastify API + static dashboard hosting
  web/         React/Vite mobile dashboard
packages/
  config/      runtime config helpers
  contracts/   shared runtime shapes/types
  ledger/      planned durable ledger package (placeholder)
  market-data/ read-only Polymarket market snapshot adapter
  risk/        pure paper-trading risk evaluation
docs/
  architecture/
  milestones/
  qa/
  runbooks/
scripts/
  phantom3-runtime.sh  local runtime helper (preflight/start/stop/status/logs/launchd-print)
  verify-paper-safe.mjs
  launchd/
    io.phantom3.v2.paper-runtime.plist.template

docker-compose.example.yml
```
