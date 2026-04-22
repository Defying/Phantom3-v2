# Live thin-slice operator runbook

Status: planned / **no-go for live capital**
Updated: 2026-04-22

This file exists to prevent operator overconfidence.
The presence of live flags, endpoints, or adapter code does **not** mean Phantom3 v2 is ready to trade real money.

## Hard-stop warnings

1. **Do not trade live capital from this repo today.**
2. **Do not infer readiness from config flags.**
   `PHANTOM3_V2_ENABLE_LIVE_MODE`, `PHANTOM3_V2_ENABLE_LIVE_ARMING`, and `PHANTOM3_V2_LIVE_EXECUTION_ENABLED` are scaffolding gates, not a safety checklist.
3. **Do not infer readiness from control endpoints.**
   `/api/control/live/*`, `/api/control/flatten`, and `/api/control/kill-switch/*` exist, but the main API runtime still does not run a venue-backed boot reconciliation flow.
4. **Do not auto-resume after restart.**
   Restart recovery is a design requirement in `docs/architecture/MILESTONE_3_LIVE_TRADING_THIN_SLICE.md`, not an operator-safe runtime path yet.
5. **Do not treat `npm run verify:live-safety` as a live-readiness certificate.**
   It is a guardrail gate. It does not prove venue integration, restart safety, or production operator readiness.

## Current concrete blockers

### 1) Boot reconcile is not wired end-to-end
`apps/api/src/runtime-store.ts` still boots the app as a paper-authoritative runtime. It does not fetch venue orders, venue fills, or venue balances/positions before allowing live control actions.

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

If any of those are missing, ambiguous, or only simulated in UI state, the answer is still **no-go**.

## Operator stance right now

If asked whether Phantom3 v2 can safely trade live capital today, the correct answer is:

**no. keep it paper-only until the live thin slice proves restart-safe, evidence-first reconciliation end-to-end.**
