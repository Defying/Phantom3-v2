# Milestone 3 Live-Trading Thin Slice

Status: planned, not implemented
Date: 2026-04-21

This spec defines the **smallest safe live-trading slice** for Phantom3 v2.
It is intentionally narrow so we do not recreate the old v1 failure modes:

- false exits
- fake realized P&L
- orphaned positions after restart, timeout, or partial fill

## 1) Non-negotiable goals

1. **Ledger/fill truth first**
   - local memory, timers, and UI badges are never position truth
   - exchange evidence is recorded first, then projected into state

2. **No local close without exchange evidence**
   - an exit intent, submit call, cancel call, or timeout does not close a position
   - only reconciled exchange fills can reduce quantity or realize P&L

3. **Fail closed on ambiguity**
   - stale market data, stale exchange state, missing ack, or mismatched fills must block new entries
   - ambiguous state moves the session into `reconcile_required`, not “probably fine”

4. **Operator flatten + kill switch are mandatory**
   - the operator must be able to stop new risk immediately
   - the operator must be able to flatten using a reduce-only path

## 2) Thin-slice scope

Milestone 3 should ship with these hard limits:

- **paper remains the default**; live stays disarmed unless explicitly armed
- **one exchange account**
- **one live writer** process for order/cancel/fill ledger writes
- **one open live market at a time**
- **one working entry order globally at a time**
- **limit orders only** for the first slice
- **no pyramiding / scale-in**
- **no local stop-loss or take-profit bookkeeping** without venue evidence
- **no unattended live resume after restart** until reconciliation passes cleanly
- **no changes to notifier scripts**; this milestone is execution-state safety, not notification scope

## 3) Truth model

Truth hierarchy for live mode:

1. **exchange order/fill/position evidence**
2. **append-only ledger events** written from that evidence
3. **projected order + lot state** rebuilt from the ledger
4. **API/UI summaries** derived from the projection

Corollaries:

- realized P&L comes from `fill.recorded` replay only
- mark-to-market P&L is display-only and must stay separate from realized P&L
- `position.updated` is a convenience event; replayed fills remain the source of truth
- local clocks may trigger a reconcile, cancel, or incident, but never a synthetic close

## 4) Required identifiers

Every live order/fill path needs these IDs:

- `intentId` — strategy/risk-approved action
- `clientOrderId` — deterministic ID persisted **before** submit
- `venueOrderId` — exchange ACK identifier when available
- `venueFillId` — exchange fill identifier for idempotent reconciliation
- `positionId` — `marketId:tokenId`
- `flattenRequestId` / `incidentId` — operator-control audit trail

`clientOrderId` is mandatory. It is the join key that lets recovery reconcile fills even if the initial ACK is delayed or missed.

## 5) Order state machine

Recommended live order states for `packages/ledger/src/schemas.ts`:

- `submit_requested`
- `open` (ACKed / working at venue)
- `partially_filled`
- `filled`
- `cancel_requested`
- `canceled`
- `rejected`
- `reconcile_required`

### Order transitions

```text
submit_requested
  -> open                (exchange ACK with venueOrderId)
  -> rejected            (explicit venue rejection)
  -> reconcile_required  (submit result unknown / timeout / duplicate ambiguity)

open
  -> partially_filled    (first exchange fill, remaining > 0)
  -> filled              (exchange cumulative fill == requested)
  -> cancel_requested    (operator/system requests cancel)
  -> reconcile_required  (venue snapshot disagrees or goes stale)

partially_filled
  -> filled              (remaining becomes 0 from exchange fills)
  -> cancel_requested    (cancel remaining quantity)
  -> reconcile_required  (filled qty/order status disagree)

cancel_requested
  -> canceled            (venue confirms cancel of remaining qty)
  -> partially_filled    (late fill arrives before cancel wins)
  -> filled              (remaining gets fully filled)
  -> reconcile_required  (cancel result unknown)
```

### Order invariants

- A live order is not "working" until exchange ACK or an exchange snapshot proves it exists.
- A missing ACK is **not** proof of failure.
- A cancel request is **not** proof of cancel.
- Fills may arrive after `cancel_requested`; those fills still count.
- `filledQuantity` must equal the sum of recorded venue fills for that order.
- `filled` and `canceled` are terminal only when venue evidence supports them.
- Any order with inconsistent venue status or duplicate/unmatched fills moves to `reconcile_required` and blocks new entries.

## 6) Position + exit state machine

Recommended derived live position states:

- `flat`
- `entry_pending`
- `open`
- `pending_exit`
- `closing_partial`
- `closed`
- `reconcile_required`

### Position transitions

```text
flat
  -> entry_pending       (entry order submitted/ACKed, no fill yet)
  -> open                (first buy fill recorded)

entry_pending
  -> open                (first buy fill recorded)
  -> flat                (entry order canceled/rejected with zero fills)
  -> reconcile_required  (submit/ACK ambiguity)

open
  -> pending_exit        (approved reduce-only exit or flatten order submitted)
  -> closing_partial     (first sell fill recorded, net qty > 0)
  -> closed              (sell fills reduce net qty to 0)
  -> reconcile_required  (venue position/order evidence conflicts)

pending_exit
  -> closing_partial     (partial sell fill recorded)
  -> closed              (net qty becomes 0 from exchange fills)
  -> open                (exit order canceled, position still open)
  -> reconcile_required  (unknown remaining qty / stale venue state)

closing_partial
  -> pending_exit        (remaining qty still protected by working reduce-only order)
  -> closed              (net qty becomes 0)
  -> reconcile_required  (ledger lots and venue fills diverge)
```

### Position invariants

- `netQuantity` changes only from exchange fills.
- `closed` requires fill replay to produce `netQuantity == 0`; a submitted exit alone is never enough.
- Realized P&L changes only when a sell fill closes existing lots.
- A partial exit is still an open position.
- A position with working reduce-only exit quantity > 0 is `pending_exit`, not `closed`.
- If ledger replay says flat but the next venue position snapshot shows residual inventory, the session must trip to `reconcile_required` and kill-switch new entries.

## 7) Flatten state machine

Flatten is an operator action, not a local shortcut.

```text
idle
  -> requested
  -> canceling_entries
  -> reduce_only_working
  -> completed
  -> reconcile_required
```

### Flatten rules

1. Persist `operator.flatten_requested` first.
2. Trip the session into reduce-only mode immediately.
3. Cancel any working **entry** orders.
4. Fetch fresh venue position + open-order state.
5. Submit a **reduce-only** exit for the exchange-confirmed remaining quantity.
6. Reconcile until venue fills reduce net quantity to zero.
7. If quantity becomes unclear at any point, move to `reconcile_required` and keep new entries blocked.

### Flatten invariants

- Flatten never opens new exposure.
- Flatten completion requires exchange fill evidence reducing position quantity to zero.
- Flatten remains latched across restart until recovery reconciliation confirms flat inventory and no open entry orders.

## 8) Kill-switch state machine

Recommended kill-switch states:

- `inactive`
- `tripped`
- `flattening`
- `latched`

### Kill-switch transitions

```text
inactive
  -> tripped       (operator action or automatic safety trigger)

tripped
  -> flattening    (open position exists and flatten is in progress)
  -> latched       (no open exposure, no working entry orders)

flattening
  -> latched       (venue confirms flat)
  -> tripped       (flatten canceled but session remains blocked)
```

### Kill-switch invariants

- `tripped` blocks all new entry intents immediately.
- `tripped` persists across restart.
- While `tripped`, only these writes are allowed:
  - cancel working entry orders
  - submit/cancel/replace reduce-only exit orders
  - record reconciliation evidence
  - acknowledge / resolve incidents
- Clearing the kill switch requires:
  - a fresh reconciliation pass
  - no unresolved incidents
  - no orphaned venue orders or positions
  - explicit operator action

### Automatic trip conditions

The system should trip automatically on any of these:

- missing or ambiguous submit result
- unmatched venue fill
- order/fill quantity mismatch
- stale venue reconciliation cursor
- restart with unreconciled open live state
- projected flat state while venue still reports inventory
- duplicate `clientOrderId` / `venueFillId`

## 9) Startup + recovery contract

Live mode must not start trading directly from persisted local state.

On every live boot:

1. load ledger projection
2. fetch venue open orders
3. fetch venue fills since the last cursor / timestamp
4. fetch venue balances or positions for the traded account
5. append reconciliation evidence to the ledger
6. rebuild projection
7. if any mismatch remains, start in `kill_switch=latched` + `reconcile_required`
8. only then allow a live session to arm

If reconciliation cannot prove a clean state, the system stays fail-closed.

## 10) Exact implementation touchpoints

### Existing files to change

| Path | Why it changes |
| --- | --- |
| `packages/config/src/index.ts` | Add explicit live-arming env gates, exchange credential validation, and a hard default of disarmed live mode. |
| `packages/contracts/src/index.ts` | Add live session status, kill-switch status, incident summaries, live order summaries, live position summaries, and operator-control response shapes. |
| `packages/ledger/src/schemas.ts` | Extend schemas for live order statuses, `clientOrderId`, `venueOrderId`, `venueFillId`, exchange timestamps, operator actions, incidents, and reconciliation snapshots. |
| `packages/ledger/src/projection.ts` | Project live order lifecycle, pending-exit state, flatten state, kill-switch latch, and reconciliation anomalies from ledger events. |
| `packages/ledger/src/index.ts` | Re-export live ledger types and helpers. |
| `packages/risk/src/index.ts` | Add live-trading gates: reconciliation freshness, single-position cap for thin slice, reduce-only enforcement while flattening or kill-switched. |
| `apps/api/src/runtime-store.ts` | Split paper-only runtime flow into mode-aware orchestration; wire live boot reconciliation, entry gating, exit gating, flatten, and incident latching. |
| `apps/api/src/index.ts` | Add token-gated live control endpoints for arm/disarm, kill switch, flatten, and incident acknowledgment. |
| `apps/api/src/strategy-runtime.ts` | Keep realized vs unrealized P&L separate in API summaries and expose explicit pending-exit / reconcile-required states. |
| `apps/web/src/App.tsx` | Show live-session state, kill-switch banner, open incidents, flatten action, and pending-exit/reconcile-required badges. |
| `apps/web/src/styles.css` | Minimal UI support for kill-switch, incident, and live-state badges. |

### New files to add

| Path | Purpose |
| --- | --- |
| `packages/live-execution/src/index.ts` | Package entrypoint for the live execution adapter. |
| `packages/live-execution/src/live-execution-adapter.ts` | Single writer for submit/cancel/replace using persisted `clientOrderId` discipline. |
| `packages/live-execution/src/reconciliation-loop.ts` | Poll / stream venue orders and fills, append evidence, and trip incidents on mismatch. |
| `packages/live-execution/src/flatten-controller.ts` | Implement the reduce-only flatten workflow. |
| `packages/live-execution/src/kill-switch.ts` | Durable kill-switch policy and automatic trip logic. |
| `packages/live-execution/src/polymarket-client.ts` | Narrow exchange client wrapper used only by the live adapter. |
| `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md` | Operator checklist for arming, flattening, kill-switch use, and restart recovery. |
| `docs/qa/LIVE_THIN_SLICE_CHECKLIST.md` | Evidence-driven go/no-go checklist for the first live slice. |

## 11) Minimal Milestone 3 evidence

Milestone 3 should not be called done without all of this evidence:

- one live entry order traced from `intentId` -> `clientOrderId` -> `venueOrderId` -> fills -> final lots
- one partial-fill scenario with correct remaining quantity and no fake close
- one canceled-exit scenario that returns to `open`, not `closed`
- one operator flatten scenario ending flat from exchange fill evidence
- one forced restart during an open live order, followed by successful recovery reconciliation
- one automatic kill-switch trip caused by ambiguous state
- UI/API proof that realized and unrealized P&L stay separate

## 12) Recommendation

For the first live slice, optimize for **boring correctness**, not trading flexibility.

That means:

- one open market at a time
- one live writer
- one deterministic client-order path
- one append-only ledger truth
- one reduce-only flatten path
- one kill switch that latches hard on ambiguity

If any of those feel too restrictive, that is a sign the thin slice is trying to do too much too early.
