import type { RuntimeMarket } from '../../contracts/src/index.js'
import type { MarketSnapshot } from '../../market-data/src/index.js'
import { defaultStrategyEngineMetadata, createStrategyEngineOptions } from './defaults.js'
import type {
  BinarySide,
  EvaluatedMarketSignal,
  PaperTradeIntent,
  StrategyEngineMetadata,
  StrategyEngineOptions,
  StrategyEntryConstraints,
  StrategyExitConstraints,
  StrategySignalDiagnostics,
  StrategySignalReport,
  StrategyThesis,
  SupportReasonCode
} from './types.js'

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

function scaleLog(value: number | null, floor: number, ceiling: number): number {
  if (!isFiniteNumber(value) || value <= 0) {
    return 0
  }

  const safeFloor = Math.max(floor, 1)
  const safeCeiling = Math.max(ceiling, safeFloor + 1)
  const min = Math.log10(safeFloor)
  const max = Math.log10(safeCeiling)
  const current = Math.log10(Math.max(value, 1))

  if (max <= min) {
    return current >= max ? 1 : 0
  }

  return clamp((current - min) / (max - min), 0, 1)
}

function parseIsoDate(value: string | null): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function hoursUntil(endDate: string | null, asOf: string): number | null {
  const endMs = parseIsoDate(endDate)
  const asOfMs = parseIsoDate(asOf)
  if (endMs === null || asOfMs === null) {
    return null
  }
  return roundTo((endMs - asOfMs) / 3600000, 2)
}

function formatUsd(value: number | null): string {
  if (!isFiniteNumber(value)) {
    return 'unknown'
  }
  if (value >= 1000000) {
    return `$${roundTo(value / 1000000, 2)}m`
  }
  if (value >= 1000) {
    return `$${roundTo(value / 1000, 1)}k`
  }
  return `$${roundTo(value, 0)}`
}

function formatProbability(value: number | null): string {
  if (!isFiniteNumber(value)) {
    return 'unknown'
  }
  return roundTo(value, 3).toFixed(3)
}

function formatPercent(value: number): string {
  return `${roundTo(value * 100, 1)}%`
}

function formatHours(value: number | null): string {
  if (!isFiniteNumber(value)) {
    return 'unknown'
  }
  return `${roundTo(value, 1)}h`
}

function selectDiscountedSide(yesPrice: number, noPrice: number): {
  side: BinarySide
  selectedPrice: number
  opposingPrice: number
} {
  if (yesPrice <= noPrice) {
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

function buildDiagnostics(input: {
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
}): StrategySignalDiagnostics {
  return {
    asOf: input.asOf,
    selectedSide: input.selectedSide,
    selectedPrice: input.selectedPrice === null ? null : roundTo(input.selectedPrice, 4),
    opposingPrice: input.opposingPrice === null ? null : roundTo(input.opposingPrice, 4),
    priceSum: roundTo(input.priceSum, 4),
    complementDrift: roundTo(input.complementDrift, 4),
    priceImbalance: roundTo(input.priceImbalance, 4),
    spread: input.spread === null ? null : roundTo(input.spread, 4),
    liquidity: input.liquidity === null ? null : roundTo(input.liquidity, 2),
    volume24hr: input.volume24hr === null ? null : roundTo(input.volume24hr, 2),
    hoursToExpiry: input.hoursToExpiry === null ? null : roundTo(input.hoursToExpiry, 2),
    qualityScore: roundTo(input.qualityScore, 4),
    setupScore: roundTo(input.setupScore, 4),
    signalScore: roundTo(input.signalScore, 4)
  }
}

function collectSupportReasons(input: {
  spread: number | null
  liquidity: number | null
  volume24hr: number | null
  hoursToExpiry: number | null
  complementDrift: number
  priceImbalance: number
  selectedPrice: number | null
  options: StrategyEngineOptions
}): SupportReasonCode[] {
  const reasons: SupportReasonCode[] = []

  if (isFiniteNumber(input.spread) && input.spread <= input.options.maxSpread * 0.5) {
    reasons.push('tight-spread')
  }
  if (isFiniteNumber(input.liquidity) && input.liquidity >= input.options.minLiquidity) {
    reasons.push('ample-liquidity')
  }
  if (isFiniteNumber(input.volume24hr) && input.volume24hr >= input.options.minVolume24hr) {
    reasons.push('ample-volume')
  }
  if (isFiniteNumber(input.hoursToExpiry) && input.hoursToExpiry >= input.options.minHoursToExpiry * 2) {
    reasons.push('comfortable-time-to-expiry')
  }
  if (input.complementDrift <= input.options.maxComplementDrift * 0.5) {
    reasons.push('sane-complement')
  }
  if (input.priceImbalance >= input.options.minPriceImbalance * 1.5) {
    reasons.push('clear-consensus-skew')
  }
  if (
    isFiniteNumber(input.selectedPrice) &&
    Math.abs(input.selectedPrice - input.options.preferredUnderdogPrice) <= input.options.maxPriceDistanceFromPreferred * 0.5
  ) {
    reasons.push('discounted-side-in-band')
  }

  return reasons
}

function buildEntryConstraints(
  selectedPrice: number,
  spread: number | null,
  options: StrategyEngineOptions
): StrategyEntryConstraints {
  const bandHalfWidth = clamp(
    options.entryPriceTolerance + (isFiniteNumber(spread) ? spread / 2 : 0),
    options.entryPriceTolerance,
    options.maxSpread / 2
  )

  return {
    limitOnly: true,
    acceptablePriceBand: {
      min: roundTo(clamp(selectedPrice - bandHalfWidth, 0.01, 0.98), 4),
      max: roundTo(clamp(selectedPrice + bandHalfWidth, 0.01, 0.98), 4)
    },
    maxSpread: roundTo(options.maxSpread, 4),
    minLiquidity: options.minLiquidity,
    minVolume24hr: options.minVolume24hr,
    minHoursToExpiry: options.minHoursToExpiry,
    cancelIfSnapshotOlderThanMs: options.maxSnapshotAgeMs
  }
}

function buildExitConstraints(
  endDate: string,
  asOf: string,
  selectedPrice: number,
  spread: number | null,
  complementDrift: number,
  options: StrategyEngineOptions
): StrategyExitConstraints {
  const asOfMs = parseIsoDate(asOf) ?? Date.now()
  const endMs = parseIsoDate(endDate) ?? asOfMs + options.maxHoldingHours * 3600000
  const maxHoldingMs = options.maxHoldingHours * 3600000
  const exitBufferMs = options.exitBufferHours * 3600000
  const latestExitMs = Math.max(asOfMs + 3600000, Math.min(endMs - exitBufferMs, asOfMs + maxHoldingMs))

  const takeProfitDistance = Math.max(0.02, (0.5 - selectedPrice) * options.takeProfitDistanceFactor)
  const stopLossDistance = Math.max(0.02, selectedPrice * options.stopLossDistanceFactor)
  const baseSpread = isFiniteNumber(spread) ? spread : options.maxSpread * 0.5

  return {
    takeProfitPrice: roundTo(clamp(selectedPrice + takeProfitDistance, selectedPrice + 0.01, 0.95), 4),
    stopLossPrice: roundTo(clamp(selectedPrice - stopLossDistance, 0.01, selectedPrice - 0.01), 4),
    latestExitAt: new Date(latestExitMs).toISOString(),
    invalidateIfSpreadAbove: roundTo(clamp(baseSpread * options.spreadInvalidationMultiplier, 0.01, options.maxSpread), 4),
    invalidateIfComplementDriftAbove: roundTo(Math.max(options.maxComplementDrift, complementDrift), 4),
    invalidateIfHoursToExpiryBelow: options.minHoursToExpiry
  }
}

function buildThesis(input: {
  market: RuntimeMarket
  side: BinarySide
  selectedPrice: number
  opposingPrice: number
  confidence: number
  entry: StrategyEntryConstraints
  exit: StrategyExitConstraints
  diagnostics: StrategySignalDiagnostics
}): StrategyThesis {
  const sideLabel = input.side === 'yes' ? input.market.yesLabel : input.market.noLabel
  const oppositeLabel = input.side === 'yes' ? input.market.noLabel : input.market.yesLabel

  return {
    summary: `Paper-only ${input.side.toUpperCase()} setup on "${input.market.question}" with ${formatPercent(input.confidence)} confidence.`,
    bullets: [
      `${sideLabel} is the discounted side at ${formatProbability(input.selectedPrice)} versus ${oppositeLabel} at ${formatProbability(input.opposingPrice)}.`,
      `24h volume ${formatUsd(input.market.volume24hr)} and liquidity ${formatUsd(input.market.liquidity)} pass the engine's conservative quality gates.`,
      `Complement drift is ${formatProbability(input.diagnostics.complementDrift)} and spread is ${formatProbability(input.market.spread)}, which keeps the snapshot usable for paper ranking.`,
      `Entry stays inside ${formatProbability(input.entry.acceptablePriceBand.min)} to ${formatProbability(input.entry.acceptablePriceBand.max)} with a paper take-profit at ${formatProbability(input.exit.takeProfitPrice)} and stop at ${formatProbability(input.exit.stopLossPrice)}.`
    ]
  }
}

function buildSuggestedNotionalUsd(
  market: RuntimeMarket,
  confidence: number,
  options: StrategyEngineOptions
): number {
  const liquidityCap = Math.max(10, (market.liquidity ?? options.minLiquidity) * options.maxNotionalPctOfLiquidity)
  const scaledNotional = options.paperNotionalUsd * (0.8 + confidence * 0.4)
  return roundTo(Math.min(liquidityCap, scaledNotional), 2)
}

function buildMetadata(options: StrategyEngineOptions): StrategyEngineMetadata {
  return {
    ...defaultStrategyEngineMetadata,
    strategyId: options.strategyId,
    strategyVersion: options.strategyVersion
  }
}

export function evaluateBinaryMarketSignalAt(
  market: RuntimeMarket,
  asOf: string,
  overrides: Partial<StrategyEngineOptions> = {}
): EvaluatedMarketSignal {
  const options = createStrategyEngineOptions(overrides)
  const yesPrice = isFiniteNumber(market.yesPrice) ? market.yesPrice : null
  const noPrice = isFiniteNumber(market.noPrice) ? market.noPrice : null
  const hasPrices = yesPrice !== null && noPrice !== null
  const endDateMs = parseIsoDate(market.endDate)
  const hasUsableEndDate = endDateMs !== null

  const sideSelection = yesPrice !== null && noPrice !== null ? selectDiscountedSide(yesPrice, noPrice) : null
  const selectedSide = sideSelection?.side ?? null
  const selectedPrice = sideSelection?.selectedPrice ?? null
  const opposingPrice = sideSelection?.opposingPrice ?? null
  const priceSum = yesPrice !== null && noPrice !== null ? yesPrice + noPrice : 0
  const complementDrift = yesPrice !== null && noPrice !== null ? Math.abs(1 - priceSum) : 1
  const priceImbalance = yesPrice !== null && noPrice !== null ? Math.abs(yesPrice - noPrice) : 0
  const hoursToExpiry = hasUsableEndDate ? hoursUntil(market.endDate, asOf) : null

  const spreadScore = market.spread === null ? 0.45 : 1 - clamp(market.spread / (options.maxSpread * 1.5), 0, 1)
  const liquidityScore = scaleLog(market.liquidity, options.minLiquidity, options.minLiquidity * 10)
  const volumeScore = scaleLog(market.volume24hr, options.minVolume24hr, options.minVolume24hr * 10)
  const timeScore = isFiniteNumber(hoursToExpiry)
    ? scaleLinear(hoursToExpiry, options.minHoursToExpiry, options.minHoursToExpiry + options.maxHoldingHours)
    : 0
  const complementScore = 1 - clamp(complementDrift / (options.maxComplementDrift * 1.25), 0, 1)
  const qualityScore = yesPrice !== null && noPrice !== null
    ? roundTo(0.26 * spreadScore + 0.23 * liquidityScore + 0.21 * volumeScore + 0.15 * timeScore + 0.15 * complementScore, 4)
    : 0

  const imbalanceScore = scaleLinear(priceImbalance, options.minPriceImbalance, 0.85)
  const preferredBandScore = isFiniteNumber(selectedPrice)
    ? 1 - clamp(Math.abs(selectedPrice - options.preferredUnderdogPrice) / options.maxPriceDistanceFromPreferred, 0, 1)
    : 0
  const setupScore = yesPrice !== null && noPrice !== null ? roundTo(0.6 * imbalanceScore + 0.4 * preferredBandScore, 4) : 0
  const signalScore = yesPrice !== null && noPrice !== null ? roundTo(0.6 * qualityScore + 0.4 * setupScore, 4) : 0
  const confidence = roundTo(clamp(0.2 + signalScore * 0.75, 0, 0.95), 4)

  const diagnostics = buildDiagnostics({
    asOf,
    selectedSide,
    selectedPrice,
    opposingPrice,
    priceSum,
    complementDrift,
    priceImbalance,
    spread: market.spread,
    liquidity: market.liquidity,
    volume24hr: market.volume24hr,
    hoursToExpiry,
    qualityScore,
    setupScore,
    signalScore
  })

  const rejectReasons: EvaluatedMarketSignal['rejectReasons'] = []

  if (!hasPrices) {
    rejectReasons.push('missing-price')
  }
  if (!hasUsableEndDate) {
    rejectReasons.push('missing-end-date')
  }
  if (
    yesPrice !== null &&
    noPrice !== null &&
    (
      yesPrice <= 0 ||
      yesPrice >= 1 ||
      noPrice <= 0 ||
      noPrice >= 1 ||
      !isFiniteNumber(selectedPrice) ||
      selectedPrice < options.minSidePrice ||
      selectedPrice > options.maxSidePrice
    )
  ) {
    rejectReasons.push('invalid-price-band')
  }
  if (yesPrice !== null && noPrice !== null && complementDrift > options.maxComplementDrift) {
    rejectReasons.push('broken-complement')
  }
  if (isFiniteNumber(market.spread) && market.spread > options.maxSpread) {
    rejectReasons.push('wide-spread')
  }
  if (!isFiniteNumber(market.liquidity) || market.liquidity < options.minLiquidity) {
    rejectReasons.push('low-liquidity')
  }
  if (!isFiniteNumber(market.volume24hr) || market.volume24hr < options.minVolume24hr) {
    rejectReasons.push('low-volume')
  }
  if (hasUsableEndDate && (!isFiniteNumber(hoursToExpiry) || hoursToExpiry < options.minHoursToExpiry)) {
    rejectReasons.push('near-expiry')
  }
  if (yesPrice !== null && noPrice !== null && priceImbalance < options.minPriceImbalance) {
    rejectReasons.push('weak-imbalance')
  }
  if (rejectReasons.length === 0 && confidence < options.minConfidence) {
    rejectReasons.push('insufficient-confidence')
  }

  const supportReasons = collectSupportReasons({
    spread: market.spread,
    liquidity: market.liquidity,
    volume24hr: market.volume24hr,
    hoursToExpiry,
    complementDrift,
    priceImbalance,
    selectedPrice,
    options
  })

  if (rejectReasons.length > 0 || !selectedSide || !isFiniteNumber(selectedPrice) || !isFiniteNumber(opposingPrice) || !market.endDate) {
    return {
      market,
      status: 'rejected',
      recommendedSide: selectedSide,
      rejectReasons,
      supportReasons,
      confidence,
      signalScore,
      diagnostics,
      thesis: null,
      intent: null
    }
  }

  const entry = buildEntryConstraints(selectedPrice, market.spread, options)
  const exit = buildExitConstraints(market.endDate, asOf, selectedPrice, market.spread, complementDrift, options)
  const thesis = buildThesis({
    market,
    side: selectedSide,
    selectedPrice,
    opposingPrice,
    confidence,
    entry,
    exit,
    diagnostics
  })
  const intent: PaperTradeIntent = {
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
    confidence,
    signalScore,
    suggestedNotionalUsd: buildSuggestedNotionalUsd(market, confidence, options),
    thesis,
    entry,
    exit,
    diagnostics
  }

  return {
    market,
    status: 'accepted',
    recommendedSide: selectedSide,
    rejectReasons,
    supportReasons,
    confidence,
    signalScore,
    diagnostics,
    thesis,
    intent
  }
}

export function evaluateBinaryMarketSignal(
  market: RuntimeMarket,
  overrides: Partial<StrategyEngineOptions> = {}
): EvaluatedMarketSignal {
  return evaluateBinaryMarketSignalAt(market, new Date().toISOString(), overrides)
}

export function buildStrategySignalReport(
  snapshot: MarketSnapshot,
  overrides: Partial<StrategyEngineOptions> = {},
  asOf = snapshot.fetchedAt
): StrategySignalReport {
  const options = createStrategyEngineOptions(overrides)
  const generatedAt = asOf
  const evaluated = snapshot.markets.map((market) => evaluateBinaryMarketSignalAt(market, generatedAt, options))

  const accepted = evaluated
    .filter((candidate) => candidate.status === 'accepted')
    .sort((left, right) => right.signalScore - left.signalScore || right.confidence - left.confidence)
    .map((candidate, index) => (index < options.maxIntents ? candidate : { ...candidate, intent: null }))

  const rejected = evaluated
    .filter((candidate) => candidate.status === 'rejected')
    .sort((left, right) => right.signalScore - left.signalScore || right.confidence - left.confidence)

  const intents = accepted.flatMap((candidate) => (candidate.intent ? [candidate.intent] : []))

  return {
    engine: buildMetadata(options),
    snapshotFetchedAt: snapshot.fetchedAt,
    generatedAt,
    options,
    totals: {
      marketsSeen: snapshot.markets.length,
      eligibleMarkets: accepted.length,
      rejectedMarkets: rejected.length,
      emittedIntents: intents.length
    },
    accepted,
    rejected,
    intents
  }
}

export function createPaperTradeIntents(
  snapshot: MarketSnapshot,
  overrides: Partial<StrategyEngineOptions> = {},
  asOf = snapshot.fetchedAt
): PaperTradeIntent[] {
  return buildStrategySignalReport(snapshot, overrides, asOf).intents
}
