import { z } from 'zod';

export const runtimeModeSchema = z.enum(['paper', 'live-disarmed']);
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

export const moduleStatusSchema = z.enum(['healthy', 'idle', 'warning', 'blocked']);
export type ModuleStatus = z.infer<typeof moduleStatusSchema>;

export const runtimeModuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: moduleStatusSchema,
  summary: z.string()
});
export type RuntimeModule = z.infer<typeof runtimeModuleSchema>;

export const eventLevelSchema = z.enum(['info', 'warning', 'error']);
export type EventLevel = z.infer<typeof eventLevelSchema>;

export const runtimeEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  level: eventLevelSchema,
  message: z.string()
});
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const watchEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['planned', 'active', 'disabled']),
  note: z.string()
});
export type WatchEntry = z.infer<typeof watchEntrySchema>;

export const marketDataTransportSchema = z.object({
  route: z.enum(['direct', 'proxy']),
  scope: z.literal('polymarket-only'),
  note: z.string()
});
export type MarketDataTransport = z.infer<typeof marketDataTransportSchema>;

export const polymarketOperatorEligibilitySchema = z.enum(['unknown', 'confirmed-eligible', 'restricted']);
export type PolymarketOperatorEligibility = z.infer<typeof polymarketOperatorEligibilitySchema>;

export const marketDataAccessSchema = z.object({
  operatorEligibility: polymarketOperatorEligibilitySchema,
  readOnly: z.literal(true),
  note: z.string()
});
export type MarketDataAccess = z.infer<typeof marketDataAccessSchema>;

export const runtimeMarketDataSchema = z.object({
  source: z.string(),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  refreshIntervalMs: z.number().int().positive(),
  error: z.string().nullable(),
  transport: marketDataTransportSchema,
  access: marketDataAccessSchema
});
export type RuntimeMarketData = z.infer<typeof runtimeMarketDataSchema>;

export const tradingPreferenceProfileSchema = z.enum([
  'current-v2-generic',
  'legacy-early-exit-classic',
  'legacy-early-exit-live',
  'legacy-sniper-hold'
]);
export type TradingPreferenceProfile = z.infer<typeof tradingPreferenceProfileSchema>;

export const tradingPreferenceParityStatusSchema = z.enum(['current-runtime', 'legacy-reference']);
export type TradingPreferenceParityStatus = z.infer<typeof tradingPreferenceParityStatusSchema>;

export const tradingPreferenceOptionSchema = z.object({
  profile: tradingPreferenceProfileSchema,
  label: z.string(),
  summary: z.string(),
  note: z.string(),
  intendedMarkets: z.array(z.enum(['BTC', 'ETH', 'SOL'])).min(1),
  intendedTimeframes: z.array(z.enum(['5m', '15m'])).min(1),
  parityStatus: tradingPreferenceParityStatusSchema
});
export type TradingPreferenceOption = z.infer<typeof tradingPreferenceOptionSchema>;

export const tradingPreferenceStateSchema = z.object({
  selected: tradingPreferenceOptionSchema,
  available: z.array(tradingPreferenceOptionSchema).min(1)
});
export type TradingPreferenceState = z.infer<typeof tradingPreferenceStateSchema>;

export const updateTradingPreferenceRequestSchema = z.object({
  profile: tradingPreferenceProfileSchema
});
export type UpdateTradingPreferenceRequest = z.infer<typeof updateTradingPreferenceRequestSchema>;

export const updateTradingPreferenceResponseSchema = z.object({
  ok: z.literal(true),
  tradingPreference: tradingPreferenceStateSchema
});
export type UpdateTradingPreferenceResponse = z.infer<typeof updateTradingPreferenceResponseSchema>;

export const runtimeMarketSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  slug: z.string(),
  eventTitle: z.string(),
  question: z.string(),
  yesLabel: z.string(),
  noLabel: z.string(),
  yesTokenId: z.string().nullable(),
  noTokenId: z.string().nullable(),
  yesPrice: z.number().nullable(),
  noPrice: z.number().nullable(),
  spread: z.number().nullable(),
  volume24hr: z.number().nullable(),
  liquidity: z.number().nullable(),
  endDate: z.string().nullable(),
  url: z.string().url()
});
export type RuntimeMarket = z.infer<typeof runtimeMarketSchema>;

export const strategyRuntimeStatusSchema = z.enum(['idle', 'observing', 'paused', 'degraded']);
export type StrategyRuntimeStatus = z.infer<typeof strategyRuntimeStatusSchema>;

export const strategyCandidateSchema = z.object({
  marketId: z.string(),
  slug: z.string(),
  question: z.string(),
  yesPrice: z.number().nullable(),
  noPrice: z.number().nullable(),
  spread: z.number().nullable(),
  liquidity: z.number().nullable(),
  volume24hr: z.number().nullable(),
  score: z.number().nonnegative(),
  status: z.enum(['watch', 'pending-data']),
  rationale: z.string()
});
export type StrategyCandidate = z.infer<typeof strategyCandidateSchema>;

export const paperExitTriggerSchema = z.enum([
  'take-profit-hit',
  'stop-loss-hit',
  'latest-exit-reached',
  'spread-invalidated',
  'complement-invalidated',
  'expiry-window',
  'managed-target-hit',
  'managed-stop-hit',
  'managed-trailing-stop',
  'managed-break-even',
  'managed-time-decay-profit',
  'managed-market-closing'
]);
export type PaperExitTrigger = z.infer<typeof paperExitTriggerSchema>;

export const paperIntentSummarySchema = z.object({
  id: z.string(),
  marketId: z.string(),
  marketQuestion: z.string(),
  side: z.enum(['yes', 'no']),
  kind: z.enum(['entry', 'exit']),
  executionSide: z.enum(['buy', 'sell']),
  reduceOnly: z.boolean(),
  status: z.enum(['draft', 'watching', 'submitted', 'closed']),
  createdAt: z.string(),
  thesis: z.string(),
  desiredSizeUsd: z.number().nonnegative(),
  positionId: z.string().nullable(),
  trigger: paperExitTriggerSchema.nullable(),
  limitPrice: z.number().min(0).max(1).nullable(),
  maxEntryPrice: z.number().min(0).max(1).nullable()
});
export type PaperIntentSummary = z.infer<typeof paperIntentSummarySchema>;

export const riskDecisionSummarySchema = z.object({
  id: z.string(),
  intentId: z.string(),
  marketId: z.string(),
  question: z.string(),
  kind: z.enum(['entry', 'exit']),
  reduceOnly: z.boolean(),
  decision: z.enum(['approve', 'reject', 'resize', 'block']),
  approvedSizeUsd: z.number().nonnegative(),
  createdAt: z.string(),
  reasons: z.array(z.string())
});
export type RiskDecisionSummary = z.infer<typeof riskDecisionSummarySchema>;

export const paperManagedExitStateSchema = z.object({
  profile: z.literal('legacy-early-exit-live'),
  fixedTargetPrice: z.number().min(0).max(1),
  dynamicStopPrice: z.number().min(0).max(1),
  stopLossFloorPrice: z.number().min(0).max(1),
  stopLossDistance: z.number().nonnegative(),
  trailingStopActivationGain: z.number().nonnegative(),
  trailingStopThreshold: z.number().nonnegative(),
  breakEvenDipThreshold: z.number().nonnegative(),
  breakEvenArmed: z.boolean(),
  trailingStopEligible: z.boolean(),
  highestObservedPrice: z.number().min(0).max(1),
  lowestObservedPrice: z.number().min(0).max(1),
  gainFromEntry: z.number().nonnegative(),
  dipFromEntry: z.number().nonnegative(),
  dropFromPeak: z.number().nonnegative(),
  currentProfit: z.number().nullable(),
  secondsToClose: z.number().int().nonnegative().nullable(),
  forceExitAt: z.string().nullable(),
  timeDecayStage: z.enum(['normal', 'profit-3pct', 'profit-1pct', 'force-exit']),
  observations: z.number().int().nonnegative(),
  lastObservedAt: z.string(),
  liveExecutionArmed: z.literal(false)
});
export type PaperManagedExitState = z.infer<typeof paperManagedExitStateSchema>;

export const paperSessionGuardReasonSchema = z.object({
  code: z.enum([
    'session-drawdown-stop',
    'session-profit-pullback-stop',
    'session-consecutive-loss-cooldown'
  ]),
  message: z.string()
});
export type PaperSessionGuardReason = z.infer<typeof paperSessionGuardReasonSchema>;

export const paperSessionGuardSchema = z.object({
  profile: z.literal('legacy-early-exit-live'),
  status: z.enum(['clear', 'cooldown', 'blocked']),
  reasons: z.array(paperSessionGuardReasonSchema),
  realizedPnlUsd: z.number(),
  peakRealizedPnlUsd: z.number(),
  drawdownUsd: z.number(),
  dailyProfitTargetUsd: z.number(),
  sessionPullbackUsd: z.number(),
  maxSessionDrawdownUsd: z.number().nullable(),
  consecutiveLosses: z.number().int().nonnegative(),
  maxConsecutiveLosses: z.number().int().nonnegative(),
  cooldownUntil: z.string().nullable(),
  lastClosedTradeAt: z.string().nullable(),
  outcomeCount: z.number().int().nonnegative(),
  liveExecutionArmed: z.literal(false)
});
export type PaperSessionGuard = z.infer<typeof paperSessionGuardSchema>;

export const paperPositionExitSchema = z.object({
  status: z.enum(['armed', 'triggered', 'submitted']),
  triggers: z.array(paperExitTriggerSchema),
  evaluatedAt: z.string(),
  summary: z.string(),
  takeProfitPrice: z.number().min(0).max(1).nullable(),
  stopLossPrice: z.number().min(0).max(1).nullable(),
  latestExitAt: z.string().nullable(),
  invalidateIfSpreadAbove: z.number().min(0).max(1).nullable(),
  invalidateIfComplementDriftAbove: z.number().nonnegative().nullable(),
  invalidateIfHoursToExpiryBelow: z.number().nonnegative().nullable(),
  recommendedQuantity: z.number().nonnegative(),
  recommendedSizeUsd: z.number().nonnegative(),
  recommendedLimitPrice: z.number().min(0).max(1).nullable(),
  submittedIntentId: z.string().nullable(),
  profile: z.enum(['generic', 'legacy-early-exit-live']).optional(),
  managed: paperManagedExitStateSchema.nullable().optional(),
  sessionGuard: paperSessionGuardSchema.nullable().optional(),
  liveExecutionArmed: z.literal(false).optional()
});
export type PaperPositionExit = z.infer<typeof paperPositionExitSchema>;

export const paperPositionSummarySchema = z.object({
  id: z.string(),
  marketId: z.string(),
  tokenId: z.string().nullable(),
  marketQuestion: z.string(),
  side: z.enum(['yes', 'no']),
  quantity: z.number().nonnegative(),
  averageEntryPrice: z.number().min(0).max(1),
  markPrice: z.number().min(0).max(1).nullable(),
  unrealizedPnlUsd: z.number().nullable(),
  openedAt: z.string(),
  status: z.enum(['open', 'closed']),
  exit: paperPositionExitSchema.nullable()
});
export type PaperPositionSummary = z.infer<typeof paperPositionSummarySchema>;

export const strategyRoutingExecutionModeSchema = z.enum(['paper-active', 'reference-only']);
export type StrategyRoutingExecutionMode = z.infer<typeof strategyRoutingExecutionModeSchema>;

export const strategyRoutingEntryPolicySchema = z.enum(['emit-new-entries', 'manage-open-positions-only']);
export type StrategyRoutingEntryPolicy = z.infer<typeof strategyRoutingEntryPolicySchema>;

export const strategyRoutingSummarySchema = z.object({
  requestedProfile: tradingPreferenceProfileSchema,
  requestedLabel: z.string(),
  evaluatedProfile: tradingPreferenceProfileSchema,
  evaluatedLabel: z.string(),
  strategyId: z.string(),
  strategyVersion: z.string(),
  selectionMode: z.string(),
  executionMode: strategyRoutingExecutionModeSchema,
  entryPolicy: strategyRoutingEntryPolicySchema,
  summary: z.string(),
  note: z.string()
});
export type StrategyRoutingSummary = z.infer<typeof strategyRoutingSummarySchema>;

export const requestedRuntimeModeSchema = z.enum(['paper', 'live']);
export type RequestedRuntimeMode = z.infer<typeof requestedRuntimeModeSchema>;

export const runtimeTradeStatusSchema = z.enum(['pending', 'reconcile', 'open', 'closed', 'error']);
export type RuntimeTradeStatus = z.infer<typeof runtimeTradeStatusSchema>;

export const runtimeTradeStateCountsSchema = z.object({
  pending: z.number().int().nonnegative(),
  reconcile: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  error: z.number().int().nonnegative()
});
export type RuntimeTradeStateCounts = z.infer<typeof runtimeTradeStateCountsSchema>;

export const runtimeTradeSummarySchema = z.object({
  id: z.string(),
  marketId: z.string(),
  tokenId: z.string(),
  marketQuestion: z.string(),
  side: z.enum(['yes', 'no']),
  status: runtimeTradeStatusSchema,
  note: z.string(),
  orderCount: z.number().int().nonnegative(),
  openOrderCount: z.number().int().nonnegative(),
  filledQuantity: z.number().nonnegative(),
  remainingQuantity: z.number().nonnegative(),
  positionQuantity: z.number().nonnegative(),
  averageEntryPrice: z.number().min(0).max(1).nullable(),
  markPrice: z.number().min(0).max(1).nullable(),
  realizedPnlUsd: z.number().nullable(),
  unrealizedPnlUsd: z.number().nullable(),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  lastUpdatedAt: z.string()
});
export type RuntimeTradeSummary = z.infer<typeof runtimeTradeSummarySchema>;

export const runtimeLiveControlSchema = z.object({
  configured: z.boolean(),
  armable: z.boolean(),
  armed: z.boolean(),
  liveAdapterReady: z.boolean(),
  killSwitchActive: z.boolean(),
  killSwitchReason: z.string().nullable(),
  flattenSupported: z.boolean(),
  lastOperatorAction: z.string().nullable(),
  lastOperatorActionAt: z.string().nullable(),
  summary: z.string()
});
export type RuntimeLiveControl = z.infer<typeof runtimeLiveControlSchema>;

export const runtimeExecutionSummarySchema = z.object({
  requestedMode: requestedRuntimeModeSchema,
  summary: z.string(),
  tradeStates: runtimeTradeStateCountsSchema,
  trades: z.array(runtimeTradeSummarySchema),
  live: runtimeLiveControlSchema
});
export type RuntimeExecutionSummary = z.infer<typeof runtimeExecutionSummarySchema>;

export const strategyRuntimeSummarySchema = z.object({
  engineId: z.string(),
  strategyVersion: z.string(),
  mode: runtimeModeSchema,
  status: strategyRuntimeStatusSchema,
  safeToExpose: z.literal(true),
  routing: strategyRoutingSummarySchema.optional(),
  lastEvaluatedAt: z.string().nullable(),
  lastSnapshotAt: z.string().nullable(),
  watchedMarketCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  openIntentCount: z.number().int().nonnegative(),
  openPositionCount: z.number().int().nonnegative(),
  openExposureUsd: z.number().nonnegative(),
  summary: z.string(),
  candidates: z.array(strategyCandidateSchema),
  intents: z.array(paperIntentSummarySchema),
  riskDecisions: z.array(riskDecisionSummarySchema),
  positions: z.array(paperPositionSummarySchema),
  notes: z.array(z.string())
});
export type StrategyRuntimeSummary = z.infer<typeof strategyRuntimeSummarySchema>;

export const strategyStateSnapshotSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  trigger: z.enum(['bootstrap', 'market-refresh', 'market-refresh-error', 'pause', 'resume']),
  mode: runtimeModeSchema,
  status: strategyRuntimeStatusSchema,
  summary: z.string(),
  watchedMarketCount: z.number().int().nonnegative(),
  candidates: z.array(strategyCandidateSchema),
  intents: z.array(paperIntentSummarySchema),
  riskDecisions: z.array(riskDecisionSummarySchema),
  positions: z.array(paperPositionSummarySchema),
  notes: z.array(z.string())
});
export type StrategyStateSnapshot = z.infer<typeof strategyStateSnapshotSchema>;

export const paperStrategyViewSchema = z.object({
  mode: z.literal('paper'),
  safeToExpose: z.literal(true),
  summary: strategyRuntimeSummarySchema,
  latestSnapshot: strategyStateSnapshotSchema.nullable(),
  snapshots: z.array(strategyStateSnapshotSchema)
});
export type PaperStrategyView = z.infer<typeof paperStrategyViewSchema>;

export const runtimeStateSchema = z.object({
  appName: z.literal('Phantom3 v2'),
  version: z.string(),
  mode: runtimeModeSchema,
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  paused: z.boolean(),
  remoteDashboardEnabled: z.boolean(),
  publicBaseUrl: z.string(),
  tradingPreference: tradingPreferenceStateSchema,
  marketData: runtimeMarketDataSchema,
  markets: z.array(runtimeMarketSchema),
  strategy: strategyRuntimeSummarySchema,
  execution: runtimeExecutionSummarySchema,
  modules: z.array(runtimeModuleSchema),
  watchlist: z.array(watchEntrySchema),
  events: z.array(runtimeEventSchema)
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
