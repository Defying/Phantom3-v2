# CLOB V2 pUSD / Balance / Allowance Audit

Status: planning/audit artifact — static inspection only, no build/test/project execution
Date: 2026-04-28

## Scope inspected

- Official Polymarket docs:
  - `https://docs.polymarket.com/concepts/pusd`
  - `https://docs.polymarket.com/v2-migration`
  - `https://docs.polymarket.com/trading/quickstart`
  - `https://docs.polymarket.com/trading/orders/create`
  - `https://docs.polymarket.com/trading/bridge/deposit`
  - `https://docs.polymarket.com/resources/contracts`
  - `https://docs.polymarket.com/trading/ctf/overview`
- Wraith static searches for:
  - `getBalanceAllowance`, `updateBalanceAllowance`, `AssetType`, `BalanceAllowance`
  - `USDC.e`, `USDC`, `pUSD`, `pusd`, `collateral`, `allowance`, `balance`, `wallet`, `funds`
- Relevant Wraith files:
  - `apps/api/src/index.ts`
  - `apps/api/src/runtime-store.ts`
  - `apps/web/src/App.tsx`
  - `packages/live-execution/src/polymarket-client.ts`
  - `packages/config/src/index.ts`
  - `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md`
  - `docs/strategy/UPDOWN_PROFIT_PATH.md`

No wallet calls, order calls, balance calls, allowance updates, API credential derivation, wrapping, tests, builds, or npm scripts were run.

## Official pUSD facts

- pUSD is Polymarket USD, the CLOB V2 collateral token used for all trading.
- It is a standard ERC-20 on Polygon with 6 decimals, backed by USDC.
- pUSD replaces old USDC.e collateral assumptions for trading.
- API-only traders with USDC.e can wrap through the CollateralOnramp contract.
- Polymarket bridge deposits can accept supported assets and credit pUSD automatically.
- For order placement:
  - BUY orders need pUSD balance and pUSD allowance sufficient for spend plus fees.
  - SELL orders need outcome token balance/allowance.
  - EOA signature type 0 also needs POL for gas.
  - Proxy wallet signature types may use gasless relayer behavior, but still need correct funder/proxy wallet collateral.
- Official contracts page lists:
  - pUSD collateral token proxy: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
  - CollateralOnramp: `0x93070a847efEf7F70739046A929D47a521F5B8ee`
  - CollateralOfframp: `0x2957922Eb93258b93368531d39fAcCA3B4dC5854`
  - USDC.e in docs example: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`

## Findings in Wraith

### 1) No current pUSD balance/allowance preflight exists

Static search found no Wraith usage of:

- `getBalanceAllowance`
- `updateBalanceAllowance`
- `AssetType.COLLATERAL`
- `BalanceAllowance*`

`packages/live-execution/src/polymarket-client.ts` relies on order placement rejection handling. If Polymarket rejects an order with `insufficient balance`, Wraith classifies that explicit API failure as a rejected order.

Assessment: acceptable for a no-go/live-disabled posture, but not enough for live-capital readiness. A future live review should add sanitized pUSD collateral readiness checks before arming.

### 2) Wallet readiness is auth-only, not collateral-ready

`apps/api/src/index.ts` exposes `/api/live/wallet` with private key, API credentials, signature type, funder address, gateway, and setup-error readiness. It does not report pUSD balance, pUSD allowance, POL gas balance, or outcome-token allowance.

Assessment: the endpoint name can imply more readiness than it proves. Docs should clarify it is wallet/auth readiness only. If live gets closer, add collateral readiness fields separately.

### 3) Stale docs mention generic USDC

`docs/strategy/UPDOWN_PROFIT_PATH.md` says “When there is no USDC to trade...” This is stale for CLOB V2 live trading because pUSD is the actual Polymarket collateral.

Assessment: should fix documentation wording to “pUSD / Polymarket trading collateral” or a neutral “collateral.”

### 4) No automatic wrapping should be added here

CLOB V2 docs describe `wrap(USDC.e, to, amount)` through CollateralOnramp, but Wraith should not auto-wrap in this migration:

- It is an external wallet/collateral operation.
- It requires onchain approvals/transactions and POL gas.
- It is irreversible enough to require explicit operator intent.
- Wraith live trading remains no-go.

Assessment: document the operator requirement; do not implement automatic onramp wrapping.

### 5) SDK has a collateral balance/allowance surface for future use

The V2 SDK type surface includes `AssetType.COLLATERAL`, `getBalanceAllowance`, and `updateBalanceAllowance`. That is likely the correct future SDK path for checking pUSD collateral balance/allowance, rather than raw ERC-20 calls.

Assessment: future enhancement, not required to complete SDK migration.

## Required Code/Doc Changes

### Must fix for CLOB V2 documentation correctness

1. Update `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md` to state that CLOB V2 live trading requires pUSD collateral and appropriate allowance on the funder address; signer/API credentials alone are not enough.
2. Update `docs/strategy/UPDOWN_PROFIT_PATH.md` stale “USDC to trade” wording.
3. Record that Wraith does not auto-wrap USDC.e to pUSD in this pass.

### Should fix before any live-capital review

1. Add a sanitized collateral readiness concept separate from auth readiness:
   - pUSD balance
   - pUSD allowance
   - POL gas balance for EOA signature type 0
   - outcome-token balance/allowance for sells/flatten
2. Prefer official V2 SDK `getBalanceAllowance({ asset_type: AssetType.COLLATERAL })` for collateral checks where possible.
3. Make `/api/live/wallet` wording clearly say “auth readiness,” not “trade readiness.”

### No fix needed for this migration

- No automatic pUSD wrapping/onramp transaction should be added.
- No raw contract address integration is needed for current SDK order placement.
- No order-signing code changes are needed solely for pUSD if the V2 SDK is used.

## Runtime Risks

- A wallet may have USDC.e but zero pUSD; CLOB V2 BUY orders can fail despite apparent dollar balance in the wallet.
- A wallet may have pUSD but insufficient exchange allowance; order placement can fail.
- EOA wallets may have pUSD but insufficient POL for gas.
- Proxy wallet/funder mismatch can make balances appear correct on one address while the SDK signs/places for another.
- Existing `/api/live/wallet` readiness could be misread as “safe to trade” unless docs/UI are explicit.

## Confidence Score

**84 / 100 — high confidence for documentation/runtime-risk conclusions; medium confidence for the exact future preflight implementation shape.**

### Confidence boosters

- Official docs consistently state pUSD is the CLOB V2 collateral token.
- Wraith static search found no current collateral balance/allowance code path to migrate incorrectly.
- Wraith live posture is no-go, reducing urgency for automated collateral handling.
- V2 SDK type surface exposes an obvious balance/allowance API for future readiness checks.

### Confidence reducers

- No live funded wallet was checked.
- No real Polymarket balance/allowance response was sampled.
- No tests/builds were run yet by design; this is planning-stage only.
- Exact pUSD allowance spender semantics should be verified against live SDK/API docs before implementing a future preflight.
