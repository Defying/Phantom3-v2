import type {
  TradingPreferenceOption,
  TradingPreferenceProfile
} from '../../contracts/src/index.js'
import { defaultStrategyEngineMetadata, defaultStrategyEngineOptions, createStrategyEngineOptions } from './defaults.js'
import type { StrategyEngineOptions, StrategySelectionMode } from './types.js'

export type StrategyRoutingExecutionMode = 'paper-active' | 'reference-only'
export type StrategyRoutingEntryPolicy = 'emit-new-entries' | 'manage-open-positions-only'

export type StrategyProfileDefinition = {
  profile: TradingPreferenceProfile
  label: string
  summary: string
  note: string
  intendedMarkets: TradingPreferenceOption['intendedMarkets']
  intendedTimeframes: TradingPreferenceOption['intendedTimeframes']
  parityStatus: TradingPreferenceOption['parityStatus']
  strategyId: string
  strategyVersion: string
  selectionMode: StrategySelectionMode
  executionMode: StrategyRoutingExecutionMode
  engineOverrides?: Partial<StrategyEngineOptions>
}

export type StrategyRuntimeRoute = {
  requested: StrategyProfileDefinition
  evaluated: StrategyProfileDefinition
  executionMode: StrategyRoutingExecutionMode
  entryPolicy: StrategyRoutingEntryPolicy
  summary: string
  note: string
}

const strategyProfiles: StrategyProfileDefinition[] = [
  {
    profile: 'current-v2-generic',
    label: 'Current v2 generic paper strategy',
    summary: 'The currently wired paper-only contrarian snapshot scorer in Phantom3-v2.',
    note: 'This is the only strategy profile that can emit new paper entries today. It is still a paper-only heuristic engine, not legacy Python parity.',
    intendedMarkets: ['BTC', 'ETH', 'SOL'],
    intendedTimeframes: ['5m', '15m'],
    parityStatus: 'current-runtime',
    strategyId: defaultStrategyEngineMetadata.strategyId,
    strategyVersion: defaultStrategyEngineMetadata.strategyVersion,
    selectionMode: defaultStrategyEngineMetadata.selectionMode,
    executionMode: 'paper-active',
    engineOverrides: {
      strategyId: defaultStrategyEngineOptions.strategyId,
      strategyVersion: defaultStrategyEngineOptions.strategyVersion
    }
  },
  {
    profile: 'legacy-early-exit-classic',
    label: 'Legacy early-exit classic',
    summary: 'Reference profile for the older 80-88% entry, 92% target, 77% stop early-exit bot.',
    note: 'Reference-only for now. Selecting this profile parks new paper entries until a real classic early-exit runtime is implemented.',
    intendedMarkets: ['BTC', 'ETH', 'SOL'],
    intendedTimeframes: ['5m', '15m'],
    parityStatus: 'legacy-reference',
    strategyId: 'legacy-early-exit-classic-reference',
    strategyVersion: 'reference-v0',
    selectionMode: 'legacy-early-exit-classic',
    executionMode: 'reference-only'
  },
  {
    profile: 'legacy-early-exit-live',
    label: 'Legacy early-exit live/managed',
    summary: 'Paper-managed exit and session-guard profile for the widened, confirmed early-exit logic with trailing and time-decay exits.',
    note: 'Paper-only partial parity. New paper entry emission stays parked, but managed exits and session guard scaffolding remain active for existing paper positions while live execution stays disarmed.',
    intendedMarkets: ['BTC', 'ETH', 'SOL'],
    intendedTimeframes: ['5m', '15m'],
    parityStatus: 'legacy-reference',
    strategyId: 'legacy-early-exit-live-reference',
    strategyVersion: 'reference-v0',
    selectionMode: 'legacy-early-exit-live-managed',
    executionMode: 'reference-only'
  },
  {
    profile: 'legacy-sniper-hold',
    label: 'Legacy sniper / hold-to-resolution',
    summary: 'Reference profile for the 95%+ probability sniper that buys late and usually holds to resolution.',
    note: 'Reference-only for now. Selecting this profile does not switch the runtime to hold-to-resolution behavior yet.',
    intendedMarkets: ['BTC', 'ETH', 'SOL'],
    intendedTimeframes: ['5m', '15m'],
    parityStatus: 'legacy-reference',
    strategyId: 'legacy-sniper-hold-reference',
    strategyVersion: 'reference-v0',
    selectionMode: 'legacy-sniper-hold',
    executionMode: 'reference-only'
  }
]

function cloneProfile(definition: StrategyProfileDefinition): StrategyProfileDefinition {
  return {
    ...definition,
    intendedMarkets: [...definition.intendedMarkets],
    intendedTimeframes: [...definition.intendedTimeframes],
    engineOverrides: definition.engineOverrides ? { ...definition.engineOverrides } : undefined
  }
}

function activePaperProfile(): StrategyProfileDefinition {
  return cloneProfile(strategyProfiles[0])
}

export function listStrategyProfiles(): StrategyProfileDefinition[] {
  return strategyProfiles.map(cloneProfile)
}

export function getStrategyProfile(profile: TradingPreferenceProfile): StrategyProfileDefinition {
  const matched = strategyProfiles.find((entry) => entry.profile === profile) ?? strategyProfiles[0]
  return cloneProfile(matched)
}

export function createTradingPreferenceOptions(): TradingPreferenceOption[] {
  return strategyProfiles.map((definition) => ({
    profile: definition.profile,
    label: definition.label,
    summary: definition.summary,
    note: definition.note,
    intendedMarkets: [...definition.intendedMarkets],
    intendedTimeframes: [...definition.intendedTimeframes],
    parityStatus: definition.parityStatus
  }))
}

export function createStrategyEngineOptionsForProfile(
  profile: TradingPreferenceProfile,
  overrides: Partial<StrategyEngineOptions> = {}
): StrategyEngineOptions {
  const definition = getStrategyProfile(profile)
  return createStrategyEngineOptions({
    ...definition.engineOverrides,
    strategyId: definition.strategyId,
    strategyVersion: definition.strategyVersion,
    ...overrides
  })
}

export function resolveStrategyRuntimeRoute(profile: TradingPreferenceProfile): StrategyRuntimeRoute {
  const requested = getStrategyProfile(profile)

  if (requested.executionMode === 'paper-active') {
    return {
      requested,
      evaluated: requested,
      executionMode: 'paper-active',
      entryPolicy: 'emit-new-entries',
      summary: `${requested.label} is active. The runtime is evaluating markets with that paper profile and can emit new paper entries when risk gates approve them.`,
      note: requested.note
    }
  }

  const evaluated = activePaperProfile()
  const managedReference = requested.profile === 'legacy-early-exit-live'

  return {
    requested,
    evaluated,
    executionMode: 'reference-only',
    entryPolicy: 'manage-open-positions-only',
    summary: managedReference
      ? `${requested.label} is selected in paper-only managed mode. New paper entries stay parked, ${evaluated.label} still provides baseline candidate visibility, and existing paper positions keep managed exits plus session guards.`
      : `${requested.label} is selected as a reference-only profile. The runtime keeps ${evaluated.label} warm for candidate visibility and paper exit safety, but it does not emit new paper entries for the requested legacy profile.`,
    note: managedReference
      ? `New paper entry emission is parked while ${requested.label} remains reference-only. Dashboard candidates still come from ${evaluated.label}, while managed exits and session guards stay active for existing paper positions.`
      : `New paper entry emission is parked while ${requested.label} remains reference-only. Dashboard candidates are the ${evaluated.label} baseline, and any existing paper positions continue to be managed safely.`
  }
}
