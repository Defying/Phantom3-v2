# Phantom3 v2 Architecture Draft

Status: draft
Date: 2026-04-20
Source baseline: `Phantom3` v1 audit + phase-0 hardening

## Executive call

Do **not** keep growing v1 as the real trading system.
Do **not** do a giant blind rewrite either.

Recommended path: build **Phantom3 v2** as a **controlled rebuild** using v1 as a frozen reference and test corpus.

## Primary recommendation

### Language

Use **TypeScript** for the live system.

Keep **Python optional** for research, notebooks, and backtests if needed.

### Architecture style

Use a **modular monolith first**, not microservices.

That means:
- one repo
- one typed backend runtime
- strict module boundaries
- one durable source of truth
- easy local development
- fewer moving parts while trust is still being rebuilt

This is the sweet spot between:
- messy single-file scripting, and
- premature distributed-systems nonsense

## Why v2 should not just extend v1

v1's core problems are structural, not cosmetic:

- dashboard/control plane and trading engine are mixed together
- simulation and live semantics were too easy to blur
- local assumptions stood in for exchange truth
- P&L and position state were not ledger-first
- control surfaces accepted secrets and owned too much behavior
- duplicated legacy/live paths drifted apart

That makes continued patching expensive and untrustworthy.

## Core design principles

1. **Ledger truth beats local assumptions**
   - no `sleep(5)` and assume filled
   - no local exit bookkeeping without reconciliation

2. **Fail closed by default**
   - live trading disabled unless explicitly enabled
   - dashboard cannot silently escalate to live mode

3. **Strategy emits intents, not orders**
   - strategy proposes
   - risk approves/rejects
   - execution submits

4. **Dashboard is not the source of truth**
   - UI reads state and sends bounded control actions
   - it does not own fills, positions, or secrets

5. **Replayability matters**
   - every signal, order, fill, and risk event should be reconstructable

6. **One canonical path for live and paper trading**
   - same strategy and risk modules
   - different execution adapters

## v2 scope

Phantom3 v2 should contain these major modules.

### 1) Config + capability gates

Owns:
- env loading
- runtime validation
- live trading enable flags
- allowed hosts/origins
- credential source policy

Rules:
- secrets come from env or secret store only
- no secrets via request body
- live mode requires explicit multi-flag confirmation

### 2) Market data adapter

Owns:
- Polymarket market discovery
- token/market normalization
- order book snapshots or best executable price
- websocket subscriptions where available
- REST fallback/reconciliation
- timestamps and freshness metadata

Output:
- normalized market events
- normalized book events
- market-state snapshots

### 3) Strategy engine

Owns:
- signal generation only
- no wallet knowledge
- no HTTP routes
- no direct order placement

Input:
- normalized market data
- oracle/reference data
- configuration

Output:
- `TradeIntent`

Example intent shape:
- market id
- token id
- side
- thesis metadata
- confidence score
- desired entry constraints
- desired exit policy

### 4) Risk engine

Owns:
- max position size
- per-market exposure caps
- total session exposure cap
- stale-data guard
- cooldowns and kill switches
- allowed market filters

Input:
- trade intent
- current positions
- recent losses
- config

Output:
- approve / reject / resize / block

### 5) Execution gateway

Owns:
- order placement
- cancel/replace
- fill polling / websocket reconciliation
- balance checks
- approval status checks
- exchange/client error normalization

Rules:
- this is the **only** module allowed to submit or cancel real orders
- it writes every exchange event into the ledger
- it never books local fills without exchange evidence

### 6) Ledger

This is the heart of v2.

Owns durable records for:
- sessions
- market snapshots worth preserving
- trade intents
- risk decisions
- orders
- fills
- position lots
- exit plans
- realized P&L
- unrealized mark snapshots
- operator actions
- incidents / kill-switch events

## Storage choice

Recommended: **Postgres** as the source of truth.

Reason:
- cleaner concurrency story than SQLite for a live multi-module app
- good transactional semantics
- better durability for ledger-like data
- easier future growth if workers split later

Avoid introducing Redis, Kafka, or other infra until there is a concrete need.

## 7) Control API

Owns:
- read-only market/session/position views
- bounded operator actions
- health endpoints
- configuration inspection

Allowed write actions:
- pause trading
- resume trading
- toggle paper/live only if already armed at process level
- flatten a position
- acknowledge incidents

Not allowed:
- raw secret injection
- arbitrary Python/JS execution
- direct ad hoc order calls outside execution policy

## 8) Dashboard

The dashboard should be a client of the control API.

Owns:
- visibility
- charts
- tables
- operator controls
- alerts

Does **not** own:
- strategy logic
- balance truth
- fill truth
- secret handling

## 9) Replay / paper-trading harness

Critical for rebuilding trust.

Owns:
- historical event playback
- paper fills under configurable execution assumptions
- strategy evaluation against recorded streams
- regression scenarios for known v1 failures

This lets us answer:
- what signal fired?
- what would risk have done?
- what order would execution have submitted?
- what actually happened in the book?

## Proposed repository shape

Recommended repo shape for v2:

```text
phantom3-v2/
  apps/
    api/
    web/
    worker/
  packages/
    config/
    contracts/
    market-data/
    strategy/
    risk/
    execution/
    ledger/
    replay/
    shared/
  infra/
    docker-compose.yml
  docs/
    architecture.md
    runbooks/
  scripts/
    approvals/
    maintenance/
```

### Notes

- `apps/worker` runs ingestion, strategy, risk, and execution loops
- `apps/api` exposes read/control endpoints and streams state to the UI
- `apps/web` is the dashboard
- `packages/contracts` holds shared TS types + runtime validation schemas

## Proposed domain contracts

These should be first-class typed objects.

### `MarketSnapshot`
- marketId
- tokenId
- question
- side
- bestBid
- bestAsk
- midpoint
- lastTrade
- sourceTimestamp
- observedAt
- sourceFreshnessMs

### `TradeIntent`
- intentId
- strategyVersion
- marketId
- tokenId
- side
- confidence
- thesis
- maxEntryPrice
- desiredSizeUsd
- stopPolicy
- targetPolicy
- createdAt

### `RiskDecision`
- intentId
- decision: approve/reject/resize
- approvedSizeUsd
- reasons[]
- createdAt

### `OrderRecord`
- orderId
- venueOrderId
- intentId
- marketId
- tokenId
- side
- limitPrice
- requestedSize
- status
- submittedAt
- acknowledgedAt
- canceledAt

### `FillRecord`
- fillId
- orderId
- price
- size
- fee
- liquidityRole
- exchangeTimestamp
- observedAt

### `PositionLot`
- lotId
- marketId
- tokenId
- side
- openedFromFillIds[]
- remainingSize
- averageEntryPrice
- realizedPnl
- unrealizedMark
- status

## State machine

The live path should look like this:

1. market data event arrives
2. strategy emits `TradeIntent`
3. risk approves/rejects/resizes
4. execution submits order
5. exchange acknowledges order
6. fills reconcile into ledger
7. position lots open from fills
8. monitor loop proposes exit intent
9. risk checks exit path
10. execution submits/cancels/replaces exit order
11. final fills close lots
12. realized P&L is computed from ledger fills only

Any missing exchange evidence should leave the position in a **pending/reconcile** state, not magically closed.

## What not to port from v1

Do **not** carry these patterns forward:

- request-body `private_key` handling
- dashboard-owned startup semantics
- duplicated live and legacy dashboards
- expected profit treated like realized profit
- `sleep()`-then-assume-filled behavior
- local stop-loss claims without reconciled exit fills
- public dashboard binding by default
- hardcoded approval scripts
- scraping-critical-path behavior when a proper API/feed exists

## Sim vs live model

v2 should have one strategy path and one risk path.

Only execution changes:
- `PaperExecutionAdapter`
- `LiveExecutionAdapter`

That keeps paper mode honest and makes live behavior comparable.

## Initial implementation choice

Do **not** start with a full microservice fleet.

Start with:
- one Postgres instance
- one worker runtime
- one API server
- one web UI

This gives clean ownership without exploding ops complexity.

## Suggested milestone plan

### Milestone 0 — Contracts + skeleton
- set up TS repo
- define schemas/types
- wire config validation
- wire Postgres schema
- add health checks

### Milestone 1 — Read-only observer
- ingest market data
- normalize it
- store snapshots/events
- build dashboard read views
- **no trading yet**

Success condition:
- we can watch markets reliably without placing orders

### Milestone 2 — Paper trading with ledger truth
- run strategy over live data
- emit intents
- run risk
- store paper orders/fills in ledger
- compare outcomes against replay

Success condition:
- the system can explain every paper trade end-to-end

### Milestone 3 — Live execution thin slice
- smallest allowed live trade size
- real order submit/ack/fill reconciliation
- no fancy strategy changes yet
- operator flatten + kill switch required

Success condition:
- one live trade can be traced perfectly from intent to fill to final position state

### Milestone 4 — Risk hardening
- exposure caps
- stale-data guard
- session kill switch
- approval/credential health checks
- circuit breakers

### Milestone 5 — Strategy iteration
Only here should we start trying to improve edge.

That includes:
- better market filtering
- better executable-price modeling
- better timing logic
- better fee/slippage assumptions
- oracle/reference refinements

## Open questions

1. Which official Polymarket websocket/data surfaces are stable enough for primary use?
2. Should signing stay local env-based, or move to a more isolated signer model?
3. Should the v2 repo live separately from this repo, or under `/v2` during migration?
4. Do we want Postgres immediately, or a short-lived SQLite prototype for Milestone 0 only?
5. What is the minimum operator workflow needed on day one, versus nice-to-have dashboard polish?

## Recommendation on repo strategy

Preferred:
- keep this repo as `Phantom3` v1 baseline and audit artifact
- create a **new repo** for v2

Why:
- cleaner history
- clearer migration boundary
- less temptation to keep dragging old assumptions along

If we keep it in this repo, use a hard boundary like `v2/` and do not blend files.

## Final recommendation

If we continue, build **Phantom3 v2 as a TypeScript modular monolith with Postgres-backed ledger truth**.

Use v1 only as:
- reference logic
- audit evidence
- regression scenario source
- UI inspiration where useful

Do **not** use v1 as the execution/state foundation for real-money trading.
