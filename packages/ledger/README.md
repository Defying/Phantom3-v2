# Ledger package

Durable append-only paper ledger for Phantom3 v2.

## What landed

- JSONL-backed append-only event store with fsync-on-append by default
- typed ledger envelopes for:
  - approved intents
  - order state transitions
  - fills
  - derived position updates
- replay/projection helpers that rebuild:
  - intents
  - orders
  - fills
  - FIFO position lots
  - realized P&L
- no exchange writes, no mutable in-place state files

## Primary exports

- `JsonlLedger`
- `projectLedgerState()`
- `applyFillToPosition()`
- `getOpenOrders()`
- typed schemas and event unions from `src/index.ts`

## Notes

- the ledger is intentionally single-writer and simple for milestone 2 foundations
- positions are derived from fills first, not trusted from UI state
- `position.updated` events are convenience outputs; fill replay remains the source of truth
