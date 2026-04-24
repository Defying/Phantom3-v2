# Wraith

Wraith is the controlled rebuild of the original Phantom3 bot.

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
npm install
npm run build:web
npm run check
npm run verify:paper-safe
npm run start
```

Then open the dashboard at the configured public URL.

Examples:
- local machine: `http://127.0.0.1:4317`
- phone on same LAN: `http://<your-server-host-or-lan-ip>:4317`

## Docker Compose example

A local Compose example lives at `docker-compose.example.yml`.

```bash
cp .env.example .env
# set a real WRAITH_CONTROL_TOKEN
# set WRAITH_PUBLIC_BASE_URL to your actual local/LAN URL

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
- future live thin-slice review checklist: `docs/qa/LIVE_THIN_SLICE_REVIEW_CHECKLIST.md`
- live thin-slice no-go runbook: `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md`

## Important safety notes

- this milestone is observer-first and paper-only
- dashboard runtime updates stream over WebSocket at `/api/ws`
- market discovery is read-only and refreshes from Polymarket Gamma + CLOB on a timed cadence
- control endpoints require `X-Wraith-Token` or `Authorization: Bearer <token>`
- change `WRAITH_CONTROL_TOKEN` before any shared use
- do **not** expose this app to the public internet, keep it on localhost, LAN, or a trusted private tunnel
- live mode is not implemented in this bootstrap
- before any live thin-slice PR is treated as ready for review, run `npm run verify:live-safety` and read `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md`
- a passing `npm run verify:paper-safe` only confirms static guardrails and docs markers, not trading safety or readiness
- a passing `npm run verify:live-safety` is still a guardrail check, not proof of live-capital readiness

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
  verify-paper-safe.mjs

docker-compose.example.yml
```
