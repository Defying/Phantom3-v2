# Paper-safe strategy test checklist

Use this checklist before calling the strategy milestone paper-safe.

Commit tested: `__________________`
Operator: `__________________`
Date: `__________________`

## 1) Static guardrails

- [ ] `npm run check` passes
- [ ] `npm run build:web` passes
- [ ] `npm run verify:paper-safe` passes
- [ ] `npm run verify:paper-runtime` passes
- [ ] README and milestone docs still state that live execution is not implemented
- [ ] control token is not left at the example value in `.env`

## 2) Startup smoke test

- [ ] `cp .env.example .env`
- [ ] set a fresh `PHANTOM3_V2_CONTROL_TOKEN`
- [ ] confirm `PHANTOM3_V2_PUBLIC_BASE_URL` matches the operator access path
- [ ] `npm run runtime:preflight` passes
- [ ] start the app with `npm run runtime:start`
- [ ] `npm run runtime:status` reports a reachable endpoint
- [ ] `GET /api/health` returns `ok: true`
- [ ] `GET /api/runtime` reports `mode: "paper"`
- [ ] `GET /api/runtime` shows `execution` as blocked or otherwise clearly disarmed
- [ ] `GET /api/runtime` shows `strategy` as idle until the strategy milestone actually lands

## 3) Control-plane safety

- [ ] `POST /api/control/pause` without a token returns `401`
- [ ] `POST /api/control/resume` without a token returns `401`
- [ ] authorized pause flips `paused` to `true`
- [ ] authorized resume flips `paused` back to `false`
- [ ] pause and resume actions are visible in runtime events or logs

Example manual checks:

```bash
curl -s http://127.0.0.1:4317/api/health
curl -s http://127.0.0.1:4317/api/runtime
curl -i -X POST http://127.0.0.1:4317/api/control/pause
curl -i -X POST \
  -H "X-Phantom3-Token: $PHANTOM3_V2_CONTROL_TOKEN" \
  http://127.0.0.1:4317/api/control/pause
```

## 4) Market-data integrity

- [ ] market snapshot eventually loads or the failure is explicit and logged
- [ ] stale-data state is visible to the operator
- [ ] tracked market count is plausible for the configured limit
- [ ] runtime heartbeat keeps updating while the server is healthy
- [ ] data and log directories are writable

## 5) Strategy-specific gates

These stay unchecked until strategy code exists.

- [ ] strategy emits intents, not direct exchange actions
- [ ] every accepted intent receives a risk decision record
- [ ] every rejected intent includes a reason
- [ ] every paper fill includes the fill assumption or model version used
- [ ] open paper positions can be reconstructed after restart
- [ ] the runtime smoke verifier still proves restart recovery from ledger truth
- [ ] replay results are comparable to the recorded live observer session
- [ ] one accepted paper trade can be traced end-to-end
- [ ] one rejected paper trade can be traced end-to-end

## 6) Operator sign-off

- [ ] operator reviewed warnings in `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md`
- [ ] operator confirms this milestone is still paper-only
- [ ] known limitations were written down before sign-off
- [ ] no evidence suggests live capital should be enabled

Notes:

```text

```
