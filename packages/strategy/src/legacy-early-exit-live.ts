import type { RuntimeMarket } from '../../contracts/src/index.js'
import type { MarketSnapshot } from '../../market-data/src/index.js'
import type {
  BinarySide,
  PaperTradeIntent,
  StrategyEntryConstraints,
  StrategyExitConstraints,
  StrategyThesis
} from './types.js'

export type LegacyEarlyExitAsset = 'BTC' | 'ETH' | 'SOL'
export type LegacyEarlyExitTimeframe = '5m' | '15m'

export type LegacyEarlyExitLiveSignalStatus = 'accepted' | 'pending-confirmation' | 'rejected'

export type LegacyEarlyExitProbabilityBand =
  | 'below-trigger'
  | 'trigger-window'
  | 'entry-window'
  | 'above-entry-window'
  | 'target-zone'
  | 'unavailable'

export type LegacyEarlyExitLiveSkipReasonCode =
  | 'asset-out-of-scope'
  | 'timeframe-out-of-scope'
  | 'missing-price'
  | 'missing-end-date'
  | 'below-confirmation-trigger'
  | 'above-entry-max'
  | 'below-entry-min-after-confirm'
  | 'confirmation-pending'
  | 'confirmation-dropped'
  | 'confirmation-drawdown-too-large'
  | 'volatility-too-high'
  | 'ask-too-far-above-mid'
  | 'oracle-disagrees'
  | 'insufficient-expected-profit'
  | 'time-before-close-too-short'
  | 'time-before-close-too-long'

export type LegacyEarlyExitLiveSupportReasonCode =
  | 'asset-scope-match'
  | 'timeframe-scope-match'
  | 'within-time-window'
  | 'trigger-band-reached'
  | 'entry-band-confirmed'
  | 'confirmation-held'
  | 'volatility-contained'
  | 'ask-near-mid'
  | 'oracle-confirmed'
  | 'profit-to-target-positive'

export type LegacyEarlyExitLiveConfirmationStatus = 'pending' | 'confirmed' | 'rejected' | 'not-applicable'
export type LegacyEarlyExitLiveVolatilityStatus = 'pass' | 'rejected' | 'unknown'
export type LegacyEarlyExitLiveExecutionStatus = 'midpoint-assumed' | 'ask-validated' | 'ask-too-high' | 'unknown'
export type LegacyEarlyExitTimeWindowStatus = 'pass' | 'too-short' | 'too-long' | 'unknown'

export type LegacyEarlyExitLiveTimeDecayBand = {
  secondsBeforeClose: number
  minProfit: number | null
}

export type LegacyEarlyExitLiveMarketContext = {
  triggerPrice?: number | null
  confirmedPrice?: number | null
  askPrice?: number | null
  observedPrices?: number[]
  oracleDirectionConfirmed?: boolean | null
  secondsToClose?: number | null
}

export type LegacyEarlyExitLiveEngineOptions = {
  strategyId: string
  strategyVersion: string
  maxIntents: number
  paperNotionalUsd: number
  minExpectedProfitUsd: number
  supportedAssets: LegacyEarlyExitAsset[]
  supportedTimeframes: LegacyEarlyExitTimeframe[]
  assetWeights: Record<LegacyEarlyExitAsset, number>
  entryMinProbability: number
  entryMaxProbability: number
  exitTargetProbability: number
  confirmationTrigger: number
  confirmationDelaySeconds: number
  maxPriceDropDuringConfirmation: number
  stopLossFloorProbability: number
  stopLossDistance: number
  minTimeBeforeCloseSeconds: number
  maxTimeBeforeCloseSeconds: number
  volatilityRangeLimit: number
  askPriceDistanceLimit: number
  trailingStopActivation: number
  trailingStopThreshold: number
  damagedTradeBreakevenDrawdown: number
  timeDecayExitBands: LegacyEarlyExitLiveTimeDecayBand[]
}

export type LegacyEarlyExitLiveEngineMetadata = {
  profileId: 'legacy-early-exit-live'
  strategyId: string
  strategyVersion: string
  selectionMode: 'confirmed-momentum-early-exit'
  paperOnly: true
  source: 'market-snapshot'
  parity: 'foundation-only'
  note: string
}

export type LegacyEarlyExitLiveEntryConstraints = StrategyEntryConstraints & {
  probabilityBand: {
    trigger: number
    min: number
    max: number
  }
  confirmation: {
    required: true
    delaySeconds: number
    maxAllowedDrop: number
    triggerPrice: number
    confirmedPrice: number
  }
}

export type LegacyEarlyExitLiveExitConstraints = StrategyExitConstraints & {
  managed: {
    stopLossFloorProbability: number
    stopLossDistance: number
    trailingStopActivation: number
    trailingStopThreshold: number
    damagedTradeBreakevenDrawdown: number
    timeDecayExitBands: LegacyEarlyExitLiveTimeDecayBand[]
  }
}

export type LegacyEarlyExitLiveDiagnostics = {
  asOf: string
  asset: LegacyEarlyExitAsset | null
  timeframe: LegacyEarlyExitTimeframe | null
  scopeMatched: boolean
  selectedSide: BinarySide | null
  selectedPrice: number | null
  opposingPrice: number | null
  probabilityBand: LegacyEarlyExitProbabilityBand
  secondsToClose: number | null
  assetWeight: number | null
  rawConfidence: number
  weightedConfidence: number
  expectedProfitUsd: number | null
  expectedProfitPct: number | null
  timeWindow: {
    minSeconds: number
    maxSeconds: number
    status: LegacyEarlyExitTimeWindowStatus
  }
  confirmation: {
    required: true
    triggerPrice: number | null
    confirmedPrice: number | null
    delaySeconds: number
    maxAllowedDrop: number
    priceChange: number | null
    status: LegacyEarlyExitLiveConfirmationStatus
  }
  volatility: {
    observedRange: number | null
    sampleCount: number
    threshold: number
    status: LegacyEarlyExitLiveVolatilityStatus
  }
  execution: {
    askPrice: number | null
    askDistance: number | null
    maxAskDistance: number
    status: LegacyEarlyExitLiveExecutionStatus
  }
  exitPlan: {
    takeProfitPrice: number
    stopLossPrice: number | null
    stopLossFloorProbability: number
    stopLossDistance: number
    trailingStopActivation: number
    trailingStopThreshold: number
    damagedTradeBreakevenDrawdown: number
    timeDecayExitBands: LegacyEarlyExitLiveTimeDecayBand[]
    latestExitAt: string | null
  }
  rationale: string[]
}

export type LegacyEarlyExitLivePaperTradeIntent = Omit<PaperTradeIntent, 'entry' | 'exit' | 'diagnostics'> & {
  entry: LegacyEarlyExitLiveEntryConstraints
  exit: LegacyEarlyExitLiveExitConstraints
  diagnostics: LegacyEarlyExitLiveDiagnostics
}

export type LegacyEarlyExitLiveEvaluatedSignal = {
  market: RuntimeMarket
  status: LegacyEarlyExitLiveSignalStatus
  recommendedSide: BinarySide | null
  skipReasons: LegacyEarlyExitLiveSkipReasonCode[]
  supportReasons: LegacyEarlyExitLiveSupportReasonCode[]
  confidence: number
  weightedConfidence: number
  diagnostics: LegacyEarlyExitLiveDiagnostics
  thesis: StrategyThesis | null
  intent: LegacyEarlyExitLivePaperTradeIntent | null
}

export type LegacyEarlyExitLiveSignalReport = {
  engine: LegacyEarlyExitLiveEngineMetadata
  snapshotFetchedAt: string
  generatedAt: string
  options: LegacyEarlyExitLiveEngineOptions
  totals: {
    marketsSeen: number
    inScopeMarkets: number
    pendingConfirmation: number
    accepted: number
    rejected: number
    emittedIntents: number
  }
  accepted: LegacyEarlyExitLiveEvaluatedSignal[]
  pendingConfirmation: LegacyEarlyExitLiveEvaluatedSignal[]
  rejected: LegacyEarlyExitLiveEvaluatedSignal[]
  intents: LegacyEarlyExitLivePaperTradeIntent[]
}

const defaultAssetWeights: Record<LegacyEarlyExitAsset, number> = {
  BTC: 1,
  ETH: 0.9,
  SOL: 0.65
}

export const defaultLegacyEarlyExitLiveEngineOptions: LegacyEarlyExitLiveEngineOptions = {
  strategyId: 'legacy-early-exit-live-foundation',
  strategyVersion: '0.1.0',
  maxIntents: 5,
  paperNotionalUsd: 10,
  minExpectedProfitUsd: 0.05,
  supportedAssets: ['BTC', 'ETH', 'SOL'],
  supportedTimeframes: ['5m', '15m'],
  assetWeights: defaultAssetWeights,
  entryMinProbability: 0.83,
  entryMaxProbability: 0.91,
  exitTargetProbability: 0.93,
  confirmationTrigger: 0.81,
  confirmationDelaySeconds: 4,
  maxPriceDropDuringConfirmation: 0.015,
  stopLossFloorProbability: 0.7,
  stopLossDistance: 0.06,
  minTimeBeforeCloseSeconds: 30,
  maxTimeBeforeCloseSeconds: 600,
  volatilityRangeLimit: 0.08,
  askPriceDistanceLimit: 0.05,
  trailingStopActivation: 0.05,
  trailingStopThreshold: 0.05,
  damagedTradeBreakevenDrawdown: 0.04,
  timeDecayExitBands: [
    { secondsBeforeClose: 120, minProfit: 0.03 },
    { secondsBeforeClose: 60, minProfit: 0.01 },
    { secondsBeforeClose: 30, minProfit: null }
  ]
}

const ASSET_PATTERNS: Record<LegacyEarlyExitAsset, RegExp[]> = {
  BTC: [/\bbtc\b/i, /\bbitcoin\b/i],
  ETH: [/\beth\b/i, /\bethereum\b/i],
  SOL: [/\bsol\b/i, /\bsolana\b/i]
}

const TIMEFRAME_PATTERNS: Record<LegacyEarlyExitTimeframe, RegExp[]> = {
  '5m': [/\b5m\b/i, /\b5\s*min(?:ute)?s?\b/i, /\b5-minute\b/i, /\bfive\s+minute\b/i],
  '15m': [/\b15m\b/i, /\b15\s*min(?:ute)?s?\b/i, /\b15-minute\b/i, /\bfifteen\s+minute\b/i]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function scaleLinear(value: number, min: number, max: number): number {
  if (max <= min) {
    return value >= max ? 1 : 0
  }
  return clamp((value - min) / (max - min), 0, 1)
}

function parseIsoDate(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function secondsUntil(endDate: string | null | undefined, asOf: string): number | null {
  const endMs = parseIsoDate(endDate)
  const asOfMs = parseIsoDate(asOf)
  if (endMs === null || asOfMs === null) {
    return null
  }
  return roundTo((endMs - asOfMs) / 1000, 2)
}

function formatPercent(value: number | null): string {
  if (!isFiniteNumber(value)) {
    return 'unknown'
  }
  return `${roundTo(value * 100, 1)}%`
}

function formatUsd(value: number | null): string {
  if (!isFiniteNumber(value)) {
    return 'unknown'
  }
  return `$${roundTo(value, 2).toFixed(2)}`
}

function leadingSide(yesPrice: number, noPrice: number): { side: BinarySide; selectedPrice: number; opposingPrice: number } {
  if (yesPrice >= noPrice) {
    return {
      side: 'yes',
      selectedPrice: yesPrice,
      opposingPrice: noPrice
    }
  }

  return {
    side: 'no',
    selectedPrice: noPrice,
    opposingPrice: yesPrice
  }
}

function normalizeHaystack(value: string): string {
  return value.replace(/[-_]+/g, ' ')
}

function detectByPatterns<T extends string>(value: string, patterns: Record<T, RegExp[]>): T | null {
  for (const [candidate, candidatePatterns] of Object.entries(patterns) as Array<[T, RegExp[]]>) {
    if (candidatePatterns.some((pattern) => pattern.test(value))) {
      return candidate
    }
  }
  return null
}

function detectScope(market: RuntimeMarket): { asset: LegacyEarlyExitAsset | null; timeframe: LegacyEarlyExitTimeframe | null } {
  const haystacks = [market.eventTitle, market.question, normalizeHaystack(market.slug)]
  let asset: LegacyEarlyExitAsset | null = null
  let timeframe: LegacyEarlyExitTimeframe | null = null

  for (const haystack of haystacks) {
    if (!asset) {
      asset = detectByPatterns(haystack, ASSET_PATTERNS)
    }
    if (!timeframe) {
      timeframe = detectByPatterns(haystack, TIMEFRAME_PATTERNS)
    }
    if (asset && timeframe) {
      break
    }
  }

  return { asset, timeframe }
}

function probabilityBand(price: number | null, options: LegacyEarlyExitLiveEngineOptions): LegacyEarlyExitProbabilityBand {
  if (!isFiniteNumber(price)) {
    return 'unavailable'
  }
  if (price < options.confirmationTrigger) {
    return 'below-trigger'
  }
  if (price < options.entryMinProbability) {
    return 'trigger-window'
  }
  if (price <= options.entryMaxProbability) {
    return 'entry-window'
  }
  if (price < options.exitTargetProbability) {
    return 'above-entry-window'
  }
  return 'target-zone'
}

function buildMetadata(options: LegacyEarlyExitLiveEngineOptions): LegacyEarlyExitLiveEngineMetadata {
  return {
    profileId: 'legacy-early-exit-live',
    strategyId: options.strategyId,
    strategyVersion: options.strategyVersion,
    selectionMode: 'confirmed-momentum-early-exit',
    paperOnly: true,
    source: 'market-snapshot',
    parity: 'foundation-only',
    note: 'Pure paper signal foundation for the managed legacy early-exit rules. Runtime routing and live parity are still separate work.'
  }
}

function calculateObservedRange(observedPrices: number[] | undefined, currentPrice: number | null): { range: number | null; sampleCount: number } {
  const values = (observedPrices ?? []).filter((value) => Number.isFinite(value))
  if (isFiniteNumber(currentPrice)) {
    values.push(currentPrice)
  }
  if (values.length === 0) {
    return { range: null, sampleCount: 0 }
  }
  return {
    range: roundTo(Math.max(...values) - Math.min(...values), 4),
    sampleCount: values.length
  }
}

function timeWindowStatus(secondsToClose: number | null, options: LegacyEarlyExitLiveEngineOptions): LegacyEarlyExitTimeWindowStatus {
  if (!isFiniteNumber(secondsToClose)) {
    return 'unknown'
  }
  if (secondsToClose < options.minTimeBeforeCloseSeconds) {
    return 'too-short'
  }
  if (secondsToClose > options.maxTimeBeforeCloseSeconds) {
    return 'too-long'
  }
  return 'pass'
}

function calculateConfidence(input: {
  price: number | null
  secondsToClose: number | null
  assetWeight: number | null
  options: LegacyEarlyExitLiveEngineOptions
}): { rawConfidence: number; weightedConfidence: number } {
  const { price, secondsToClose, assetWeight, options } = input

  if (!isFiniteNumber(price) || !isFiniteNumber(assetWeight)) {
    return { rawConfidence: 0, weightedConfidence: 0 }
  }

  const entryMid = (options.entryMinProbability + options.entryMaxProbability) / 2
  const entryHalfWidth = Math.max(0.001, (options.entryMaxProbability - options.entryMinProbability) / 2)
  const bandProgress = scaleLinear(price, options.confirmationTrigger, options.exitTargetProbability)

  let entryFit = 0
  if (price < options.entryMinProbability) {
    entryFit = scaleLinear(price, options.confirmationTrigger, options.entryMinProbability) * 0.65
  } else if (price <= options.entryMaxProbability) {
    entryFit = 1 - clamp(Math.abs(price - entryMid) / entryHalfWidth, 0, 1)
  } else {
    entryFit = Math.max(0, 1 - scaleLinear(price, options.entryMaxProbability, options.exitTargetProbability)) * 0.5
  }

  const midWindow = (options.minTimeBeforeCloseSeconds + options.maxTimeBeforeCloseSeconds) / 2
  const halfWindow = Math.max(1, (options.maxTimeBeforeCloseSeconds - options.minTimeBeforeCloseSeconds) / 2)
  const timeFit = isFiniteNumber(secondsToClose)
    ? 1 - clamp(Math.abs(secondsToClose - midWindow) / halfWindow, 0, 1)
    : 0.2

  const targetEdge = Math.max(0, options.exitTargetProbability / price - 1)
  const targetEdgeScore = scaleLinear(targetEdge, options.minExpectedProfitUsd / options.paperNotionalUsd, 0.12)
  const rawConfidence = roundTo(clamp(0.35 * bandProgress + 0.35 * entryFit + 0.15 * timeFit + 0.15 * targetEdgeScore, 0, 1), 4)
  const weightedConfidence = roundTo(clamp(rawConfidence * assetWeight, 0, 1), 4)

  return { rawConfidence, weightedConfidence }
}

function buildEntryConstraints(input: {
  triggerPrice: number
  confirmedPrice: number
  options: LegacyEarlyExitLiveEngineOptions
}): LegacyEarlyExitLiveEntryConstraints {
  const { triggerPrice, confirmedPrice, options } = input
  return {
    limitOnly: true,
    acceptablePriceBand: {
      min: roundTo(options.entryMinProbability, 4),
      max: roundTo(options.entryMaxProbability, 4)
    },
    maxSpread: roundTo(options.askPriceDistanceLimit, 4),
    minLiquidity: 0,
    minVolume24hr: 0,
    minHoursToExpiry: roundTo(options.minTimeBeforeCloseSeconds / 3600, 4),
    cancelIfSnapshotOlderThanMs: Math.round((options.confirmationDelaySeconds + 1) * 1000),
    probabilityBand: {
      trigger: roundTo(options.confirmationTrigger, 4),
      min: roundTo(options.entryMinProbability, 4),
      max: roundTo(options.entryMaxProbability, 4)
    },
    confirmation: {
      required: true,
      delaySeconds: options.confirmationDelaySeconds,
      maxAllowedDrop: roundTo(options.maxPriceDropDuringConfirmation, 4),
      triggerPrice: roundTo(triggerPrice, 4),
      confirmedPrice: roundTo(confirmedPrice, 4)
    }
  }
}

function buildExitConstraints(input: {
  asOf: string
  endDate: string
  entryPrice: number
  options: LegacyEarlyExitLiveEngineOptions
}): LegacyEarlyExitLiveExitConstraints {
  const { asOf, endDate, entryPrice, options } = input
  const asOfMs = parseIsoDate(asOf) ?? Date.now()
  const endMs = parseIsoDate(endDate) ?? asOfMs
  const latestExitAt = new Date(Math.max(asOfMs, endMs - options.minTimeBeforeCloseSeconds * 1000)).toISOString()

  return {
    takeProfitPrice: roundTo(options.exitTargetProbability, 4),
    stopLossPrice: roundTo(Math.max(entryPrice - options.stopLossDistance, options.stopLossFloorProbability), 4),
    latestExitAt,
    invalidateIfSpreadAbove: roundTo(options.askPriceDistanceLimit, 4),
    invalidateIfComplementDriftAbove: 1,
    invalidateIfHoursToExpiryBelow: roundTo(options.minTimeBeforeCloseSeconds / 3600, 4),
    managed: {
      stopLossFloorProbability: roundTo(options.stopLossFloorProbability, 4),
      stopLossDistance: roundTo(options.stopLossDistance, 4),
      trailingStopActivation: roundTo(options.trailingStopActivation, 4),
      trailingStopThreshold: roundTo(options.trailingStopThreshold, 4),
      damagedTradeBreakevenDrawdown: roundTo(options.damagedTradeBreakevenDrawdown, 4),
      timeDecayExitBands: options.timeDecayExitBands.map((band) => ({ ...band }))
    }
  }
}

function buildThesis(input: {
  market: RuntimeMarket
  asset: LegacyEarlyExitAsset
  timeframe: LegacyEarlyExitTimeframe
  side: BinarySide
  confidence: number
  weightedConfidence: number
  entryPrice: number
  expectedProfitUsd: number
  paperNotionalUsd: number
  entry: LegacyEarlyExitLiveEntryConstraints
  exit: LegacyEarlyExitLiveExitConstraints
}): StrategyThesis {
  const chosenLabel = input.side === 'yes' ? input.market.yesLabel : input.market.noLabel
  return {
    summary: `Paper-only legacy early-exit ${input.asset} ${input.timeframe} ${input.side.toUpperCase()} setup with ${formatPercent(input.weightedConfidence)} weighted confidence (${formatPercent(input.confidence)} raw).`,
    bullets: [
      `${input.asset} ${input.timeframe} market is in scope and the leading ${chosenLabel} side confirmed at ${formatPercent(input.entryPrice)} after the ${input.entry.confirmation.delaySeconds}s delay.`,
      `Expected paper upside to the ${formatPercent(input.exit.takeProfitPrice)} target is ${formatUsd(input.expectedProfitUsd)} on ${formatUsd(input.paperNotionalUsd)} notional, before any fees or slippage assumptions.`,
      `Hard stop sits at ${formatPercent(input.exit.stopLossPrice)} using max(entry - ${formatPercent(input.exit.managed.stopLossDistance)}, ${formatPercent(input.exit.managed.stopLossFloorProbability)}).`,
      `Managed exit diagnostics retain trailing-stop, damaged-trade breakeven, and time-decay thresholds, but this module stays paper-only and does not route live execution.`
    ]
  }
}

export function createLegacyEarlyExitLiveEngineOptions(
  overrides: Partial<LegacyEarlyExitLiveEngineOptions> = {}
): LegacyEarlyExitLiveEngineOptions {
  return {
    ...defaultLegacyEarlyExitLiveEngineOptions,
    ...overrides,
    supportedAssets: [...(overrides.supportedAssets ?? defaultLegacyEarlyExitLiveEngineOptions.supportedAssets)],
    supportedTimeframes: [...(overrides.supportedTimeframes ?? defaultLegacyEarlyExitLiveEngineOptions.supportedTimeframes)],
    assetWeights: {
      ...defaultLegacyEarlyExitLiveEngineOptions.assetWeights,
      ...overrides.assetWeights
    },
    timeDecayExitBands: (overrides.timeDecayExitBands ?? defaultLegacyEarlyExitLiveEngineOptions.timeDecayExitBands)
      .map((band) => ({ ...band }))
  }
}

export function evaluateLegacyEarlyExitLiveSignalAt(
  market: RuntimeMarket,
  asOf: string,
  context: LegacyEarlyExitLiveMarketContext = {},
  overrides: Partial<LegacyEarlyExitLiveEngineOptions> = {}
): LegacyEarlyExitLiveEvaluatedSignal {
  const options = createLegacyEarlyExitLiveEngineOptions(overrides)
  const { asset, timeframe } = detectScope(market)
  const yesPrice = isFiniteNumber(market.yesPrice) ? market.yesPrice : null
  const noPrice = isFiniteNumber(market.noPrice) ? market.noPrice : null
  const sideSelection = yesPrice !== null && noPrice !== null ? leadingSide(yesPrice, noPrice) : null
  const selectedSide = sideSelection?.side ?? null
  const selectedPrice = sideSelection?.selectedPrice ?? null
  const opposingPrice = sideSelection?.opposingPrice ?? null
  const triggerPrice = isFiniteNumber(context.triggerPrice) ? context.triggerPrice : selectedPrice
  const confirmedPrice = isFiniteNumber(context.confirmedPrice) ? context.confirmedPrice : null
  const secondsToClose = isFiniteNumber(context.secondsToClose) ? context.secondsToClose : secondsUntil(market.endDate, asOf)
  const assetWeight = asset ? options.assetWeights[asset] ?? null : null
  const priceForConfidence = confirmedPrice ?? triggerPrice
  const { rawConfidence, weightedConfidence } = calculateConfidence({
    price: priceForConfidence,
    secondsToClose,
    assetWeight,
    options
  })
  const timeStatus = timeWindowStatus(secondsToClose, options)
  const { range: observedRange, sampleCount } = calculateObservedRange(context.observedPrices, confirmedPrice ?? triggerPrice)
  const volatilityStatus: LegacyEarlyExitLiveVolatilityStatus = observedRange === null || sampleCount < 3
    ? 'unknown'
    : observedRange > options.volatilityRangeLimit
      ? 'rejected'
      : 'pass'
  const askDistance = isFiniteNumber(context.askPrice) && isFiniteNumber(confirmedPrice)
    ? roundTo(context.askPrice - confirmedPrice, 4)
    : null

  const skipReasons: LegacyEarlyExitLiveSkipReasonCode[] = []
  const supportReasons: LegacyEarlyExitLiveSupportReasonCode[] = []
  const rationale: string[] = []

  if (asset && options.supportedAssets.includes(asset)) {
    supportReasons.push('asset-scope-match')
    rationale.push(`${asset} asset scope matched the managed profile.`)
  } else {
    skipReasons.push('asset-out-of-scope')
    rationale.push('Market text did not map cleanly to BTC, ETH, or SOL.')
  }

  if (timeframe && options.supportedTimeframes.includes(timeframe)) {
    supportReasons.push('timeframe-scope-match')
    rationale.push(`${timeframe} timeframe matched the intended short-duration profile.`)
  } else {
    skipReasons.push('timeframe-out-of-scope')
    rationale.push('Market text did not map cleanly to a 5m or 15m scope.')
  }

  if (selectedPrice === null || opposingPrice === null || !selectedSide) {
    skipReasons.push('missing-price')
    rationale.push('Leading-side probability is unavailable from the snapshot.')
  }

  if (!market.endDate) {
    skipReasons.push('missing-end-date')
    rationale.push('Market end date is unavailable, so close-window rules cannot be applied.')
  }

  if (timeStatus === 'pass') {
    supportReasons.push('within-time-window')
    rationale.push(`Time before close (${secondsToClose?.toFixed(0) ?? 'unknown'}s) sits inside the ${options.minTimeBeforeCloseSeconds}s-${options.maxTimeBeforeCloseSeconds}s gate.`)
  } else if (timeStatus === 'too-short') {
    skipReasons.push('time-before-close-too-short')
    rationale.push('Market is too close to settlement for a managed early-exit entry.')
  } else if (timeStatus === 'too-long') {
    skipReasons.push('time-before-close-too-long')
    rationale.push('Market is still too early in its cycle for the managed close-window profile.')
  }

  const band = probabilityBand(triggerPrice, options)
  if (band === 'trigger-window' || band === 'entry-window') {
    supportReasons.push('trigger-band-reached')
  }

  if (band === 'below-trigger') {
    skipReasons.push('below-confirmation-trigger')
    rationale.push(`Leading price ${formatPercent(triggerPrice)} is still below the ${formatPercent(options.confirmationTrigger)} confirmation trigger.`)
  }

  if (band === 'above-entry-window' || band === 'target-zone') {
    skipReasons.push('above-entry-max')
    rationale.push(`Leading price ${formatPercent(triggerPrice)} is already above the ${formatPercent(options.entryMaxProbability)} max entry band.`)
  }

  const confirmationPriceChange = isFiniteNumber(confirmedPrice) && isFiniteNumber(triggerPrice)
    ? roundTo(confirmedPrice - triggerPrice, 4)
    : null

  let confirmationStatus: LegacyEarlyExitLiveConfirmationStatus = 'pending'
  let executionStatus: LegacyEarlyExitLiveExecutionStatus = 'unknown'
  let expectedProfitUsd: number | null = null
  let expectedProfitPct: number | null = null
  let actualEntryPrice: number | null = null
  let thesis: StrategyThesis | null = null
  let intent: LegacyEarlyExitLivePaperTradeIntent | null = null
  let status: LegacyEarlyExitLiveSignalStatus = 'rejected'
  let stopLossPrice: number | null = null
  let latestExitAt: string | null = null

  if (!isFiniteNumber(confirmedPrice)) {
    if (skipReasons.length === 0) {
      skipReasons.push('confirmation-pending')
      rationale.push(`Signal passed the quick filter at ${formatPercent(triggerPrice)} and now needs the ${options.confirmationDelaySeconds}s confirmation re-check.`)
      status = 'pending-confirmation'
      confirmationStatus = 'pending'
    } else {
      confirmationStatus = 'not-applicable'
      status = 'rejected'
    }
  } else {
    confirmationStatus = 'confirmed'

    if (confirmedPrice < options.entryMinProbability) {
      skipReasons.push('below-entry-min-after-confirm')
      rationale.push(`Confirmed price ${formatPercent(confirmedPrice)} fell below the ${formatPercent(options.entryMinProbability)} entry floor.`)
    } else if (confirmedPrice <= options.entryMaxProbability) {
      supportReasons.push('entry-band-confirmed')
    } else {
      skipReasons.push('above-entry-max')
      rationale.push(`Confirmed price ${formatPercent(confirmedPrice)} rose above the ${formatPercent(options.entryMaxProbability)} entry ceiling.`)
    }

    if (isFiniteNumber(confirmationPriceChange) && confirmationPriceChange < 0) {
      skipReasons.push('confirmation-dropped')
      rationale.push(`Confirmation price moved down from ${formatPercent(triggerPrice)} to ${formatPercent(confirmedPrice)}.`)
      confirmationStatus = 'rejected'
    } else if (isFiniteNumber(confirmationPriceChange)) {
      supportReasons.push('confirmation-held')
      rationale.push(`Confirmation held or improved by ${formatPercent(confirmationPriceChange)} over the delay window.`)
    }

    if (isFiniteNumber(confirmationPriceChange) && confirmationPriceChange < -options.maxPriceDropDuringConfirmation) {
      skipReasons.push('confirmation-drawdown-too-large')
      rationale.push(`Confirmation drawdown exceeded the ${formatPercent(options.maxPriceDropDuringConfirmation)} tolerance.`)
      confirmationStatus = 'rejected'
    }

    if (volatilityStatus === 'rejected') {
      skipReasons.push('volatility-too-high')
      rationale.push(`Observed short-window range ${formatPercent(observedRange)} exceeded the ${formatPercent(options.volatilityRangeLimit)} volatility cap.`)
    } else if (volatilityStatus === 'pass') {
      supportReasons.push('volatility-contained')
      rationale.push(`Observed short-window range ${formatPercent(observedRange)} stayed inside the ${formatPercent(options.volatilityRangeLimit)} volatility cap.`)
    }

    if (context.oracleDirectionConfirmed === false) {
      skipReasons.push('oracle-disagrees')
      rationale.push('Optional oracle direction check disagreed with the leading market side.')
    } else if (context.oracleDirectionConfirmed === true) {
      supportReasons.push('oracle-confirmed')
      rationale.push('Optional oracle direction check agreed with the leading market side.')
    }

    if (isFiniteNumber(context.askPrice) && isFiniteNumber(confirmedPrice)) {
      if ((context.askPrice - confirmedPrice) > options.askPriceDistanceLimit) {
        skipReasons.push('ask-too-far-above-mid')
        rationale.push(`Executable ask sat ${formatPercent(context.askPrice - confirmedPrice)} above midpoint, beyond the ${formatPercent(options.askPriceDistanceLimit)} limit.`)
        executionStatus = 'ask-too-high'
      } else {
        actualEntryPrice = context.askPrice
        executionStatus = 'ask-validated'
        supportReasons.push('ask-near-mid')
        rationale.push('Executable ask stayed close enough to midpoint for a paper entry assumption.')
      }
    } else {
      actualEntryPrice = confirmedPrice
      executionStatus = 'midpoint-assumed'
      rationale.push('No executable ask was supplied, so the paper engine keeps the midpoint as the assumed entry.')
    }

    if (!isFiniteNumber(actualEntryPrice) && isFiniteNumber(confirmedPrice)) {
      actualEntryPrice = confirmedPrice
    }

    if (isFiniteNumber(actualEntryPrice)) {
      expectedProfitUsd = roundTo(options.paperNotionalUsd * (options.exitTargetProbability / actualEntryPrice - 1), 4)
      expectedProfitPct = roundTo(options.exitTargetProbability / actualEntryPrice - 1, 4)
      if (expectedProfitUsd > 0) {
        supportReasons.push('profit-to-target-positive')
      }
      if (expectedProfitUsd < options.minExpectedProfitUsd) {
        skipReasons.push('insufficient-expected-profit')
        rationale.push(`Expected paper upside ${formatUsd(expectedProfitUsd)} failed the ${formatUsd(options.minExpectedProfitUsd)} minimum.`)
      }
    }

    if (skipReasons.length === 0 && asset && timeframe && selectedSide && isFiniteNumber(actualEntryPrice) && market.endDate) {
      const entry = buildEntryConstraints({
        triggerPrice: triggerPrice ?? actualEntryPrice,
        confirmedPrice: actualEntryPrice,
        options
      })
      const exit = buildExitConstraints({
        asOf,
        endDate: market.endDate,
        entryPrice: actualEntryPrice,
        options
      })
      stopLossPrice = exit.stopLossPrice
      latestExitAt = exit.latestExitAt
      thesis = buildThesis({
        market,
        asset,
        timeframe,
        side: selectedSide,
        confidence: rawConfidence,
        weightedConfidence,
        entryPrice: actualEntryPrice,
        expectedProfitUsd: expectedProfitUsd ?? 0,
        paperNotionalUsd: options.paperNotionalUsd,
        entry,
        exit
      })
      intent = {
        kind: 'paper-trade-intent',
        mode: 'paper',
        readOnly: true,
        generatedAt: asOf,
        snapshotFetchedAt: asOf,
        strategyId: options.strategyId,
        strategyVersion: options.strategyVersion,
        marketId: market.id,
        eventId: market.eventId,
        marketSlug: market.slug,
        question: market.question,
        url: market.url,
        side: selectedSide,
        confidence: weightedConfidence,
        signalScore: weightedConfidence,
        suggestedNotionalUsd: roundTo(options.paperNotionalUsd, 2),
        thesis,
        entry,
        exit,
        diagnostics: undefined as never
      }
      status = 'accepted'
    } else {
      status = 'rejected'
      if (confirmationStatus !== 'rejected') {
        confirmationStatus = 'rejected'
      }
    }
  }

  const uniqueSkipReasons = [...new Set(skipReasons)]
  const uniqueSupportReasons = [...new Set(supportReasons)]
  const uniqueRationale = [...new Set(rationale)]

  const diagnostics: LegacyEarlyExitLiveDiagnostics = {
    asOf,
    asset,
    timeframe,
    scopeMatched: uniqueSkipReasons.every((reason) => reason !== 'asset-out-of-scope' && reason !== 'timeframe-out-of-scope'),
    selectedSide,
    selectedPrice: selectedPrice === null ? null : roundTo(selectedPrice, 4),
    opposingPrice: opposingPrice === null ? null : roundTo(opposingPrice, 4),
    probabilityBand: probabilityBand(priceForConfidence ?? triggerPrice, options),
    secondsToClose: secondsToClose === null ? null : roundTo(secondsToClose, 2),
    assetWeight: assetWeight === null ? null : roundTo(assetWeight, 4),
    rawConfidence,
    weightedConfidence,
    expectedProfitUsd: expectedProfitUsd === null ? null : roundTo(expectedProfitUsd, 4),
    expectedProfitPct: expectedProfitPct === null ? null : roundTo(expectedProfitPct, 4),
    timeWindow: {
      minSeconds: options.minTimeBeforeCloseSeconds,
      maxSeconds: options.maxTimeBeforeCloseSeconds,
      status: timeStatus
    },
    confirmation: {
      required: true,
      triggerPrice: triggerPrice === null ? null : roundTo(triggerPrice, 4),
      confirmedPrice: confirmedPrice === null ? null : roundTo(confirmedPrice, 4),
      delaySeconds: roundTo(options.confirmationDelaySeconds, 4),
      maxAllowedDrop: roundTo(options.maxPriceDropDuringConfirmation, 4),
      priceChange: confirmationPriceChange === null ? null : roundTo(confirmationPriceChange, 4),
      status: confirmationStatus
    },
    volatility: {
      observedRange,
      sampleCount,
      threshold: roundTo(options.volatilityRangeLimit, 4),
      status: volatilityStatus
    },
    execution: {
      askPrice: isFiniteNumber(context.askPrice) ? roundTo(context.askPrice, 4) : null,
      askDistance,
      maxAskDistance: roundTo(options.askPriceDistanceLimit, 4),
      status: executionStatus
    },
    exitPlan: {
      takeProfitPrice: roundTo(options.exitTargetProbability, 4),
      stopLossPrice,
      stopLossFloorProbability: roundTo(options.stopLossFloorProbability, 4),
      stopLossDistance: roundTo(options.stopLossDistance, 4),
      trailingStopActivation: roundTo(options.trailingStopActivation, 4),
      trailingStopThreshold: roundTo(options.trailingStopThreshold, 4),
      damagedTradeBreakevenDrawdown: roundTo(options.damagedTradeBreakevenDrawdown, 4),
      timeDecayExitBands: options.timeDecayExitBands.map((band) => ({ ...band })),
      latestExitAt
    },
    rationale: uniqueRationale
  }

  if (intent) {
    intent = {
      ...intent,
      diagnostics
    }
  }

  return {
    market,
    status,
    recommendedSide: selectedSide,
    skipReasons: uniqueSkipReasons,
    supportReasons: uniqueSupportReasons,
    confidence: weightedConfidence,
    weightedConfidence,
    diagnostics,
    thesis,
    intent
  }
}

export function evaluateLegacyEarlyExitLiveSignal(
  market: RuntimeMarket,
  context: LegacyEarlyExitLiveMarketContext = {},
  overrides: Partial<LegacyEarlyExitLiveEngineOptions> = {}
): LegacyEarlyExitLiveEvaluatedSignal {
  return evaluateLegacyEarlyExitLiveSignalAt(market, new Date().toISOString(), context, overrides)
}

export function buildLegacyEarlyExitLiveSignalReport(
  snapshot: MarketSnapshot,
  input: {
    marketContexts?: Record<string, LegacyEarlyExitLiveMarketContext>
    overrides?: Partial<LegacyEarlyExitLiveEngineOptions>
  } = {},
  asOf = snapshot.fetchedAt
): LegacyEarlyExitLiveSignalReport {
  const options = createLegacyEarlyExitLiveEngineOptions(input.overrides)
  const evaluated = snapshot.markets.map((market) =>
    evaluateLegacyEarlyExitLiveSignalAt(market, asOf, input.marketContexts?.[market.id] ?? {}, options)
  )

  const accepted = evaluated
    .filter((signal) => signal.status === 'accepted')
    .sort((left, right) => right.weightedConfidence - left.weightedConfidence)
    .map((signal, index) => (index < options.maxIntents ? signal : { ...signal, intent: null }))

  const pendingConfirmation = evaluated
    .filter((signal) => signal.status === 'pending-confirmation')
    .sort((left, right) => right.weightedConfidence - left.weightedConfidence)

  const rejected = evaluated
    .filter((signal) => signal.status === 'rejected')
    .sort((left, right) => right.weightedConfidence - left.weightedConfidence)

  const intents = accepted.flatMap((signal) => signal.intent ? [signal.intent] : [])
  const inScopeMarkets = evaluated.filter((signal) => signal.diagnostics.scopeMatched).length

  return {
    engine: buildMetadata(options),
    snapshotFetchedAt: snapshot.fetchedAt,
    generatedAt: asOf,
    options,
    totals: {
      marketsSeen: snapshot.markets.length,
      inScopeMarkets,
      pendingConfirmation: pendingConfirmation.length,
      accepted: accepted.length,
      rejected: rejected.length,
      emittedIntents: intents.length
    },
    accepted,
    pendingConfirmation,
    rejected,
    intents
  }
}

export function createLegacyEarlyExitLivePaperTradeIntents(
  snapshot: MarketSnapshot,
  input: {
    marketContexts?: Record<string, LegacyEarlyExitLiveMarketContext>
    overrides?: Partial<LegacyEarlyExitLiveEngineOptions>
  } = {},
  asOf = snapshot.fetchedAt
): LegacyEarlyExitLivePaperTradeIntent[] {
  return buildLegacyEarlyExitLiveSignalReport(snapshot, input, asOf).intents
}
