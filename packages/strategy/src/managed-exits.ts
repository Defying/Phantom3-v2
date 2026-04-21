export type LegacyManagedExitTrigger =
  | 'managed-target-hit'
  | 'managed-stop-hit'
  | 'managed-trailing-stop'
  | 'managed-break-even'
  | 'managed-time-decay-profit'
  | 'managed-market-closing'

export type LegacyManagedExitTimeDecayRule = {
  secondsToCloseBelow: number
  minProfitFromEntry: number | null
  trigger: Extract<LegacyManagedExitTrigger, 'managed-time-decay-profit' | 'managed-market-closing'>
}

export type LegacyManagedExitConfig = {
  profile: 'legacy-early-exit-live'
  fixedTargetPrice: number
  stopLossFloorPrice: number
  stopLossDistance: number
  trailingStopActivationGain: number
  trailingStopThreshold: number
  breakEvenDipThreshold: number
  timeDecayRules: readonly LegacyManagedExitTimeDecayRule[]
  liveExecutionArmed: false
}

export type LegacyManagedExitState = {
  profile: 'legacy-early-exit-live'
  fixedTargetPrice: number
  dynamicStopPrice: number
  stopLossFloorPrice: number
  stopLossDistance: number
  trailingStopActivationGain: number
  trailingStopThreshold: number
  breakEvenDipThreshold: number
  breakEvenArmed: boolean
  trailingStopEligible: boolean
  highestObservedPrice: number
  lowestObservedPrice: number
  gainFromEntry: number
  dipFromEntry: number
  dropFromPeak: number
  currentProfit: number | null
  secondsToClose: number | null
  forceExitAt: string | null
  timeDecayStage: 'normal' | 'profit-3pct' | 'profit-1pct' | 'force-exit'
  observations: number
  lastObservedAt: string
  liveExecutionArmed: false
}

export type LegacyManagedExitEvaluation = {
  state: LegacyManagedExitState
  triggers: LegacyManagedExitTrigger[]
  takeProfitPrice: number
  stopLossPrice: number
  latestExitAt: string | null
}

export type ManagedSessionPositionEvent = {
  positionId: string
  recordedAt: string
  transition: 'opened' | 'increased' | 'reduced' | 'closed'
  realizedPnlDelta: number
}

export type LegacyManagedSessionTradeOutcome = {
  positionId: string
  closedAt: string
  realizedPnlUsd: number
}

export type LegacyManagedSessionGuardReasonCode =
  | 'session-drawdown-stop'
  | 'session-profit-pullback-stop'
  | 'session-consecutive-loss-cooldown'

export type LegacyManagedSessionGuardReason = {
  code: LegacyManagedSessionGuardReasonCode
  message: string
}

export type LegacyManagedSessionGuardConfig = {
  profile: 'legacy-early-exit-live'
  dailyProfitTargetUsd: number
  sessionPullbackUsd: number
  maxSessionDrawdownUsd: number | null
  maxConsecutiveLosses: number
  cooldownMs: number
  liveExecutionArmed: false
}

export type LegacyManagedSessionGuardState = {
  profile: 'legacy-early-exit-live'
  status: 'clear' | 'cooldown' | 'blocked'
  reasons: LegacyManagedSessionGuardReason[]
  realizedPnlUsd: number
  peakRealizedPnlUsd: number
  drawdownUsd: number
  dailyProfitTargetUsd: number
  sessionPullbackUsd: number
  maxSessionDrawdownUsd: number | null
  consecutiveLosses: number
  maxConsecutiveLosses: number
  cooldownUntil: string | null
  lastClosedTradeAt: string | null
  outcomeCount: number
  liveExecutionArmed: false
}

const EPSILON = 1e-9

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isoFromMs(value: number | null): string | null {
  return value == null || !Number.isFinite(value) ? null : new Date(value).toISOString()
}

function uniqueTriggers(triggers: LegacyManagedExitTrigger[]): LegacyManagedExitTrigger[] {
  return [...new Set(triggers)]
}

export const defaultLegacyManagedExitConfig: LegacyManagedExitConfig = {
  profile: 'legacy-early-exit-live',
  fixedTargetPrice: 0.93,
  stopLossFloorPrice: 0.7,
  stopLossDistance: 0.06,
  trailingStopActivationGain: 0.05,
  trailingStopThreshold: 0.05,
  breakEvenDipThreshold: 0.04,
  timeDecayRules: [
    {
      secondsToCloseBelow: 120,
      minProfitFromEntry: 0.03,
      trigger: 'managed-time-decay-profit'
    },
    {
      secondsToCloseBelow: 60,
      minProfitFromEntry: 0.01,
      trigger: 'managed-time-decay-profit'
    },
    {
      secondsToCloseBelow: 30,
      minProfitFromEntry: null,
      trigger: 'managed-market-closing'
    }
  ],
  liveExecutionArmed: false
}

export const defaultLegacyManagedSessionGuardConfig: LegacyManagedSessionGuardConfig = {
  profile: 'legacy-early-exit-live',
  dailyProfitTargetUsd: 55,
  sessionPullbackUsd: 15,
  maxSessionDrawdownUsd: -30,
  maxConsecutiveLosses: 3,
  cooldownMs: 10 * 60 * 1000,
  liveExecutionArmed: false
}

export function createLegacyManagedExitConfig(overrides: Partial<LegacyManagedExitConfig> = {}): LegacyManagedExitConfig {
  return {
    ...defaultLegacyManagedExitConfig,
    ...overrides,
    timeDecayRules: [...(overrides.timeDecayRules ?? defaultLegacyManagedExitConfig.timeDecayRules)],
    liveExecutionArmed: false,
    profile: 'legacy-early-exit-live'
  }
}

export function createLegacyManagedSessionGuardConfig(
  overrides: Partial<LegacyManagedSessionGuardConfig> = {}
): LegacyManagedSessionGuardConfig {
  return {
    ...defaultLegacyManagedSessionGuardConfig,
    ...overrides,
    liveExecutionArmed: false,
    profile: 'legacy-early-exit-live'
  }
}

function resolveSecondsToClose(endDate: string | null, observedAt: string): number | null {
  const endMs = parseTimestamp(endDate)
  const observedAtMs = parseTimestamp(observedAt)
  if (endMs == null || observedAtMs == null) {
    return null
  }
  return Math.max(0, Math.round((endMs - observedAtMs) / 1000))
}

function resolveForceExitAt(endDate: string | null): string | null {
  const endMs = parseTimestamp(endDate)
  if (endMs == null) {
    return null
  }
  return new Date(Math.max(0, endMs - 30_000)).toISOString()
}

export function evaluateLegacyManagedExit(input: {
  entryPrice: number
  observedAt: string
  markPrice: number | null
  marketEndDate: string | null
  previousState?: Partial<LegacyManagedExitState> | null
  config?: Partial<LegacyManagedExitConfig>
}): LegacyManagedExitEvaluation {
  const config = createLegacyManagedExitConfig(input.config)
  const fallbackPrice = input.previousState?.highestObservedPrice ?? input.previousState?.lowestObservedPrice ?? input.entryPrice
  const observedPrice = input.markPrice ?? fallbackPrice
  const previousHighest = input.previousState?.highestObservedPrice ?? input.entryPrice
  const previousLowest = input.previousState?.lowestObservedPrice ?? input.entryPrice
  const highestObservedPrice = round(Math.max(previousHighest, observedPrice))
  const lowestObservedPrice = round(Math.min(previousLowest, observedPrice))
  const gainFromEntry = round(Math.max(0, highestObservedPrice - input.entryPrice))
  const dipFromEntry = round(Math.max(0, input.entryPrice - lowestObservedPrice))
  const dropFromPeak = round(Math.max(0, highestObservedPrice - observedPrice))
  const currentProfit = input.markPrice == null ? null : round(input.markPrice - input.entryPrice)
  const dynamicStopPrice = round(clamp(Math.max(input.entryPrice - config.stopLossDistance, config.stopLossFloorPrice), 0.01, 0.99))
  const secondsToClose = resolveSecondsToClose(input.marketEndDate, input.observedAt)
  const forceExitAt = resolveForceExitAt(input.marketEndDate)

  let timeDecayStage: LegacyManagedExitState['timeDecayStage'] = 'normal'
  if (secondsToClose != null) {
    if (secondsToClose < 30) {
      timeDecayStage = 'force-exit'
    } else if (secondsToClose < 60 && currentProfit != null && currentProfit > 0.01 + EPSILON) {
      timeDecayStage = 'profit-1pct'
    } else if (secondsToClose < 120 && currentProfit != null && currentProfit > 0.03 + EPSILON) {
      timeDecayStage = 'profit-3pct'
    }
  }

  const trailingStopEligible = gainFromEntry > config.trailingStopActivationGain + EPSILON
  const breakEvenArmed = dipFromEntry >= config.breakEvenDipThreshold - EPSILON

  const triggers: LegacyManagedExitTrigger[] = []
  if (input.markPrice != null && input.markPrice >= config.fixedTargetPrice - EPSILON) {
    triggers.push('managed-target-hit')
  }
  if (
    input.markPrice != null &&
    trailingStopEligible &&
    dropFromPeak > config.trailingStopThreshold + EPSILON &&
    input.markPrice > input.entryPrice + EPSILON
  ) {
    triggers.push('managed-trailing-stop')
  }
  if (input.markPrice != null && breakEvenArmed && input.markPrice >= input.entryPrice - EPSILON) {
    triggers.push('managed-break-even')
  }

  for (const rule of [...config.timeDecayRules].sort((left, right) => right.secondsToCloseBelow - left.secondsToCloseBelow)) {
    if (secondsToClose == null || secondsToClose >= rule.secondsToCloseBelow) {
      continue
    }
    if (rule.minProfitFromEntry == null) {
      triggers.push(rule.trigger)
      continue
    }
    if (currentProfit != null && currentProfit > rule.minProfitFromEntry + EPSILON) {
      triggers.push(rule.trigger)
    }
  }

  if (input.markPrice != null && input.markPrice <= dynamicStopPrice + EPSILON) {
    triggers.push('managed-stop-hit')
  }

  return {
    state: {
      profile: 'legacy-early-exit-live',
      fixedTargetPrice: round(config.fixedTargetPrice),
      dynamicStopPrice,
      stopLossFloorPrice: round(config.stopLossFloorPrice),
      stopLossDistance: round(config.stopLossDistance),
      trailingStopActivationGain: round(config.trailingStopActivationGain),
      trailingStopThreshold: round(config.trailingStopThreshold),
      breakEvenDipThreshold: round(config.breakEvenDipThreshold),
      breakEvenArmed,
      trailingStopEligible,
      highestObservedPrice,
      lowestObservedPrice,
      gainFromEntry,
      dipFromEntry,
      dropFromPeak,
      currentProfit,
      secondsToClose,
      forceExitAt,
      timeDecayStage,
      observations: input.previousState?.observations != null
        ? input.previousState.observations + (input.markPrice == null ? 0 : 1)
        : input.markPrice == null ? 0 : 1,
      lastObservedAt: input.observedAt,
      liveExecutionArmed: false
    },
    triggers: uniqueTriggers(triggers),
    takeProfitPrice: round(config.fixedTargetPrice),
    stopLossPrice: dynamicStopPrice,
    latestExitAt: forceExitAt
  }
}

export function summarizeLegacyManagedSessionTradeOutcomes(
  positionEvents: readonly ManagedSessionPositionEvent[]
): LegacyManagedSessionTradeOutcome[] {
  const cyclePnlByPosition = new Map<string, number>()
  const outcomes: LegacyManagedSessionTradeOutcome[] = []

  for (const event of positionEvents) {
    if (event.transition === 'opened') {
      cyclePnlByPosition.set(event.positionId, 0)
      continue
    }

    if (event.transition === 'reduced' || event.transition === 'closed') {
      cyclePnlByPosition.set(
        event.positionId,
        round((cyclePnlByPosition.get(event.positionId) ?? 0) + event.realizedPnlDelta, 2)
      )
    }

    if (event.transition === 'closed') {
      outcomes.push({
        positionId: event.positionId,
        closedAt: event.recordedAt,
        realizedPnlUsd: round(cyclePnlByPosition.get(event.positionId) ?? event.realizedPnlDelta, 2)
      })
      cyclePnlByPosition.delete(event.positionId)
    }
  }

  return outcomes
}

export function evaluateLegacyManagedSessionGuards(input: {
  positionEvents: readonly ManagedSessionPositionEvent[]
  now: string
  config?: Partial<LegacyManagedSessionGuardConfig>
}): LegacyManagedSessionGuardState {
  const config = createLegacyManagedSessionGuardConfig(input.config)
  const outcomes = summarizeLegacyManagedSessionTradeOutcomes(input.positionEvents)
  const nowMs = parseTimestamp(input.now) ?? Date.now()

  let realizedPnlUsd = 0
  let peakRealizedPnlUsd = 0
  let consecutiveLosses = 0
  let cooldownUntilMs: number | null = null

  for (const outcome of outcomes) {
    realizedPnlUsd = round(realizedPnlUsd + outcome.realizedPnlUsd, 2)
    peakRealizedPnlUsd = round(Math.max(peakRealizedPnlUsd, realizedPnlUsd), 2)

    if (outcome.realizedPnlUsd < -EPSILON) {
      consecutiveLosses += 1
      if (config.maxConsecutiveLosses > 0 && consecutiveLosses >= config.maxConsecutiveLosses) {
        const closedAtMs = parseTimestamp(outcome.closedAt)
        if (closedAtMs != null) {
          cooldownUntilMs = closedAtMs + config.cooldownMs
        }
        consecutiveLosses = 0
      }
    } else {
      consecutiveLosses = 0
    }
  }

  const drawdownUsd = round(realizedPnlUsd - peakRealizedPnlUsd, 2)
  const reasons: LegacyManagedSessionGuardReason[] = []
  let status: LegacyManagedSessionGuardState['status'] = 'clear'

  if (config.maxSessionDrawdownUsd != null && realizedPnlUsd <= config.maxSessionDrawdownUsd + EPSILON) {
    status = 'blocked'
    reasons.push({
      code: 'session-drawdown-stop',
      message: `Paper session drawdown stop hit at $${round(realizedPnlUsd, 2)} (limit $${round(config.maxSessionDrawdownUsd, 2)}).`
    })
  }

  if (peakRealizedPnlUsd >= config.dailyProfitTargetUsd - EPSILON) {
    const trailingFloor = Math.max(peakRealizedPnlUsd - config.sessionPullbackUsd, config.dailyProfitTargetUsd - 5)
    if (realizedPnlUsd < trailingFloor - EPSILON) {
      status = 'blocked'
      reasons.push({
        code: 'session-profit-pullback-stop',
        message: `Paper session profit pullback stop hit at $${round(realizedPnlUsd, 2)} after peaking at $${round(peakRealizedPnlUsd, 2)}.`
      })
    }
  }

  if (status !== 'blocked' && cooldownUntilMs != null && cooldownUntilMs > nowMs) {
    status = 'cooldown'
    reasons.push({
      code: 'session-consecutive-loss-cooldown',
      message: `Paper session cooldown is active until ${new Date(cooldownUntilMs).toISOString()} after consecutive losses.`
    })
  }

  return {
    profile: 'legacy-early-exit-live',
    status,
    reasons,
    realizedPnlUsd: round(realizedPnlUsd, 2),
    peakRealizedPnlUsd: round(peakRealizedPnlUsd, 2),
    drawdownUsd,
    dailyProfitTargetUsd: round(config.dailyProfitTargetUsd, 2),
    sessionPullbackUsd: round(config.sessionPullbackUsd, 2),
    maxSessionDrawdownUsd: config.maxSessionDrawdownUsd == null ? null : round(config.maxSessionDrawdownUsd, 2),
    consecutiveLosses,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
    cooldownUntil: isoFromMs(cooldownUntilMs),
    lastClosedTradeAt: outcomes.at(-1)?.closedAt ?? null,
    outcomeCount: outcomes.length,
    liveExecutionArmed: false
  }
}
