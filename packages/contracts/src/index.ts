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

export const strategyStateTriggerSchema = z.enum(['bootstrap', 'market-refresh', 'market-refresh-error', 'pause', 'resume']);
export type StrategyStateTrigger = z.infer<typeof strategyStateTriggerSchema>;

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
  trigger: strategyStateTriggerSchema,
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

export const runtimeHealthStatusSchema = z.enum(['healthy', 'warning', 'degraded']);
export type RuntimeHealthStatus = z.infer<typeof runtimeHealthStatusSchema>;

export const diagnosticsCounterSchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative()
});
export type DiagnosticsCounter = z.infer<typeof diagnosticsCounterSchema>;

export const rejectReasonCountSchema = z.object({
  reason: z.string(),
  count: z.number().int().positive()
});
export type RejectReasonCount = z.infer<typeof rejectReasonCountSchema>;

export const runtimeHealthSchema = z.object({
  safeToExpose: z.literal(true),
  generatedAt: z.string(),
  status: runtimeHealthStatusSchema,
  mode: runtimeModeSchema,
  paused: z.boolean(),
  uptimeMs: z.number().int().nonnegative(),
  heartbeatAgeMs: z.number().int().nonnegative(),
  summary: z.string(),
  warnings: z.array(z.string())
});
export type RuntimeHealth = z.infer<typeof runtimeHealthSchema>;

export const marketSyncDiagnosticsSchema = z.object({
  safeToExpose: z.literal(true),
  state: z.enum(['never', 'ok', 'error']),
  stale: z.boolean(),
  refreshInFlight: z.boolean(),
  refreshIntervalMs: z.number().int().positive(),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  lastDurationMs: z.number().int().nonnegative().nullable(),
  lastSuccessDurationMs: z.number().int().nonnegative().nullable(),
  lastFailureDurationMs: z.number().int().nonnegative().nullable(),
  marketDataAgeMs: z.number().int().nonnegative().nullable(),
  marketsInLatestSnapshot: z.number().int().nonnegative(),
  counters: diagnosticsCounterSchema,
  consecutiveFailureCount: z.number().int().nonnegative(),
  error: z.string().nullable()
});
export type MarketSyncDiagnostics = z.infer<typeof marketSyncDiagnosticsSchema>;

export const strategyEvaluationDiagnosticsSchema = z.object({
  safeToExpose: z.literal(true),
  engineId: z.string(),
  strategyVersion: z.string(),
  status: strategyRuntimeStatusSchema,
  lastSnapshotTrigger: strategyStateTriggerSchema.nullable(),
  lastEvaluationTrigger: strategyStateTriggerSchema.nullable(),
  lastStartedAt: z.string().nullable(),
  lastCompletedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastDurationMs: z.number().int().nonnegative().nullable(),
  lastEvaluatedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  counters: diagnosticsCounterSchema,
  watchedMarketCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  eligibleMarketCount: z.number().int().nonnegative(),
  rejectedMarketCount: z.number().int().nonnegative(),
  emittedIntentCount: z.number().int().nonnegative(),
  submittedIntentCount: z.number().int().nonnegative(),
  openIntentCount: z.number().int().nonnegative(),
  openPositionCount: z.number().int().nonnegative(),
  openExposureUsd: z.number().nonnegative(),
  riskDecisionCount: z.number().int().nonnegative(),
  rejectReasonBreakdown: z.array(rejectReasonCountSchema),
  notes: z.array(z.string())
});
export type StrategyEvaluationDiagnostics = z.infer<typeof strategyEvaluationDiagnosticsSchema>;

export const persistenceDiagnosticsSchema = z.object({
  safeToExpose: z.literal(true),
  statePath: z.string(),
  stateFileBytes: z.number().int().nonnegative(),
  pendingWrite: z.boolean(),
  lastScheduledAt: z.string().nullable(),
  lastStartedAt: z.string().nullable(),
  lastPersistedAt: z.string().nullable(),
  lastDurationMs: z.number().int().nonnegative().nullable(),
  counters: diagnosticsCounterSchema,
  lastError: z.string().nullable()
});
export type PersistenceDiagnostics = z.infer<typeof persistenceDiagnosticsSchema>;

export const ledgerDiagnosticsSchema = z.object({
  safeToExpose: z.literal(true),
  filePath: z.string(),
  fileBytes: z.number().int().nonnegative(),
  latestSequence: z.number().int().nonnegative(),
  lastAppendedAt: z.string().nullable(),
  intentCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  openOrderCount: z.number().int().nonnegative(),
  fillCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  openPositionCount: z.number().int().nonnegative(),
  positionEventCount: z.number().int().nonnegative(),
  anomalyCount: z.number().int().nonnegative(),
  anomalies: z.array(z.string())
});
export type LedgerDiagnostics = z.infer<typeof ledgerDiagnosticsSchema>;

export const runtimeDiagnosticsSchema = z.object({
  safeToExpose: z.literal(true),
  generatedAt: z.string(),
  runtime: runtimeHealthSchema,
  marketSync: marketSyncDiagnosticsSchema,
  strategyEvaluation: strategyEvaluationDiagnosticsSchema,
  persistence: persistenceDiagnosticsSchema,
  ledger: ledgerDiagnosticsSchema,
  recentEvents: z.array(runtimeEventSchema)
});
export type RuntimeDiagnostics = z.infer<typeof runtimeDiagnosticsSchema>;

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
  marketData: runtimeMarketDataSchema,
  markets: z.array(runtimeMarketSchema),
  strategy: strategyRuntimeSummarySchema,
  modules: z.array(runtimeModuleSchema),
  watchlist: z.array(watchEntrySchema),
  events: z.array(runtimeEventSchema)
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
