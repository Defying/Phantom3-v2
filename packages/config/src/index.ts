import { z } from 'zod';

const envSchema = z.object({
  PHANTOM3_V2_HOST: z.string().default('127.0.0.1'),
  PHANTOM3_V2_PORT: z.coerce.number().int().positive().default(4317),
  PHANTOM3_V2_REMOTE_DASHBOARD: z.string().default('false'),
  PHANTOM3_V2_PUBLIC_BASE_URL: z.string().default('http://127.0.0.1:4317'),
  PHANTOM3_V2_DATA_DIR: z.string().default('./data'),
  PHANTOM3_V2_LOG_DIR: z.string().default('./logs'),
  PHANTOM3_V2_MARKET_REFRESH_MS: z.coerce.number().int().positive().default(30000),
  PHANTOM3_V2_MARKET_LIMIT: z.coerce.number().int().positive().max(24).default(16),
  PHANTOM3_V2_ENABLE_LIVE_MODE: z.string().default('false'),
  PHANTOM3_V2_ENABLE_LIVE_ARMING: z.string().default('false'),
  PHANTOM3_V2_LIVE_EXECUTION_ENABLED: z.string().default('false'),
  PHANTOM3_V2_LIVE_EXECUTION_VENUE: z.string().default('polymarket'),
  PHANTOM3_V2_LIVE_MAX_QUOTE_AGE_MS: z.coerce.number().int().nonnegative().default(5000),
  PHANTOM3_V2_LIVE_MAX_RECONCILE_AGE_MS: z.coerce.number().int().positive().default(15000),
  PHANTOM3_V2_LIVE_MISSING_ORDER_GRACE_MS: z.coerce.number().int().positive().default(30000),
  PHANTOM3_V2_CONTROL_TOKEN: z.string().min(16, 'PHANTOM3_V2_CONTROL_TOKEN must be at least 16 characters')
});

function readFlag(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export type LiveExecutionAppConfig = {
  enabled: boolean;
  venue: string;
  maxQuoteAgeMs: number;
  maxReconcileAgeMs: number;
  missingOrderGraceMs: number;
};

export type AppConfig = {
  host: string;
  port: number;
  remoteDashboardEnabled: boolean;
  publicBaseUrl: string;
  dataDir: string;
  logDir: string;
  marketRefreshMs: number;
  marketLimit: number;
  liveModeEnabled: boolean;
  liveArmingEnabled: boolean;
  liveExecution: LiveExecutionAppConfig;
  controlToken: string;
};

export function readConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const liveModeEnabled = readFlag(parsed.PHANTOM3_V2_ENABLE_LIVE_MODE);

  return {
    host: parsed.PHANTOM3_V2_HOST,
    port: parsed.PHANTOM3_V2_PORT,
    remoteDashboardEnabled: readFlag(parsed.PHANTOM3_V2_REMOTE_DASHBOARD),
    publicBaseUrl: parsed.PHANTOM3_V2_PUBLIC_BASE_URL,
    dataDir: parsed.PHANTOM3_V2_DATA_DIR,
    logDir: parsed.PHANTOM3_V2_LOG_DIR,
    marketRefreshMs: parsed.PHANTOM3_V2_MARKET_REFRESH_MS,
    marketLimit: parsed.PHANTOM3_V2_MARKET_LIMIT,
    liveModeEnabled,
    liveArmingEnabled: liveModeEnabled && readFlag(parsed.PHANTOM3_V2_ENABLE_LIVE_ARMING),
    liveExecution: {
      enabled: readFlag(parsed.PHANTOM3_V2_LIVE_EXECUTION_ENABLED),
      venue: parsed.PHANTOM3_V2_LIVE_EXECUTION_VENUE,
      maxQuoteAgeMs: parsed.PHANTOM3_V2_LIVE_MAX_QUOTE_AGE_MS,
      maxReconcileAgeMs: parsed.PHANTOM3_V2_LIVE_MAX_RECONCILE_AGE_MS,
      missingOrderGraceMs: parsed.PHANTOM3_V2_LIVE_MISSING_ORDER_GRACE_MS
    },
    controlToken: parsed.PHANTOM3_V2_CONTROL_TOKEN
  };
}
