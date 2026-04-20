# Phantom3 v2

Phantom3 v2 is the controlled rebuild of the original Phantom3 bot.

This repo is the **v2 bootstrap**: a TypeScript modular-monolith skeleton with a phone-friendly dashboard, strict safety defaults, and a bounded control API.

## Current scope

This is **not** a live trading bot yet.

Current milestone:
- v2 repo bootstrap
- TypeScript runtime
- phone-accessible dashboard
- WebSocket runtime stream (`/api/ws`)
- bounded control API
- file-backed bootstrap ledger/state
- safe defaults (paper mode, live disarmed)

## Quick start

```bash
cp .env.example .env
npm install
npm run build:web
npm run start
```

Then open the dashboard at the configured public URL.

Examples:
- local machine: `http://127.0.0.1:4317`
- phone on same LAN: `http://<your-server-host-or-lan-ip>:4317`

## Important safety notes

- dashboard runtime updates stream over WebSocket at `/api/ws`
- control endpoints require `X-Phantom3-Token` or `Authorization: Bearer <token>`
- live mode is not implemented in this bootstrap
- this app is safe to expose to your LAN only because it is read-first and control actions are token-gated

## Repo layout

```text
apps/
  api/         Fastify API + static dashboard hosting
  web/         React/Vite mobile dashboard
packages/
  config/      runtime config helpers
  contracts/   shared runtime shapes/types
  ledger/      planned durable ledger package (placeholder)
docs/
  architecture/
scripts/
  run-server.sh
```
