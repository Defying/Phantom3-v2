import { z } from 'zod';

const envSchema = z.object({
  PHANTOM3_V2_HOST: z.string().default('127.0.0.1'),
  PHANTOM3_V2_PORT: z.coerce.number().int().positive().default(4317),
  PHANTOM3_V2_REMOTE_DASHBOARD: z.string().default('false'),
  PHANTOM3_V2_PUBLIC_BASE_URL: z.string().default('http://127.0.0.1:4317'),
  PHANTOM3_V2_DATA_DIR: z.string().default('./data'),
  PHANTOM3_V2_LOG_DIR: z.string().default('./logs'),
  PHANTOM3_V2_MARKET_REFRESH_MS: z.coerce.number().int().positive().default(30000),
  PHANTOM3_V2_MARKET_LIMIT: z.coerce.number().int().positive().max(20).default(6),
  PHANTOM3_V2_CONTROL_TOKEN: z.string().min(16, 'PHANTOM3_V2_CONTROL_TOKEN must be at least 16 characters')
});

export type AppConfig = {
  host: string;
  port: number;
  remoteDashboardEnabled: boolean;
  publicBaseUrl: string;
  dataDir: string;
  logDir: string;
  marketRefreshMs: number;
  marketLimit: number;
  controlToken: string;
};

export function readConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  return {
    host: parsed.PHANTOM3_V2_HOST,
    port: parsed.PHANTOM3_V2_PORT,
    remoteDashboardEnabled: ['1', 'true', 'yes', 'on'].includes(parsed.PHANTOM3_V2_REMOTE_DASHBOARD.toLowerCase()),
    publicBaseUrl: parsed.PHANTOM3_V2_PUBLIC_BASE_URL,
    dataDir: parsed.PHANTOM3_V2_DATA_DIR,
    logDir: parsed.PHANTOM3_V2_LOG_DIR,
    marketRefreshMs: parsed.PHANTOM3_V2_MARKET_REFRESH_MS,
    marketLimit: parsed.PHANTOM3_V2_MARKET_LIMIT,
    controlToken: parsed.PHANTOM3_V2_CONTROL_TOKEN
  };
}
