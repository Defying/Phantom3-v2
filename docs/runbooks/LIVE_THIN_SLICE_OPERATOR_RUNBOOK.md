# Live thin-slice operator runbook

Status: planned / **no-go for live capital**
Updated: 2026-04-28

This file exists to prevent operator overconfidence.
The presence of live flags, endpoints, or adapter code does **not** mean Wraith is ready to trade real money.

## Hard-stop warnings

1. **Do not trade live capital from this repo today.**
2. **Do not infer readiness from config flags.**
   `WRAITH_ENABLE_LIVE_MODE`, `WRAITH_ENABLE_LIVE_ARMING`, and `WRAITH_LIVE_EXECUTION_ENABLED` are scaffolding gates, not a safety checklist.
3. **Do not infer readiness from control endpoints.**
   `/api/control/live/*`, `/api/control/flatten`, and `/api/control/kill-switch/*` exist, and the main API runtime has startup-reconcile scaffolding when a live gateway is installed. That is still not a completed live-readiness proof.
4. **Do not auto-resume after restart.**
   Restart recovery is a design requirement in `docs/architecture/MILESTONE_3_LIVE_TRADING_THIN_SLICE.md`, not an operator-safe runtime path yet.
5. **Do not treat `npm run verify:live-safety` as a live-readiness certificate.**
   It is a guardrail gate. It does not prove venue integration, restart safety, or production operator readiness.

## Wallet/auth status

Wraith now has a wallet/auth wiring path for Polymarket, but that only removes the “no signer exists” blocker. It does **not** make live capital safe.

Sanitized readiness is exposed at `/api/live/wallet`. It reports whether a private key, L2 API credentials, API-key derivation permission, signature type, funder address, and live gateway are configured. It never returns the private key, API secret, or passphrase.

Required env for a wallet-backed live gateway:

- `WRAITH_POLYMARKET_PRIVATE_KEY` — 0x-prefixed Polygon signer private key; keep this out of git/logs.
- `WRAITH_POLYMARKET_SIGNATURE_TYPE` — Polymarket signature type; non-EOA/proxy types require a funder.
- `WRAITH_POLYMARKET_FUNDER_ADDRESS` — required for signature types 1-3.
- Either all three existing L2 API credentials (`WRAITH_POLYMARKET_API_KEY`, `WRAITH_POLYMARKET_API_SECRET`, `WRAITH_POLYMARKET_API_PASSPHRASE`) or `WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION=true`.

CLOB V2 live trading also requires collateral readiness that `/api/live/wallet` does **not** currently prove:

- BUY orders require pUSD balance and pUSD allowance on the funder address, including fee headroom.
- SELL/flatten orders require outcome-token balance and allowance.
- EOA signature type `0` also needs POL for gas.
- A wallet can hold USDC.e and still be unable to buy if it has not been wrapped/credited as pUSD.
- Wraith does **not** auto-wrap USDC.e to pUSD, does not call the CollateralOnramp, and must not hide collateral migration inside this repo without explicit operator approval.

If wallet/auth initialization fails, the API process starts fail-closed: live arming stays scaffold/blocked and the blocking reason includes the wallet/auth setup error.

## Current concrete blockers

### 1) Boot reconcile must be proven on real venue state
`apps/api/src/index.ts` can now install a Polymarket wallet-backed gateway when live env is complete, and `runtime-store.ts` can run startup reconciliation from that gateway. This still needs a real traced dry/live review on the intended wallet before live capital: open orders, fills, positions, and kill-switch behavior must be proven from venue evidence, not just unit tests.

### 2) Unmatched venue evidence still needs caller-side incident handling
`packages/live-execution/src/index.ts` now surfaces both `unmatchedVenueOrderIds` and `unmatchedVenueFillIds` from reconciliation, but the runtime still has to turn those results into incidents / kill-switch latches. Reporting the mismatch is not the same as making the session safe.

### 3) Flatten is still only partially hardened
The live adapter now fails closed if a same-market working buy order is still open, because flattening while entry orders can still fill is unsafe. That is only a stopgap:
- it does **not** yet cancel working entry orders for you
- it does **not** yet run a full flatten state machine
- it does **not** yet prove flat inventory across restart before clearing the session

### 4) Kill-switch policy is not enforced end-to-end
The architecture doc requires fresh reconciliation, no orphaned venue state, and explicit operator action before clearing the kill switch. The current bootstrap runtime does not enforce that full release contract.

### 5) UI/API presence is not proof of live truth
Dashboard and API surfaces are useful observability/control scaffolding, but they are downstream summaries. They are not venue truth and must not be treated as proof that live positions are reconciled correctly.

## Minimum evidence before any live review/demo

Before anyone says “ready for live review,” require all of this:

- `npm run check`
- `npm run verify:live-safety`
- completed `docs/qa/LIVE_THIN_SLICE_REVIEW_CHECKLIST.md`
- one traced live entry from `intentId` -> `clientOrderId` -> `venueOrderId` -> fills -> final lots
- one partial-fill trace
- one flatten trace that ends flat from venue fill evidence
- one restart/reconcile trace during open live state
- one incident trace showing unmatched venue order/fill evidence blocks new entries
- one pUSD collateral-readiness trace proving the intended funder has pUSD balance/allowance and, for EOA signing, enough POL for gas

If any of those are missing, ambiguous, or only simulated in UI state, the answer is still **no-go**.

## Operator stance right now

If asked whether Wraith can safely trade live capital today, the correct answer is:

**no. keep it paper-only until the live thin slice proves restart-safe, evidence-first reconciliation end-to-end.**
