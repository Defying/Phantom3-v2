# Live Capital Readiness Report

Date: 2026-04-29
Branch: `feat/live-capital-readiness-2026-04-28`
Base: `4f66d92 chore: complete polymarket clob v2 readiness pass`

## Verdict

**LOCAL CODE GATES READY; LIVE CAPITAL STILL REQUIRES A SEPARATELY APPROVED READ-ONLY VENUE/WALLET TRACE BEFORE ANY ORDER TEST.**

This pass moves Wraith from CLOB V2 package/docs readiness to fail-closed local live-capital readiness plumbing. The runtime can now require fresh, sanitized pUSD/POL collateral evidence before live arming and conditional-token evidence before live flatten. It still does not make trading safe by itself: real venue evidence, operator runbook evidence, and explicit approval are still required before any live order.

## What changed

### Config and env

Added explicit readiness thresholds:

- `WRAITH_LIVE_READINESS_MAX_AGE_MS` default `30000`
- `WRAITH_LIVE_MIN_PUSD_BALANCE` default `1`
- `WRAITH_LIVE_MIN_PUSD_ALLOWANCE` default `1`
- `WRAITH_LIVE_MIN_POL_GAS` default `0.05`
- `WRAITH_POLYGON_RPC_URL` optional read-only Polygon RPC for POL gas proof

Positive POL gas thresholds intentionally block arming when no Polygon RPC is configured.

### Runtime contract

`execution.live.collateralReadiness` now exposes sanitized readiness evidence:

- status: `not-required | unknown | ready | blocked`
- checked timestamp and stale flag
- pUSD balance and required balance
- pUSD allowance and required allowance
- optional POL gas balance and required gas
- blocking reasons
- `safeToLog: true`

No private key, API secret, passphrase, or raw sensitive credential is exposed.

### Polymarket CLOB V2 read-only readiness

`PolymarketLiveClient` now wraps SDK read APIs:

- pUSD collateral readiness via `getBalanceAllowance({ asset_type: AssetType.COLLATERAL })`
- outcome-token readiness via `getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id })`
- optional POL gas balance through a read-only viem public client when `WRAITH_POLYGON_RPC_URL` is configured

It does **not** call `updateBalanceAllowance`, CollateralOnramp, wrapping, approval, order placement, cancellation, or API-key derivation as part of this readiness pass.

### Arming and flatten gates

Live arming now refreshes readiness immediately before arm and fails closed when:

- live arming is disabled
- live execution/gateway is absent
- startup reconciliation is missing, stale, or non-clean
- kill switch is active
- pUSD readiness is missing, stale, unsupported, errored, or below configured thresholds
- required POL gas proof is missing or below configured threshold

Live flatten now fails closed before submit when:

- live flatten path is unsupported/blocked
- active live projection state is ambiguous
- conditional-token balance/allowance readiness is absent or below the exact token/quantity required

### API/dashboard/operator visibility

- `/api/live/wallet` now includes sanitized collateral readiness and readiness thresholds.
- `/api/live/readiness` exposes sanitized wallet + live-control readiness with `safeToLog: true`.
- Dashboard live-control panel shows pUSD readiness and the first blocking reason.
- Live thin-slice runbook now documents pUSD/POL/conditional-token readiness gates and remaining no-go evidence.

## Verification evidence

Completed in this pass:

- `npm run check` ✅
- `npm run test:live-safety` ✅ — 22 tests passed
- `node --import tsx --test packages/live-execution/src/polymarket-client.test.ts` ✅ — 5 tests passed
- `node --import tsx --test packages/config/src/index.test.ts` ✅ — 4 tests passed
- `npm run verify:paper-safe` ✅ — 17 checks passed
- `npm run build` ✅ — TypeScript check + Vite web build passed
- `npm audit --omit=dev --audit-level=moderate` ❌ — unchanged known dependency advisories remain: 13 total, 12 low + 1 moderate, including `@fastify/static` and `elliptic` through `@ethersproject/*` / `@polymarket/clob-client-v2`.

## Remaining live-capital no-go conditions

Wraith should remain no-go for actual live capital until Ben explicitly approves and completes a supervised read-only trace proving:

1. intended wallet/funder has sufficient pUSD balance;
2. intended wallet/funder has sufficient pUSD allowance;
3. EOA signer has enough POL gas when applicable;
4. venue startup reconciliation is clean against the intended wallet;
5. unmatched venue orders/fills kill-switch and block new entries;
6. conditional-token readiness blocks/succeeds correctly for a real flatten candidate;
7. restart during open live state reattaches order/fill evidence correctly;
8. operator runbook evidence is captured before any live thin-slice order.

## Confidence score

**90/100**

### Factors increasing confidence

- Uses official CLOB V2 SDK read-only balance/allowance surface.
- Existing runtime already had startup reconciliation, kill-switch durability, reduce-only flatten scaffolding, and live-control status.
- New gates are fail-closed by default and covered by focused unit/runtime tests.
- Verification gates pass locally without real venue calls or fund movement.

### Factors reducing confidence

- No real wallet/venue read-only trace was run in this pass.
- SDK balance/allowance unit semantics are inferred from CLOB token decimals and mocked tests, not a live response sample.
- Flatten remains a guarded reduce-only submit path, not a complete multi-step live flatten state machine with cancellation and final venue-flat proof.
- `npm audit` advisories from the prior CLOB V2 pass remain outside this patch’s scope.
