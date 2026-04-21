# Paper-safe operator runbook

This runbook is for supervised paper-only sessions.

## Operator warnings

Read these as hard warnings, not suggestions:

1. **This repo is not live-trading ready.**
   Live execution is intentionally not implemented in this milestone.

2. **Paper-safe is not profit-safe.**
   A clean paper session does not prove edge, fill quality, or live readiness.

3. **Do not expose this dashboard to the public internet.**
   Read endpoints are open and control endpoints are only token-gated. Keep access constrained to localhost, LAN, or a trusted private tunnel.

4. **Do not load live trading credentials for this milestone.**
   If strategy work begins, keep it paper-only until a later milestone explicitly changes that rule.

5. **Do not ignore stale data.**
   If the runtime shows stale market data, pause and investigate before trusting any paper result.

6. **Do not treat the UI as the source of truth.**
   The ledger and logs must explain what happened. If they cannot, stop the session.

7. **Do not use the proxy setting to evade geographic restrictions.**
   Any optional venue proxy must stay read-only, container-scoped, compliant with Polymarket access rules, and deployed with Docker Compose rather than host-level VPN changes.

## Preflight

Before starting a session:

- set a fresh `PHANTOM3_V2_CONTROL_TOKEN`
- verify `PHANTOM3_V2_PUBLIC_BASE_URL` matches the actual access path
- confirm `PHANTOM3_V2_DATA_DIR` and `PHANTOM3_V2_LOG_DIR` point to writable local storage
- if `PHANTOM3_V2_POLYMARKET_PROXY_URL` is set, keep it scoped to read-only Polymarket market-data traffic only
- set `PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY` to `confirmed-eligible` when reviewed, or `restricted` to fail closed
- prefer `PHANTOM3_V2_REMOTE_DASHBOARD=false` unless remote access is truly needed
- if you are using the container-only Mullvad flow, prepare the untracked WireGuard input with `./scripts/prepare-mullvad-wireguard-config.sh`
- review `docs/runbooks/MULLVAD_WIREGUARD_CONTAINER_INPUTS.md` for the safe local input path
- review `docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md` and confirm exactly one local Mullvad conf is mounted read-only via Compose
- review `docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md`
- print or open `docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md`

## Startup procedure

```bash
cp .env.example .env
# set a fresh PHANTOM3_V2_CONTROL_TOKEN before continuing
npm install
npm run runtime:preflight
npm run verify:paper-runtime
npm run runtime:start
npm run runtime:status
```

What the helper does:
- loads `.env` from the repo root unless `PHANTOM3_V2_ENV_FILE` overrides it
- writes pid and runtime logs under `PHANTOM3_V2_LOG_DIR`
- rebuilds the dashboard before startup so the served UI matches the current checkout
- checks `/api/health` instead of trusting a stale pid file

Then confirm:
- `npm run verify:paper-runtime` passed on the same commit you are about to run
- `/api/health` returns healthy JSON
- `/api/runtime` reports `mode: "paper"`
- `/api/runtime` shows the expected Polymarket transport route and eligibility note
- the runtime shows the execution path as blocked or disarmed
- unauthorized control requests fail with `401`

Useful operator commands:

```bash
npm run runtime:logs
npm run runtime:restart
npm run runtime:stop
```

## Optional container-only Mullvad egress

If you need the Mullvad SOCKS5 path for venue traffic:
- use Docker Compose, not a host VPN or host-wide proxy settings
- route only the application traffic that is explicitly configured for the SOCKS5 proxy
- keep localhost and internal/private destinations on their direct path with `NO_PROXY` or equivalent client settings
- select and mount exactly one Mullvad WireGuard conf from the provided bundle
- follow `docs/runbooks/MULLVAD_SOCKS5_COMPOSE_RUNBOOK.md`

If the Mullvad path is unhealthy, stop the proxied application container and investigate. Do not paper over it with host-level network changes.

If you want the paper runtime to start at login on macOS, render the repo-aware launchd plist with:

```bash
npm run runtime:launchd:print > ~/Library/LaunchAgents/io.phantom3.v2.paper-runtime.plist
```

## During a supervised paper session

The operator should keep an eye on:
- stale market-data status
- whether pause state is respected immediately
- whether events and logs remain coherent
- whether a restart would leave any paper state unexplained

Recommended discipline:
- one accountable operator per session
- no silent config changes mid-session
- record the commit hash and notable events
- save one or two representative traces for later review

## Immediate stop conditions

Pause the runtime and treat the session as invalid if:
- market data becomes stale and does not recover quickly
- the runtime cannot explain a decision or state transition
- unauthorized control access behaves unexpectedly
- strategy output appears without a corresponding risk or ledger trail
- paper positions or fills cannot be reconciled after restart
- anyone proposes enabling live capital from paper results alone

## Post-run wrap-up

Before declaring the session useful:
- save the tested commit hash
- note config differences from `.env.example`
- attach the completed checklist
- document known limitations, surprises, and open bugs
- keep at least one accepted and one rejected decision trace

If any trace is missing or ambiguous, the correct outcome is "not ready yet."