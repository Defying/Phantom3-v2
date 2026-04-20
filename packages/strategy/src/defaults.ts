import type { StrategyEngineMetadata, StrategyEngineOptions } from './types.js'

export const defaultStrategyEngineMetadata: StrategyEngineMetadata = {
  strategyId: 'binary-snapshot-contrarian',
  strategyVersion: '0.1.0',
  selectionMode: 'discounted-underdog',
  paperOnly: true,
  source: 'market-snapshot'
}

export const defaultStrategyEngineOptions: StrategyEngineOptions = {
  strategyId: defaultStrategyEngineMetadata.strategyId,
  strategyVersion: defaultStrategyEngineMetadata.strategyVersion,
  maxIntents: 5,
  minConfidence: 0.55,
  minLiquidity: 15000,
  minVolume24hr: 10000,
  maxSpread: 0.06,
  maxComplementDrift: 0.08,
  minHoursToExpiry: 6,
  minPriceImbalance: 0.12,
  minSidePrice: 0.08,
  maxSidePrice: 0.42,
  preferredUnderdogPrice: 0.32,
  maxPriceDistanceFromPreferred: 0.18,
  entryPriceTolerance: 0.015,
  maxSnapshotAgeMs: 120000,
  maxHoldingHours: 36,
  exitBufferHours: 2,
  takeProfitDistanceFactor: 0.45,
  stopLossDistanceFactor: 0.22,
  spreadInvalidationMultiplier: 1.5,
  paperNotionalUsd: 50,
  maxNotionalPctOfLiquidity: 0.0025
}

export function createStrategyEngineOptions(overrides: Partial<StrategyEngineOptions> = {}): StrategyEngineOptions {
  return {
    ...defaultStrategyEngineOptions,
    ...overrides,
    strategyId: overrides.strategyId ?? defaultStrategyEngineOptions.strategyId,
    strategyVersion: overrides.strategyVersion ?? defaultStrategyEngineOptions.strategyVersion
  }
}
