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
  marketData: runtimeMarketDataSchema,
  markets: z.array(runtimeMarketSchema),
  strategy: strategyRuntimeSummarySchema,
  modules: z.array(runtimeModuleSchema),
  watchlist: z.array(watchEntrySchema),
  events: z.array(runtimeEventSchema)
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
