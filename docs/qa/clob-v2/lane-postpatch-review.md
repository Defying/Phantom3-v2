# CLOB V2 Post-Patch Review

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Branch: `audit/clob-v2-readiness-2026-04-28`
- Mode: static post-patch review plus local verification result review. No live Polymarket calls, wallet calls, credential derivation, balance/allowance calls, wrapping, order placement, cancellation, or heartbeat calls were performed.

## Verdict

**PATCH READY FOR LOCAL CLOB V2 SDK/DOC READINESS.**

The originally identified blockers are resolved in the working tree:

- `@polymarket/clob-client-v2` is refreshed to `^1.0.2` in `package.json` and `1.0.2` in `package-lock.json`.
- Local `node_modules/@polymarket/clob-client-v2` was reinstalled and now reports package version `1.0.2`.
- Stale operator-facing `USDC` wording in `docs/strategy/UPDOWN_PROFIT_PATH.md` was replaced with CLOB V2 pUSD/collateral wording.
- `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md` now explicitly states pUSD balance/allowance, outcome-token allowance, POL gas, no-auto-wrap, and auth-not-collateral-readiness constraints.
- `.env.example` now carries pUSD/no-auto-wrap warnings and safer local/dashboard-off defaults.
- Paper-safe docs now avoid the stale absolute claim that live execution is unimplemented while preserving the no-live-capital warning.
- Final CLOB V2 lane docs and rollup artifacts are present.

This is **not** a live-capital readiness approval.

## Patch review

| Expected high-confidence change | Post-patch state | Result |
| --- | --- | --- |
| Refresh V2 SDK package/lock to latest observed `1.0.2` | `package.json` = `^1.0.2`; lock = `1.0.2`; node_modules = `1.0.2`. | Pass |
| Remove stale active-doc `USDC` wording | Active strategy doc says CLOB V2 live collateral is pUSD, not raw USDC.e. | Pass |
| Add pUSD/no-auto-wrap live runbook warning | Live runbook now documents pUSD balance/allowance, outcome token allowance, POL gas, USDC.e not enough, and no CollateralOnramp auto-wrap. | Pass |
| Preserve no-go posture | Live runbook remains `planned / no-go for live capital`; paper docs remain paper-only. | Pass |
| Harden example env | `.env.example` keeps live flags disabled and now defaults host/dashboard to local/off. | Pass |
| Add final QA artifacts | Dependency, live-execution, implementation-plan, test-plan, postpatch, and final report artifacts exist. | Pass |

## Verification reviewed

- Static stale/V1 search over active files excluding `docs/qa/clob-v2/**`: **no output**.
- Package version check:
  - `package.json`: `^1.0.2`
  - `package-lock.json`: `1.0.2`
  - `node_modules`: `1.0.2`
- `npm run check`: **pass**.
- `npm run test:live-safety`: **pass** — 20 tests, 20 passed.
- `npm run verify:paper-safe`: **pass** — 17 checks, 17 passed.
- `npm run build`: **pass** — TypeScript check plus Vite web build.

## Residual risks

1. **Live capital remains no-go.** Local SDK/docs readiness does not prove pUSD funding, allowance, geoblock/auth behavior, production venue reconciliation, flatten, restart, or incident handling.
2. **No pUSD preflight exists yet.** Wraith documents pUSD readiness requirements but does not yet call SDK balance/allowance helpers before arming or submitting.
3. **No automatic USDC.e wrapping.** This is intentional and should remain explicit operator wallet work unless a separate approved transaction-safety design is built.
4. **npm audit still reports known findings.** `@fastify/static` has a moderate advisory with a breaking major fix available; `@polymarket/clob-client-v2` depends on `@ethersproject/*`, which pulls `elliptic` advisories with no direct fix available from this repo.
5. **QA lane files are chronological.** Some earlier lane reports mention pre-patch stale findings; this post-patch review and final report are the authoritative current rollup.

## Confidence score

**93 / 100** confidence that the CLOB V2 package/docs migration patch is locally ready.

Confidence boosters:

- Direct package/lock/node_modules verification after reinstalling the actual SDK version.
- Typecheck, safety tests, paper-safe verification, and build all passed.
- Active-file stale/V1 search is clean.
- No live external trading action was performed.

Confidence reducers:

- No live Polymarket venue/wallet/balance/order behavior was exercised by design.
- pUSD readiness is documented, not enforced by code.
- Upstream SDK and dependency advisories remain external dependencies.
