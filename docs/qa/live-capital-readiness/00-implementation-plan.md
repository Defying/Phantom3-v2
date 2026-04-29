# Live Capital Readiness Implementation Plan

Date: 2026-04-28
Branch: `feat/live-capital-readiness-2026-04-28`
Base: `4f66d92 chore: complete polymarket clob v2 readiness pass`

## Objective

Move Wraith from CLOB V2 SDK/docs readiness toward code-level live-capital readiness while preserving fail-closed behavior. This pass must make the runtime prove wallet, collateral, venue reconciliation, and flatten prerequisites before live controls can arm or submit operator live exits.

## Non-negotiable safety boundaries

- No live order placement during this implementation pass.
- No real pUSD wrapping, USDC.e migration, CollateralOnramp calls, allowance updates, or fund movement.
- No API-key derivation unless the operator explicitly enables it in env; tests must use mocks.
- No secret logging. Runtime/API responses must stay sanitized and `safeToLog` only.
- If any live prerequisite is missing, stale, unsupported, ambiguous, or unproven, the runtime must block arming and/or flattening.

## Code changes planned

1. **Collateral readiness contract**
   - Extend runtime contracts so `execution.live` exposes sanitized pUSD/POL readiness.
   - Include checked time, readiness status, pUSD balance/allowance, required thresholds, optional POL gas, blocking reasons, and `safeToLog: true`.

2. **Config gates**
   - Add env-driven thresholds:
     - `WRAITH_LIVE_MIN_PUSD_BALANCE`
     - `WRAITH_LIVE_MIN_PUSD_ALLOWANCE`
     - `WRAITH_LIVE_MIN_POL_GAS`
     - `WRAITH_LIVE_READINESS_MAX_AGE_MS`
     - optional `WRAITH_POLYGON_RPC_URL` for read-only POL gas checks
   - Defaults should be conservative enough that arming is not possible without a positive pUSD/allowance proof.

3. **Polymarket SDK read-only readiness**
   - Wrap SDK `getBalanceAllowance({ asset_type: AssetType.COLLATERAL })` for pUSD.
   - Wrap SDK `getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id })` for outcome-token flatten readiness.
   - Never call `updateBalanceAllowance` automatically.
   - Treat integer balance/allowance strings as 6-decimal raw token units; decimal strings as already human-unit values.
   - Optional read-only POL gas check through configured Polygon RPC.

4. **Runtime fail-closed gating**
   - Refresh pUSD readiness during startup and immediately before arming.
   - Block arming unless pUSD balance/allowance and required gas readiness are fresh and ready.
   - Keep existing startup reconciliation, unmatched venue order/fill, mixed provenance, and kill-switch blockers.
   - Before live flatten, query conditional-token balance/allowance for the exact token/quantity; block if unsupported or insufficient.

5. **API/dashboard/readiness visibility**
   - Extend `/api/live/wallet` and add `/api/live/readiness` with sanitized readiness evidence.
   - Dashboard should surface collateral readiness status and blocking reasons.

6. **Tests and verification**
   - Unit tests for Polymarket collateral and conditional-token readiness parsing/blocking.
   - Runtime tests for arming blocked by missing/insufficient/stale collateral and allowed only after clean venue + collateral proof.
   - Runtime test for live flatten blocked by insufficient conditional-token readiness.
   - Existing gates must remain green: `npm run check`, `npm run test:live-safety`, `npm run verify:paper-safe`, `npm run build`.

## Confidence score

**87/100**

### Confidence factors

Positive:
- Existing runtime already has live-control state, startup reconciliation, kill-switch durability, and reduce-only flatten scaffolding.
- Official V2 SDK exposes the exact read-only `getBalanceAllowance` API needed for pUSD and conditional-token readiness.
- The current env defaults are already fail-closed.

Reducing confidence:
- `balance-allowance` response unit format is not documented in local type definitions; this pass uses conservative 6-decimal raw parsing for integer strings.
- Full live readiness still requires an operator-approved real read-only trace against the intended wallet and venue.
- This pass does not implement automatic collateral migration or allowance updates; those remain explicit operator actions.

## Expected verdict after this pass

If tests pass, Wraith can honestly report: local code gates for live-capital readiness are present and fail-closed. Actual deployment remains blocked until Ben approves a supervised read-only wallet/venue trace proving the intended wallet has pUSD, allowance, gas, and clean venue state.
