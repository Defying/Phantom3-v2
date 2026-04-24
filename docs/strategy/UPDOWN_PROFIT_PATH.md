# Wraith Up/Down Profit Path

Wraith should not optimize for “more trades.” It should optimize for positive expected value with controlled downside.

## Current edge hypothesis

Short-window BTC/ETH/SOL Up/Down markets can become mispriced when the underlying has already moved far enough from the opening price that the market's entry price underestimates the probability of staying on that side through resolution.

## Trade gate

A setup is only actionable when all of these are true:

1. Market is inside the allowed time window, but not too close to resolution.
2. Spread is tight enough to enter without donating the edge.
3. Liquidity is high enough to enter and exit realistically.
4. Coinbase proxy move has enough buffer from the open.
5. Model probability exceeds the current buy price by at least `minEdge`.
6. The entry price is not so high that downside/reversal risk dominates.

If any gate fails, the correct action is no trade.

## Model v0

The scanner estimates remaining volatility from recent Coinbase one-minute candles, converts the current open-to-spot buffer into a normal tail probability, then compares that probability to the Polymarket best buy price.

This is intentionally conservative and transparent. It is not a live-capital proof. It is a ranking/filtering layer that tells us which windows deserve paper fills and manual source checks.

## Sizing

The scanner emits a capped Kelly fraction. For paper/live experiments, treat this as a maximum position fraction, not a target. Early paper trading should use tiny fixed sizes until the observed hit rate and realized prices beat the model assumptions.

## Operating loop

1. Run `npm run scan:updown` for the full ranked board.
2. Run `npm run watch:updown` on an interval for candidate-only alerts.
3. Run `npm run observe:updown` on an interval to append scan snapshots to `data/updown-observations.jsonl`.
4. Run `npm run evaluate:updown` after markets resolve to score candidate hit rate and unit P&L against the Coinbase proxy.
5. Paper trade only `CANDIDATE` rows.
6. Record fill price, market close result, modeled probability, edge, and blocker state.
7. Promote to live only after enough paper samples show positive realized EV after spread/slippage.

## No-go rules

- No live trades from `WATCH` or `SKIP`.
- No live trades while source/proxy mismatch is unresolved.
- No live trades if Wraith cannot prove durable ledger/reconciliation for the venue path.
- No martingale, no doubling down, no “make it back” trades.


## Zero-dollar simulation mode

When there is no USDC to trade, Wraith should keep learning without touching the wallet.

- `npm run observe:updown` records every scanner row to `data/updown-observations.jsonl`.
- `npm run simulate:updown` replays resolved observations across threshold sweeps and reports hit rate, unit P&L, implied ROI, drawdown, and example trades.
- By default the simulator dedupes by market+side so repeated scans do not pretend we could enter the same event over and over. Set `WRAITH_UPDOWN_SIM_DEDUPE=observation` only for research.
- `npm run evaluate:updown` remains the strict candidate-only evaluator.

Useful sweep knobs:

- `WRAITH_UPDOWN_SIM_MIN_BUFFER_BPS=0,5,8,12,18`
- `WRAITH_UPDOWN_SIM_MIN_MODEL_PROBABILITY=0.5,0.55,0.57,0.6,0.65`
- `WRAITH_UPDOWN_SIM_MIN_EDGE=0,0.01,0.02,0.03,0.05`
- `WRAITH_UPDOWN_SIM_MIN_TRADES=20` once enough observations exist

A threshold set is not interesting until it has enough resolved samples and stays positive after spread/slippage assumptions. Tiny sample wins are noise.

## Realistic backtest requirements

Midpoint-only simulation is not enough to prove edge. Before any live-capital canary, Wraith needs a book-aware replay path that records enough public Polymarket/CLOB state to simulate executable fills.

Capture per market:

- Gamma/Gamma-public identity: event id, market id, slug, question, condition id, outcome labels, CLOB token ids, start/end dates, active/closed state, description, resolution source, and URL.
- CLOB metadata: token-to-outcome mapping, min order size, tick size, fee rate, order delay flags, and exchange server time.
- Order book snapshots/events: full depth or at least enough bid/ask levels to fill the target simulated size, with token id, condition id, orderbook hash, exchange timestamp, and local receive timestamp.
- Resolution facts: market-specific oracle/source prices at start/end and equality rule. Coinbase remains proxy-only unless the market explicitly resolves from Coinbase.

Execution simulation rules:

- Never fill at midpoint.
- Simulated buys walk asks from lowest price upward; simulated sells walk bids from highest price downward.
- Model partial fills, VWAP, slippage, fees, tick rounding, min order size, and signal-to-execution latency.
- Treat `/prices-history` as chart context only, not realistic fill data.
- Validate reconstructed books against CLOB `/book`, WS `best_bid_ask`, actual trades, and final `market_resolved` winning token.

Safety invariants for zero-dollar mode:

- Use only public read endpoints and public market WebSocket subscriptions.
- Do not load private keys, L2 API credentials, signer, funder, or wallet state.
- Hard-block authenticated CLOB order/cancel/balance/allowance paths.
- Tests should prove outbound non-GET/WS trading writes are zero and no auth headers are attached.
