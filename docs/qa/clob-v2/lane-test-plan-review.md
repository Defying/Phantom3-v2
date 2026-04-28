# CLOB V2 Migration Lane — Test Plan Review

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Branch: `audit/clob-v2-readiness-2026-04-28`
- Mode: manual test-plan reconstruction after the automated lane returned unusable raw test content. No live Polymarket calls, wallet calls, credential derivation, wrapping, real orders, tests, builds, or dev servers were run for this lane.

## Verdict

The minimum safe verification plan for this CLOB V2 pass is local/static only. It should prove that the package/docs patch is source-compatible and that existing safety guardrails still hold, but it must **not** be interpreted as live-capital readiness.

## Required local gates

Run in this order after the patch lands:

1. **Static search / inspection**
   - Confirm active source/package metadata does not reference legacy CLOB V1 SDK/package names.
   - Confirm operator-facing docs no longer imply raw USDC.e is sufficient CLOB V2 collateral.
   - Confirm live docs still say no-go for live capital.

2. **TypeScript check**
   - Command: `npm run check`
   - Purpose: prove the refreshed `@polymarket/clob-client-v2` package remains compatible with active imports/types.

3. **Live-safety regression tests**
   - Command: `npm run test:live-safety`
   - Purpose: prove existing local live/paper safety regressions still pass after the dependency/docs patch.
   - Important: this is not a production venue proof.

4. **Paper-safe static guardrail verification**
   - Command: `npm run verify:paper-safe`
   - Purpose: prove the repository still exposes and documents paper-safe guardrails.

5. **Build**
   - Command: `npm run build`
   - Purpose: run the project’s declared build path (`check` plus web build) after the CLOB V2 package refresh.

## Explicitly disallowed for this pass

- `createOrDeriveApiKey` against a real wallet.
- live CLOB authenticated API calls.
- order placement/cancellation/heartbeat against production.
- pUSD balance/allowance writes.
- USDC.e approval or CollateralOnramp wrapping.
- printing `.env` values, private keys, API secrets, or passphrases.

## Pass criteria

The final report can say Wraith is **CLOB V2 SDK-ready at the package/source/docs level** only if:

- the package/lockfile resolve to the intended V2 SDK release;
- all required local gates pass;
- docs clearly state pUSD/no-auto-wrap/no-go constraints;
- remaining live-capital blockers are explicitly listed.

## Confidence score

**86 / 100** confidence in this test plan.

Confidence boosters:

- It matches the project’s existing scripts and guardrail philosophy.
- It exercises source compatibility and safety regressions without touching live capital.
- It is narrow enough to run quickly and repeatedly.

Confidence reducers:

- It does not verify live Polymarket production behavior.
- It does not verify pUSD balance/allowance or wallet funding.
- It cannot prove restart-safe venue truth; that needs a later traced live-review workflow.
