import { z } from 'zod';

export const ethereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 0x-prefixed 20-byte Ethereum address.');
export const ethereumPrivateKeySchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Expected a 0x-prefixed 32-byte hex private key.');
export const polymarketChainIdSchema = z.union([z.literal(137), z.literal(80002)]);
export const polymarketSignatureTypeSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const polymarketApiCredentialsSchema = z.object({
  key: z.string().min(1),
  secret: z.string().min(1),
  passphrase: z.string().min(1)
});

const polymarketEnvSchema = z.object({
  WRAITH_POLYMARKET_CLOB_HOST: z.string().url().default('https://clob.polymarket.com'),
  WRAITH_POLYMARKET_CHAIN_ID: z.coerce.number().int().default(137),
  WRAITH_POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().default(0),
  WRAITH_POLYMARKET_USE_SERVER_TIME: z.string().default('true'),
  WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION: z.string().default('false'),
  WRAITH_POLYMARKET_FUNDER_ADDRESS: z.string().default(''),
  WRAITH_POLYMARKET_PRIVATE_KEY: z.string().default(''),
  WRAITH_POLYMARKET_API_KEY: z.string().default(''),
  WRAITH_POLYMARKET_API_SECRET: z.string().default(''),
  WRAITH_POLYMARKET_API_PASSPHRASE: z.string().default('')
});

const envSchema = z.object({
  WRAITH_HOST: z.string().default('127.0.0.1'),
  WRAITH_PORT: z.coerce.number().int().positive().default(4317),
  WRAITH_REMOTE_DASHBOARD: z.string().default('false'),
  WRAITH_PUBLIC_BASE_URL: z.string().default('http://127.0.0.1:4317'),
  WRAITH_DATA_DIR: z.string().default('./data'),
  WRAITH_LOG_DIR: z.string().default('./logs'),
  WRAITH_MARKET_REFRESH_MS: z.coerce.number().int().positive().default(30000),
  WRAITH_MARKET_LIMIT: z.coerce.number().int().positive().max(24).default(16),
  WRAITH_ENABLE_LIVE_MODE: z.string().default('false'),
  WRAITH_ENABLE_LIVE_ARMING: z.string().default('false'),
  WRAITH_LIVE_EXECUTION_ENABLED: z.string().default('false'),
  WRAITH_LIVE_EXECUTION_VENUE: z.string().default('polymarket'),
  WRAITH_LIVE_MAX_QUOTE_AGE_MS: z.coerce.number().int().nonnegative().default(5000),
  WRAITH_LIVE_MAX_RECONCILE_AGE_MS: z.coerce.number().int().positive().default(15000),
  WRAITH_LIVE_MISSING_ORDER_GRACE_MS: z.coerce.number().int().positive().default(30000),
  WRAITH_CONTROL_TOKEN: z.string().min(16, 'WRAITH_CONTROL_TOKEN must be at least 16 characters')
}).extend(polymarketEnvSchema.shape);

function readFlag(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function withLegacyPhantomEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const normalized = { ...env };
  for (const key of Object.keys(envSchema.shape)) {
    if (normalized[key] !== undefined) {
      continue;
    }
    const legacyKey = key.replace(/^WRAITH/, 'PHANTOM3_V2');
    const legacyValue = env[legacyKey];
    if (legacyValue !== undefined) {
      normalized[key] = legacyValue;
    }
  }
  return normalized;
}

function readOptionalSecret(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export type PolymarketChainId = z.infer<typeof polymarketChainIdSchema>;
export type PolymarketSignatureType = z.infer<typeof polymarketSignatureTypeSchema>;
export type PolymarketApiCredentials = z.infer<typeof polymarketApiCredentialsSchema>;

export type PolymarketLiveAuthConfig = {
  signatureType: PolymarketSignatureType;
  funderAddress: string | null;
  privateKey: string | null;
  allowApiKeyDerivation: boolean;
  apiCredentials: PolymarketApiCredentials | null;
  hasPrivateKey: boolean;
  hasApiCredentials: boolean;
  needsApiKeyDerivation: boolean;
  canAccessAuthenticatedApi: boolean;
  canPlaceOrders: boolean;
};

export type PolymarketLiveVenueConfig = {
  host: string;
  chainId: PolymarketChainId;
  useServerTime: boolean;
  auth: PolymarketLiveAuthConfig;
};

export type LiveExecutionAppConfig = {
  enabled: boolean;
  venue: string;
  maxQuoteAgeMs: number;
  maxReconcileAgeMs: number;
  missingOrderGraceMs: number;
  polymarket: PolymarketLiveVenueConfig;
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

function readPolymarketApiCredentials(parsed: z.infer<typeof polymarketEnvSchema>): PolymarketApiCredentials | null {
  const key = readOptionalSecret(parsed.WRAITH_POLYMARKET_API_KEY);
  const secret = readOptionalSecret(parsed.WRAITH_POLYMARKET_API_SECRET);
  const passphrase = readOptionalSecret(parsed.WRAITH_POLYMARKET_API_PASSPHRASE);
  const present = [key, secret, passphrase].filter((value) => value !== null).length;

  if (present === 0) {
    return null;
  }

  if (present !== 3) {
    const missing = [
      key ? null : 'WRAITH_POLYMARKET_API_KEY',
      secret ? null : 'WRAITH_POLYMARKET_API_SECRET',
      passphrase ? null : 'WRAITH_POLYMARKET_API_PASSPHRASE'
    ].filter((value): value is string => value !== null);

    throw new Error(`Polymarket API credentials must be supplied together. Missing: ${missing.join(', ')}`);
  }

  return polymarketApiCredentialsSchema.parse({
    key,
    secret,
    passphrase
  });
}

function readPolymarketLiveVenueConfigFromParsedEnv(parsed: z.infer<typeof polymarketEnvSchema>): PolymarketLiveVenueConfig {
  const chainId = polymarketChainIdSchema.parse(parsed.WRAITH_POLYMARKET_CHAIN_ID);
  const signatureType = polymarketSignatureTypeSchema.parse(parsed.WRAITH_POLYMARKET_SIGNATURE_TYPE);
  const privateKey = (() => {
    const value = readOptionalSecret(parsed.WRAITH_POLYMARKET_PRIVATE_KEY);
    return value ? ethereumPrivateKeySchema.parse(value) : null;
  })();
  const funderAddress = (() => {
    const value = readOptionalSecret(parsed.WRAITH_POLYMARKET_FUNDER_ADDRESS);
    return value ? ethereumAddressSchema.parse(value) : null;
  })();
  const apiCredentials = readPolymarketApiCredentials(parsed);
  const allowApiKeyDerivation = readFlag(parsed.WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION);

  if (signatureType !== 0 && privateKey && !funderAddress) {
    throw new Error('Polymarket signature types 1-3 require WRAITH_POLYMARKET_FUNDER_ADDRESS.');
  }

  const hasPrivateKey = privateKey !== null;
  const hasApiCredentials = apiCredentials !== null;
  const needsApiKeyDerivation = hasPrivateKey && !hasApiCredentials && allowApiKeyDerivation;
  const canAccessAuthenticatedApi = hasPrivateKey && (hasApiCredentials || allowApiKeyDerivation);

  return {
    host: parsed.WRAITH_POLYMARKET_CLOB_HOST,
    chainId,
    useServerTime: readFlag(parsed.WRAITH_POLYMARKET_USE_SERVER_TIME),
    auth: {
      signatureType,
      funderAddress,
      privateKey,
      allowApiKeyDerivation,
      apiCredentials,
      hasPrivateKey,
      hasApiCredentials,
      needsApiKeyDerivation,
      canAccessAuthenticatedApi,
      canPlaceOrders: canAccessAuthenticatedApi
    }
  };
}

export function readPolymarketLiveVenueConfig(env: Record<string, string | undefined> = process.env): PolymarketLiveVenueConfig {
  return readPolymarketLiveVenueConfigFromParsedEnv(polymarketEnvSchema.parse(withLegacyPhantomEnv(env)));
}

export function readConfig(): AppConfig {
  const parsed = envSchema.parse(withLegacyPhantomEnv(process.env));
  const liveModeEnabled = readFlag(parsed.WRAITH_ENABLE_LIVE_MODE);

  return {
    host: parsed.WRAITH_HOST,
    port: parsed.WRAITH_PORT,
    remoteDashboardEnabled: readFlag(parsed.WRAITH_REMOTE_DASHBOARD),
    publicBaseUrl: parsed.WRAITH_PUBLIC_BASE_URL,
    dataDir: parsed.WRAITH_DATA_DIR,
    logDir: parsed.WRAITH_LOG_DIR,
    marketRefreshMs: parsed.WRAITH_MARKET_REFRESH_MS,
    marketLimit: parsed.WRAITH_MARKET_LIMIT,
    liveModeEnabled,
    liveArmingEnabled: liveModeEnabled && readFlag(parsed.WRAITH_ENABLE_LIVE_ARMING),
    liveExecution: {
      enabled: readFlag(parsed.WRAITH_LIVE_EXECUTION_ENABLED),
      venue: parsed.WRAITH_LIVE_EXECUTION_VENUE,
      maxQuoteAgeMs: parsed.WRAITH_LIVE_MAX_QUOTE_AGE_MS,
      maxReconcileAgeMs: parsed.WRAITH_LIVE_MAX_RECONCILE_AGE_MS,
      missingOrderGraceMs: parsed.WRAITH_LIVE_MISSING_ORDER_GRACE_MS,
      polymarket: readPolymarketLiveVenueConfigFromParsedEnv(parsed)
    },
    controlToken: parsed.WRAITH_CONTROL_TOKEN
  };
}
