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

export const runtimeStateSchema = z.object({
  appName: z.literal('Phantom3 v2'),
  version: z.string(),
  mode: z.enum(['paper', 'live-disarmed']),
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  paused: z.boolean(),
  remoteDashboardEnabled: z.boolean(),
  publicBaseUrl: z.string(),
  modules: z.array(runtimeModuleSchema),
  watchlist: z.array(watchEntrySchema),
  events: z.array(runtimeEventSchema)
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
