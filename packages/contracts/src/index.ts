import { z } from 'zod';

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
  yesPrice: z.number().nullable(),
  noPrice: z.number().nullable(),
  spread: z.number().nullable(),
  volume24hr: z.number().nullable(),
  liquidity: z.number().nullable(),
  endDate: z.string().nullable(),
  url: z.string().url()
});
export type RuntimeMarket = z.infer<typeof runtimeMarketSchema>;

export const runtimeStateSchema = z.object({
  appName: z.literal('Phantom3 v2'),
  version: z.string(),
  mode: z.enum(['paper', 'live-disarmed']),
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  paused: z.boolean(),
  remoteDashboardEnabled: z.boolean(),
  publicBaseUrl: z.string(),
  marketData: runtimeMarketDataSchema,
  markets: z.array(runtimeMarketSchema),
  modules: z.array(runtimeModuleSchema),
  watchlist: z.array(watchEntrySchema),
  events: z.array(runtimeEventSchema)
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
