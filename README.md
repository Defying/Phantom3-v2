# Phantom3 v2

Phantom3 v2 is the controlled rebuild of the original Phantom3 bot.

This repo is the **v2 bootstrap**: a TypeScript modular-monolith skeleton with a phone-friendly dashboard, strict safety defaults, and a bounded control API.

## Current status

This repo is a **paper-safe runtime bootstrap**, not a live-trading system.

The paper-safe strategy materials below are still the safety gate, but the repo now includes a working paper runtime with strategy, risk, ledger, and dashboard wiring.

Implemented today:
- TypeScript runtime
- phone-accessible dashboard
- WebSocket runtime stream (`/api/ws`)
- read-only Polymarket market snapshot (Gamma + CLOB midpoint data)
- explicit, venue-scoped Polymarket transport controls with optional SOCKS5 routing
- generic paper-only strategy engine runtime
- pure paper-trading risk evaluation module
- append-only paper ledger projection and paper execution adapter
- persisted runtime state on disk
- persisted trading-preference control with legacy reference profiles and a paper-managed exit/session-guard foundation for the legacy live profile
- bounded control API
- safe defaults (paper mode, live disarmed)

Not implemented yet:
- full legacy strategy parity for the new trading-preference profiles (entries still do not match the legacy bots)
- replay / comparison harness
- live execution

## Quick start

```bash
cp .env.example .env
# set a real PHANTOM3_V2_CONTROL_TOKEN first
# optional: PHANTOM3_V2_POLYMARKET_PROXY_URL=socks5h://mullvad-socks5:1080
npm install
npm run runtime:preflight
npm run verify:paper-runtime
npm run verify:trading-preference
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

## Optional scoped Polymarket proxy

Phantom3 v2 can route only its outbound Polymarket venue traffic through an explicit SOCKS proxy without changing host networking or proxying dashboard access.

```bash
PHANTOM3_V2_POLYMARKET_PROXY_URL=socks5h://mullvad-socks5:1080
PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY=confirmed-eligible
```

Notes:
- only the Polymarket Gamma + CLOB market-data adapter uses `PHANTOM3_V2_POLYMARKET_PROXY_URL`
- supports `socks5://` and `socks5h://`, prefer `socks5h://` when you want proxy-side DNS resolution
- dashboard, control, health, Fastify binds, and in-browser requests stay direct
- `PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY` is a read-only compliance scaffold: `unknown`, `confirmed-eligible`, or `restricted`
- when eligibility is marked `restricted`, the runtime fails closed and disables Polymarket sync instead of trying to route around venue policy
- do not use this setting for geoblock bypass behavior

## Container-only Mullvad SOCKS5 path

Use Docker Compose for the Mullvad egress path. This is a container-scoped deployment option for venue traffic, not a host VPN.

1. prepare the untracked WireGuard input from your Mullvad zip or `.conf`:

```bash
./scripts/prepare-mullvad-wireguard-config.sh --source /path/to/mullvad-wireguard.zip --select <config-name>.conf
```

2. review the safe local-input docs in `docs/runbooks/MULLVAD_WIREGUARD_CONTAINER_INPUTS.md`
3. run the static checks:

```bash
npm run verify:mullvad-config-safety
npm run verify:mullvad-socks5
```

4. deploy with the compose overlay in `docker-compose.mullvad.example.yml`

Boundary rules:
- only Phantom3 traffic that is explicitly configured for the SOCKS5 path uses the Mullvad sidecar
- the host machine, browser, shell, and unrelated containers stay on their normal network path
- keep localhost and other private/internal destinations out of the proxy path
- never commit vendor zips or selected WireGuard configs

Reference files:
- Compose overlay: `docker-compose.mullvad.example.yml`
- Static verifier model: `docker-compose.mullvad-socks5.example.yml`
- Static env example: `.env.mullvad-socks5.example`
- Mount snippet: `examples/mullvad/mount-snippet.example.yml`
- Static checklist: `docs/qa/MULLVAD_SOCKS5_STATIC_CHECKLIST.md`
- Compose runbook: `docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md`
- Legacy sidecar notes: `docs/runbooks/MULLVAD_SOCKS5_COMPOSE.md`

## Paper-safe strategy docs

- milestone definition: `docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md`
- trading-preference rule reference: `docs/architecture/TRADING_PREFERENCE_PROFILES.md`
- canonical crypto-window parity target: `docs/architecture/CRYPTO_WINDOW_PARITY_SPEC.md`
- QA checklist: `docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md`
- Mullvad static checklist: `docs/qa/MULLVAD_SOCKS5_STATIC_CHECKLIST.md`
- operator runbook and warnings: `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md`
- container-only Mullvad input handling: `docs/runbooks/MULLVAD_WIREGUARD_CONTAINER_INPUTS.md`
- Mullvad SOCKS5 Compose runbook: `docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md`
- future live thin-slice review checklist: `docs/qa/LIVE_THIN_SLICE_REVIEW_CHECKLIST.md`

## Important safety notes

- this milestone is observer-first and paper-only
- dashboard runtime updates stream over WebSocket at `/api/ws`
- market discovery is read-only and refreshes from Polymarket Gamma + CLOB on a timed cadence
- `PHANTOM3_V2_POLYMARKET_PROXY_URL` only affects the Polymarket market-data adapter, not the dashboard or control plane
- set `PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY` explicitly and do not use proxy settings for geoblock bypass
- control endpoints require `X-Phantom3-Token` or `Authorization: Bearer <token>`
- change `PHANTOM3_V2_CONTROL_TOKEN` before any shared use
- selecting a legacy trading preference may enable paper-only partial parity foundations, but does **not** mean the current runtime has full legacy parity or that live trading is enabled
- do **not** expose this app to the public internet, keep it on localhost, LAN, or a trusted private tunnel
- the optional Mullvad SOCKS5 path only affects explicitly proxied container traffic, not the host machine
- proxy exit geography does not change venue rules, geoblocks, or compliance obligations
- live mode is not implemented in this bootstrap
- before any live thin-slice PR is treated as ready for review, run `npm run verify:live-safety`
- a passing `npm run verify:paper-safe` only confirms static guardrails and docs markers, not trading safety or readiness
- `npm run verify:paper-runtime` is a local smoke test for ledger projection invariants, bootstrap restart truth, and the sanitized paper API shape
- `npm run verify:trading-preference` is a local scenario verifier for token-gated control behavior, persisted preference state, honest legacy-reference exposure, and doc-backed parity thresholds

## Repo layout

```text
apps/
  api/         Fastify API + static dashboard hosting
  web/         React/Vite mobile dashboard
examples/
  mullvad/     env + mount snippets for runtime-only WireGuard inputs
packages/
  config/      runtime config helpers
  contracts/   shared runtime shapes/types
  ledger/      planned durable ledger package (placeholder)
  market-data/ read-only Polymarket market snapshot adapter
  risk/        pure paper-trading risk evaluation
  transport/   proxy-aware outbound HTTP/WebSocket transport helpers
docs/
  architecture/
  milestones/
  qa/
  runbooks/
runtime/
  mullvad/     gitignored local vendor inputs and generated mount files
scripts/
  phantom3-runtime.sh                 local runtime helper (preflight/start/stop/status/logs/launchd-print)
  prepare-mullvad-wireguard-config.sh select and stage one untracked WireGuard config for containers
  verify-paper-runtime.ts
  verify-paper-safe.mjs
  verify-trading-preference.ts
  verify-mullvad-config-safety.mjs
  verify-mullvad-socks5.mjs
  launchd/
    io.phantom3.v2.paper-runtime.plist.template
docker/
  mullvad/      userspace WireGuard + SOCKS5 sidecar config and ignored secret inputs

docker-compose.example.yml
docker-compose.mullvad.example.yml
docker-compose.mullvad-socks5.example.yml
```
