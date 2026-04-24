# Strategy Signal Engine

Status: draft
Date: 2026-04-20

## What landed

`packages/strategy` now provides a paper-safe, read-only signal engine for binary Polymarket markets.

It consumes the current `MarketSnapshot` surface from `packages/market-data` and produces:
- rejected market diagnostics with explicit reason codes
- accepted market rankings with transparent sub-scores
- paper-only `TradeIntent`-like objects with thesis, confidence, entry bounds, and exit constraints

## Safety boundary

This package is intentionally **not** an execution module.

It does **not**:
- place orders
- touch wallets or signing
- claim predictive truth or profitability
- bypass risk review

Its job is narrower:
- accept the latest normalized market snapshot
- filter out structurally bad markets
- rank cleaner binary setups
- emit conservative paper intents that another module could review later

## Current heuristic

The first engine version is a **discounted underdog snapshot strategy**.

Because the repo currently only has a read-only snapshot surface, the engine avoids pretending it has more information than it does. It scores markets using only what is actually available now:
- yes/no midpoint prices
- spread
- 24h volume
- liquidity
- end date
- complement consistency (`yesPrice + noPrice` staying near 1)

It then prefers the cheaper side only when the market also clears conservative quality gates.

That means the score is best understood as a **paper hypothesis quality score**, not a claim that the selected side is objectively correct.

## Filtering defaults

By default the engine rejects markets when they are missing or violating any of these constraints:
- missing yes/no prices
- invalid or extreme price band
- broken yes/no complement
- spread above the configured ceiling
- low liquidity
- low 24h volume
- too close to expiry
- too little price imbalance
- final confidence below the configured floor

These defaults are intentionally conservative so the engine fails closed.

## Output shape

Accepted candidates include:
- selected side (`yes` or `no`)
- confidence and signal score
- support reason codes
- thesis summary plus bullet points
- entry constraints
- exit constraints
- suggested paper notional
- detailed diagnostics

Rejected candidates still keep diagnostics and reject reasons so later modules or tests can explain why a market was filtered.

## Why this shape is useful

This gives Wraith a strategy-core module that is:
- deterministic from the current snapshot input
- explainable enough for replay and audits
- safe to run in paper mode today
- ready for a later risk engine to approve, resize, or reject

## Known limits

This engine does not yet use:
- historical price series
- order book depth
- external oracle/reference data
- realized fill behavior
- portfolio context

Those belong in later market-data, risk, replay, and execution milestones.
