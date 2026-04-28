# CLOB V2 Official Research

Status: planning/audit artifact — created before any build/test/compile/project execution
Date: 2026-04-28
Branch: `audit/clob-v2-readiness-2026-04-28`

## Executive summary

Polymarket CLOB V2 is a production cutover, not a cosmetic SDK rename. Official docs say V2 is live on `https://clob.polymarket.com` as of April 28, 2026; legacy V1 SDKs and V1-signed orders are no longer accepted on production. The migration combines new exchange contracts, a rewritten CLOB backend, and collateral migration from USDC.e to pUSD.

For Wraith specifically, the most important finding is that the active code already uses the official TypeScript V2 SDK (`@polymarket/clob-client-v2`) and the V2 constructor/options-object shape. The remaining high-confidence migration work is dependency-lock freshness and documentation/operator wording, not a raw order-signing rewrite.

## Sources checked

- Polymarket docs: `https://docs.polymarket.com/v2-migration`
- Polymarket changelog: `https://docs.polymarket.com/changelog`
- Polymarket quickstart: `https://docs.polymarket.com/trading/quickstart`
- Polymarket order docs: `https://docs.polymarket.com/trading/orders/create`
- Polymarket pUSD docs: `https://docs.polymarket.com/concepts/pusd`
- Polymarket contracts docs: `https://docs.polymarket.com/resources/contracts`
- Official TS SDK README: `https://github.com/Polymarket/clob-client-v2`
- Official TS SDK npm metadata: latest observed `@polymarket/clob-client-v2@1.0.2`

The X/Twitter URL itself was not reliably fetchable from this environment, so the migration basis is the official Polymarket documentation/changelog and official SDK metadata rather than the tweet body.

## Official CLOB V2 facts

| Area | Official V2 requirement/fact | Wraith impact |
| --- | --- | --- |
| Production host | V2 now runs at `https://clob.polymarket.com`; pre-cutover `https://clob-v2.polymarket.com` is not the production target. | Wraith already defaults to `https://clob.polymarket.com`. |
| SDK | Use `@polymarket/clob-client-v2` / `py-clob-client-v2`; legacy `@polymarket/clob-client` / `py-clob-client` are V1-only. | Wraith already imports `@polymarket/clob-client-v2`; lockfile is at 1.0.0 while npm latest is 1.0.2. |
| Compatibility | No V1 compatibility after go-live; V1-signed orders no longer supported. | Any old raw signing path would be critical, but no Wraith raw signing path was found in the initial audit. |
| Open orders | Resting V1-era open orders were wiped at cutover and must be recreated with V2 signing. | Live trading remains no-go; no automatic recreation should be added. Runtime reconciliation must treat missing venue orders as expected only with explicit operator context. |
| Order struct | V2 removes `nonce`, `feeRateBps`, and `taker`; adds `timestamp`, `metadata`, and `builder`. `expiration` remains wire-body/GTD behavior but not signed struct. | Wraith order submit path sends only `tokenID`, `price`, `size`, `side`, optional `expiration`; it relies on SDK signing. |
| Constructor | V2 TS constructor uses options object and `chain`, not V1 positional args / `chainId`. | Wraith constructs `new ClobClient({ host, chain, signer, creds, signatureType, funderAddress, useServerTime, throwOnError })`. |
| Auth | L1/L2 API authentication remains conceptually unchanged; `ClobAuthDomain` stays version 1. | Wraith private-key + API credential derivation path remains relevant. |
| Collateral | pUSD replaces USDC.e as trading collateral. API-only users may need to wrap USDC.e via CollateralOnramp. | Code should not promise USDC availability as live trading collateral; docs/operator wording should say pUSD. |
| Fees | Fees are dynamic and operator-set at match time; users should not set `feeRateBps` in orders. Makers are not charged; takers pay according to market fee details. | Wraith does not set order `feeRateBps`; it fetches `getClobMarketInfo()` to estimate taker fill fees for ledger evidence. |
| Builder program | Old builder HMAC order-signing flow replaced by `builderCode` on orders or constructor `builderConfig: { builderCode }`. | Wraith does not currently implement builder attribution. Not required unless Ben needs builder credit/revenue. |
| Exchange contracts | CTF Exchange V2 and Neg Risk CTF Exchange V2 have new addresses; SDK handles this for SDK order signing. | No raw contract address usage found in Wraith initial audit. |

## Wraith codebase findings before execution

- Active repo inspected: `/Volumes/Carve/Projects/wraith`.
- Branch: `audit/clob-v2-readiness-2026-04-28`.
- `package.json` depends on `@polymarket/clob-client-v2` and `viem`.
- `package-lock.json` currently locks `@polymarket/clob-client-v2` to 1.0.0; npm latest observed is 1.0.2.
- `packages/live-execution/src/polymarket-client.ts` imports V2 SDK symbols and uses the options-object constructor.
- `packages/config/src/index.ts` defaults CLOB host to `https://clob.polymarket.com`, chain ID `137`, and live auth disabled unless env is explicitly supplied.
- `.env.example` keeps live execution disabled and contains no secrets.
- Runbook still says live capital is **no-go**; this remains correct after CLOB V2 readiness work.
- Static search found `USDC` wording in `docs/strategy/UPDOWN_PROFIT_PATH.md`; this is documentation/operator wording, not a live signing path.
- Static search found `feeRateBps` in `packages/paper-execution`; this is paper simulation fee modeling, not a CLOB order field.

## Required migration items

1. Pin/refresh `@polymarket/clob-client-v2` to the latest production SDK release observed (`1.0.2`) so the lockfile is not stuck on the initial 1.0.0 release.
2. Add/update QA documentation proving Wraith is already on the V2 SDK path and recording CLOB V2 operational constraints.
3. Update operator/documentation wording that implies live trading collateral is generic `USDC`; after cutover the live collateral requirement is pUSD.
4. Keep live trading disabled/no-go. CLOB V2 readiness does not prove Wraith live-capital readiness.

## Not required for Wraith based on current evidence

- No raw EIP-712 order struct migration was found because Wraith uses the official TS SDK.
- No exchange contract address migration was found because Wraith does not sign raw orders or call exchange contracts directly.
- No removal of V1 `@polymarket/clob-client` imports was needed because no legacy package import was found in repo source.
- No builder HMAC migration was found because Wraith does not currently use builder-signing-sdk or `POLY_BUILDER_*` headers.
- No automatic pUSD wrapping should be added in this pass; it is external wallet/collateral management and live trading remains no-go.

## Confidence score

**86 / 100 — high confidence for the minimal migration plan; not high confidence for live-capital readiness.**

### Confidence boosters

- Official docs/changelog agree on the same core cutover requirements.
- Wraith already uses `@polymarket/clob-client-v2` and the V2 constructor shape.
- Static search did not find the legacy TS SDK package, builder-signing-sdk, raw V1 order struct construction, or `clob-v2.polymarket.com` as a production target.
- Live runbook explicitly remains no-go for live capital, which avoids conflating API compatibility with operational readiness.

### Confidence reducers

- The tweet body itself was not directly retrieved from X/Twitter.
- Subagent lane audits are still running and may find additional stale docs or edge cases.
- No compile/test/build has run yet by design; this file is part of the required planning-before-execution stage.
- Actual wallet pUSD balance/allowance and Polymarket geoblock/auth status cannot be proven safely without a live funded environment and explicit operator approval.

## Decision

Proceed to implementation **only after** the full markdown planning/audit set exists. If no lane audit contradicts this file, the high-confidence autonomous implementation scope is:

1. SDK lockfile/package refresh to latest V2 SDK.
2. Documentation/runbook wording updates for CLOB V2/pUSD/no-go posture.
3. Build/typecheck/live-safety verification after docs exist.

No live trading, no order placement, no API credential derivation, and no pUSD wrapping should be performed by this migration.
