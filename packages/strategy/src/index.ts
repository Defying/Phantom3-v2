export { defaultStrategyEngineMetadata, defaultStrategyEngineOptions, createStrategyEngineOptions } from './defaults.js'
export {
  createTradingPreferenceOptions,
  createStrategyEngineOptionsForProfile,
  getStrategyProfile,
  listStrategyProfiles,
  resolveStrategyRuntimeRoute
} from './profiles.js'
export {
  buildStrategySignalReport,
  createPaperTradeIntents,
  evaluateBinaryMarketSignal,
  evaluateBinaryMarketSignalAt
} from './engine.js'
export {
  buildLegacyEarlyExitLiveSignalReport,
  createLegacyEarlyExitLiveEngineOptions,
  createLegacyEarlyExitLivePaperTradeIntents,
  defaultLegacyEarlyExitLiveEngineOptions,
  evaluateLegacyEarlyExitLiveSignal,
  evaluateLegacyEarlyExitLiveSignalAt
} from './legacy-early-exit-live.js'
export {
  createLegacyManagedExitConfig,
  createLegacyManagedSessionGuardConfig,
  defaultLegacyManagedExitConfig,
  defaultLegacyManagedSessionGuardConfig,
  evaluateLegacyManagedExit,
  evaluateLegacyManagedSessionGuards,
  summarizeLegacyManagedSessionTradeOutcomes
} from './managed-exits.js'
export type {
  BinarySide,
  EvaluatedMarketSignal,
  PaperTradeIntent,
  RejectReasonCode,
  StrategyEngineMetadata,
  StrategyEngineOptions,
  StrategyEntryConstraints,
  StrategyExitConstraints,
  StrategySelectionMode,
  StrategySignalDiagnostics,
  StrategySignalReport,
  StrategyThesis,
  SupportReasonCode
} from './types.js'
export type {
  LegacyEarlyExitAsset,
  LegacyEarlyExitLiveConfirmationStatus,
  LegacyEarlyExitLiveDiagnostics,
  LegacyEarlyExitLiveEngineMetadata,
  LegacyEarlyExitLiveEngineOptions,
  LegacyEarlyExitLiveEntryConstraints,
  LegacyEarlyExitLiveEvaluatedSignal,
  LegacyEarlyExitLiveExecutionStatus,
  LegacyEarlyExitLiveExitConstraints,
  LegacyEarlyExitLiveMarketContext,
  LegacyEarlyExitLivePaperTradeIntent,
  LegacyEarlyExitLiveSignalReport,
  LegacyEarlyExitLiveSignalStatus,
  LegacyEarlyExitLiveSkipReasonCode,
  LegacyEarlyExitLiveSupportReasonCode,
  LegacyEarlyExitLiveTimeDecayBand,
  LegacyEarlyExitLiveVolatilityStatus,
  LegacyEarlyExitProbabilityBand,
  LegacyEarlyExitTimeframe,
  LegacyEarlyExitTimeWindowStatus
} from './legacy-early-exit-live.js'
export type {
  StrategyProfileDefinition,
  StrategyRoutingEntryPolicy,
  StrategyRoutingExecutionMode,
  StrategyRuntimeRoute
} from './profiles.js'
export type {
  LegacyManagedExitConfig,
  LegacyManagedExitEvaluation,
  LegacyManagedExitState,
  LegacyManagedExitTimeDecayRule,
  LegacyManagedExitTrigger,
  LegacyManagedSessionGuardConfig,
  LegacyManagedSessionGuardReason,
  LegacyManagedSessionGuardReasonCode,
  LegacyManagedSessionGuardState,
  LegacyManagedSessionTradeOutcome,
  ManagedSessionPositionEvent
} from './managed-exits.js'
