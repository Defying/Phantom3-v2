import type { RuntimeMarket } from '../../contracts/src/index.js'

export type BinarySide = 'yes' | 'no'

export type RejectReasonCode =
  | 'missing-price'
  | 'missing-end-date'
  | 'invalid-price-band'
  | 'broken-complement'
  | 'wide-spread'
  | 'low-liquidity'
  | 'low-volume'
  | 'near-expiry'
  | 'weak-imbalance'
  | 'insufficient-confidence'

export type SupportReasonCode =
  | 'tight-spread'
  | 'ample-liquidity'
  | 'ample-volume'
  | 'comfortable-time-to-expiry'
  | 'sane-complement'
  | 'clear-consensus-skew'
  | 'discounted-side-in-band'

export type StrategyEngineOptions = {
  strategyId: string
  strategyVersion: string
  maxIntents: number
  minConfidence: number
  minLiquidity: number
  minVolume24hr: number
  maxSpread: number
  maxComplementDrift: number
  minHoursToExpiry: number
  minPriceImbalance: number
  minSidePrice: number
  maxSidePrice: number
  preferredUnderdogPrice: number
  maxPriceDistanceFromPreferred: number
  entryPriceTolerance: number
  maxSnapshotAgeMs: number
  maxHoldingHours: number
  exitBufferHours: number
  takeProfitDistanceFactor: number
  stopLossDistanceFactor: number
  spreadInvalidationMultiplier: number
  paperNotionalUsd: number
  maxNotionalPctOfLiquidity: number
}

export type StrategyEngineMetadata = {
  strategyId: string
  strategyVersion: string
  selectionMode: 'discounted-underdog'
  paperOnly: true
  source: 'market-snapshot'
}

export type StrategySignalDiagnostics = {
  asOf: string
  selectedSide: BinarySide | null
  selectedPrice: number | null
  opposingPrice: number | null
  priceSum: number
  complementDrift: number
  priceImbalance: number
  spread: number | null
  liquidity: number | null
  volume24hr: number | null
  hoursToExpiry: number | null
  qualityScore: number
  setupScore: number
  signalScore: number
}

export type StrategyThesis = {
  summary: string
  bullets: string[]
}

export type StrategyEntryConstraints = {
  limitOnly: true
  acceptablePriceBand: {
    min: number
    max: number
  }
  maxSpread: number
  minLiquidity: number
  minVolume24hr: number
  minHoursToExpiry: number
  cancelIfSnapshotOlderThanMs: number
}

export type StrategyExitConstraints = {
  takeProfitPrice: number
  stopLossPrice: number
  latestExitAt: string
  invalidateIfSpreadAbove: number
  invalidateIfComplementDriftAbove: number
  invalidateIfHoursToExpiryBelow: number
}

export type PaperTradeIntent = {
  kind: 'paper-trade-intent'
  mode: 'paper'
  readOnly: true
  generatedAt: string
  snapshotFetchedAt: string
  strategyId: string
  strategyVersion: string
  marketId: string
  eventId: string
  marketSlug: string
  question: string
  url: string
  side: BinarySide
  confidence: number
  signalScore: number
  suggestedNotionalUsd: number
  thesis: StrategyThesis
  entry: StrategyEntryConstraints
  exit: StrategyExitConstraints
  diagnostics: StrategySignalDiagnostics
}

export type EvaluatedMarketSignal = {
  market: RuntimeMarket
  status: 'accepted' | 'rejected'
  recommendedSide: BinarySide | null
  rejectReasons: RejectReasonCode[]
  supportReasons: SupportReasonCode[]
  confidence: number
  signalScore: number
  diagnostics: StrategySignalDiagnostics
  thesis: StrategyThesis | null
  intent: PaperTradeIntent | null
}

export type StrategySignalReport = {
  engine: StrategyEngineMetadata
  snapshotFetchedAt: string
  generatedAt: string
  options: StrategyEngineOptions
  totals: {
    marketsSeen: number
    eligibleMarkets: number
    rejectedMarkets: number
    emittedIntents: number
  }
  accepted: EvaluatedMarketSignal[]
  rejected: EvaluatedMarketSignal[]
  intents: PaperTradeIntent[]
}
