# CLOB V2 Migration Lane — Live Execution Audit

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Branch: `audit/clob-v2-readiness-2026-04-28`
- Mode: static source audit. No live Polymarket calls, wallet calls, credential derivation, wrapping, order placement, tests, builds, or dev servers were run for this lane.

## Verdict

**Structurally CLOB V2-compatible, but not live-capital ready.**

The live execution path already uses the official V2 TypeScript SDK package (`@polymarket/clob-client-v2`) and the current production host default remains `https://clob.polymarket.com`. No V1 SDK import or raw V1 signing path was identified in the active live execution code.

## Source findings

### V2 SDK usage

`packages/live-execution/src/polymarket-client.ts` imports V2 SDK symbols directly:

- `ClobClient`
- `SignatureTypeV2`
- `OrderType`
- `Side`
- `ApiKeyCreds`
- `OpenOrder`, `Trade`, `TradesPaginatedResponse`, `MarketDetails`

The SDK client factory constructs:

```ts
new ClobClient({
  host,
  chain,
  signer,
  creds,
  signatureType,
  funderAddress,
  useServerTime,
  throwOnError: true
})
```

That matches the installed V2 SDK constructor style inspected during this migration pass.

### Auth posture

`PolymarketLiveClient.fromConfig(...)` requires:

- a private key before authenticated operations;
- either existing L2 API credentials or explicit `WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION=true` before authenticated API access;
- funder address for non-EOA signature types through config validation.

This is a reasonable V2 auth shape, but it is still only auth readiness.

### Order path

`submitLimitOrder(...)` calls `sdk.createAndPostOrder(...)` with:

- `tokenID`
- `price`
- `size`
- `side`
- optional expiration
- `OrderType.GTC` or `OrderType.GTD`
- `postOnly`
- `deferExec=false`

It then attempts order lookup and fill lookup. Explicit 4xx SDK `ApiError` failures are mapped as rejected; unknown submit/lookup failures become ambiguous/reconcile-required rather than silently acknowledged.

### Venue evidence path

The client can fetch:

- individual orders;
- open orders filtered by market/token;
- paginated user trades;
- venue state snapshots combining open/tracked orders and fills;
- cancellation state;
- heartbeat.

The live adapter layer records venue order/fill evidence into ledger-shaped events and has reconciliation outputs for unmatched venue orders/fills.

## CLOB V2 migration gaps not solved by this source shape

1. **No pUSD balance/allowance preflight yet.**
   The code does not call SDK balance/allowance helpers (`getBalanceAllowance`, `updateBalanceAllowance`) and does not prove pUSD collateral readiness before order submission.

2. **No automatic USDC.e wrapping.**
   This is intentional for this migration. Wrapping/CollateralOnramp is an operator wallet action and should not be hidden in Wraith without explicit approval and a separate transaction-safety design.

3. **No live-capital proof.**
   CLOB V2 SDK compatibility does not prove restart-safe venue reconciliation, position truth, flatten correctness, incident handling, or pUSD readiness.

4. **Builder attribution not implemented.**
   The V2 SDK exposes builder-code related fields, but Wraith does not need builder attribution for this pass.

## Required implementation from this audit

- Refresh `@polymarket/clob-client-v2` package/lock metadata to the latest observed V2 package (`1.0.2`).
- Add operator documentation saying pUSD balance/allowance is required and not proven by `/api/live/wallet`.
- Preserve live no-go posture until separate venue/collateral/reconciliation evidence is collected.

## Confidence score

**89 / 100** — high confidence in the static source conclusion; not a live-readiness claim.

Confidence boosters:

- Direct inspection of live execution source and tests.
- Direct inspection of installed V2 SDK types/constructor shape.
- Multiple independent QA lane reports converged on the same pUSD/no-go gaps.

Confidence reducers:

- No live API calls, wallet calls, credential derivation, balance calls, wrapping, or real order placement were performed.
- Upstream SDK behavior is trusted from installed types/source, not exercised against production.
- pUSD balance/allowance remains a documented external prerequisite rather than a code-level preflight.
