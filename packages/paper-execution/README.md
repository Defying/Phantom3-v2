# Paper execution package

Conservative paper execution adapter for Wraith.

## What landed

- accepts approved intents and writes them into the ledger
- emits order, fill, and position events without touching any live venue
- rejects overselling against currently open inventory after existing sell-order reservations
- uses top-of-book quote checks only
- fills at the conservative crossing price:
  - buy at `bestAsk`
  - sell at `bestBid`
- supports partial fills and later quote-driven reconciliation of open paper orders
- keeps positions ledger-first: working orders alone never open, close, or flatten lots
- computes realized P&L from recorded fill prices plus fees, not requested prices or midpoint estimates
- ships a regression harness for the old v1 failure modes via `npm run verify:live-safety`

## Primary exports

- `PaperExecutionAdapter`
- re-exported `JsonlLedger`
- shared ledger types for intents, quotes, orders, fills, and positions

## Usage shape

1. create a `JsonlLedger`
2. create a `PaperExecutionAdapter`
3. call `submitApprovedIntent({ intent, quote? })`
4. later call `reconcileQuote(quote)` to work open paper orders

This keeps paper mode ledger-first and comparable to a future live adapter.
