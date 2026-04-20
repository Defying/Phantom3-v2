# `@phantom3-v2/risk`

Pure paper-trading risk evaluation for Phantom3 v2.

## What it does

The module evaluates a `TradeIntent` against a normalized market snapshot, current paper positions, operator hooks, and paper risk config.

It can:
- block when kill switches or cooldowns are active
- reject stale quotes, wide spreads, thin liquidity, or low volume
- enforce max order size, simultaneous position count, per-market caps, and total exposure caps
- resize paper orders down to the allowed size when a cap is hit
- allow reduce-only intents to pass through operator blocks when configured

## Main API

```ts
import {
  createPaperRiskConfig,
  evaluatePaperTradeRisk
} from './src/index.js';

const config = createPaperRiskConfig({
  maxPositionSizeUsd: 25,
  perMarketExposureCapUsd: 50,
  totalExposureCapUsd: 100
});

const decision = evaluatePaperTradeRisk({
  config,
  now: new Date().toISOString(),
  intent: {
    intentId: 'intent-1',
    marketId: 'market-123',
    side: 'yes',
    desiredSizeUsd: 20
  },
  market: {
    marketId: 'market-123',
    bestBid: 0.48,
    bestAsk: 0.5,
    liquidityUsd: 5000,
    volume24hrUsd: 12000,
    observedAt: new Date().toISOString()
  },
  positions: [],
  hooks: {
    cooldowns: {
      markets: {
        'market-999': '2026-04-20T23:00:00.000Z'
      }
    }
  }
});
```

## Output shape

`evaluatePaperTradeRisk()` returns a structured decision with:
- `decision`: `approve`, `reject`, `resize`, or `block`
- `approvedSizeUsd`: final allowed paper size
- `reasons[]`: human-readable reason codes and metadata for auditability
- `metrics`: exposure, freshness, spread, and capacity context used during evaluation

This package is intentionally pure. It does not place orders, mutate state, or read the clock unless `now` is omitted.
