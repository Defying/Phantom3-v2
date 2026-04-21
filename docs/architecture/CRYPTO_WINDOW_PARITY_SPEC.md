# Phantom3 v2 Crypto Window Parity Spec

Status: target parity spec for the next build phase  
Date: 2026-04-21

This document defines the **canonical paper-only parity target** for the next Phantom3 v2 build phase.

It is intentionally narrower than “all legacy behavior”:
- target venue family: Polymarket crypto up/down window markets
- target assets: **BTC, ETH, SOL** only
- target windows: **5m and 15m** only
- target runtime mode: **paper-only**
- target rule family: **managed early-exit parity**, informed by the legacy managed Python bot and the BTC momentum-confirmation TS bots

When legacy source files disagree, **this document wins** for v2 implementation.

## Ground-truth references

Primary references used for this parity target:
- `/Volumes/Carve/Projects/Phantom3/dashboard_early_exit.py`
- `/Volumes/Carve/Projects/Phantom3/dashboard_early_exit_LIVE.py`
- `/Volumes/Carve/Projects/Phantom3/polymarket_sniper_v2.py`
- `/Volumes/Carve/Projects/Phantom3/polymarket_live.py`
- `/Volumes/Carve/Projects/polybot/src/btc5m.ts`
- `/Volumes/Carve/Projects/polybot/src/btc15m.ts`
- `/Volumes/Carve/Projects/polybot/src/signals.ts`
- `/Volumes/Carve/Projects/polybot/src/execution.ts`

## 1. Canonical target and explicit non-goals

### Canonical target

Phantom3 v2 should implement **one crypto-window parity profile** with these rules:
- **market discovery** and up/down token normalization for BTC / ETH / SOL 5m and 15m windows
- **external reference direction** from parsed market open price plus venue-independent spot data
- **momentum confirmation** using the polybot signal family where the asset feed exists
- **managed exits** from the legacy live/managed Python bot
- **paper-only execution** through the v2 paper ledger and paper execution adapter

### Not canonical for this phase

These stay reference-only and are **not** the next-build default:
- the current v2 generic discounted-underdog strategy
- the legacy 95% sniper hold-to-resolution profile
- XRP support
- live wallet trading, live order submission, live redemption, or any real-money enablement
- maker/taker live order behavior from `execution.ts` as an active runtime path

## 2. Source reconciliation decisions

| Topic | Legacy evidence | Canonical v2 decision |
| --- | --- | --- |
| Asset universe | Python managed bot still carried XRP weights, trade-preference work narrowed intent to BTC/ETH/SOL | **BTC, ETH, SOL only**. Reject XRP and all other assets. |
| Window coverage | Python bots were mostly 15m, polybot added BTC 5m and 15m | **5m and 15m are both in scope**. |
| Entry family | Python managed bot used late high-probability confirmed entries, polybot used momentum-confirmed market agreement | **Combine them**: use external direction plus market-price confirmation, then apply managed exits. |
| 15m entry price band | Managed Python bot used trigger 0.81, confirm 0.83 to 0.91 | **Keep that band for 15m parity.** |
| 5m entry price band | BTC 5m polybot used price floors, dead-zone rejection, and momentum confirmation, not 83 to 91 | **Keep the 5m momentum lane separate**. Do not force 5m into the 15m high-probability band. |
| Exit family | Python managed bot had target, dynamic stop, trailing, damaged-trade breakeven, time-decay exits | **This is the canonical exit state machine for parity positions.** |
| Sizing | Python “dynamic” sizing function still returned flat max trade size, polybot supported compounding modes | **Default to flat sizing.** Compounding stays paper-only research, not parity default. |
| Order-book pricing | Python managed bot checked actual ask and rejected books more than 5% above midpoint | **Use CLOB midpoint for scoring and best ask for executable paper entry checks.** |
| Execution enablement | `polymarket_live.py` is fail-closed and defaults live mode off | **Keep live trading disarmed.** |

## 3. Market universe and discovery rules

### 3.1 Allowed markets

A market is parity-eligible only if all of the following are true:
- venue is Polymarket crypto up/down window market
- asset is exactly `BTC`, `ETH`, or `SOL`
- window is exactly `5m` or `15m`
- market is active, not closed, and still accepting orders
- `endDate` is in the future
- exactly two outcome tokens are available and can be normalized to `UP` and `DOWN`
- the question text yields a parseable opening/reference price

### 3.2 Discovery order

The runtime should discover markets in this order:

1. **slug-targeted lookup** for the current window
2. **slug-targeted lookup** for the next window
3. **slug-targeted lookup** for the previous window if it is still open
4. **broad active-market fallback** sorted by nearest end time
5. **page-data fallback** only when a known slug is missing or incomplete from Gamma

Target slug formats:
- `{asset}-updown-5m-{windowStartTs}`
- `{asset}-updown-15m-{windowStartTs}`

### 3.3 Scan cadence

Use different scan cadences by window:
- **5m lane**: evaluate every **1s**
- **15m lane**: scan every **8s** and run delayed confirmation in the background
- **open-position monitor**: evaluate exits every **2s**

### 3.4 Market dedupe rules

Do not enter when any of the following are true:
- same `conditionId` or slug already has an open position
- same market was already processed this session
- durable trade storage already contains a non-rejected trade for the market

One market gets **at most one trade**.

## 4. External price and momentum dependencies

### 4.1 Required external references

Each candidate needs these external references:
- **parsed market opening price** from the market question
- **spot/reference price** for the asset from an external venue-independent source
- **Polymarket CLOB midpoint** for the candidate token
- **Polymarket order book ask** for executable-price validation

### 4.2 Preferred dependency stack

Use this stack in descending order:

1. **streaming spot feed** for the asset
2. **1m candle fallback** for the asset
3. **Chainlink spot/oracle cross-check** for BTC / ETH / SOL
4. **CoinGecko-style paper fallback** only when higher-priority feeds are unavailable

### 4.3 Momentum signal contract

Where an asset has a proper streaming or candle feed, compute:
- EMA(3)
- EMA(8)
- RSI
- short-window velocity

The default parity signal rule is:
- direction is `UP` when at least **2** bullish indicators agree and there are **0** bearish indicators
- direction is `DOWN` when at least **2** bearish indicators agree and there are **0** bullish indicators
- otherwise direction is `NEUTRAL`
- minimum signal strength is **0.67**

The aggressive one-indicator override from legacy polybot is **not** the canonical default.

### 4.4 Asset-specific honesty boundary

The BTC thresholds in `btc5m.ts`, `btc15m.ts`, and `signals.ts` are source-proven.

ETH and SOL are in-scope for the parity profile, but their momentum thresholds are **not yet source-proven** in the supplied TS bots. For the next build phase:
- keep the same signal shape for ETH and SOL
- keep BTC / ETH / SOL priority weights of **1.0 / 0.9 / 0.65** for candidate ranking
- treat ETH and SOL momentum threshold tuning as **paper-only calibration work**, not live-ready behavior

## 5. Entry protocol

A candidate must pass **all** stages below.

### 5.1 Shared pre-entry gates

Reject the candidate when any of these are true:
- market is unsupported, closed, stale, or missing token IDs
- parsed opening price is missing
- external reference direction is missing or stale
- external direction and market direction disagree
- duplicate market guard is hit
- session cooldown or session stop is active
- configured trading hours exclude the current time

### 5.2 Direction selection

Determine two directions independently:
- **market direction**: the currently leading `UP` or `DOWN` side from the Polymarket midpoint
- **reference direction**: whether external spot is above or below the parsed opening price, optionally strengthened by momentum indicators

The runtime may only enter when those two directions agree.

### 5.3 5m lane

The 5m parity lane inherits the polybot momentum-entry shape.

Required gates:
- time to close is **more than 10s** and **no more than 300s**
- signal direction is not `NEUTRAL`
- signal strength is at least **0.67**
- paper entry price is at least **0.52**
- dormant live floor remains **0.70**, but live mode stays disarmed
- entry price does not exceed **0.99**
- reject the **dead zone** from **0.55** inclusive to **0.65** exclusive
- reject extreme RSI exhaustion and extreme velocity spikes

Interpretation:
- 5m is the short-window momentum lane
- it is allowed to enter much earlier in the price curve than the 15m managed lane
- it still exits using the managed-exit state machine in section 7 once a parity position is open

### 5.4 15m lane

The 15m parity lane inherits the managed Python bot’s confirmation behavior.

Required gates:
- time to close is **at least 30s** and **at most 600s**
- the leading side first triggers at **0.81** or higher
- wait **4.0s** before confirmation
- after confirmation, the entry price must still be within **0.83 to 0.91**
- reject the candidate if confirmed price drops below the initial trigger price
- reject the candidate if short-window token-price range exceeds **0.08**
- reject the candidate if best ask is more than **0.05** above midpoint
- if ask is within the allowed spread, use the ask as the executable paper entry price
- require oracle/reference direction agreement with the parsed opening price before promotion to a paper intent

### 5.5 Expected-profit floor

Before emitting a paper intent, compute the managed target payout assumption and reject when expected profit is below the configured minimum.

Parity default minimum stays **$0.05**.

## 6. Sizing, cooldowns, and session guardrails

### 6.1 Default sizing

Parity default sizing is:
- **flat $10 notional per trade**
- do **not** scale size by asset weight yet
- do **not** make compounding or percentage-of-balance sizing the parity default

Use asset weights only to prioritize candidates when several are valid at once:
- BTC: **1.0**
- ETH: **0.9**
- SOL: **0.65**

### 6.2 Paper bankroll guards

Keep these guards in the paper risk layer:
- minimum bankroll / balance floor: **$1**
- hard cap of **25% of current bankroll** on any one position, even in paper mode
- max relative bankroll drawdown breaker: **50%** from starting paper balance when that paper balance is tracked

### 6.3 Session controls

Use these session-level limits:
- max **3 trades per hour**
- cooldown after **3 consecutive losses**
- cooldown duration: **10 minutes**
- hard session stop at **-$30** total session P&L
- daily profit target at **+$55**
- once the daily target is reached, keep trading only while session P&L stays above `max(sessionPeak - 15, 50)`
- optional trading-hour window may block new entries but must **not** stop exit monitoring

## 7. Managed exit behavior

Managed exits are the canonical parity behavior for open parity positions.

Track at least:
- entry price
- current midpoint
- highest price since entry
- lowest price since entry
- time remaining to market close

Apply exits in this order:

1. **Hard target**  
   Exit when price reaches **0.93**.

2. **Trailing stop**  
   Exit when:
   - peak gain from entry is greater than **0.05**
   - drop from peak is greater than **0.05**
   - current price is still above entry

3. **Damaged-trade breakeven**  
   Exit when:
   - the trade first dipped at least **0.04** below entry
   - then recovers back to entry or better

4. **Time-decay exits**  
   Exit when:
   - under **120s** left and profit is above **0.03**
   - under **60s** left and profit is above **0.01**
   - under **30s** left regardless of profit

5. **Hard stop**  
   Use the per-position stop:
   - `max(entryPrice - 0.06, 0.70)`

### Stop-loss conflict resolution

Do **not** port the inconsistent helper defaults from `polymarket_live.py` as canonical behavior.

Canonical v2 parity stop logic is the managed-bot formula above, not:
- the classic **0.77** stop
- the helper’s **0.75** default
- the audit-comment **0.65** default mention

## 8. Canonical skip reasons

The v2 parity evaluator should emit explicit reason codes. At minimum, keep these families:

| Code | Meaning |
| --- | --- |
| `SKIP_UNSUPPORTED_MARKET` | not BTC / ETH / SOL, not 5m / 15m, bad outcome structure, or missing open price |
| `SKIP_DUPLICATE` | already traded or already open for this market |
| `SKIP_DB_DUPLICATE` | durable ledger already contains a non-rejected trade for the market |
| `SKIP_TIMING` | too early or too late relative to the window-specific time-to-close band |
| `SKIP_NEUTRAL` | momentum/reference direction not strong enough to choose a side |
| `SKIP_STRENGTH` | signal strength below threshold |
| `SKIP_PRICE` | below min entry, stale/NaN price, or missing midpoint |
| `SKIP_MAX_PRICE` | above max entry price |
| `SKIP_DEAD_ZONE` | 5m price fell into the no-trade dead zone |
| `SKIP_CONFIRM_DROP` | 15m candidate fell during confirmation |
| `SKIP_VOLATILITY` | token price swing too large during the confirmation window |
| `SKIP_SPREAD` | ask too far above midpoint |
| `SKIP_ORACLE_DISAGREE` | external reference says the opposite direction |
| `SKIP_PROFIT` | expected profit below floor |
| `SKIP_LIMIT` | hourly rate limit or other session cap hit |
| `SKIP_BALANCE` | bankroll floor violated |
| `SKIP_DRAWDOWN` | relative or absolute drawdown breaker hit |
| `SKIP_COOLDOWN` | consecutive-loss cooldown active |
| `SKIP_OUTSIDE_HOURS` | outside configured trading window |

## 9. What remains paper-only for now

These items stay explicitly paper-only after this spec lands:
- all order submission, cancel, reprice, maker, taker, and fill reconciliation logic
- wallet signing, allowance handling, redemption, and real-money P&L
- ETH/SOL momentum-threshold calibration beyond the BTC-proven baseline structure
- compounding / percentage sizing as a default runtime path
- the 95% sniper hold-to-resolution profile as the main engine behavior
- any “live mode” path in the dashboard or worker

If a component cannot satisfy this spec without touching real exchange state, that component is **out of scope for this phase**.

## 10. Minimum implementation outputs

The next build phase should persist enough paper data to replay every decision. Each candidate or position should record at least:
- asset, timeframe, market slug, condition ID
- parsed opening price and current external spot/reference price
- midpoint, best ask, and entry price used for the paper intent
- market direction, reference direction, momentum indicators, and signal strength
- skip reason or exit reason code
- entry timestamp, exit timestamp, and time-to-close at both points
- per-position stop, target, highest price, lowest price, and current time-decay state

That is the minimum bar for claiming parity-target behavior in v2.
