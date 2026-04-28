# CLOB V2 Migration Lane — Docs Consistency Review

- Date: 2026-04-28
- Repo: `/Volumes/Carve/Projects/wraith`
- Mode: static documentation/config-example review only. No tests, builds, dev servers, live API calls, wallet calls, credential derivation, order calls, balance calls, wrapping, or project execution were run.
- Output constraint: this report is the only file written by this lane.

## Scope inspected

Target scope requested by the orchestrator:

- `docs/qa/clob-v2/`
  - `00-official-research.md`
  - `lane-config-env-audit.md`
  - `lane-live-safety-audit.md`
  - `lane-pusd-allowance-audit.md`
  - `lane-repo-wide-v1-search.md`
- `docs/runbooks/`
  - `LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md`
  - `PAPER_SAFE_OPERATOR_RUNBOOK.md`
- `docs/strategy/`
  - `UPDOWN_PROFIT_PATH.md`
- `.env.example`

## Executive verdict

The core CLOB V2 / pUSD / no-auto-wrap / live-no-go posture is mostly consistent in the QA artifacts:

- CLOB V2 production host is consistently `https://clob.polymarket.com`.
- The QA docs consistently treat pUSD as CLOB V2 trading collateral.
- The QA docs consistently say Wraith should **not** auto-wrap USDC.e to pUSD in this migration.
- The live-capital answer remains consistently **no-go**; no inspected doc claims Wraith is ready to trade live capital today.

However, a few operator-facing docs are still stale or underspecified. The most important fixes are to surface pUSD/no-auto-wrap in the live runbook and `.env.example`, remove the remaining `USDC` wording in the strategy doc, and resolve a boot-reconcile wording contradiction in the live runbook.

## Findings

### 1) Must fix: live runbook and `.env.example` do not yet surface pUSD collateral / no-auto-wrap clearly enough

**Evidence**

- `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md:21-34` describes wallet/auth status and required env for a wallet-backed live gateway, but does not mention pUSD balance, pUSD allowance, POL gas, outcome-token allowance, or no automatic USDC.e wrapping.
- `.env.example:22-31` comments on API-key derivation, funder address, private key, and L2 credentials, but has no CLOB V2 pUSD/no-auto-wrap/operator-collateral warning.
- `docs/qa/clob-v2/00-official-research.md`, `lane-config-env-audit.md`, `lane-pusd-allowance-audit.md`, and `lane-live-safety-audit.md` all converge on the same constraint: CLOB V2 trading collateral is pUSD, signer/API credentials are not enough, and Wraith should not auto-wrap USDC.e in this pass.

**Why it matters**

The operator-facing runbook currently tells a human what env is required for a wallet-backed gateway. Without adjacent pUSD wording, that can be misread as “auth configured = trade-capable.” The QA docs correctly reject that interpretation, but the runbook/example env should carry the same warning.

**Suggested fix**

Add a short “CLOB V2 / pUSD collateral” note under `Wallet/auth status`, for example:

> CLOB V2 trading collateral is pUSD. `/api/live/wallet` is auth/gateway readiness only; it does not prove pUSD balance, pUSD allowance, POL gas, or outcome-token allowance. Wraith does not auto-wrap USDC.e or perform collateral migration in this pass. Collateral preparation is an explicit external operator action, and live capital remains no-go until venue-backed evidence gates are complete.

Also add a concise `.env.example` comment near the Polymarket live vars:

> CLOB V2 uses pUSD collateral. These auth vars do not prove pUSD balance/allowance; Wraith does not auto-wrap USDC.e.

### 2) Must fix: strategy doc still says `USDC` and its “promote to live” wording is too weakly gated

**Evidence**

- `docs/strategy/UPDOWN_PROFIT_PATH.md:40` says: “Promote to live only after enough paper samples show positive realized EV after spread/slippage.”
- `docs/strategy/UPDOWN_PROFIT_PATH.md:52` says: “When there is no USDC to trade...”

**Why it matters**

The `USDC` wording is stale after CLOB V2’s pUSD collateral migration. Separately, positive paper EV is necessary for a live review but not sufficient for live capital; the live runbook also requires venue reconciliation, pUSD readiness, incident handling, restart safety, and no-go checklist completion.

**Suggested fix**

- Replace line 52 with collateral-neutral or pUSD-aware wording, e.g. “When there is no pUSD / Polymarket trading collateral available...” or simply “When there is no trading collateral available...”
- Replace “Promote to live” with “Only consider a live review...” and cross-reference `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md` before any live capital.

### 3) Must fix before operator use: live runbook has an internal boot-reconcile wording conflict

**Evidence**

- `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md:14-15` says the control endpoints exist, “but the main API runtime still does not run a venue-backed boot reconciliation flow.”
- `docs/runbooks/LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md:38-39` later says `apps/api/src/index.ts` can install a Polymarket wallet-backed gateway and `runtime-store.ts` can run startup reconciliation from that gateway.
- `docs/qa/clob-v2/lane-live-safety-audit.md` resolves the nuance: startup reconciliation exists in code, but it is not proven against real venue state and is not enough to prove venue truth/live readiness.

**Why it matters**

The no-go conclusion is still correct, but the contradiction can confuse an operator about whether reconciliation exists at all.

**Suggested fix**

Replace the hard-stop wording with the more precise current state, for example:

> `/api/control/live/*`, `/api/control/flatten`, and `/api/control/kill-switch/*` exist, and startup reconciliation code can run when a wallet-backed live gateway is configured. That path is still unproven against real venue state, lacks complete venue-position evidence, and is not an operator-safe live-readiness proof.

### 4) Should fix: paper runbook’s “live execution is intentionally not implemented” is stale as an absolute statement

**Evidence**

- `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md:9-10` says the repo is not live-trading ready and “Live execution is intentionally not implemented in this milestone.”
- The live runbook and QA artifacts now describe wallet/auth wiring, a Polymarket gateway path, live controls, startup reconciliation scaffolding, and live adapter guardrails.

**Why it matters**

The paper runbook preserves the right no-go behavior, but the absolute “not implemented” claim is stale relative to current live scaffolding. This is a small consistency issue, not a safety reversal.

**Suggested fix**

Change the second sentence to something like:

> Live execution/control scaffolding may exist, but this milestone is not live-trading ready. Do not load live credentials for paper sessions.

### 5) Should fix: `.env.example` is inconsistent with paper-safe exposure guidance

**Evidence**

- `.env.example:1-3` defaults to `WRAITH_HOST=0.0.0.0` and `WRAITH_REMOTE_DASHBOARD=true`.
- `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md:15-16` warns not to expose the dashboard publicly.
- `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md:31-34` says to set a fresh `WRAITH_CONTROL_TOKEN` and prefer `WRAITH_REMOTE_DASHBOARD=false` unless remote access is truly needed.
- `.env.example:32` uses `WRAITH_CONTROL_TOKEN=replace_me_with_a_long_random_token`, which the config audit notes may satisfy schema if copied verbatim.

**Why it matters**

This is not a CLOB V2 signing issue, and live execution remains disabled by default. But it is an operator-safety consistency problem in the same runbook/example surface.

**Suggested fix**

Prefer source-safe defaults in `.env.example`:

- `WRAITH_HOST=127.0.0.1`
- `WRAITH_REMOTE_DASHBOARD=false`
- unmistakably invalid placeholder token or comments requiring replacement before startup

If remote defaults are intentionally kept, add loud comments tying them to trusted private tunnels only.

### 6) Low: QA artifacts have minor historical/status drift now that more lane files exist

**Evidence**

- `docs/qa/clob-v2/00-official-research.md:83-90` still says subagent lane audits are running and implementation should proceed only after the full markdown planning/audit set exists.
- `docs/qa/clob-v2/lane-config-env-audit.md:158-159` says `lane-repo-wide-v1-search.md` “currently reads as pending,” but the inspected repo now contains a completed `lane-repo-wide-v1-search.md`.

**Why it matters**

These are understandable chronological artifacts, not bad CLOB V2 guidance. But if the QA folder is used as a final evidence packet, stale status text can make the packet look unfinished.

**Suggested fix**

Either preserve the lane files as historical point-in-time reports and add a final rollup/index explaining chronology, or update the stale status references once all lanes land.

## Positive consistency notes

- No inspected target doc says live capital is ready today.
- No inspected target doc instructs Wraith to auto-wrap USDC.e into pUSD.
- `.env.example` keeps `WRAITH_RUNTIME_MODE=simulation`, `WRAITH_ENABLE_LIVE_MODE=false`, `WRAITH_ENABLE_LIVE_ARMING=false`, and `WRAITH_LIVE_EXECUTION_ENABLED=false`.
- The QA docs consistently distinguish CLOB V2 SDK/API compatibility from live-capital readiness.
- The target docs consistently identify `https://clob.polymarket.com` as the current production CLOB host and treat `https://clob-v2.polymarket.com` as non-production/pre-cutover context only.

## Suggested fix order

1. Update `LIVE_THIN_SLICE_OPERATOR_RUNBOOK.md` for pUSD/no-auto-wrap/auth-not-collateral-ready wording and boot-reconcile nuance.
2. Update `UPDOWN_PROFIT_PATH.md` to remove stale `USDC` wording and soften “Promote to live” into “consider live review only after...” with a live-runbook cross-reference.
3. Add pUSD/no-auto-wrap comments to `.env.example`; consider changing dashboard exposure/token defaults as a separate operator-safety cleanup.
4. Update `PAPER_SAFE_OPERATOR_RUNBOOK.md` stale “live execution is intentionally not implemented” wording.
5. Add a final CLOB V2 QA rollup/index or refresh stale status lines in the lane artifacts.

## Confidence score

**87 / 100 — high confidence in the documentation-consistency findings; not a live-capital readiness claim.**

Confidence boosters:

- Directly inspected all requested target docs and `.env.example`.
- Findings are cross-supported by multiple lane artifacts.
- The main inconsistencies are exact operator-facing lines, not speculative code behavior.

Confidence reducers:

- Static review only; no tests, builds, runtime inspection, live calls, wallet checks, or official-doc re-fetching were performed in this lane.
- Some QA artifacts are intentionally point-in-time reports, so “stale” status text may be acceptable if a final rollup preserves chronology.
- This review assumes the current checked-out files are the orchestrator’s latest landed edits.
