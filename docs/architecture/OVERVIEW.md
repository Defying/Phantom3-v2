# Phantom3 v2 Overview

This repo is the first executable milestone of the Phantom3 v2 rebuild.

## Implemented today

- phone-accessible dashboard
- read-only Polymarket market snapshot adapter with explicit, venue-scoped transport controls
- paper-safe snapshot strategy signal engine
- pure paper-trading risk evaluation module
- append-only paper ledger and paper execution adapter
- runtime wiring for paper entries plus reduce-only paper exits
- typed runtime exposure for open-position paper exit state
- bounded pause/resume control API
- fail-closed defaults
- modular repo layout
- bootstrap file-backed runtime state

## Still pending

- replay / comparison harness
- live execution adapter
- richer strategy history, depth, and portfolio-aware sizing

## Next milestone pack

The next milestone is a **paper-safe strategy** milestone, not a live-trading milestone.

Use these docs together:
- `docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md`
- `docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md`
- `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md`
