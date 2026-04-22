# Live thin-slice hostile review — 2026-04-21

Reviewed commit: `0a649f8`
Reviewer stance: hostile safety review for live-capital misuse, restart ambiguity, and fake-close regressions.

## What I changed

- **Fail closed on unmatched venue activity.** `packages/live-execution/src/index.ts` now:
  - reconciles tracked orders even when they were locally marked terminal but the venue still reports activity
  - surfaces `unmatchedVenueFillIds`
  - automatically **engages the live kill switch** when venue orders or fills appear with no tracked match instead of silently ignoring them
- **Removed stronger-than-real live-control signals** in the runtime bootstrap:
  - `flattenSupported` is now `false` while no live adapter is wired
  - `/api/control/live/arm` now rejects until a real live adapter **and** startup reconciliation path exist
  - `/api/access` now states that `/api/control/flatten` is paper-only in this bootstrap and `/api/control/live/*` is scaffold-only
- **Expanded `npm run verify:live-safety`** to include live-adapter regression coverage, not just paper-execution checks.

## Remaining blockers — still **no-go for real money**

1. **No live adapter is wired into the runtime/store/API path.** The package scaffold exists, but the running app is still paper-authoritative.
2. **No startup venue reconciliation is wired into app boot.** Real live restart recovery is still unproven from the actual runtime entrypoint.
3. **No proven cancel/partial-fill/restart flow through the operator API.** The package-level adapter has guardrails, but the app-level control plane does not yet drive them.
4. **No live flatten controller or incident workflow is wired.** Paper flatten exists; live reduce-only flatten does not.
5. **No real-money evidence bundle exists yet.** There is still no traced end-to-end proof for live entry -> ack -> partial fill -> cancel/reconcile -> exit -> restart recovery.

## Required proofs before real capital

- one traced live order from `intentId` -> `clientOrderId` -> `venueOrderId` -> `venueFillId`
- one late-fill-after-cancel trace showing no fake close and correct remaining quantity
- one restart during an open live order with clean recovery before re-arming
- one unmatched venue event automatically tripping the kill switch and blocking new entries until manual reconciliation
- one operator flatten run ending flat from venue fill evidence only
- UI/API proof that realized P&L never uses requested price, midpoint, or target price

## Bottom line

This branch is safer than before, but it is still a **paper bootstrap with live scaffolding**, not a live-trading system.
