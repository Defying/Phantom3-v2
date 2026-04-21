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
  kind: z.enum(['entry', 'exit']),
  executionSide: z.enum(['buy', 'sell']),
  reduceOnly: z.boolean(),
  status: z.enum(['draft', 'watching', 'submitted', 'closed']),
  createdAt: z.string(),
  thesis: z.string(),
  desiredSizeUsd: z.number().nonnegative(),
  positionId: z.string().nullable(),
  trigger: z.enum([
    'take-profit-hit',
    'stop-loss-hit',
    'latest-exit-reached',
    'spread-invalidated',
    'complement-invalidated',
    'expiry-window'
  ]).nullable(),
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

export const paperExitTriggerSchema = z.enum([
  'take-profit-hit',
  'stop-loss-hit',
  'latest-exit-reached',
  'spread-invalidated',
  'complement-invalidated',
  'expiry-window'
]);
export type PaperExitTrigger = z.infer<typeof paperExitTriggerSchema>;

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
  submittedIntentId: z.string().nullable()
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
