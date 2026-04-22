# Polymarket live adapter integration surfaces

Status: implementation note for the live-adapter merge worker
Date: 2026-04-21

This note maps the **actual repo touchpoints** a real Polymarket adapter must satisfy.
It is narrower than the milestone spec: the goal here is to reduce merge risk by showing where the current code already defines contracts, where the adapter should plug in, and which gaps are still explicit.

## 1) Current baseline

Today the repo already has:

- scoped Polymarket outbound transport for **read-only** venue traffic
- read-only Polymarket market discovery + midpoint hydration
- append-only ledger schemas and projection helpers
- a generic `LiveExecutionAdapter` with strict ledger-first reconciliation rules
- runtime/API control surfaces for arm, disarm, kill switch, and flatten

Today the repo does **not** yet have:

- a real Polymarket authenticated client
- live credential/config validation
- a live reconciliation loop wired into `RuntimeStore`
- a live boot/recovery handshake that proves clean venue state before arming

## 2) Highest-level integration rule

The safest merge shape is:

1. keep **`packages/live-execution/src/index.ts`** as the single ledger-writing live execution core
2. implement Polymarket as a **thin venue adapter** around that core
3. keep `apps/api/src/runtime-store.ts` as an orchestrator, not a second execution engine

In other words:

- **do not** add direct venue -> ledger writes in `RuntimeStore`
- **do not** let UI/control routes synthesize fills or closed positions
- **do** adapt Polymarket responses into `LiveSubmitResult`, `LiveVenueOrderSnapshot`, and `LiveVenueFill`
- **do** let `LiveExecutionAdapter` continue to own order/fill/position ledger events

## 3) Existing transport + market-data surfaces

### 3.1 Scoped venue transport

Primary files:

- `packages/transport/src/index.ts`
- `packages/config/src/index.ts`
- `packages/market-data/src/index.ts`

Relevant exports already in use:

- `parseSocksProxyUrl()`
- `OutboundTransport`
- `OutboundTransport.getJson()`
- `OutboundTransport.webSocketOptions()`
- `describePolymarketTransport()`
- `describePolymarketAccess()`

What this means for a live adapter:

- if Polymarket REST or WS traffic needs proxy routing, reuse the existing `OutboundTransport`
- keep proxy scope **venue-only**; do not leak it into dashboard/control traffic
- if a Polymarket WS client is added, feed it `transport.webSocketOptions()` so SOCKS behavior stays consistent with current read-only flows
- preserve the current operator-facing transport summary language (`direct` vs `proxy`, `polymarket-only` scope)

### 3.2 Current market snapshot contract

Primary files:

- `packages/market-data/src/index.ts`
- `packages/market-data/src/discovery.ts`
- `packages/contracts/src/index.ts`

Existing read-side contracts already expected by the runtime:

- `RuntimeMarket`
- `MarketSnapshot`
- `CryptoWindowMarketSnapshot`
- `fetchTopMarkets()` / `fetchCryptoWindowMarkets()`

What the live adapter should assume:

- market discovery is already normalized around `marketId`, `yesTokenId`, `noTokenId`, `yesPrice`, `noPrice`, `spread`, `liquidity`, `endDate`
- entry/exit orchestration in the runtime already depends on those normalized IDs
- a real live adapter does **not** need to redesign market discovery first; it should consume the same `marketId` / `tokenId` identity model

What is still missing for live trading:

- executable order-book snapshots beyond midpoint reads
- venue order/fill stream ingestion wired into the runtime
- a durable cursor/checkpoint for live reconciliation

## 4) Config + auth surfaces

### 4.1 What exists today

Primary file:

- `packages/config/src/index.ts`

Current live-related config already parsed:

- `PHANTOM3_V2_ENABLE_LIVE_MODE`
- `PHANTOM3_V2_ENABLE_LIVE_ARMING`
- `PHANTOM3_V2_LIVE_EXECUTION_ENABLED`
- `PHANTOM3_V2_LIVE_EXECUTION_VENUE`
- `PHANTOM3_V2_LIVE_MAX_QUOTE_AGE_MS`
- `PHANTOM3_V2_LIVE_MAX_RECONCILE_AGE_MS`
- `PHANTOM3_V2_LIVE_MISSING_ORDER_GRACE_MS`
- `PHANTOM3_V2_POLYMARKET_PROXY_URL`
- `PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY`

What is notably **not** present yet:

- Polymarket live credentials
- authenticated client/base-url settings for live order APIs
- signer/funder identity config
- credential preflight / readiness validation

### 4.2 Adapter requirement

A real adapter needs one typed Polymarket auth/config bundle added under `packages/config/src/index.ts`.
That bundle should be resolved **once** at process boot and then injected, not fetched ad hoc from request handlers.

Minimum requirement:

- all secrets come from env or secret store only
- missing/invalid live credentials must leave `liveAdapterReady=false`
- arming must stay fail-closed if credential/config preflight is incomplete
- venue config should stay separate from the existing control token

Practical merge note:

- prefer adding one nested config object for Polymarket live auth instead of scattering new env reads across runtime files
- avoid naming/env churn in multiple packages; `RuntimeStore` should consume parsed config, not raw env vars

## 5) Contracts and schemas the adapter must satisfy

### 5.1 Existing live execution contracts

Primary file:

- `packages/live-execution/src/index.ts`

This package already defines the key venue-facing adapter boundary:

- `LiveExchangeGateway`
- `LiveSubmitOrderRequest`
- `LiveSubmitResult`
- `LiveVenueOrderSnapshot`
- `LiveVenueFill`
- `LiveVenueStateSnapshot`
- `LiveExecutionAdapter`

This is the most important concrete integration point in the repo.

### 5.2 What a Polymarket client should do

The Polymarket-specific layer should primarily translate venue payloads into these existing generic shapes:

- submit order -> `LiveSubmitResult`
- venue open-order state -> `LiveVenueOrderSnapshot[]`
- venue fill state -> `LiveVenueFill[]`
- periodic reconciliation payload -> `LiveVenueStateSnapshot`

That keeps:

- order lifecycle rules
- duplicate fill detection
- fill-to-lot projection
- reconcile-on-ambiguity behavior

inside the existing generic live execution package instead of duplicating them.

### 5.3 Ledger/event expectations already encoded

Primary files:

- `packages/ledger/src/schemas.ts`
- `packages/ledger/src/projection.ts`
- `packages/live-execution/src/index.ts`

The current live path already assumes:

- an intent is written first (`intent.approved`)
- a tracked order is persisted **before** the exchange result is trusted (`pending-submit`)
- exchange ACKs update the tracked order via `order.updated`
- realized P&L changes only from `fill.recorded`
- `position.updated` is derived convenience output, not truth
- duplicate or inconsistent venue evidence moves the order to `reconcile`

Concrete venue evidence requirements:

- stable `venueOrderId` when available
- stable `venueFillId` for idempotent fill replay
- exchange timestamps when available
- filled quantity that can be proven by explicit fill evidence

Important consequence:

A Polymarket adapter should not “helpfully” infer fills from midpoint changes, requested prices, or UI state. The existing live adapter is already designed to reject that.

## 6) Runtime-store and execution-runtime integration points

### 6.1 Runtime store

Primary file:

- `apps/api/src/runtime-store.ts`

Current live-facing surfaces already exist:

- `armLive()`
- `disarmLive()`
- `engageKillSwitch()`
- `releaseKillSwitch()`
- `flattenOpenPositions()`
- `state.execution.live.*`

Current limitations to account for:

- `liveAdapterReady` is hardcoded false in practice
- flatten currently uses the **paper** execution path
- market refresh currently reconciles **paper** open orders only
- boot/init does not yet perform venue recovery reconciliation
- operator arm/disarm only toggles runtime state; it does not wire a real adapter lifecycle

Adapter wiring required here:

1. instantiate the Polymarket client + `LiveExecutionAdapter` during store init
2. set `liveAdapterReady` from real config/client readiness
3. on live boot, run a venue reconciliation pass before allowing arming
4. route live flatten / live kill-switch actions through the live adapter, not paper execution
5. keep paper mode behavior unchanged when live is disabled or unready

### 6.2 Execution summary surface

Primary file:

- `apps/api/src/execution-runtime.ts`

This file derives operator-facing trade state from the ledger projection:

- `pending`
- `reconcile`
- `open`
- `closed`
- `error`

A real adapter must preserve those semantics.

That means:

- do not invent a parallel live-only trade summary model
- make the ledger projection rich enough that existing summary logic stays correct
- if new live states/incidents are added, surface them through contracts/UI without bypassing ledger-derived trade status

## 7) Ledger invariants the Polymarket adapter must respect

These are already encoded in `packages/live-execution/src/index.ts` and `packages/ledger/src/projection.ts`:

- `clientOrderId` must exist before submit and remain the local join key
- `filledQuantity` must never exceed requested quantity
- terminal `filled` requires full explicit fill evidence
- a submitted or canceled order is **not** a closed trade by itself
- sell quantity must respect reserved inventory from other active sell orders
- missing orders after the grace window move to `reconcile`
- duplicate fills or mismatched market/token/side data move to `reconcile`
- stale venue snapshots are skipped or treated as ambiguous, not trusted

For merge safety, any Polymarket adapter should treat these as non-negotiable repo contracts, not optional implementation details.

## 8) Gaps that remain explicit

These are the main unfinished seams a real adapter still has to close:

1. **Polymarket auth/config schema**
   - not yet present in `packages/config`

2. **Polymarket authenticated client**
   - no `packages/live-execution/src/polymarket-client.ts` yet

3. **Reconciliation loop / snapshot producer**
   - no runtime task currently converts venue REST/WS state into `LiveVenueStateSnapshot`

4. **Boot recovery contract**
   - `RuntimeStore.init()` restores ledger truth, but not venue truth

5. **Live flatten path**
   - control API exists, but current implementation is paper-only

6. **Incident/readiness exposure**
   - contracts/UI do not yet expose unmatched venue orders, reconciliation incidents, or live recovery blockers in a first-class way

7. **Cancel/replace boundary**
   - the current generic live gateway contract is submit-focused; if Polymarket cancel/replace is added, extend the generic boundary instead of hiding that logic inside runtime code

## 9) Recommended merge order

To keep overlap low, this is the cleanest sequence:

1. add typed Polymarket live config/auth parsing + readiness reporting
2. add a narrow Polymarket client that reuses existing transport/proxy policy
3. adapt submit responses into `LiveSubmitResult`
4. add venue snapshot translation into `LiveVenueStateSnapshot`
5. wire boot reconciliation + live readiness into `RuntimeStore`
6. switch live flatten/kill-switch flows onto the live adapter
7. add tests for ack ambiguity, partial fills, restart recovery, unmatched venue state

## 10) Bottom line

The repo already has the important safety core.

The real Polymarket adapter should be a **translation and orchestration layer** on top of these existing contracts:

- transport stays in `packages/transport`
- market identity stays in `packages/market-data` + `packages/contracts`
- live order/fill truth stays in `packages/live-execution`
- durable state stays in `packages/ledger`
- operator lifecycle stays in `apps/api/src/runtime-store.ts`

If the adapter writes directly around those surfaces, merge risk goes up fast.
If it plugs into them cleanly, most of the repo’s safety model stays intact.