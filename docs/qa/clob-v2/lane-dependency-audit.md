# CLOB V2 Migration Lane — Dependency Audit

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Branch: `audit/clob-v2-readiness-2026-04-28`
- Mode: package metadata / lockfile audit. No live Polymarket calls, wallet calls, credential derivation, wrapping, order placement, tests, builds, or dev servers were run for this lane.

## Verdict

**SDK freshness fix required and applied in the implementation patch.**

Wraith already depended on the official V2 TypeScript package, `@polymarket/clob-client-v2`, but the lockfile was pinned to `1.0.0` while npm metadata showed `1.0.2` as the latest available release during this migration pass.

## Evidence

Before the implementation patch:

- `package.json` declared `"@polymarket/clob-client-v2": "^1.0.0"`.
- `package-lock.json` resolved `node_modules/@polymarket/clob-client-v2` to `1.0.0` from `clob-client-v2-1.0.0.tgz`.
- Registry lookup for `@polymarket/clob-client-v2@1.0.2` returned:
  - tarball: `https://registry.npmjs.org/@polymarket/clob-client-v2/-/clob-client-v2-1.0.2.tgz`
  - integrity: `sha512-lC80Esug6s6y3uV8D5HnkxoXVZUnATjyP6PcK2IXO740iGDuLlp9Dvvkx3+VVygHahN+M3NY7JiYiTQkDfWoeQ==`
  - dependency set including `viem`, `axios`, `tslib`, and `@ethersproject/*` packages.

The implementation patch refreshes package metadata to `^1.0.2` and lock metadata to `1.0.2`.

## Dependency migration assessment

- No legacy `@polymarket/clob-client` package was found in active source/package metadata during prior repo-wide search.
- Active live execution code imports from `@polymarket/clob-client-v2`.
- The installed V2 SDK exposes the V2 shapes this repo is using, including `ClobClient`, `SignatureTypeV2`, `OrderType`, `Side`, order APIs, and authenticated user trade/open-order paths.
- The package bump is lockfile/package metadata only; no source rewrite was required for the current V2 SDK constructor/import shape.

## Risks / not proven

- npm registry metadata can change after this report; re-check before release if the branch sits stale.
- This dependency audit does not prove live trading safety, pUSD balance, pUSD allowance, venue reconciliation, or order placement behavior.
- `npm install` reported existing npm audit findings (`12 low`, `1 moderate`). They were not automatically fixed in this CLOB V2 pass because the requested migration scope is SDK freshness/pUSD docs and because audit fixes can introduce unrelated churn.

## Required verification after patch

- Confirm `package.json` and `package-lock.json` both resolve `@polymarket/clob-client-v2` to `1.0.2`/`^1.0.2`.
- Run TypeScript check to verify the refreshed SDK remains source-compatible.
- Run live-safety and paper-safe guardrail scripts.

## Confidence score

**91 / 100** — high confidence that the dependency freshness issue is correctly scoped and that the patch resolves it.

Confidence boosters:

- Direct package and lockfile inspection.
- Direct npm registry metadata lookup for `1.0.2`.
- Active source already imports the V2 package.

Confidence reducers:

- Static/package audit only; no live SDK calls were made.
- Did not inspect upstream SDK changelog diff between `1.0.0` and `1.0.2` line-by-line.
- Existing npm audit findings remain outside this migration scope.
