# CLOB V2 Migration Lane — Live Safety / Runbook Static Audit

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Mode: static inspection only. No npm scripts, tests, builds, dev servers, live API calls, credential derivation, or project code execution were run.
- Output constraint: this audit file is the only file written by this lane.

## Scope inspected

Primary requested files:

- `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md`
- `docs/qa/LIVE_THIN_SLICE_REVIEW_CHECKLIST.md`
- `package.json`
- `apps/api/src/index.ts`
- `apps/api/src/runtime-store.ts`
- `packages/live-execution/src/index.ts`

Supporting static context inspected because it directly affects live safety / CLOB V2 posture:

- `packages/live-execution/src/polymarket-client.ts`
- `packages/config/src/index.ts`
- `docs/architecture/MILESTONE_3_LIVE_TRADING_THIN_SLICE.md`
- `docs/qa/clob-v2/00-official-research.md`
- `docs/qa/clob-v2/lane-repo-wide-v1-search.md`
- `docs/qa/clob-v2/lane-config-env-audit.md`
- `packages/paper-execution/src/live-safety.regression.test.ts` — read only
- `packages/live-execution/src/live-execution.regression.test.ts` — read only
- `packages/live-execution/src/live-safety.regression.test.ts` — read only
- `packages/live-execution/src/polymarket-client.test.ts` — read only
- `apps/api/src/runtime-store.live-controls.test.ts` — read only

## Findings

1. **The operator docs still correctly say live capital is no-go.**
   - The runbook status is `planned / no-go for live capital` and explicitly warns not to infer readiness from live flags, endpoints, adapter code, or `npm run verify:live-safety`.
   - The review checklist requires durable order/fill evidence, realized P&L from fills/fees only, visible unmatched/open orders, inventory reservation for working sells/flatten, executable venue prices only, and cold-start rebuild from ledger + venue truth.
   - The architecture doc still describes Milestone 3 as planned/not implemented and requires fail-closed ambiguity handling, one live writer/account/market/entry, limit orders only, no pyramiding, and no unattended live resume until reconciliation passes.

2. **CLOB V2 SDK compatibility is not the live-safety blocker.**
   - `package.json` depends on `@polymarket/clob-client-v2`.
   - `packages/live-execution/src/polymarket-client.ts` imports from `@polymarket/clob-client-v2` and constructs `new ClobClient({ host, chain, signer, creds, signatureType, funderAddress, useServerTime, throwOnError })`, matching the V2 options-object path recorded by the CLOB V2 research lane.
   - The submit path delegates order signing/posting to the V2 SDK via `createAndPostOrder` with `tokenID`, `price`, `size`, `side`, optional `expiration`, GTC/GTD order type, and `postOnly`; no raw V1 order struct rewrite was found in the inspected live submit path.
   - This only removes a compatibility class of blocker. It does **not** prove venue reconciliation, restart safety, collateral readiness, or operator readiness.

3. **The API can install a wallet-backed gateway, but it is fail-closed when setup fails.**
   - `apps/api/src/index.ts` installs `PolymarketLiveGateway` only outside simulation mode, only when live mode and live execution are enabled, and only for the Polymarket venue.
   - Gateway creation failures set `liveSetupError` and return no live exchange, which keeps arming blocked/scaffolded.
   - `/api/live/wallet` exposes sanitized readiness state for runtime mode, live flags, CLOB host, chain ID, signature type, funder/private-key/API-credential readiness, derivation posture, gateway installation, and setup error. It does not return private keys, API secrets, or passphrases.
   - Live control endpoints are token-gated, and simulation mode rejects live arming/disarming.

4. **Startup reconciliation exists in code, but it is not yet enough to prove venue truth.**
   - `RuntimeStore.init()` calls `reconcileLiveStartupState('startup')` after ledger/state hydration.
   - If startup reconciliation returns dirty or throws, `runtime-store.ts` engages the durable live kill switch and blocks arming.
   - However, the default Polymarket snapshot wired by `apps/api/src/index.ts` is `gateway.fetchVenueStateSnapshot()` with no tracked-order query. In the inspected adapter, that snapshot fetches open orders, but does not populate venue `positions`, and only fetches fills when explicit `venueOrders` are supplied.
   - Consequence: startup can fail closed for tracked ledger positions missing from the empty venue-position snapshot, and it can surface open/unmatched venue orders. But it cannot currently prove “venue flat” for residual token inventory that exists outside the ledger, because no venue position/balance inventory is fetched into `positions`.
   - There is also no continuous reconciliation loop/cursor in the inspected runtime path; startup and submit-path reconciliation are not a full live recovery system.

5. **The live adapter has strong evidence-first guards, but they remain adapter-level guardrails.**
   - `LiveExecutionAdapter.submitApprovedIntent()` persists the intent and `pending-submit` order before the exchange submit call, preserving `clientOrderId` for recovery.
   - Submit exceptions or ambiguous submit responses move the order to `reconcile`, not “probably rejected.”
   - Reconciliation requires fresh venue snapshots, stable fill IDs, matching client/venue order IDs, matching market/token/side, consistent requested/filled/remaining quantities, and explicit full fill evidence before marking filled.
   - Duplicate candidate orders, missing tracked orders after grace, stale snapshots, ambiguous venue snapshots, unmatched venue orders, and unmatched venue fills are surfaced and/or force `reconcile`.
   - Sell paths reserve active sell inventory and reject oversell against reconciled live inventory.
   - A durable kill switch blocks non-reduce-only live entries.

6. **Arming does not mean automated live trading is implemented.**
   - `RuntimeStore.armLive()` only arms the live control plane after readiness gates pass.
   - The runtime event message explicitly says automated strategy entries remain paper-only.
   - The inspected strategy submission path still calls `paperExecution.submitApprovedIntent(...)` for approved entries.
   - Therefore, even an `adapter-ready`/armed API state should not be marketed as “live trading enabled.” It is, at most, an operator-control scaffold with a live flatten path when reconciled live inventory already exists.

7. **Flatten and kill-switch behavior are partially hardened but not complete.**
   - Runtime flatten refuses stale market data, missing current market snapshots, open orders, mixed/unknown provenance, simulation mutation of live provenance, startup-reconcile blockers, and live projection blockers.
   - Live flatten uses `requestFlatten()`, which records an operator action first and submits a reduce-only sell for unreserved reconciled inventory.
   - `requestFlatten()` fails closed when same-market working buy orders exist and reserves existing working sell quantity.
   - Kill-switch release fails closed when startup reconciliation is dirty or when live reconcile orders, active live orders, open live positions, or mixed positions remain.
   - Remaining gap: the architecture requires a full flatten state machine that cancels working entries, fetches fresh venue position/open-order state, reconciles until flat, and stays latched across restart. The inspected code still blocks instead of performing that full cancel/reconcile workflow.

8. **Automated verification script names exist, but current coverage is not a live-readiness certificate.**
   - `package.json` defines:
     - `check`: `tsc --noEmit -p tsconfig.json`
     - `test:live-safety`: `node --import tsx --test packages/paper-execution/src/live-safety.regression.test.ts packages/live-execution/src/live-execution.regression.test.ts apps/api/src/runtime-store.live-controls.test.ts`
     - `verify:live-safety`: `npm run check && npm run test:live-safety`
   - Static read of tests found relevant coverage for evidence-first live fills, stale snapshots, duplicate candidates, unmatched orders/fills, restart recovery by `clientOrderId`, reduce-only flatten reservations, startup reconciliation kill-switch latch, kill-switch persistence, and simulation/live provenance separation.
   - Important static mismatch: `packages/live-execution/src/live-safety.regression.test.ts` and `packages/live-execution/src/polymarket-client.test.ts` are relevant to live safety / CLOB V2 SDK behavior but are not included in `test:live-safety` as currently named in `package.json`.
   - No tests were run in this lane by instruction.

9. **Runbook wording has a small internal staleness/conflict, but the no-go conclusion remains right.**
   - One hard-stop warning says the main API runtime still does not run a venue-backed boot reconciliation flow.
   - The code now can install a gateway and call startup reconciliation when live env is complete.
   - The later runbook blocker already reflects that nuance: gateway/startup reconciliation code exists but still needs a real traced dry/live review on the intended wallet.
   - Recommendation: update wording later to avoid contradiction, while preserving the stronger “not live-capital ready” stance.

## Live Go/No-Go Recommendation

**NO-GO for live capital after the CLOB V2 migration.**

CLOB V2 compatibility work should not enable live trading. The repo appears to be on the V2 SDK path, but live-capital readiness is blocked by operational safety gaps: incomplete venue position inventory in startup snapshots, no proven real-wallet startup reconciliation, no continuous reconciliation/cursor loop, partial flatten/cancel workflow, incomplete incident handling for unmatched venue evidence, and unrun/unexpanded verification gates.

The safe posture is:

- keep default runtime/paper behavior;
- keep live execution disabled unless explicitly configured for a controlled review;
- do not route automated strategy entries to live;
- do not place live orders merely because the CLOB V2 SDK path compiles or wallet readiness reports configured auth;
- treat any live adapter/control endpoint state as scaffolding until the required evidence gates below are completed.

## Required Safety Gates Before Any Live Capital

All of these should remain explicit blockers before any real capital is used:

1. `npm run check` passes.
2. `npm run verify:live-safety` passes after the live-safety test script is reviewed/expanded to include all relevant live safety and Polymarket client tests, or an explicit rationale is documented for exclusions.
3. `docs/qa/LIVE_THIN_SLICE_REVIEW_CHECKLIST.md` is completed with reviewer/operator sign-off.
4. A real intended-wallet venue trace proves startup reconciliation from venue truth: open orders, historical/recent fills, current token inventory/positions, unmatched venue order/fill behavior, and kill-switch latch behavior.
5. A live or venue-backed dry trace covers `intentId -> clientOrderId -> venueOrderId -> fills -> ledger lots -> projected position`.
6. A partial-fill trace proves no double counting, no dropped tracking, and correct remaining order/position quantity.
7. A missing/ambiguous ACK trace proves recovery by persisted `clientOrderId` and blocks new risk until reconciled.
8. A flatten trace proves reduce-only behavior, inventory reservation, fresh venue inventory, and final flat state from fill evidence only.
9. A restart during open live state proves no auto-resume until reconciliation is clean.
10. Unmatched venue order/fill evidence is converted into an operator-visible incident or durable kill-switch latch, not merely returned from an adapter call.
11. Kill-switch release requires fresh venue reconciliation, no unresolved incidents, no orphaned venue orders/fills/positions, no open live inventory, and explicit operator action.
12. CLOB V2 pUSD collateral readiness is documented and verified externally: funded pUSD balance/allowance where required, no stale USDC.e assumptions, and no automatic wrapping/onramp behavior hidden inside Wraith.
13. Operator docs are updated to remove contradictory boot-reconcile wording while preserving no-go warnings and pUSD/CLOB V2 cutover warnings.
14. Dependency lock freshness for `@polymarket/clob-client-v2` is handled by the migration implementation and then verified through the normal gates.

## CLOB V2 Cutover/Open-Order-Wipe Implications

Official CLOB V2 research in this repo records that resting V1-era open orders were wiped at cutover and must be recreated with V2 signing. For Wraith live safety, that has these implications:

1. **Do not auto-recreate wiped orders.** A missing open order after cutover is not a signal to blindly re-submit. Recreating orders requires a fresh operator decision, current quote/risk review, CLOB V2 signing path, and proof there are no late fills or residual inventory surprises.
2. **Missing tracked orders should stay fail-closed until explicitly reconciled.** The adapter already marks tracked active orders as `reconcile` when they are absent from a fresh venue snapshot after the missing-order grace window. Startup reconciliation then becomes dirty and the runtime should block arming / latch the kill switch.
3. **A wiped buy entry is not equivalent to a rejected order unless fill history proves zero fills.** If the order partially filled before the wipe, the account may hold inventory even though the order no longer appears open. Wraith must reconcile fills and venue positions before concluding there is no exposure.
4. **A wiped sell/flatten order is not a close.** If a reduce-only exit was resting and then wiped, the position remains open unless venue fills prove otherwise. Local inventory reservations for that sell should remain blocking until a venue-backed cancel/wipe reconciliation event or explicit operator resolution updates the ledger safely.
5. **Current snapshot wiring is not sufficient to prove cutover cleanliness.** `fetchVenueStateSnapshot()` currently returns open orders and optionally tracked fills, but does not populate venue positions by default. A cutover with no open orders but residual token inventory could be missed if the ledger is flat and no venue position snapshot is supplied.
6. **Cutover should be treated as an incident boundary.** If any local live ledger state predates the V2 cutover, require manual reconciliation/annotation before arming. Preserve the no-go stance until open-order wipe implications are tested against a real or venue-faithful snapshot.

## Confidence Score 0-100 and factors

**84 / 100** confidence in this static no-go assessment.

Confidence boosters:

- Directly read the requested runbook, checklist, package scripts, API gateway/readiness code, runtime live controls, live execution adapter, Polymarket client, architecture doc, and relevant tests.
- Findings align across docs and code: guardrails exist, but live-capital evidence requirements remain unmet.
- Static inspection found concrete fail-closed mechanisms: persisted `clientOrderId` before submit, reconcile-on-ambiguity, kill-switch persistence, startup reconciliation latch, sell inventory reservation, and reduce-only flatten behavior.
- CLOB V2 SDK usage is clearly visible in the live client path, reducing uncertainty around legacy SDK/order-shape risk.

Confidence reducers:

- No compile, tests, builds, dev servers, project code, live API calls, or credential derivation were run by instruction.
- Static inspection cannot prove real Polymarket behavior, pUSD balance/allowance, geoblock/auth behavior, or production SDK edge cases.
- Startup reconciliation behavior depends on runtime deployment env and real venue responses that were not exercised.
- The inspected snapshot path lacks venue positions by default; exact remediation requires implementation/design work beyond this audit.
- Package-lock freshness and any post-migration code changes were not dynamically verified in this lane.
