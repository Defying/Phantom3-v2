# CLOB V2 Migration Lane — Config / Env Static Audit

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Mode: static inspection only; no npm scripts, tests, builds, dev servers, live API calls, credential derivation, or project code execution.
- Output constraint: this audit file is the only file written by this lane.

## Scope inspected

Primary requested files:

- `packages/config/src/index.ts`
- `packages/config/src/index.test.ts`
- `.env.example`
- `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md`

Supporting static context inspected/read because it was directly relevant to CLOB V2 config/env correctness:

- `docs/qa/clob-v2/00-official-research.md`
- `docs/qa/clob-v2/lane-repo-wide-v1-search.md`
- `docs/strategy/UPDOWN_PROFIT_PATH.md`
- `docs/qa/LIVE_THIN_SLICE_REVIEW_CHECKLIST.md`
- `packages/live-execution/src/polymarket-client.ts` excerpt covering SDK client construction/auth derivation
- `apps/api/src/index.ts` excerpt covering `/api/live/wallet` readiness surface
- Static `rg` searches for `builderCode`/builder config, V1/stale host clues, `PHANTOM3_V2`, `USDC`/`pUSD`, Polymarket env names, signature/funder/API credential wording

## Findings

### 1) Production host and chain defaults are CLOB V2-correct

- `packages/config/src/index.ts` defaults `WRAITH_POLYMARKET_CLOB_HOST` to `https://clob.polymarket.com`.
- `.env.example` also uses `https://clob.polymarket.com`.
- `packages/config/src/index.ts` defaults `WRAITH_POLYMARKET_CHAIN_ID` to `137`, and `polymarketChainIdSchema` permits `137` and `80002`.
- The live Polymarket client maps `137` to Polygon and `80002` to Amoy in the inspected static excerpt.
- Static search did not find `https://clob-v2.polymarket.com` or a stale production host in the inspected repo content.

Assessment: good for CLOB V2 production defaults. Keep host override support only if operators understand it is an explicit non-default/testing path.

### 2) Signature type, funder, private key, and API credential handling are mostly fail-closed

- Signature types `0`, `1`, `2`, and `3` are accepted.
- Private keys must be `0x` + 32-byte hex when supplied.
- Funder addresses must be `0x` + 20-byte hex when supplied.
- If a private key is present and signature type is non-EOA (`1`-`3`), config throws unless `WRAITH_POLYMARKET_FUNDER_ADDRESS` is supplied.
- L2 API credentials are all-or-nothing: `WRAITH_POLYMARKET_API_KEY`, `WRAITH_POLYMARKET_API_SECRET`, and `WRAITH_POLYMARKET_API_PASSPHRASE` must be supplied together.
- `WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION` defaults to `false`; derivation requires an explicit flag.
- Tests cover derivation-ready auth, partial API credential rejection, funder requirement when a private key is present, and simulation-mode fail-closed behavior with invalid/partial auth env.

Minor caveat: non-EOA signature types without a private key do not immediately require a funder. That is not an order-placement bypass because no private key means no authenticated live client, but earlier validation would produce clearer operator feedback.

### 3) API key derivation posture is explicit but readiness wording can over-read as “placeable”

- With a private key, no L2 API credentials, and `WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION=true`, config reports:
  - `hasApiCredentials=false`
  - `needsApiKeyDerivation=true`
  - `canAccessAuthenticatedApi=true`
  - `canPlaceOrders=true`
- The live client then derives credentials before returning an armed client.

Assessment: this is reasonable as an internal capability model, but operator-facing docs/readiness should keep emphasizing `needsApiKeyDerivation` so humans do not mistake “derivation permitted” for “existing API credentials already present.”

### 4) Live defaults are disabled / disarmed by default

- `.env.example` sets:
  - `WRAITH_RUNTIME_MODE=simulation`
  - `WRAITH_ENABLE_LIVE_MODE=false`
  - `WRAITH_ENABLE_LIVE_ARMING=false`
  - `WRAITH_LIVE_EXECUTION_ENABLED=false`
- Source defaults keep live mode, live arming, and live execution disabled unless explicitly enabled.
- `readConfig()` hard-disables live execution in `simulation` mode even if live flags and malformed auth env are present.
- The runbook remains explicit **no-go for live capital** and warns that live flags/control endpoints are scaffolding, not readiness proof.

Assessment: good. CLOB V2 migration should not change the no-go/live-disabled stance.

### 5) Builder attribution is absent, not partially migrated

- No `builderCode`, `builderConfig`, `POLY_BUILDER_*`, or builder-signing config was found outside the existing CLOB V2 research doc.
- `packages/config/src/index.ts` has no builder env.
- The inspected live client construction does not pass `builderConfig`.

Assessment: no broken partial builder migration was found. This is not a CLOB V2 blocker unless Ben wants builder attribution/revenue; if he does, it needs an explicit new env/config design such as a `WRAITH_POLYMARKET_BUILDER_CODE` path plus tests/docs.

### 6) pUSD / USDC wording still needs doc cleanup

- Config/env files do not model collateral currency directly.
- The runbook wallet/auth section lists signer/API requirements but does not mention CLOB V2 pUSD collateral, pUSD balance, pUSD allowance, or that Wraith should not auto-wrap USDC.e in this pass.
- `docs/strategy/UPDOWN_PROFIT_PATH.md` still says “When there is no USDC to trade,” which is stale after CLOB V2’s pUSD collateral migration.
- `docs/qa/clob-v2/00-official-research.md` already records the correct V2 fact: pUSD replaces USDC.e as trading collateral and docs/operator wording should say pUSD.

Assessment: documentation mismatch, not a config-code blocker. Fix before any operator-facing CLOB V2/live review.

### 7) Legacy `PHANTOM3_V2_*` env fallback is the main stale-name risk

- `withLegacyPhantomEnv()` silently maps every missing `WRAITH_*` env var from a corresponding `PHANTOM3_V2_*` env var.
- This is broad backward compatibility, not a literal CLOB V1 variable name, but it can silently import stale pre-Wraith/pre-migration env into live Polymarket config if `WRAITH_*` values are absent.
- No docs/examples found instruct operators to use `PHANTOM3_V2_*`, and no stale V1 production host string was found.

Assessment: not an immediate CLOB V2 correctness failure, but it is a migration footgun. Live CLOB V2 operation should prefer explicit `WRAITH_*` env and either warn on or reject legacy fallback for live execution.

### 8) `.env.example` has non-CLOB security-risky operator defaults

- Source defaults are local/safe (`WRAITH_HOST=127.0.0.1`, `WRAITH_REMOTE_DASHBOARD=false`).
- `.env.example` instead sets `WRAITH_HOST=0.0.0.0` and `WRAITH_REMOTE_DASHBOARD=true`.
- `.env.example` also uses `WRAITH_CONTROL_TOKEN=replace_me_with_a_long_random_token`, which currently satisfies the schema minimum length if copied verbatim.
- Live trading remains disabled in `.env.example`, so this is not a direct CLOB V2 order-placement risk. It is still a risky example for a control-plane/operator surface.

Assessment: should harden docs/example before telling an operator to copy it onto any reachable host.

## Must Fix

No source-level CLOB V2 config/env **must-fix** was found in the inspected lane:

- Production host default is `https://clob.polymarket.com`.
- Production chain default is `137`.
- Live execution defaults are disabled.
- API credentials are all-or-nothing.
- API key derivation is opt-in.
- Private key/funder validation is present for live-auth-capable non-EOA signature configs.
- No stale `clob-v2.polymarket.com` production target or legacy V1 SDK env path was found in the inspected files/searches.

Important boundary: this does **not** mean Wraith is ready for live capital. The runbook’s no-go posture remains correct.

## Should Fix

1. **Harden `.env.example` operator exposure defaults.** Prefer localhost/remote-off in the example, or make the comments extremely explicit. Also make the sample `WRAITH_CONTROL_TOKEN` unmistakably non-reusable and ideally rejected by schema if copied unchanged.
2. **Deprecate or guard `PHANTOM3_V2_*` fallback for live execution.** At minimum warn when legacy names populate live Polymarket config; stronger option is to require explicit `WRAITH_*` vars when `WRAITH_LIVE_EXECUTION_ENABLED=true`.
3. **Add pUSD collateral wording to operator docs.** The runbook should say CLOB V2 live trading collateral is pUSD, API-only users may need external wrapping/onramp handling, and Wraith does not auto-wrap USDC.e in this migration.
4. **Update stale `USDC` wording in `docs/strategy/UPDOWN_PROFIT_PATH.md`.** Use pUSD or a neutral phrase like “Polymarket trading collateral” depending on context.
5. **Clarify builder attribution absence.** Add a short doc note that Wraith currently does not pass `builderCode`/`builderConfig`; no action is needed unless builder attribution is desired.
6. **Consider earlier funder validation.** For clearer operator feedback, non-EOA `WRAITH_POLYMARKET_SIGNATURE_TYPE=1..3` could require `WRAITH_POLYMARKET_FUNDER_ADDRESS` when live execution is enabled, even before a private key is present.
7. **Add static/unit coverage for config migration edges when code changes resume.** Suggested cases: exact default host/chain, rejection/warning around legacy fallback in live mode, copied `.env.example` token behavior, and readiness output when derivation is permitted but credentials are not yet present.

## No Fix Needed

- No change needed for the default CLOB host; it is already the V2 production host.
- No change needed for the default production chain ID; it is already Polygon `137`.
- No forced `builderCode` work is needed for basic order placement; absence is acceptable unless builder attribution is a product requirement.
- No automatic pUSD wrapping/onramp behavior should be added in config. Collateral preparation is external/operator work while live remains no-go.
- No secret should be added to examples/docs. Current example correctly leaves private key and API credential values empty.
- No dynamic verification should be run from this lane; static-only constraint was respected.

## Documentation Updates

Recommended documentation edits after this audit lane:

1. `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md`
   - Add a “CLOB V2 / pUSD collateral” note to Wallet/auth status.
   - State that signer + L2 API credentials are necessary but not sufficient; live review also needs pUSD balance/allowance evidence, venue truth reconciliation, and no-go checklist completion.
   - State Wraith does not auto-wrap USDC.e or perform collateral migration in this pass.
   - Warn not to use pre-cutover hosts such as `https://clob-v2.polymarket.com` for production.
2. `.env.example`
   - Consider changing host/remote dashboard defaults to match safe source defaults.
   - Add comments that the CLOB host default is the current V2 production host.
   - Add comments that `ALLOW_API_KEY_DERIVATION=true` may create/derive L2 credentials from the signer and should be intentionally enabled only.
   - Add an optional note that builder attribution is unsupported unless a future `builderCode` env is added.
3. `docs/strategy/UPDOWN_PROFIT_PATH.md`
   - Replace stale “USDC to trade” wording with pUSD-aware or collateral-neutral wording.
4. `docs/qa/clob-v2/lane-repo-wide-v1-search.md`
   - That file currently reads as pending. Either complete it in its own lane or avoid treating it as finished CLOB V2 evidence.

## Confidence Score

**88 / 100 — high confidence for config/env static correctness; not live-capital confidence.**

Confidence boosters:

- Read the requested config, test, env example, and runbook files directly.
- Read CLOB V2 official-research artifact already present in the repo.
- Inspected supporting live client construction/readiness snippets to verify config fields are consumed as expected.
- Ran static searches for builder support, V1/stale host clues, legacy env names, and pUSD/USDC wording.
- Found no dynamic execution, no npm scripts, no tests, no builds, no dev servers, no live API calls, and no credential derivation in this lane.

Confidence reducers:

- This lane did not compile or run tests by instruction.
- No real live environment, funded wallet, pUSD balance/allowance, Polymarket geoblock, or API credential behavior was verified.
- Official CLOB V2 facts were taken from the repo’s existing research artifact rather than re-fetching every official source in this lane.
- Runtime behavior could still depend on environment/deployment details outside the inspected files.
