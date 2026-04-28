# CLOB V2 Migration — Implementation Plan

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Branch: `audit/clob-v2-readiness-2026-04-28`
- Mode: planning artifact written before compilation/test gates. This plan intentionally avoids live Polymarket calls, wallet calls, credential derivation, wrapping, and real orders.

## Objective

Make Wraith operationally current with Polymarket CLOB V2 package/docs reality while preserving the existing no-go stance for live capital.

## High-confidence facts driving the plan

- CLOB V2 is live on production host `https://clob.polymarket.com`.
- V1 SDKs / V1-signed orders are no longer production-safe.
- Wraith already imports `@polymarket/clob-client-v2` in the live execution integration.
- Wraith package metadata was stale: lockfile pinned the V2 SDK to `1.0.0`; npm latest observed during this pass was `1.0.2`.
- CLOB V2 live collateral is pUSD, not raw USDC.e.
- Wraith does not currently prove pUSD balance/allowance and should not auto-wrap USDC.e in this migration.
- Live-capital safety remains blocked by venue truth/reconciliation/flatten/incident/pUSD evidence, not just SDK compatibility.

## Planned patch

1. **Dependency refresh**
   - Update `@polymarket/clob-client-v2` from `^1.0.0` / lock `1.0.0` to `^1.0.2` / lock `1.0.2`.
   - Avoid broader dependency churn.

2. **Operator docs: pUSD collateral and no auto-wrap**
   - Update the live thin-slice runbook to state that `/api/live/wallet` is auth/gateway readiness only.
   - Add pUSD balance, pUSD allowance, outcome-token allowance, and POL gas requirements.
   - State that USDC.e in a wallet is not enough for CLOB V2 buys unless wrapped/credited as pUSD.
   - State that Wraith does not auto-wrap USDC.e or call CollateralOnramp in this pass.

3. **Strategy docs: remove stale USDC wording**
   - Replace generic/stale `USDC` trading wording with pUSD-aware or collateral-neutral language.
   - Soften `Promote to live` language to `Only consider a live review...` and cross-reference live evidence gates.

4. **Example env hardening**
   - Add pUSD/no-auto-wrap comments near Polymarket live env vars.
   - Keep live execution disabled/disarmed by default.
   - Prefer local-only/dashboard-off defaults in `.env.example` unless an operator explicitly enables remote/private-tunnel access.

5. **Paper-safe docs consistency**
   - Replace stale absolute wording that live execution is “not implemented” with the more precise warning that live scaffolding may exist but is not live-capital readiness.

6. **Final QA rollup**
   - Add a final report summarizing changed files, confidence, verification results, and remaining blockers.

## Non-goals

- No live Polymarket API calls.
- No wallet balance checks.
- No API-key derivation.
- No pUSD wrapping / CollateralOnramp call.
- No private key/API secret printing.
- No real order placement/cancellation/heartbeat.
- No implementation of automatic pUSD preflight in code during this documentation/package refresh pass.

## Verification plan

Run these gates after the patch lands:

1. static search for stale CLOB V1 / USDC operator wording;
2. `npm run check`;
3. `npm run test:live-safety`;
4. `npm run verify:paper-safe`;
5. `npm run build`.

If any gate fails, stop and record the failure in the final report instead of claiming readiness.

## Confidence score

**90 / 100** confidence in this implementation scope.

Confidence boosters:

- Multiple static audits agree Wraith is already on the V2 SDK path.
- Required changes are narrow: package lock refresh plus operator documentation.
- No source signing/order rewrite is required for the current code shape.

Confidence reducers:

- Direct tweet content was not reliably fetched; official Polymarket docs/changelog were used instead.
- No live venue, wallet, or balance calls are allowed in this pass.
- pUSD/allowance remains documented rather than enforced by code.
