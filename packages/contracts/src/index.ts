import { z } from 'zod';

export const runtimeModeSchema = z.enum(['simulation', 'paper', 'live-disarmed']);
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

export const runtimeMarketDataSchema = z.object({
  source: z.string(),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  refreshIntervalMs: z.number().int().positive(),
  error: z.string().nullable()
});
export type RuntimeMarketData = z.infer<typeof runtimeMarketDataSchema>;

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

export const paperIntentSummarySchema = z.object({
  id: z.string(),
  marketId: z.string(),
  marketQuestion: z.string(),
  side: z.enum(['yes', 'no']),
  status: z.enum(['draft', 'watching', 'submitted', 'closed']),
  createdAt: z.string(),
  thesis: z.string(),
  desiredSizeUsd: z.number().nonnegative(),
  maxEntryPrice: z.number().min(0).max(1).nullable()
});
export type PaperIntentSummary = z.infer<typeof paperIntentSummarySchema>;

export const riskDecisionSummarySchema = z.object({
  id: z.string(),
  intentId: z.string(),
  marketId: z.string(),
  question: z.string(),
  decision: z.enum(['approve', 'reject', 'resize', 'block']),
  approvedSizeUsd: z.number().nonnegative(),
  createdAt: z.string(),
  reasons: z.array(z.string())
});
export type RiskDecisionSummary = z.infer<typeof riskDecisionSummarySchema>;

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
  status: z.enum(['open', 'closed'])
});
export type PaperPositionSummary = z.infer<typeof paperPositionSummarySchema>;

export const requestedRuntimeModeSchema = z.enum(['simulation', 'paper', 'live']);
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

export const runtimeLiveControlStatusSchema = z.enum(['paper-only', 'scaffold', 'adapter-ready', 'blocked-by-reconcile']);
export type RuntimeLiveControlStatus = z.infer<typeof runtimeLiveControlStatusSchema>;

export const runtimeFlattenPathSchema = z.enum(['paper', 'live', 'blocked']);
export type RuntimeFlattenPath = z.infer<typeof runtimeFlattenPathSchema>;

export const runtimeLiveReadinessStatusSchema = z.enum(['not-required', 'unknown', 'ready', 'blocked']);
export type RuntimeLiveReadinessStatus = z.infer<typeof runtimeLiveReadinessStatusSchema>;

export const runtimeLiveCollateralReadinessSchema = z.object({
  status: runtimeLiveReadinessStatusSchema,
  checkedAt: z.string().nullable(),
  stale: z.boolean(),
  pUsdBalance: z.number().nonnegative().nullable(),
  pUsdAllowance: z.number().nonnegative().nullable(),
  requiredPUsdBalance: z.number().nonnegative(),
  requiredPUsdAllowance: z.number().nonnegative(),
  polGasBalance: z.number().nonnegative().nullable(),
  requiredPolGas: z.number().nonnegative(),
  blockingReasons: z.array(z.string()),
  safeToLog: z.literal(true)
});
export type RuntimeLiveCollateralReadiness = z.infer<typeof runtimeLiveCollateralReadinessSchema>;

export const runtimeLiveControlSchema = z.object({
  configured: z.boolean(),
  armable: z.boolean(),
  armed: z.boolean(),
  status: runtimeLiveControlStatusSchema,
  liveAdapterReady: z.boolean(),
  canArm: z.boolean(),
  blockingReason: z.string().nullable(),
  killSwitchActive: z.boolean(),
  killSwitchReason: z.string().nullable(),
  flattenSupported: z.boolean(),
  flattenPath: runtimeFlattenPathSchema,
  collateralReadiness: runtimeLiveCollateralReadinessSchema,
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
  mode: z.enum(['simulation', 'paper']),
  safeToExpose: z.literal(true),
  summary: strategyRuntimeSummarySchema,
  latestSnapshot: strategyStateSnapshotSchema.nullable(),
  snapshots: z.array(strategyStateSnapshotSchema)
});
export type PaperStrategyView = z.infer<typeof paperStrategyViewSchema>;

export const runtimeStateSchema = z.object({
  appName: z.literal('Wraith'),
  version: z.string(),
  mode: runtimeModeSchema,
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  paused: z.boolean(),
  remoteDashboardEnabled: z.boolean(),
  publicBaseUrl: z.string(),
  marketData: runtimeMarketDataSchema,
  markets: z.array(runtimeMarketSchema),
  strategy: strategyRuntimeSummarySchema,
  execution: runtimeExecutionSummarySchema,
  modules: z.array(runtimeModuleSchema),
  watchlist: z.array(watchEntrySchema),
  events: z.array(runtimeEventSchema)
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
