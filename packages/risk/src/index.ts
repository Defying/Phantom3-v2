import { z } from 'zod';

const timestampSchema = z.string().min(1);
const detailValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const riskDecisionActionSchema = z.enum(['approve', 'reject', 'resize', 'block']);

const EPSILON = 1e-6;

export const outcomeSideSchema = z.enum(['yes', 'no']);
export type OutcomeSide = z.infer<typeof outcomeSideSchema>;

export const tradeIntentSchema = z.object({
  intentId: z.string().min(1),
  strategyVersion: z.string().min(1).optional(),
  marketId: z.string().min(1),
  tokenId: z.string().min(1).optional(),
  side: outcomeSideSchema,
  desiredSizeUsd: z.number().positive(),
  maxEntryPrice: z.number().min(0).max(1).nullable().optional(),
  reduceOnly: z.boolean().optional().default(false),
  createdAt: timestampSchema.optional()
});
export type TradeIntent = z.infer<typeof tradeIntentSchema>;

export const riskMarketSnapshotSchema = z.object({
  marketId: z.string().min(1),
  tokenId: z.string().min(1).optional(),
  bestBid: z.number().min(0).max(1).nullable().optional(),
  bestAsk: z.number().min(0).max(1).nullable().optional(),
  midpoint: z.number().min(0).max(1).nullable().optional(),
  liquidityUsd: z.number().nonnegative().nullable().optional(),
  volume24hrUsd: z.number().nonnegative().nullable().optional(),
  sourceTimestamp: timestampSchema.nullable().optional(),
  observedAt: timestampSchema,
  sourceFreshnessMs: z.number().int().nonnegative().nullable().optional()
});
export type RiskMarketSnapshot = z.infer<typeof riskMarketSnapshotSchema>;

export const positionSnapshotSchema = z.object({
  marketId: z.string().min(1),
  side: outcomeSideSchema,
  exposureUsd: z.number().nonnegative(),
  quantity: z.number().nonnegative().optional(),
  markPrice: z.number().min(0).max(1).nullable().optional(),
  openedAt: timestampSchema.optional()
});
export type PositionSnapshot = z.infer<typeof positionSnapshotSchema>;

export const hookStateSchema = z.object({
  active: z.boolean(),
  reason: z.string().min(1).optional(),
  triggeredAt: timestampSchema.optional()
});
export type HookState = z.infer<typeof hookStateSchema>;

export const riskHooksSchema = z.object({
  killSwitch: z
    .object({
      global: hookStateSchema.optional(),
      markets: z.record(z.string(), hookStateSchema).optional()
    })
    .optional(),
  cooldowns: z
    .object({
      globalUntil: timestampSchema.nullable().optional(),
      markets: z.record(z.string(), timestampSchema.nullable()).optional(),
      marketSides: z.record(z.string(), timestampSchema.nullable()).optional()
    })
    .optional()
});
export type RiskHooks = z.infer<typeof riskHooksSchema>;

export const paperRiskConfigSchema = z.object({
  minOrderSizeUsd: z.number().positive().default(5),
  maxPositionSizeUsd: z.number().positive().default(25),
  maxMarketDataAgeMs: z.number().int().positive().default(15_000),
  maxSpreadBps: z.number().nonnegative().default(250),
  minLiquidityUsd: z.number().nonnegative().default(500),
  minVolume24hrUsd: z.number().nonnegative().default(0),
  maxSimultaneousPositions: z.number().int().positive().default(3),
  perMarketExposureCapUsd: z.number().positive().default(50),
  totalExposureCapUsd: z.number().positive().default(100),
  maxLiquidityShareBps: z.number().nonnegative().max(10_000).default(1_000),
  allowedMarketIds: z.array(z.string()).optional(),
  blockedMarketIds: z.array(z.string()).default([]),
  allowReduceOnlyWhileBlocked: z.boolean().default(true)
});
export type PaperRiskConfig = z.infer<typeof paperRiskConfigSchema>;

export const paperRiskConfigOverrideSchema = paperRiskConfigSchema.partial();
export type PaperRiskConfigOverrides = z.infer<typeof paperRiskConfigOverrideSchema>;

export const riskReasonSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), detailValueSchema).optional()
});
export type RiskReason = z.infer<typeof riskReasonSchema>;

export const paperRiskMetricsSchema = z.object({
  requestedSizeUsd: z.number().nonnegative(),
  approvedSizeUsd: z.number().nonnegative(),
  referenceEntryPrice: z.number().min(0).max(1).nullable(),
  spreadBps: z.number().nonnegative().nullable(),
  marketFreshnessMs: z.number().int().nonnegative().nullable(),
  currentSameSideExposureUsd: z.number().nonnegative(),
  currentMarketExposureUsd: z.number().nonnegative(),
  currentTotalExposureUsd: z.number().nonnegative(),
  openMarketCount: z.number().int().nonnegative(),
  remainingMarketCapacityUsd: z.number().nonnegative(),
  remainingTotalCapacityUsd: z.number().nonnegative(),
  liquiditySizeLimitUsd: z.number().nonnegative().nullable()
});
export type PaperRiskMetrics = z.infer<typeof paperRiskMetricsSchema>;

export const paperRiskDecisionSchema = z.object({
  intentId: z.string().min(1),
  decision: riskDecisionActionSchema,
  approvedSizeUsd: z.number().nonnegative(),
  reasons: z.array(riskReasonSchema),
  evaluatedAt: timestampSchema,
  metrics: paperRiskMetricsSchema
});
export type PaperRiskDecision = z.infer<typeof paperRiskDecisionSchema>;

export const paperRiskEvaluationInputSchema = z.object({
  intent: tradeIntentSchema,
  market: riskMarketSnapshotSchema,
  positions: z.array(positionSnapshotSchema).optional(),
  hooks: riskHooksSchema.optional(),
  config: paperRiskConfigOverrideSchema.optional(),
  now: timestampSchema.optional()
});
export type PaperRiskEvaluationInput = z.infer<typeof paperRiskEvaluationInputSchema>;

export function createPaperRiskConfig(overrides?: PaperRiskConfigOverrides): PaperRiskConfig {
  return paperRiskConfigSchema.parse(overrides ?? {});
}

export function evaluatePaperTradeRisk(input: PaperRiskEvaluationInput): PaperRiskDecision {
  const parsed = paperRiskEvaluationInputSchema.parse(input);
  const config = createPaperRiskConfig(parsed.config);
  const positions = parsed.positions ?? [];
  const hooks = parsed.hooks;
  const nowMs = parseTimestamp(parsed.now) ?? Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();

  const currentSameSideExposureUsd = sumExposureUsd(
    positions,
    (position) => position.marketId === parsed.intent.marketId && position.side === parsed.intent.side
  );
  const currentSameSideQuantity = sumQuantity(
    positions,
    (position) => position.marketId === parsed.intent.marketId && position.side === parsed.intent.side
  );
  const currentMarketExposureUsd = sumExposureUsd(
    positions,
    (position) => position.marketId === parsed.intent.marketId
  );
  const currentTotalExposureUsd = sumExposureUsd(positions);
  const openMarketCount = countOpenMarkets(positions);
  const remainingMarketCapacityUsd = Math.max(0, config.perMarketExposureCapUsd - currentMarketExposureUsd);
  const remainingTotalCapacityUsd = Math.max(0, config.totalExposureCapUsd - currentTotalExposureUsd);
  const referenceEntryPrice = resolveExecutableReferencePrice(parsed.market, parsed.intent.reduceOnly);
  const currentSameSideReducibleSizeUsd = sumReducibleSizeUsd(
    positions,
    (position) => position.marketId === parsed.intent.marketId && position.side === parsed.intent.side,
    referenceEntryPrice
  );
  const hasSameSidePosition = currentSameSideQuantity > EPSILON || currentSameSideExposureUsd > EPSILON;
  const spreadBps = computeSpreadBps(parsed.market);
  const marketFreshnessMs = computeEffectiveFreshnessMs(parsed.market, nowMs);
  const liquiditySizeLimitUsd =
    parsed.market.liquidityUsd == null ? null : (parsed.market.liquidityUsd * config.maxLiquidityShareBps) / 10_000;

  const baseMetrics: PaperRiskMetrics = {
    requestedSizeUsd: roundUsd(parsed.intent.desiredSizeUsd),
    approvedSizeUsd: 0,
    referenceEntryPrice: roundPrice(referenceEntryPrice),
    spreadBps: roundBps(spreadBps),
    marketFreshnessMs,
    currentSameSideExposureUsd: roundUsd(currentSameSideExposureUsd),
    currentMarketExposureUsd: roundUsd(currentMarketExposureUsd),
    currentTotalExposureUsd: roundUsd(currentTotalExposureUsd),
    openMarketCount,
    remainingMarketCapacityUsd: roundUsd(remainingMarketCapacityUsd),
    remainingTotalCapacityUsd: roundUsd(remainingTotalCapacityUsd),
    liquiditySizeLimitUsd: liquiditySizeLimitUsd == null ? null : roundUsd(liquiditySizeLimitUsd)
  };

  const blockedReasons = getBlockingReasons({
    intent: parsed.intent,
    hooks,
    config,
    nowMs
  });
  if (blockedReasons.length > 0) {
    return finalizeDecision({
      decision: 'block',
      approvedSizeUsd: 0,
      intentId: parsed.intent.intentId,
      reasons: blockedReasons,
      metrics: baseMetrics,
      evaluatedAt
    });
  }

  const hardRejectReasons = getHardRejectReasons({
    intent: parsed.intent,
    market: parsed.market,
    config,
    referenceEntryPrice,
    spreadBps,
    marketFreshnessMs,
    currentMarketExposureUsd,
    currentSameSideExposureUsd,
    hasSameSidePosition,
    openMarketCount
  });
  if (hardRejectReasons.length > 0) {
    return finalizeDecision({
      decision: 'reject',
      approvedSizeUsd: 0,
      intentId: parsed.intent.intentId,
      reasons: hardRejectReasons,
      metrics: baseMetrics,
      evaluatedAt
    });
  }

  if (parsed.intent.reduceOnly) {
    const approvedSizeUsd = roundUsd(Math.min(parsed.intent.desiredSizeUsd, currentSameSideReducibleSizeUsd));
    if (approvedSizeUsd <= EPSILON) {
      return finalizeDecision({
        decision: 'reject',
        approvedSizeUsd: 0,
        intentId: parsed.intent.intentId,
        reasons: [
          buildReason('no_position_to_reduce', 'Reduce-only intent has no same-side paper exposure to unwind.', {
            marketId: parsed.intent.marketId,
            side: parsed.intent.side,
            currentSameSideExposureUsd: roundUsd(currentSameSideExposureUsd)
          })
        ],
        metrics: baseMetrics,
        evaluatedAt
      });
    }

    if (approvedSizeUsd + EPSILON < parsed.intent.desiredSizeUsd) {
      return finalizeDecision({
        decision: 'resize',
        approvedSizeUsd,
        intentId: parsed.intent.intentId,
        reasons: [
          buildReason('reduce_only_resized_to_open_exposure', 'Reduce-only size was clipped to the currently open same-side position.', {
            requestedSizeUsd: roundUsd(parsed.intent.desiredSizeUsd),
            approvedSizeUsd,
            currentSameSideReducibleSizeUsd: roundUsd(currentSameSideReducibleSizeUsd)
          })
        ],
        metrics: baseMetrics,
        evaluatedAt
      });
    }

    return finalizeDecision({
      decision: 'approve',
      approvedSizeUsd,
      intentId: parsed.intent.intentId,
      reasons: [],
      metrics: baseMetrics,
      evaluatedAt
    });
  }

  const sizingReasons: RiskReason[] = [];
  const sizeLimits: number[] = [parsed.intent.desiredSizeUsd, config.maxPositionSizeUsd, remainingMarketCapacityUsd, remainingTotalCapacityUsd];

  if (config.maxPositionSizeUsd + EPSILON < parsed.intent.desiredSizeUsd) {
    sizingReasons.push(
      buildReason('max_position_size_cap', 'Requested size exceeds the paper max position size.', {
        requestedSizeUsd: roundUsd(parsed.intent.desiredSizeUsd),
        maxPositionSizeUsd: roundUsd(config.maxPositionSizeUsd)
      })
    );
  }

  if (remainingMarketCapacityUsd + EPSILON < parsed.intent.desiredSizeUsd) {
    sizingReasons.push(
      buildReason('per_market_exposure_cap', 'Requested size would exceed the per-market paper exposure cap.', {
        requestedSizeUsd: roundUsd(parsed.intent.desiredSizeUsd),
        remainingMarketCapacityUsd: roundUsd(remainingMarketCapacityUsd)
      })
    );
  }

  if (remainingTotalCapacityUsd + EPSILON < parsed.intent.desiredSizeUsd) {
    sizingReasons.push(
      buildReason('total_exposure_cap', 'Requested size would exceed the total paper exposure cap.', {
        requestedSizeUsd: roundUsd(parsed.intent.desiredSizeUsd),
        remainingTotalCapacityUsd: roundUsd(remainingTotalCapacityUsd)
      })
    );
  }

  if (liquiditySizeLimitUsd != null) {
    sizeLimits.push(liquiditySizeLimitUsd);
    if (liquiditySizeLimitUsd + EPSILON < parsed.intent.desiredSizeUsd) {
      sizingReasons.push(
        buildReason('liquidity_share_cap', 'Requested size would consume too much displayed market liquidity.', {
          requestedSizeUsd: roundUsd(parsed.intent.desiredSizeUsd),
          liquiditySizeLimitUsd: roundUsd(liquiditySizeLimitUsd),
          maxLiquidityShareBps: config.maxLiquidityShareBps
        })
      );
    }
  }

  const approvedSizeUsd = roundUsd(Math.max(0, Math.min(...sizeLimits)));
  if (approvedSizeUsd <= EPSILON) {
    return finalizeDecision({
      decision: 'reject',
      approvedSizeUsd: 0,
      intentId: parsed.intent.intentId,
      reasons: sizingReasons.length > 0 ? sizingReasons : [buildReason('size_reduced_to_zero', 'No paper exposure capacity remains for this intent.')],
      metrics: baseMetrics,
      evaluatedAt
    });
  }

  if (approvedSizeUsd + EPSILON < config.minOrderSizeUsd) {
    return finalizeDecision({
      decision: 'reject',
      approvedSizeUsd: 0,
      intentId: parsed.intent.intentId,
      reasons: [
        ...sizingReasons,
        buildReason('below_min_order_size', 'Remaining paper size after risk caps falls below the minimum order size.', {
          approvedSizeUsd,
          minOrderSizeUsd: roundUsd(config.minOrderSizeUsd)
        })
      ],
      metrics: baseMetrics,
      evaluatedAt
    });
  }

  if (approvedSizeUsd + EPSILON < parsed.intent.desiredSizeUsd) {
    return finalizeDecision({
      decision: 'resize',
      approvedSizeUsd,
      intentId: parsed.intent.intentId,
      reasons: sizingReasons,
      metrics: baseMetrics,
      evaluatedAt
    });
  }

  return finalizeDecision({
    decision: 'approve',
    approvedSizeUsd,
    intentId: parsed.intent.intentId,
    reasons: [],
    metrics: baseMetrics,
    evaluatedAt
  });
}

function getBlockingReasons(options: {
  intent: TradeIntent;
  hooks: RiskHooks | undefined;
  config: PaperRiskConfig;
  nowMs: number;
}): RiskReason[] {
  const { intent, hooks, config, nowMs } = options;
  if (intent.reduceOnly && config.allowReduceOnlyWhileBlocked) {
    return [];
  }

  const reasons: RiskReason[] = [];
  const globalKillSwitch = hooks?.killSwitch?.global;
  if (globalKillSwitch?.active) {
    reasons.push(
      buildReason('kill_switch_active', 'Global kill switch is active for paper trading.', {
        scope: 'global',
        reason: globalKillSwitch.reason ?? null,
        triggeredAt: globalKillSwitch.triggeredAt ?? null
      })
    );
  }

  const marketKillSwitch = hooks?.killSwitch?.markets?.[intent.marketId];
  if (marketKillSwitch?.active) {
    reasons.push(
      buildReason('kill_switch_active', 'Market-specific kill switch is active for this paper intent.', {
        scope: 'market',
        marketId: intent.marketId,
        reason: marketKillSwitch.reason ?? null,
        triggeredAt: marketKillSwitch.triggeredAt ?? null
      })
    );
  }

  const globalCooldownUntilMs = parseTimestamp(hooks?.cooldowns?.globalUntil);
  if (globalCooldownUntilMs != null && globalCooldownUntilMs > nowMs) {
    reasons.push(
      buildReason('global_cooldown_active', 'Global cooldown is still active.', {
        globalUntil: new Date(globalCooldownUntilMs).toISOString()
      })
    );
  }

  const marketCooldownUntilMs = parseTimestamp(hooks?.cooldowns?.markets?.[intent.marketId]);
  if (marketCooldownUntilMs != null && marketCooldownUntilMs > nowMs) {
    reasons.push(
      buildReason('market_cooldown_active', 'Market cooldown is still active for this market.', {
        marketId: intent.marketId,
        marketUntil: new Date(marketCooldownUntilMs).toISOString()
      })
    );
  }

  const marketSideKey = buildMarketSideKey(intent.marketId, intent.side);
  const marketSideCooldownUntilMs = parseTimestamp(hooks?.cooldowns?.marketSides?.[marketSideKey]);
  if (marketSideCooldownUntilMs != null && marketSideCooldownUntilMs > nowMs) {
    reasons.push(
      buildReason('market_side_cooldown_active', 'Side-specific cooldown is still active for this market.', {
        marketId: intent.marketId,
        side: intent.side,
        marketSideUntil: new Date(marketSideCooldownUntilMs).toISOString()
      })
    );
  }

  return reasons;
}

function getHardRejectReasons(options: {
  intent: TradeIntent;
  market: RiskMarketSnapshot;
  config: PaperRiskConfig;
  referenceEntryPrice: number | null;
  spreadBps: number | null;
  marketFreshnessMs: number | null;
  currentMarketExposureUsd: number;
  currentSameSideExposureUsd: number;
  hasSameSidePosition: boolean;
  openMarketCount: number;
}): RiskReason[] {
  const {
    intent,
    market,
    config,
    referenceEntryPrice,
    spreadBps,
    marketFreshnessMs,
    currentMarketExposureUsd,
    currentSameSideExposureUsd,
    hasSameSidePosition,
    openMarketCount
  } = options;

  const reasons: RiskReason[] = [];

  if (market.marketId !== intent.marketId) {
    reasons.push(
      buildReason('market_id_mismatch', 'Risk input market snapshot does not match the trade intent market.', {
        intentMarketId: intent.marketId,
        snapshotMarketId: market.marketId
      })
    );
  }

  if (config.allowedMarketIds != null && !config.allowedMarketIds.includes(intent.marketId)) {
    reasons.push(
      buildReason('market_not_allowed', 'Market is outside the configured paper trading allowlist.', {
        marketId: intent.marketId
      })
    );
  }

  if (config.blockedMarketIds.includes(intent.marketId)) {
    reasons.push(
      buildReason('market_blocked', 'Market is explicitly blocked for paper trading.', {
        marketId: intent.marketId
      })
    );
  }

  if (marketFreshnessMs == null) {
    reasons.push(buildReason('missing_market_timestamp', 'Market snapshot is missing a usable timestamp for stale-data checks.'));
  } else if (marketFreshnessMs > config.maxMarketDataAgeMs) {
    reasons.push(
      buildReason('stale_market_data', 'Market snapshot is too stale for a paper fill decision.', {
        marketFreshnessMs,
        maxMarketDataAgeMs: config.maxMarketDataAgeMs
      })
    );
  }

  if (referenceEntryPrice == null) {
    reasons.push(
      intent.reduceOnly
        ? buildReason('missing_executable_exit_quote', 'Market snapshot is missing a usable executable best-bid quote. Midpoint remains reference-only.')
        : buildReason('missing_executable_entry_quote', 'Market snapshot is missing a usable executable best-ask quote. Midpoint remains reference-only.')
    );
  } else if (!intent.reduceOnly && intent.maxEntryPrice != null && referenceEntryPrice - intent.maxEntryPrice > EPSILON) {
    reasons.push(
      buildReason('entry_price_above_limit', 'Reference entry price is above the intent limit price.', {
        referenceEntryPrice: roundPrice(referenceEntryPrice),
        maxEntryPrice: roundPrice(intent.maxEntryPrice)
      })
    );
  }

  if (!intent.reduceOnly) {
    if (intent.desiredSizeUsd + EPSILON < config.minOrderSizeUsd) {
      reasons.push(
        buildReason('below_min_order_size', 'Requested paper size is below the configured minimum order size.', {
          requestedSizeUsd: roundUsd(intent.desiredSizeUsd),
          minOrderSizeUsd: roundUsd(config.minOrderSizeUsd)
        })
      );
    }

    if (spreadBps == null) {
      reasons.push(buildReason('missing_spread_quote', 'Market snapshot is missing best-bid/best-ask data for spread checks.'));
    } else if (spreadBps - config.maxSpreadBps > EPSILON) {
      reasons.push(
        buildReason('spread_too_wide', 'Displayed spread is wider than the paper risk limit.', {
          spreadBps: roundBps(spreadBps),
          maxSpreadBps: config.maxSpreadBps
        })
      );
    }

    if (market.liquidityUsd == null) {
      reasons.push(buildReason('missing_liquidity_quote', 'Market snapshot is missing liquidity data for paper sizing checks.'));
    } else if (market.liquidityUsd + EPSILON < config.minLiquidityUsd) {
      reasons.push(
        buildReason('liquidity_too_low', 'Displayed liquidity is below the paper risk minimum.', {
          liquidityUsd: roundUsd(market.liquidityUsd),
          minLiquidityUsd: roundUsd(config.minLiquidityUsd)
        })
      );
    }

    if (market.volume24hrUsd == null) {
      if (config.minVolume24hrUsd > EPSILON) {
        reasons.push(buildReason('missing_volume_quote', 'Market snapshot is missing 24-hour volume data for paper sizing checks.'));
      }
    } else if (market.volume24hrUsd + EPSILON < config.minVolume24hrUsd) {
      reasons.push(
        buildReason('volume_too_low', '24-hour volume is below the paper risk minimum.', {
          volume24hrUsd: roundUsd(market.volume24hrUsd),
          minVolume24hrUsd: roundUsd(config.minVolume24hrUsd)
        })
      );
    }

    const isNewMarket = currentMarketExposureUsd <= EPSILON;
    if (isNewMarket && openMarketCount >= config.maxSimultaneousPositions) {
      reasons.push(
        buildReason('max_simultaneous_positions_reached', 'Opening another market would exceed the paper simultaneous position cap.', {
          openMarketCount,
          maxSimultaneousPositions: config.maxSimultaneousPositions
        })
      );
    }
  } else if (!hasSameSidePosition) {
    reasons.push(
      buildReason('no_position_to_reduce', 'Reduce-only intent has no same-side paper exposure to unwind.', {
        marketId: intent.marketId,
        side: intent.side,
        currentSameSideExposureUsd: roundUsd(currentSameSideExposureUsd)
      })
    );
  }

  return reasons;
}

function finalizeDecision(options: {
  decision: z.infer<typeof riskDecisionActionSchema>;
  approvedSizeUsd: number;
  intentId: string;
  reasons: RiskReason[];
  metrics: PaperRiskMetrics;
  evaluatedAt: string;
}): PaperRiskDecision {
  return paperRiskDecisionSchema.parse({
    intentId: options.intentId,
    decision: options.decision,
    approvedSizeUsd: roundUsd(options.approvedSizeUsd),
    reasons: options.reasons,
    evaluatedAt: options.evaluatedAt,
    metrics: {
      ...options.metrics,
      approvedSizeUsd: roundUsd(options.approvedSizeUsd)
    }
  });
}

function sumExposureUsd(
  positions: PositionSnapshot[],
  predicate: (position: PositionSnapshot) => boolean = () => true
): number {
  return positions.reduce((total, position) => (predicate(position) ? total + position.exposureUsd : total), 0);
}

function sumQuantity(
  positions: PositionSnapshot[],
  predicate: (position: PositionSnapshot) => boolean = () => true
): number {
  return positions.reduce((total, position) => (predicate(position) ? total + (position.quantity ?? 0) : total), 0);
}

function sumReducibleSizeUsd(
  positions: PositionSnapshot[],
  predicate: (position: PositionSnapshot) => boolean,
  executablePrice: number | null
): number {
  if (executablePrice == null || executablePrice <= EPSILON) {
    return 0;
  }

  return positions.reduce((total, position) => {
    if (!predicate(position)) {
      return total;
    }
    if (position.quantity != null) {
      return total + position.quantity * executablePrice;
    }
    return total + position.exposureUsd;
  }, 0);
}

function countOpenMarkets(positions: PositionSnapshot[]): number {
  const openMarkets = new Set<string>();
  for (const position of positions) {
    if (position.exposureUsd > EPSILON) {
      openMarkets.add(position.marketId);
    }
  }
  return openMarkets.size;
}

function resolveExecutableReferencePrice(market: RiskMarketSnapshot, reduceOnly: boolean): number | null {
  return reduceOnly ? market.bestBid ?? null : market.bestAsk ?? null;
}

function computeSpreadBps(market: RiskMarketSnapshot): number | null {
  if (market.bestBid == null || market.bestAsk == null || market.bestAsk < market.bestBid) {
    return null;
  }
  const executableMidpoint = (market.bestBid + market.bestAsk) / 2;
  if (executableMidpoint <= 0) {
    return null;
  }
  return ((market.bestAsk - market.bestBid) / executableMidpoint) * 10_000;
}

function computeEffectiveFreshnessMs(market: RiskMarketSnapshot, nowMs: number): number | null {
  const observedAtMs = parseTimestamp(market.observedAt);
  if (observedAtMs == null) {
    return null;
  }

  const observationAgeMs = Math.max(0, nowMs - observedAtMs);
  const sourceTimestampMs = parseTimestamp(market.sourceTimestamp);
  const freshnessAtObservationMs =
    market.sourceFreshnessMs ?? (sourceTimestampMs == null ? 0 : Math.max(0, observedAtMs - sourceTimestampMs));

  return Math.round(freshnessAtObservationMs + observationAgeMs);
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (value == null || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildMarketSideKey(marketId: string, side: OutcomeSide): string {
  return `${marketId}:${side}`;
}

function buildReason(code: string, message: string, details?: Record<string, string | number | boolean | null>): RiskReason {
  return details == null ? { code, message } : { code, message, details };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundBps(value: number | null): number | null {
  return value == null ? null : Math.round(value * 100) / 100;
}

function roundPrice(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10_000) / 10_000;
}
