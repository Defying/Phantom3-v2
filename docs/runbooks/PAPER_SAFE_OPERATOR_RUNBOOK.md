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

## Preflight

Before starting a session:

- set a fresh `PHANTOM3_V2_CONTROL_TOKEN`
- verify `PHANTOM3_V2_PUBLIC_BASE_URL` matches the actual access path
- confirm `PHANTOM3_V2_DATA_DIR` and `PHANTOM3_V2_LOG_DIR` point to writable local storage
- prefer `PHANTOM3_V2_REMOTE_DASHBOARD=false` unless remote access is truly needed
- review `docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md`
- print or open `docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md`

## Startup procedure

```bash
cp .env.example .env
npm install
npm run build:web
npm run check
npm run verify:paper-safe
npm run verify:paper-runtime
npm run start
```

Then confirm:
- `npm run verify:paper-runtime` passed on the same commit you are about to run
- `/api/health` returns healthy JSON
- `/api/runtime` reports `mode: "paper"`
- the runtime shows the execution path as blocked or disarmed
- unauthorized control requests fail with `401`

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