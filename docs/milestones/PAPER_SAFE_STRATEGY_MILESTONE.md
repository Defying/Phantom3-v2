# Paper-safe strategy milestone

Status: planned, not yet achieved

## What this milestone means

This is the first milestone where a strategy loop may run against live market data **in paper mode only**.

"Paper-safe" here means:
- no live order submission path is used
- every strategy decision is traceable end-to-end
- an operator can pause the runtime and explain what happened
- paper results are recorded in durable ledger truth, not just transient UI state

It does **not** mean:
- profitable
- ready for unattended operation
- safe for public internet exposure
- ready for live capital

## Current truth today

Today this repo is still a read-only observer milestone.

Not landed yet:
- strategy engine
- risk engine
- append-only paper ledger
- paper execution adapter
- replay and side-by-side verification harness

Until those exist, this milestone is a target definition, not a completion claim.

## Entry requirements

Before strategy code is allowed to run continuously, the repo should have all of the following:

1. **Append-only paper ledger**
   - intents, risk decisions, paper orders, paper fills, position changes, and operator actions are persisted
   - records are timestamped and reconstructable after restart

2. **Strategy emits intents only**
   - strategy produces proposed actions
   - strategy does not call an exchange or signing path directly

3. **Risk sits between strategy and paper execution**
   - stale-data guard
   - size and exposure limits
   - operator pause respected immediately
   - rejected decisions logged with reasons

4. **Paper execution adapter**
   - simulated fills use explicit assumptions
   - assumptions are documented and versioned
   - resulting fills are stored in the ledger

5. **Replay or comparison harness**
   - recorded sessions can be replayed
   - operator can compare paper outcomes against recorded market data
   - major gaps between live observer data and replayed outcomes are explainable

6. **Operator visibility**
   - dashboard or logs show current strategy version
   - dashboard or logs show whether market data is stale
   - operator can see pause state, paper positions, and most recent decisions

## Exit criteria

The milestone should only be called done when all of these are true:

- a paper trade can be traced from market snapshot to strategy intent to risk decision to paper fill to resulting position state
- unauthorized control calls are rejected
- operator pause stops new strategy decisions within one control cycle
- stale market data blocks new paper actions
- restart recovery preserves ledger truth needed to explain open paper positions
- replayed sessions produce explainable outcomes for the same strategy version and assumptions
- the team has reviewed at least one full operator session and found no unexplained paper actions

## Required evidence

Ship this milestone with an evidence bundle, not just code:
- commit hash tested
- filled-out checklist from `docs/qa/PAPER_SAFE_STRATEGY_CHECKLIST.md`
- operator notes from at least one supervised paper session
- sample ledger trace for one accepted intent and one rejected intent
- known limitations list

## Non-goals

These are intentionally out of scope for this milestone:
- proving edge or profitability
- latency optimization
- live execution
- unattended runtime
- broad internet exposure

## Known blockers right now

The current repo still needs:
- durable ledger storage beyond `runtime-state.json`
- strategy and risk packages
- a paper execution model
- automated replay verification
- richer operator surfaces for strategy-specific state

## Go / no-go guidance

Go only if the system can explain every paper action.

No-go if any of the following are true:
- data is stale or intermittently missing
- paper actions cannot be reconstructed after restart
- strategy can bypass risk or operator pause
- paper fills rely on undocumented assumptions
- anyone is tempted to treat paper PnL as proof that live trading is safe
