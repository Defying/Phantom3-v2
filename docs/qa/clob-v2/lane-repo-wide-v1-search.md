# CLOB V2 Migration Lane — Repo-wide V1 Static Search

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Branch/HEAD observed: `audit/clob-v2-readiness-2026-04-28` / `cdc3880`
- Mode: static inspection only. No npm scripts, tests, builds, dev servers, live API calls, credential derivation, or project code execution were run.
- Output constraint: this audit file is the only file written by this lane.

## Scope

Repo-wide static search for CLOB V1 assumptions and CLOB V2 migration-relevant terms, excluding `.git` and `node_modules`.

Requested search terms covered:

- `@polymarket/clob-client` without `-v2`
- `py-clob-client`
- `builder-signing-sdk`
- `POLY_BUILDER_*`
- `nonce`
- `taker`
- `feeRateBps`
- `userUSDCBalance`
- `USDC.e`
- `USDC`
- `pUSD`
- `clob-v2.polymarket.com`
- `clob.polymarket.com`
- `createAndPostOrder`
- `createAndPostMarketOrder`
- `getPreMigrationOrders`
- `signatureType`
- `funderAddress`
- `BalanceAllowance`
- `AssetType.COLLATERAL`

Supporting files inspected after hits:

- `package.json`
- `package-lock.json`
- `.env.example`
- `packages/config/src/index.ts`
- `packages/live-execution/src/polymarket-client.ts`
- `packages/live-execution/src/index.ts`
- `packages/ledger/src/schemas.ts`
- `packages/paper-execution/src/index.ts`
- `packages/market-data/src/index.ts`
- `packages/market-data/src/updown-edge.ts`
- `apps/api/src/index.ts`
- `docs/strategy/UPDOWN_PROFIT_PATH.md`
- `docs/qa/clob-v2/00-official-research.md`
- `docs/qa/clob-v2/lane-config-env-audit.md`

## Exact search approach / commands

```sh
pwd
find . -maxdepth 2 -not -path './.git/*' -not -path './node_modules/*' -print | sed 's#^./##' | sort | head -200
find /Volumes/Carve/Projects -maxdepth 3 -path '*/node_modules' -prune -o -path '*/.git' -prune -o \( -iname '*wraith*' -o -path '*/docs/qa/clob-v2' \) -print 2>/dev/null | head -200

git rev-parse --show-toplevel
git branch --show-current
git rev-parse --short HEAD
rg --files --hidden --glob '!node_modules/**' --glob '!.git/**' | wc -l

rg -n --hidden --pcre2 --glob '!node_modules/**' --glob '!.git/**' \
  -e '@polymarket/clob-client(?!-v2)' \
  -e 'py-clob-client' \
  -e 'builder-signing-sdk' \
  -e 'POLY_BUILDER_' \
  -e '\bnonce\b' \
  -e '\btaker\b' \
  -e '\bfeeRateBps\b' \
  -e '\buserUSDCBalance\b' \
  -e 'USDC\.e' \
  -e '\bUSDC\b' \
  -e '\bpUSD\b' \
  -e 'clob-v2\.polymarket\.com' \
  -e 'clob\.polymarket\.com' \
  -e 'createAndPostOrder' \
  -e 'createAndPostMarketOrder' \
  -e 'getPreMigrationOrders' \
  -e '\bsignatureType\b' \
  -e '\bfunderAddress\b' \
  -e 'BalanceAllowance' \
  -e 'AssetType\.COLLATERAL' \
  .

# Per-term drilldown used the same rg flags and one term at a time.
# A count summary was also taken with:
rg --count-matches --hidden --pcre2 --glob '!node_modules/**' --glob '!.git/**' [same -e terms] . | sort

# Broader sanity checks for adjacent balance/allowance/order-shape wording:
rg -n --hidden --pcre2 --glob '!node_modules/**' --glob '!.git/**' \
  'balance.?allowance|allowance|COLLATERAL|collateral|AssetType|USDC|pUSD' .
rg -n --hidden --pcre2 --glob '!node_modules/**' --glob '!.git/**' \
  'createAndPost|market.?order|nonce|feeRate|taker|timestamp|metadata|builder' packages apps docs .env.example package.json package-lock.json
```

Note: the negative lookahead for `@polymarket/clob-client(?!-v2)` requires `rg --pcre2`; a plain-regex attempt failed before producing useful results and was corrected.

## Key hits

### SDK/package references

- `package.json:24` depends on `@polymarket/clob-client-v2`, not the legacy package.
- `package-lock.json:13` references `@polymarket/clob-client-v2` and `package-lock.json:1358-1361` locks `node_modules/@polymarket/clob-client-v2` at `1.0.0`.
- No active source/package dependency on legacy `@polymarket/clob-client` was found.
- No `py-clob-client` dependency or source import was found; only the QA research doc mentions it as legacy/V1 context.

### Live execution adapter

- `packages/live-execution/src/polymarket-client.ts:1-13` imports from `@polymarket/clob-client-v2`.
- `packages/live-execution/src/polymarket-client.ts:148-159` constructs `new ClobClient({ host, chain, signer, creds, signatureType, funderAddress, useServerTime, throwOnError })`, which matches the V2 options-object shape recorded in the research doc.
- `packages/live-execution/src/polymarket-client.ts:95` has `createOrDeriveApiKey(nonce?: number)`. This is API-key derivation surface, not a raw order struct nonce.
- `packages/live-execution/src/polymarket-client.ts:96-108` and `:380-391` call `createAndPostOrder` through the V2 SDK with `{ tokenID, price, size, side, expiration }` plus order-type/post-only args. No raw order fields named `nonce`, `taker`, or `feeRateBps` are supplied.
- `packages/live-execution/src/polymarket-client.ts:517-541` uses `trade.taker_order_id` and `liquidityRole: 'taker'` to classify venue fills from Polymarket trade responses.
- `packages/live-execution/src/polymarket-client.ts:643-657` reads `trade.fee_rate_bps` and market fee metadata to estimate taker fill fees for ledger evidence; it does not set order `feeRateBps`.

### Config/env/API surfaces

- `packages/config/src/index.ts:15` defaults `WRAITH_POLYMARKET_CLOB_HOST` to `https://clob.polymarket.com`, which is the current V2 production host per `docs/qa/clob-v2/00-official-research.md`.
- `packages/config/src/index.ts:76-77`, `:154-155`, `:170-197` model `signatureType` and `funderAddress`; these flow into the V2 SDK constructor and are not V1-only assumptions.
- `.env.example:18-30` uses `https://clob.polymarket.com`, leaves funder/private key/API credentials empty, and keeps live execution disabled.
- `apps/api/src/index.ts:38-51` exposes wallet/auth readiness fields including `signatureType` and `funderAddress`; this is operator status surface, not order signing.

### Market data

- `packages/market-data/src/index.ts:4` and `packages/market-data/src/updown-edge.ts:2` use `https://clob.polymarket.com` for read-only CLOB market data. This is the correct production host after the V2 cutover.

### Paper/ledger/test terminology

- `packages/paper-execution/src/index.ts:25`, `:58`, `:65`, `:77`, `:87-88`, `:473` use `feeRateBps` as local paper/simulation fee modeling.
- `packages/paper-execution/src/index.ts:60`, `packages/ledger/src/schemas.ts:28`, and `packages/live-execution/src/index.ts:30,95` use `maker`/`taker` as internal liquidity-role labels.
- Multiple regression tests and client tests use `taker`, `signatureType`, `funderAddress`, and mocked `createAndPostOrder`; these are test coverage hits, not live V1 assumptions.

### Docs/QA hits

- `docs/strategy/UPDOWN_PROFIT_PATH.md:52` says: “When there is no USDC to trade…” This is stale collateral wording after CLOB V2’s pUSD migration.
- `docs/qa/clob-v2/00-official-research.md` intentionally contains many search terms while documenting V2 facts, e.g. legacy SDKs, V1 order fields, pUSD migration, and the correct host.
- `docs/qa/clob-v2/lane-config-env-audit.md` intentionally contains many search terms while documenting config/env findings.

### No-hit terms

No source/package hits were found for:

- `builder-signing-sdk`
- `POLY_BUILDER_*`
- `userUSDCBalance`
- `createAndPostMarketOrder`
- `getPreMigrationOrders`
- `BalanceAllowance`
- `AssetType.COLLATERAL`

No production-code hit was found for `clob-v2.polymarket.com`; it appears only in QA docs as the pre-cutover host that should not be used for production.

## Risk classification

| Classification | Hits | Assessment |
| --- | --- | --- |
| Real code risk | None found for legacy SDK imports, raw V1 order struct fields, builder HMAC headers, V1 pre-migration order APIs, balance-allowance helpers, or stale production host. | No repo-wide source blocker found from V1 CLOB assumptions. |
| Migration-relevant code, no V1 risk | `packages/live-execution/src/polymarket-client.ts`, `packages/config/src/index.ts`, `.env.example`, `packages/market-data/src/*` | Uses V2 SDK, V2 constructor shape, and correct production host. `signatureType`/`funderAddress` remain valid auth/config concepts. |
| False positives | `nonce` in `createOrDeriveApiKey`, `taker` liquidity roles/trade response fields, `feeRateBps` in paper simulation and observed trade fee metadata | These are not V1 order fields being submitted. No fix needed for CLOB V2 order signing. |
| Test/doc only | Regression tests, client tests, `docs/qa/clob-v2/*` | Useful coverage/research artifacts. Not live code risk. |
| Stale docs | `docs/strategy/UPDOWN_PROFIT_PATH.md:52` | Should be updated from generic/legacy `USDC` wording to pUSD-aware or collateral-neutral wording. |

## Must-fix bucket

No must-fix source/package issue was found by this repo-wide static search.

Specifically, the search did **not** find:

- legacy `@polymarket/clob-client` source imports or package dependency;
- Python `py-clob-client` use;
- `builder-signing-sdk` or `POLY_BUILDER_*` headers;
- raw V1 order fields (`nonce`, `taker`, `feeRateBps`) being supplied to order creation;
- V1/pre-migration order APIs (`getPreMigrationOrders`);
- market-order helper usage (`createAndPostMarketOrder`);
- `BalanceAllowance` / `AssetType.COLLATERAL` usage;
- production-code use of `https://clob-v2.polymarket.com`.

## Should-fix bucket

1. **Update stale collateral wording** in `docs/strategy/UPDOWN_PROFIT_PATH.md:52`; prefer `pUSD`, or a neutral phrase such as “Polymarket trading collateral,” depending on the surrounding operator intent.
2. **Add/keep pUSD operator notes** in live-readiness docs/runbooks: CLOB V2 collateral is pUSD, API-only users may need external wrapping/onramp handling, and Wraith should not auto-wrap USDC.e in this migration.
3. **Refresh/pin the V2 SDK dependency when implementation resumes**: package files already use `@polymarket/clob-client-v2`, but the lockfile is on `1.0.0`; the existing research doc observed newer `1.0.2`. This is not a V1 assumption, but it is migration hygiene.
4. **Optional builder attribution decision**: absence of `builderCode`/`builderConfig` is acceptable for basic order placement, but document it or add explicit config only if builder attribution/revenue is a product requirement.

## No-fix bucket

- Keep `https://clob.polymarket.com` as the production CLOB host; V2 now runs there.
- Keep using the official V2 SDK path in `packages/live-execution/src/polymarket-client.ts` rather than introducing raw EIP-712 order signing in this migration.
- No fix needed for `nonce` in `createOrDeriveApiKey`; it is not an order struct field.
- No fix needed for `taker` in liquidity-role modeling or trade response parsing.
- No fix needed for `feeRateBps` in paper execution fee modeling, as long as it remains local/paper and is not sent in live CLOB orders.
- No automatic pUSD wrapping/onramp should be added by this lane; collateral preparation remains external/operator work while live trading remains no-go.

## Confidence score

**90 / 100 — high confidence for repo-wide V1-assumption absence; not a live-capital readiness claim.**

Confidence boosters:

- Static search covered all requested terms across the repo while excluding only `.git` and `node_modules` for the main pass.
- Package/source references point to `@polymarket/clob-client-v2`, not legacy `@polymarket/clob-client`.
- The live order path delegates signing/posting to the V2 SDK and does not construct raw V1 order fields.
- The default and example CLOB host are the current V2 production host.
- No builder HMAC, V1 pre-migration, market-order helper, or balance-allowance API usage was found.

Confidence reducers:

- This lane intentionally did not compile, test, build, or execute project code.
- Static search cannot prove runtime SDK behavior, live wallet pUSD balance/allowance, Polymarket auth/geoblock status, or venue reconciliation correctness.
- The exact search is strong for named V1 assumptions, but unknown future SDK/API edge cases still require normal verification after planning/audit completion.
- Existing docs contain intentionally duplicated migration terms, so documentation hits require human-context classification rather than blind grep counts.
