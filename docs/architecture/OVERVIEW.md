# Wraith Overview

This repo is the first executable milestone of the Wraith rebuild.

## Implemented today

- phone-accessible dashboard
- read-only Polymarket market snapshot adapter
- paper-safe snapshot strategy signal engine
- pure paper-trading risk evaluation module
- bounded pause/resume control API
- fail-closed defaults
- modular repo layout
- bootstrap file-backed runtime state

## Still pending

- append-only paper ledger
- strategy engine runtime wiring into the worker/runtime loop
- paper execution adapter
- replay / comparison harness
- live execution adapter

## Next milestone pack

The next milestone is a **paper-safe strategy** milestone, not a live-trading milestone.

Use these docs together:
- `docs/milestones/PAPER_SAFE_STRATEGY_MILESTONE.md`
- `docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md`
- `docs/runbooks/PAPER_SAFE_OPERATOR_RUNBOOK.md`

## Planned live-trading design reference

The first live-capital spec is documented separately and remains **planned, not implemented**:
- `docs/architecture/MILESTONE_3_LIVE_TRADING_THIN_SLICE.md`
