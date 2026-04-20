export { defaultStrategyEngineMetadata, defaultStrategyEngineOptions, createStrategyEngineOptions } from './defaults.js'
export {
  buildStrategySignalReport,
  createPaperTradeIntents,
  evaluateBinaryMarketSignal,
  evaluateBinaryMarketSignalAt
} from './engine.js'
export type {
  BinarySide,
  EvaluatedMarketSignal,
  PaperTradeIntent,
  RejectReasonCode,
  StrategyEngineMetadata,
  StrategyEngineOptions,
  StrategyEntryConstraints,
  StrategyExitConstraints,
  StrategySignalDiagnostics,
  StrategySignalReport,
  StrategyThesis,
  SupportReasonCode
} from './types.js'
