# Wraith Polymarket CLOB V2 Migration Report

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Branch: `audit/clob-v2-readiness-2026-04-28`
- Scope: CLOB V2 SDK/package refresh, pUSD/no-go documentation cleanup, planning/audit artifacts, and local verification gates.
- Safety boundary: no live Polymarket calls, wallet calls, API-key derivation, pUSD balance/allowance calls, USDC.e wrapping, CollateralOnramp calls, order placement, cancellation, or heartbeat calls were performed.

## Executive verdict

**Wraith is now CLOB V2 SDK-ready at the local package/source/docs level.**

It is **still no-go for live capital**. CLOB V2 compatibility means the repo is on the current SDK/package/documentation path; it does not prove live wallet collateral, allowance, venue truth, restart safety, flatten safety, or incident handling.

## What changed

### Package / lockfile

- `package.json`
  - `@polymarket/clob-client-v2` updated from `^1.0.0` to `^1.0.2`.
- `package-lock.json`
  - `node_modules/@polymarket/clob-client-v2` updated from `1.0.0` to `1.0.2`.
  - Resolved tarball: `https://registry.npmjs.org/@polymarket/clob-client-v2/-/clob-client-v2-1.0.2.tgz`
  - Integrity: `sha512-lC80Esug6s6y3uV8D5HnkxoXVZUnATjyP6PcK2IXO740iGDuLlp9Dvvkx3+VVygHahN+M3NY7JiYiTQkDfWoeQ==`

Local install was refreshed after a lockfile-only install initially left `node_modules` stale. Final verified state:

```json
{
  "packageJson": "^1.0.2",
  "lock": "1.0.2",
  "nodeModules": "1.0.2"
}
```

### Operator/docs cleanup

- `.env.example`
  - Safer source defaults: `WRAITH_HOST=127.0.0.1`, `WRAITH_REMOTE_DASHBOARD=false`.
  - Added CLOB V2 pUSD collateral + allowance warning.
  - Added explicit no-auto-wrap/no-collateral-migration warning.
- `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md`
  - Updated date to 2026-04-28.
  - Clarified startup-reconcile scaffolding exists but is not a live-readiness proof.
  - Added pUSD balance/allowance, outcome-token allowance, POL gas, USDC.e-not-enough, and no-auto-wrap warnings.
  - Added pUSD collateral-readiness trace to minimum live-review evidence.
- `docs/strategy/UPDOWN_PROFIT_PATH.md`
  - Replaced “Promote to live...” with “Only consider a live review...” gated by live-runbook evidence.
  - Replaced stale “USDC to trade” wording with pUSD-aware Polymarket collateral wording.
- `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md`
  - Replaced stale absolute “live execution not implemented” wording with “scaffolding may exist, but paper-safe only.”
- `docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md`
  - Updated static guardrail wording to reflect live scaffolding without implying live readiness.

### QA artifacts added/updated

- `docs/qa/clob-v2/00-official-research.md`
- `docs/qa/clob-v2/lane-config-env-audit.md`
- `docs/qa/clob-v2/lane-dependency-audit.md`
- `docs/qa/clob-v2/lane-docs-consistency-review.md`
- `docs/qa/clob-v2/lane-implementation-plan.md`
- `docs/qa/clob-v2/lane-live-execution-audit.md`
- `docs/qa/clob-v2/lane-live-safety-audit.md`
- `docs/qa/clob-v2/lane-postpatch-review.md`
- `docs/qa/clob-v2/lane-pusd-allowance-audit.md`
- `docs/qa/clob-v2/lane-repo-wide-v1-search.md`
- `docs/qa/clob-v2/lane-test-plan-review.md`
- `docs/qa/clob-v2/final-migration-report.md`

Note: individual lane files are chronological. The authoritative current state is this final report plus `lane-postpatch-review.md`.

## Verification results

| Gate | Result | Notes |
| --- | --- | --- |
| Active-file stale/V1 search | Pass | No active-file hits outside chronological QA docs for legacy SDK/stale CLOB V1 host/stale `USDC` wording. |
| Package version check | Pass | package, lockfile, and node_modules all at intended V2 SDK version. |
| `npm run check` | Pass | TypeScript `tsc --noEmit -p tsconfig.json`. |
| `npm run test:live-safety` | Pass | 20 tests passed, 0 failed. |
| `npm run verify:paper-safe` | Pass | 17 checks passed, 0 failed. |
| `npm run build` | Pass | `npm run check` plus Vite web build succeeded. |
| `npm audit --omit=dev --audit-level=moderate` | Findings remain | 13 advisories: 12 low, 1 moderate. Not fixed in this CLOB V2 pass due unrelated/breaking/no-fix dependency constraints. |

## Current no-go blockers for live capital

Do not trade live capital from this branch until a separate live-review pass proves all of this:

1. Intended wallet/funder has pUSD balance and pUSD allowance for BUY orders.
2. Intended wallet/funder has outcome-token balance/allowance for SELL/flatten paths.
3. EOA signing path has enough POL for gas.
4. Startup reconciliation is traced against real venue state.
5. Open orders, fills, positions, partial fills, and late fills reconcile from venue evidence, not UI assumptions.
6. Flatten ends flat from venue fill evidence.
7. Unmatched venue order/fill evidence creates incidents and blocks new entries.
8. Restart during open live state recovers without orphaning venue inventory.
9. Any CLOB V1-era local/live ledger state is manually reconciled across the CLOB V2 open-order wipe boundary.
10. Operator explicitly approves any future collateral migration / wrapping design.

## npm audit notes

`npm audit --omit=dev --audit-level=moderate` still reports:

- `@fastify/static` moderate advisories with a breaking major fix path (`@fastify/static@9.1.3`). This is not part of the CLOB V2 SDK migration and should be handled as a separate web/server dependency update.
- `elliptic` advisories via `@ethersproject/*`, pulled by `@polymarket/clob-client-v2`. npm reports no direct fix available for that dependency chain from this repo.

## Rollback

If this patch needs to be reverted before merge:

1. Revert the changed files in git.
2. Run `npm install --ignore-scripts` to restore `node_modules` to the reverted lockfile.
3. Re-run `npm run check`, `npm run test:live-safety`, `npm run verify:paper-safe`, and `npm run build`.

## Confidence score

**92 / 100** confidence that the requested CLOB V2 migration pass is complete at the package/source/docs/local-verification level.

Confidence boosters:

- Official docs/research converged on the required facts: production host unchanged, V2 SDK required, pUSD collateral required.
- Active source was already using the V2 SDK; no risky order-signing rewrite was needed.
- Package/lock/node_modules all verified at `@polymarket/clob-client-v2@1.0.2`.
- All requested local gates passed after the actual SDK install was refreshed.
- Active docs now preserve pUSD/no-auto-wrap/no-go language.

Confidence reducers:

- Direct tweet body was not reliably fetchable; official Polymarket docs/changelog were used instead.
- No live Polymarket wallet/API/balance/order behavior was exercised by design.
- pUSD collateral readiness is documented but not enforced programmatically yet.
- npm audit advisories remain for unrelated/breaking/no-direct-fix dependencies.
