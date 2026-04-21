# Trading preference profiles

Status: operator reference
Date: 2026-04-21

This document extracts the legacy Python rule sets that informed the new Phantom3 v2 trading-preference control.

For the selected next-build implementation target, see `docs/architecture/CRYPTO_WINDOW_PARITY_SPEC.md`.

## Intended operator scope now

Phantom3 v2 should be thought of as targeting **Bitcoin, Ethereum, and Solana** short-dated crypto markets, with an operator preference focused on **5 minute and 15 minute** windows.

Important nuance:
- the current TypeScript runtime now narrows discovery to **BTC / ETH / SOL 5m and 15m Up or Down markets**, but the strategy remains a **paper-only generic snapshot engine** after discovery
- the legacy Python files below were mostly written around **15-minute markets closing soon**
- these legacy rules are documented here so the operator can choose an intended preference, not because full parity already exists in v2

## At-a-glance comparison

| Profile | Market scope | Entry / selection | Exit behavior | Runtime parity in v2 |
| --- | --- | --- | --- | --- |
| Current v2 generic paper strategy | BTC / ETH / SOL 5m and 15m discovery is now wired, but the engine is still generic once that filtered snapshot is built | Discounted-underdog paper ranking with liquidity, volume, spread, complement, price-band, and expiry gates | Paper TP / SL / invalidation plan derived from snapshot heuristics | **Current runtime** |
| Legacy early-exit classic | 15-minute crypto markets, inherited Polymarket sniper scan loop | Buy the leading side at **80% to 88%** implied probability | Exit at **92%**, stop at **77%**, force exit near market close | Reference only |
| Legacy early-exit live / managed | 15-minute crypto markets, BTC / ETH / SOL prioritized, XRP still present in weights | Confirmed entry at **83% to 91%**, triggered from **81%** after re-check | Target **93%**, dynamic stop `max(entry - 6%, 70%)`, trailing stop, damaged-trade breakeven, time-decay exits | Paper-managed exit/session-guard foundation |
| Legacy sniper / hold-to-resolution | 15-minute crypto markets closing soon | Buy the likely resolving side at **95%+** implied probability | Usually hold to resolution, optional stop-on-loss | Reference only |

## 1. Current v2 generic paper strategy

Source of truth in this repo:
- `packages/strategy/src/defaults.ts`
- `packages/strategy/src/engine.ts`
- `apps/api/src/runtime-store.ts`

### Core filters and scoring defaults

The current engine is a **discounted underdog snapshot strategy**. Default thresholds:

- `minConfidence`: **0.55**
- `minLiquidity`: **15000**
- `minVolume24hr`: **10000**
- `maxSpread`: **0.06**
- `maxComplementDrift`: **0.08**
- `minHoursToExpiry`: **6**
- `minPriceImbalance`: **0.12**
- `minSidePrice`: **0.08**
- `maxSidePrice`: **0.42**
- `preferredUnderdogPrice`: **0.32**
- `maxPriceDistanceFromPreferred`: **0.18**
- `entryPriceTolerance`: **0.015**
- `maxSnapshotAgeMs`: **120000**
- `maxHoldingHours`: **36**
- `exitBufferHours`: **2**
- `takeProfitDistanceFactor`: **0.45**
- `stopLossDistanceFactor`: **0.22**
- `spreadInvalidationMultiplier`: **1.5**
- `paperNotionalUsd`: **50**
- `maxNotionalPctOfLiquidity`: **0.0025**

### Behavior

- selects the cheaper YES/NO side only after conservative quality gates pass
- emits **paper-only** intents, not live orders
- derives a paper exit plan with TP, SL, spread invalidation, complement invalidation, and latest-exit timing
- risk and paper execution are still sanitized and append-only
- this is the **only strategy profile actually wired into the TypeScript runtime today**

## 2. Legacy early-exit classic

Primary source:
- `/Volumes/Carve/Projects/Phantom3/dashboard_early_exit.py`

Inherited base defaults from:
- `/Volumes/Carve/Projects/Phantom3/polymarket_sniper_v2.py`

### Entry and sizing

- entry band: **0.80 to 0.88**
- exit target: **0.92**
- stop loss: **0.77**
- inherited `max_trade_size`: **$10**
- inherited `min_expected_profit`: **$0.05**
- inherited scan interval: **10s**
- inherited trade window: **30s to 300s** before market close

### Market selection behavior

- fetches **15-minute crypto markets** from a Next.js data endpoint
- identifies whether UP or DOWN is currently leading
- enters only when the leading side is inside the 80% to 88% band
- skips closed markets, already-processed markets, and markets where a position is already open
- checks expected profit before entry using the 92% exit assumption

### Exit behavior

- exits immediately on:
  - target hit at **92%**
  - stop hit at **77%**
  - market closing with under **30s** left
- monitors open positions every **5s**
- this is a relatively simple binary target/stop system with no confirmation stage and no trailing logic

## 3. Legacy early-exit live / managed

Primary source:
- `/Volumes/Carve/Projects/Phantom3/dashboard_early_exit_LIVE.py`

Supporting live-order helper:
- `/Volumes/Carve/Projects/Phantom3/polymarket_live.py`

### Confidence weighting and scope

The managed bot added crypto-specific weighting:

- BTC: **1.0**
- ETH: **0.9**
- SOL: **0.65**
- XRP: **0.5**

For Phantom3 v2, the intended operator scope is narrower: **BTC / ETH / SOL** only.

### Entry and timing defaults

- entry band: **0.83 to 0.91**
- confirmation trigger: **0.81**
- confirmation delay: **4.0s**
- max drop during confirmation: **0.015**
- stop-loss floor: **0.70**
- stop-loss distance: **0.06** below entry
- exit target: **0.93**
- time window: **30s to 600s** before close
- scan interval: **8s**
- inherited `max_trade_size`: **$10** unless overridden
- inherited `min_expected_profit`: **$0.05**

### Entry behavior improvements vs classic

- uses a quick pre-filter first, then a delayed confirmation pass
- re-checks only the triggered token midpoint instead of refetching the whole market set
- rejects entries that are still below entry minimum or above entry maximum after confirmation
- rejects falling confirmations, using price direction as a quality filter
- rejects markets with observed short-window volatility above **8%**
- checks executable ask price and ignores books where ask is more than **5%** above midpoint
- optionally cross-checks direction against Chainlink spot-vs-open parsing from the question text
- position sizing helper is labeled dynamic, but the implementation currently returns a **flat bet size** equal to `max_trade_size`

### Managed exits

The live/managed variant is materially more complex than the classic bot:

1. **Hard target** at **93%**
2. **Trailing stop** once gain from entry exceeds **5%** and price falls more than **5%** from the peak, while still above entry
3. **Damaged-trade breakeven exit** if the trade first dips **4%+** below entry and later recovers back to entry
4. **Time-decay exits**:
   - under **120s** left and profit above **3%**
   - under **60s** left and profit above **1%**
   - under **30s** left, exit regardless
5. **Hard stop** at `max(entry - 0.06, 0.70)`

### Live trading safety nuance

`polymarket_live.py` is fail-closed:

- `live_mode=False` by default
- the helper refuses real exchange access unless explicitly armed and properly configured
- `enter_position()` still shows default helper values of target **0.93** and stop **0.75**
- comments in that helper mention an audit finding pointing toward a **0.65** stop default, while the managed dashboard bot itself uses the stricter per-position formula above

For Phantom3 v2, **live trading remains disarmed**.

### Current v2 implementation status

The TypeScript runtime now carries a **paper-only foundation** for this profile:

- open paper positions can expose a managed exit state with:
  - fixed **93%** target
  - dynamic stop `max(entry - 0.06, 0.70)`
  - trailing-stop activation and threshold tracking
  - damaged-trade break-even recovery tracking
  - time-decay stages near close
- session guard scaffolding can summarize:
  - realized session P&L
  - drawdown-stop state
  - consecutive-loss cooldown state
  - profit-pullback stop state after the daily target is reached
- those guards can feed existing paper risk hooks for **new entries only**
- reduce-only paper exits remain allowed even when the session guard is active
- entry selection is **still the current v2 generic engine**, so this is not full legacy parity yet
- live execution is still explicitly **false / disarmed**

## 4. Legacy sniper / hold-to-resolution

Primary source:
- `/Volumes/Carve/Projects/Phantom3/polymarket_sniper_v2.py`

### Core thresholds

- `min_probability`: **0.95**
- `max_trade_size`: **$10**
- `min_time_before_close`: **30s**
- `max_time_before_close`: **300s**
- `min_expected_profit`: **$0.05**
- `max_expected_profit`: **$0.20**
- `scan_interval`: **10s**
- `stop_on_loss`: **false** by default

### Behavior

- fetches active **15-minute crypto prediction markets**
- parses market questions for crypto, opening price, and direction
- compares current spot from CoinGecko against the market's opening/reference price
- buys only when the implied probability is already **95%+** and expected profit still fits the configured band
- typically **holds to resolution** rather than managing an early-exit ladder
- can optionally stop the whole bot after a loss when `STOP_ON_LOSS=true`

## Practical interpretation for the new v2 control

The new trading-preference selector in Phantom3 v2 should be read as:

- **current-v2-generic**: use the runtime as it actually exists today
- **legacy-early-exit-classic**: record that the operator wants the old simple 80-88 / 92 / 77 behavior as the reference target
- **legacy-early-exit-live**: enable the paper-managed exit and session-guard foundation while still keeping entry selection on the current v2 generic engine
- **legacy-sniper-hold**: record that the operator wants the late, high-confidence hold-to-resolution family as the reference target

That selector is intentionally honest: it exposes partial paper parity where it exists, but it does **not** claim full legacy strategy parity yet.
