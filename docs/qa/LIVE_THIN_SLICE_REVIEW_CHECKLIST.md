# Live execution thin-slice review checklist

Use this before merging, demoing, or operating any live-execution thin slice.

Commit / PR: `__________________`
Reviewer: `__________________`
Operator: `__________________`
Date: `__________________`

## 1) Non-negotiable truth invariants

- [ ] Every entry, exit, flatten, stop, and recovery action is backed by durable order/fill evidence. No timer, UI action, or local state update may mark a position closed by itself. _(guards fake exits)_
- [ ] Realized P&L is computed from recorded fill prices and fees only. Never from requested limit price, target/stop price, midpoint, or UI-estimated exit. _(guards synthetic exit prices, P&L from requested prices)_
- [ ] Open or unmatched orders stay visible as working orders and do not delete, hide, or silently resize positions. _(guards dropping positions on unmatched orders)_
- [ ] Working sell/flatten orders reserve inventory before any new sell sizing is allowed. New exits use reconciled available size, not cached shares. _(guards stale share assumptions)_
- [ ] Execution uses executable venue prices only. Midpoint may inform analytics, but it must never be treated as a fill price or realized exit price. _(guards midpoint-used-as-fill)_
- [ ] Cold start rebuilds orders, fills, lots, and realized P&L from durable ledger + venue truth before new live actions are allowed. _(guards restart orphaning)_

## 2) Required automated gates

- [ ] `npm run check`
- [ ] `npm run verify:live-safety`
- [ ] Any new live adapter tests cover ack -> partial fill -> final fill/cancel, not just a one-shot happy path

## 3) Mandatory adversarial traces

- [ ] **Unmatched exit:** submit an exit that does not cross; verify the position stays open and the order remains explicitly working
- [ ] **Partial exit:** partially fill an exit; verify remaining order quantity, remaining position quantity, and realized P&L all match ledger truth
- [ ] **Price-source trace:** compare requested price, displayed midpoint, and actual fill price; verify realized P&L uses actual fill only
- [ ] **Restart trace:** restart between order ack and final fill/cancel; verify open orders and lots are reconstructed before new actions are allowed
- [ ] **Flatten / kill-switch trace:** operator flatten or pause must submit/reconcile a real venue action or leave the position pending; it must not synthesize a close locally

## 4) Review red flags — immediate no-go

- [ ] No code path sets realized P&L or closed quantity from request data, target prices, or midpoint values
- [ ] No code path marks a position closed without a corresponding reconciled fill trail
- [ ] No restart path lets cached UI/runtime state override ledger or venue truth
- [ ] No oversell path exists when one or more exit orders are still open
- [ ] No "estimated fill" or midpoint fallback leaks from analytics/risk code into execution or realized P&L

## 5) Sign-off

- [ ] One reviewer traced a full entry -> working order -> fill -> position update -> exit -> final position flow
- [ ] One reviewer traced a restart/reconcile scenario and found no orphaned orders or ghost closes
- [ ] Known limitations are written down before any live-capital discussion
- [ ] If any item above failed or was untestable, the result is **no-go for live capital**

Notes:

```text

```
