import {
  ApiError,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type MarketDetails,
  type OpenOrder,
  type Trade,
  type TradesPaginatedResponse
} from '@polymarket/clob-client-v2';
import { createWalletClient, custom, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import type { PolymarketLiveVenueConfig } from '../../config/src/index.js';
import {
  liveSubmitResultSchema,
  liveVenueFillSchema,
  liveVenueOrderSnapshotSchema,
  liveVenueStateSnapshotSchema,
  type LiveExchangeGateway,
  type LiveSubmitOrderRequest,
  type LiveSubmitResult,
  type LiveVenueFill,
  type LiveVenueOrderSnapshot,
  type LiveVenueStateSnapshot
} from './index.js';

const END_CURSOR = 'LTE=';

const polymarketLimitOrderRequestSchema = z.object({
  clientOrderId: z.string().min(1),
  marketId: z.string().min(1),
  tokenId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  limitPrice: z.number().min(0).max(1).finite(),
  quantity: z.number().positive().finite(),
  postOnly: z.boolean().default(false),
  expiration: z.number().int().positive().optional()
});

const polymarketTrackedVenueOrderSchema = z.object({
  venueOrderId: z.string().min(1),
  clientOrderId: z.string().min(1).nullable().optional()
});

const polymarketTradeQuerySchema = z.object({
  marketId: z.string().min(1).optional(),
  tokenId: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
  maxPages: z.number().int().positive().default(4)
});

const polymarketTrackedFillQuerySchema = polymarketTradeQuerySchema.extend({
  venueOrders: z.array(polymarketTrackedVenueOrderSchema).min(1)
});

const polymarketVenueStateQuerySchema = polymarketTradeQuerySchema.extend({
  venueOrders: z.array(polymarketTrackedVenueOrderSchema).optional()
});

const polymarketOrderResponseSchema = z.object({
  success: z.boolean().optional(),
  errorMsg: z.string().nullish(),
  orderID: z.string().min(1).optional(),
  status: z.string().nullish(),
  takingAmount: z.string().optional(),
  makingAmount: z.string().optional()
}).passthrough();

export type PolymarketLimitOrderRequest = z.input<typeof polymarketLimitOrderRequestSchema>;
export type PolymarketTrackedVenueOrder = z.input<typeof polymarketTrackedVenueOrderSchema>;
export type PolymarketTradeQuery = z.input<typeof polymarketTradeQuerySchema>;
export type PolymarketTrackedFillQuery = z.input<typeof polymarketTrackedFillQuerySchema>;
export type PolymarketVenueStateQuery = z.input<typeof polymarketVenueStateQuerySchema>;

export type PolymarketCancelOrderResult = {
  venueOrderId: string;
  order: LiveVenueOrderSnapshot | null;
  raw: unknown;
};

export type PolymarketHeartbeatResult = {
  heartbeatId: string;
  raw: {
    heartbeat_id: string;
    error_msg?: string;
  };
};

export type PolymarketSdkClientLike = {
  createOrDeriveApiKey(nonce?: number): Promise<ApiKeyCreds>;
  createAndPostOrder(
    userOrder: {
      tokenID: string;
      price: number;
      size: number;
      side: Side;
      expiration?: number;
    },
    options?: unknown,
    orderType?: OrderType,
    postOnly?: boolean,
    deferExec?: boolean
  ): Promise<unknown>;
  getOrder(orderId: string): Promise<OpenOrder>;
  getOpenOrders(params?: { market?: string; asset_id?: string }, onlyFirstPage?: boolean, nextCursor?: string): Promise<OpenOrder[]>;
  getTradesPaginated(
    params?: {
      market?: string;
      asset_id?: string;
      before?: string;
      after?: string;
    },
    nextCursor?: string
  ): Promise<TradesPaginatedResponse>;
  cancelOrder(payload: { orderID: string }): Promise<unknown>;
  postHeartbeat(heartbeatId?: string): Promise<{ heartbeat_id: string; error_msg?: string }>;
  getClobMarketInfo(conditionId: string): Promise<MarketDetails>;
};

export type PolymarketSdkClientFactoryInput = {
  host: string;
  chainId: number;
  signatureType: SignatureTypeV2;
  funderAddress?: string;
  useServerTime: boolean;
  signer: WalletClient;
  creds?: ApiKeyCreds;
};

export type PolymarketSdkClientFactory = (input: PolymarketSdkClientFactoryInput) => PolymarketSdkClientLike;

function toSdkChain(chainId: number): Chain {
  switch (chainId) {
    case Chain.POLYGON:
      return Chain.POLYGON;
    case Chain.AMOY:
      return Chain.AMOY;
    default:
      throw new Error(`Unsupported Polymarket chain id: ${chainId}`);
  }
}

function createPolymarketSdkClient(input: PolymarketSdkClientFactoryInput): PolymarketSdkClientLike {
  return new ClobClient({
    host: input.host,
    chain: toSdkChain(input.chainId),
    signer: input.signer,
    creds: input.creds,
    signatureType: input.signatureType,
    funderAddress: input.funderAddress,
    useServerTime: input.useServerTime,
    throwOnError: true
  });
}

function parseNumber(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Polymarket ${label} was not numeric: ${String(value)}`);
  }
  return parsed;
}

function parseProbability(value: string | number, label: string): number {
  const parsed = parseNumber(value, label);
  if (parsed < 0 || parsed > 1) {
    throw new Error(`Polymarket ${label} must be between 0 and 1. Received ${parsed}.`);
  }
  return parsed;
}

function parsePositive(value: string | number, label: string): number {
  const parsed = parseNumber(value, label);
  if (parsed <= 0) {
    throw new Error(`Polymarket ${label} must be positive. Received ${parsed}.`);
  }
  return parsed;
}

function parseNonNegative(value: string | number, label: string): number {
  const parsed = parseNumber(value, label);
  if (parsed < 0) {
    throw new Error(`Polymarket ${label} must be non-negative. Received ${parsed}.`);
  }
  return parsed;
}

function epochToIso(value: number): string {
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

function normalizeTimestamp(value: string | number | null | undefined, fallback: string): string {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'number') {
    return epochToIso(value);
  }

  const numeric = Number.parseFloat(value);
  if (Number.isFinite(numeric) && value.trim() !== '') {
    return epochToIso(numeric);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Polymarket timestamp was not parseable: ${value}`);
  }
  return new Date(parsed).toISOString();
}

function mapSdkSide(side: 'buy' | 'sell'): Side {
  return side === 'buy' ? Side.BUY : Side.SELL;
}

function mapTradeSide(side: string): 'buy' | 'sell' {
  switch (side.trim().toUpperCase()) {
    case 'BUY':
      return 'buy';
    case 'SELL':
      return 'sell';
    default:
      throw new Error(`Unsupported Polymarket side: ${side}`);
  }
}

function mapOrderStatus(status: string, filledQuantity: number, requestedQuantity: number): LiveVenueOrderSnapshot['status'] {
  const normalized = status.trim().toLowerCase();

  if (normalized === 'open' || normalized === 'live') {
    return filledQuantity > 0 ? 'partially-filled' : 'open';
  }
  if (normalized === 'matched' || normalized === 'filled' || normalized === 'executed') {
    return 'filled';
  }
  if (normalized === 'partially-filled' || normalized === 'partial' || normalized === 'partially_matched') {
    return 'partially-filled';
  }
  if (normalized === 'pending' || normalized === 'delayed' || normalized === 'queued') {
    return 'pending';
  }
  if (normalized === 'rejected' || normalized === 'error') {
    return 'rejected';
  }
  if (normalized === 'canceled' || normalized === 'cancelled') {
    return requestedQuantity - filledQuantity > 0 ? 'canceled' : 'filled';
  }
  if (normalized.includes('cancel')) {
    return requestedQuantity - filledQuantity > 0 ? 'canceled' : 'filled';
  }

  return 'unknown';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExplicitRejection(error: unknown): boolean {
  return error instanceof ApiError && typeof error.status === 'number' && error.status >= 400 && error.status < 500;
}

function roundFee(value: number): number {
  return Number(value.toFixed(5));
}

export class PolymarketLiveClient {
  private readonly clock: () => Date;
  private readonly marketInfoCache = new Map<string, Promise<MarketDetails>>();

  constructor(
    private readonly sdk: PolymarketSdkClientLike,
    readonly config: PolymarketLiveVenueConfig,
    options: {
      clock?: () => Date;
    } = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  static async fromConfig(
    config: PolymarketLiveVenueConfig,
    options: {
      clock?: () => Date;
      signer?: WalletClient;
      clientFactory?: PolymarketSdkClientFactory;
    } = {}
  ): Promise<PolymarketLiveClient> {
    if (!config.auth.privateKey) {
      throw new Error('Polymarket live client requires WRAITH_POLYMARKET_PRIVATE_KEY for authenticated operations.');
    }

    if (!config.auth.canAccessAuthenticatedApi) {
      throw new Error(
        'Polymarket live client is not armed for authenticated operations. Provide existing API credentials or enable WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION=true.'
      );
    }

    const signer = options.signer ?? createWalletClient({
      account: privateKeyToAccount(config.auth.privateKey as Hex),
      transport: custom({
        async request() {
          throw new Error('Polymarket live signer transport is offline-only; RPC requests are not configured here.');
        }
      })
    });
    const clientFactory = options.clientFactory ?? createPolymarketSdkClient;
    const signatureType = config.auth.signatureType as SignatureTypeV2;
    const shared = {
      host: config.host,
      chainId: config.chainId,
      signatureType,
      funderAddress: config.auth.funderAddress ?? undefined,
      useServerTime: config.useServerTime,
      signer
    } satisfies Omit<PolymarketSdkClientFactoryInput, 'creds'>;

    let creds = config.auth.apiCredentials ?? undefined;
    let sdk = clientFactory({
      ...shared,
      creds
    });

    if (!creds) {
      creds = await sdk.createOrDeriveApiKey();
      sdk = clientFactory({
        ...shared,
        creds
      });
    }

    return new PolymarketLiveClient(sdk, {
      ...config,
      auth: {
        ...config.auth,
        apiCredentials: creds,
        hasApiCredentials: true,
        needsApiKeyDerivation: false,
        canAccessAuthenticatedApi: true,
        canPlaceOrders: true
      }
    }, {
      clock: options.clock
    });
  }

  async submitIntentOrder(
    request: LiveSubmitOrderRequest,
    options: {
      postOnly?: boolean;
    } = {}
  ): Promise<LiveSubmitResult> {
    return this.submitLimitOrder({
      clientOrderId: request.clientOrderId,
      marketId: request.intent.marketId,
      tokenId: request.intent.tokenId,
      side: request.intent.side,
      limitPrice: request.intent.limitPrice,
      quantity: request.intent.quantity,
      postOnly: options.postOnly ?? false
    });
  }

  async submitLimitOrder(input: PolymarketLimitOrderRequest): Promise<LiveSubmitResult> {
    const request = polymarketLimitOrderRequestSchema.parse(input);

    if (!this.config.auth.canPlaceOrders) {
      throw new Error('Polymarket order placement is blocked until private-key auth and L2 credentials are both available.');
    }

    try {
      const rawResponse = polymarketOrderResponseSchema.parse(
        await this.sdk.createAndPostOrder(
          {
            tokenID: request.tokenId,
            price: request.limitPrice,
            size: request.quantity,
            side: mapSdkSide(request.side),
            expiration: request.expiration
          },
          undefined,
          request.expiration ? OrderType.GTD : OrderType.GTC,
          request.postOnly,
          false
        )
      );

      if (rawResponse.success === false) {
        return liveSubmitResultSchema.parse({
          transportStatus: this.mapSubmitFailureStatus(rawResponse.status ?? rawResponse.errorMsg ?? ''),
          reason: rawResponse.errorMsg ?? rawResponse.status ?? 'Polymarket rejected the order.'
        });
      }

      if (!rawResponse.orderID) {
        return liveSubmitResultSchema.parse({
          transportStatus: 'ambiguous',
          reason: 'Polymarket submit response did not include an orderID.'
        });
      }

      let order: LiveVenueOrderSnapshot;
      try {
        order = await this.fetchOrder(rawResponse.orderID, {
          clientOrderId: request.clientOrderId
        });
      } catch (error) {
        return liveSubmitResultSchema.parse({
          transportStatus: 'ambiguous',
          reason: `Polymarket acknowledged order ${rawResponse.orderID}, but order lookup failed: ${describeError(error)}`
        });
      }

      let fills: LiveVenueFill[] = [];
      try {
        fills = await this.fetchFillsForOrders({
          marketId: request.marketId,
          tokenId: request.tokenId,
          after: order.acknowledgedAt ?? this.lookbackIso(5 * 60 * 1000),
          maxPages: 1,
          venueOrders: [
            {
              venueOrderId: rawResponse.orderID,
              clientOrderId: request.clientOrderId
            }
          ]
        });
      } catch {
        fills = [];
      }

      return liveSubmitResultSchema.parse({
        transportStatus: 'acknowledged',
        order,
        fills: fills.length > 0 ? fills : undefined,
        reason: rawResponse.errorMsg ?? undefined
      });
    } catch (error) {
      return liveSubmitResultSchema.parse({
        transportStatus: isExplicitRejection(error) ? 'rejected' : 'ambiguous',
        reason: describeError(error)
      });
    }
  }

  async fetchOrder(
    venueOrderId: string,
    options: {
      clientOrderId?: string | null;
      observedAt?: string;
    } = {}
  ): Promise<LiveVenueOrderSnapshot> {
    const rawOrder = await this.sdk.getOrder(venueOrderId);
    return this.normalizeOrder(rawOrder, {
      clientOrderId: options.clientOrderId ?? null,
      observedAt: options.observedAt ?? this.nowIso()
    });
  }

  async fetchOpenOrders(
    filter: {
      marketId?: string;
      tokenId?: string;
      observedAt?: string;
    } = {}
  ): Promise<LiveVenueOrderSnapshot[]> {
    const observedAt = filter.observedAt ?? this.nowIso();
    const orders = await this.sdk.getOpenOrders({
      market: filter.marketId,
      asset_id: filter.tokenId
    });

    return orders.map((order) => this.normalizeOrder(order, { observedAt }));
  }

  async fetchUserTrades(input: PolymarketTradeQuery = {}): Promise<Trade[]> {
    const query = polymarketTradeQuerySchema.parse(input);
    const trades: Trade[] = [];
    let nextCursor: string | undefined = undefined;
    let pagesRead = 0;

    while (pagesRead < query.maxPages) {
      const response = await this.sdk.getTradesPaginated({
        market: query.marketId,
        asset_id: query.tokenId,
        after: query.after,
        before: query.before
      }, nextCursor);

      trades.push(...response.trades);
      pagesRead += 1;
      nextCursor = response.next_cursor;

      if (!nextCursor || nextCursor === END_CURSOR) {
        break;
      }
    }

    return trades;
  }

  async fetchFillsForOrders(input: PolymarketTrackedFillQuery): Promise<LiveVenueFill[]> {
    const query = polymarketTrackedFillQuerySchema.parse(input);
    const trackedOrders = new Map(query.venueOrders.map((order) => [order.venueOrderId, order.clientOrderId ?? null]));
    const trades = await this.fetchUserTrades(query);
    const dedupe = new Set<string>();
    const fills: LiveVenueFill[] = [];

    for (const trade of trades) {
      const takerMatch = trackedOrders.has(trade.taker_order_id)
        ? [{ venueOrderId: trade.taker_order_id, clientOrderId: trackedOrders.get(trade.taker_order_id) ?? null, side: trade.side, quantity: trade.size, liquidityRole: 'taker' as const }]
        : [];
      const makerMatches = trade.maker_orders
        .filter((makerOrder) => trackedOrders.has(makerOrder.order_id))
        .map((makerOrder) => ({
          venueOrderId: makerOrder.order_id,
          clientOrderId: trackedOrders.get(makerOrder.order_id) ?? null,
          side: makerOrder.side,
          quantity: makerOrder.matched_amount,
          liquidityRole: 'maker' as const
        }));

      for (const match of [...takerMatch, ...makerMatches]) {
        const key = `${trade.id}:${match.venueOrderId}`;
        if (dedupe.has(key)) {
          continue;
        }
        dedupe.add(key);

        const quantity = parsePositive(match.quantity, 'trade.quantity');
        const price = parseProbability(trade.price, 'trade.price');
        const fee = match.liquidityRole === 'taker'
          ? await this.computeTradeFee(trade, quantity)
          : 0;

        fills.push(liveVenueFillSchema.parse({
          venueFillId: trade.id,
          venueOrderId: match.venueOrderId,
          clientOrderId: match.clientOrderId,
          marketId: trade.market,
          tokenId: trade.asset_id,
          side: mapTradeSide(match.side),
          price,
          quantity,
          fee,
          liquidityRole: match.liquidityRole,
          occurredAt: normalizeTimestamp(trade.match_time, this.nowIso()),
          raw: {
            trade,
            matchedOrderRole: match.liquidityRole
          }
        }));
      }
    }

    return fills.sort((left, right) => {
      const byTime = left.occurredAt.localeCompare(right.occurredAt);
      return byTime !== 0 ? byTime : left.venueFillId.localeCompare(right.venueFillId);
    });
  }

  async fetchVenueStateSnapshot(input: PolymarketVenueStateQuery = {}): Promise<LiveVenueStateSnapshot> {
    const query = polymarketVenueStateQuerySchema.parse(input);
    const observedAt = this.nowIso();
    const openOrders = await this.fetchOpenOrders({
      marketId: query.marketId,
      tokenId: query.tokenId,
      observedAt
    });
    const trackedOrders = await Promise.all((query.venueOrders ?? []).map((order) => this.fetchOrder(order.venueOrderId, {
      clientOrderId: order.clientOrderId ?? null,
      observedAt
    })));
    const orderMap = new Map<string, LiveVenueOrderSnapshot>();

    for (const order of [...openOrders, ...trackedOrders]) {
      const key = order.venueOrderId ?? order.clientOrderId ?? `${order.marketId}:${order.tokenId}:${order.side}`;
      orderMap.set(key, order);
    }

    const fills = query.venueOrders && query.venueOrders.length > 0
      ? await this.fetchFillsForOrders({
          marketId: query.marketId,
          tokenId: query.tokenId,
          after: query.after,
          before: query.before,
          maxPages: query.maxPages,
          venueOrders: query.venueOrders
        })
      : [];

    return liveVenueStateSnapshotSchema.parse({
      observedAt,
      orders: [...orderMap.values()],
      fills
    });
  }

  async cancelOrder(venueOrderId: string, clientOrderId?: string | null): Promise<PolymarketCancelOrderResult> {
    const raw = await this.sdk.cancelOrder({ orderID: venueOrderId });

    try {
      const order = await this.fetchOrder(venueOrderId, {
        clientOrderId: clientOrderId ?? null
      });
      return {
        venueOrderId,
        order,
        raw
      };
    } catch {
      return {
        venueOrderId,
        order: null,
        raw
      };
    }
  }

  async postHeartbeat(heartbeatId = ''): Promise<PolymarketHeartbeatResult> {
    const raw = await this.sdk.postHeartbeat(heartbeatId);
    return {
      heartbeatId: raw.heartbeat_id,
      raw
    };
  }

  private async computeTradeFee(trade: Trade, quantity: number): Promise<number> {
    if (trade.trader_side !== 'TAKER') {
      return 0;
    }

    const marketInfo = await this.getMarketInfo(trade.market);
    const declaredFeeRate = parseNonNegative(trade.fee_rate_bps, 'trade.fee_rate_bps');
    if (!marketInfo.fd) {
      if (declaredFeeRate === 0) {
        return 0;
      }
      throw new Error(`Polymarket market ${trade.market} did not expose fee metadata for taker trade ${trade.id}.`);
    }

    const feeRate = marketInfo.fd.r ?? 0;
    const feeExponent = marketInfo.fd.e ?? 0;
    if (feeRate <= 0) {
      return 0;
    }

    const price = parseProbability(trade.price, 'trade.price');
    return roundFee(quantity * feeRate * (price * (1 - price)) ** feeExponent);
  }

  private async getMarketInfo(conditionId: string): Promise<MarketDetails> {
    const cached = this.marketInfoCache.get(conditionId);
    if (cached) {
      return cached;
    }

    const request = this.sdk.getClobMarketInfo(conditionId);
    this.marketInfoCache.set(conditionId, request);
    return request;
  }

  private normalizeOrder(
    order: OpenOrder,
    context: {
      observedAt: string;
      clientOrderId?: string | null;
    }
  ): LiveVenueOrderSnapshot {
    const requestedQuantity = parsePositive(order.original_size, 'order.original_size');
    const filledQuantity = parseNonNegative(order.size_matched, 'order.size_matched');
    const remainingQuantity = Math.max(0, requestedQuantity - filledQuantity);

    return liveVenueOrderSnapshotSchema.parse({
      observedAt: context.observedAt,
      venueOrderId: order.id,
      clientOrderId: context.clientOrderId ?? null,
      marketId: order.market,
      tokenId: order.asset_id,
      side: mapTradeSide(order.side),
      limitPrice: parseProbability(order.price, 'order.price'),
      requestedQuantity,
      filledQuantity,
      remainingQuantity,
      status: mapOrderStatus(order.status, filledQuantity, requestedQuantity),
      acknowledgedAt: normalizeTimestamp(order.created_at, context.observedAt),
      updatedAt: context.observedAt,
      raw: {
        status: order.status,
        owner: order.owner,
        maker_address: order.maker_address,
        associate_trades: order.associate_trades,
        outcome: order.outcome,
        order_type: order.order_type,
        expiration: order.expiration
      }
    });
  }

  private mapSubmitFailureStatus(value: string): 'rejected' | 'ambiguous' {
    const normalized = value.trim().toLowerCase();
    if (normalized.includes('reject') || normalized.includes('invalid') || normalized.includes('insufficient')) {
      return 'rejected';
    }
    return 'ambiguous';
  }

  private lookbackIso(milliseconds: number): string {
    return new Date(this.clock().getTime() - milliseconds).toISOString();
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

export class PolymarketLiveGateway implements LiveExchangeGateway {
  constructor(
    private readonly client: PolymarketLiveClient,
    private readonly options: {
      postOnly?: boolean;
    } = {}
  ) {}

  submitOrder(request: LiveSubmitOrderRequest): Promise<LiveSubmitResult> {
    return this.client.submitIntentOrder(request, {
      postOnly: this.options.postOnly
    });
  }

  fetchVenueStateSnapshot(input: PolymarketVenueStateQuery = {}): Promise<LiveVenueStateSnapshot> {
    return this.client.fetchVenueStateSnapshot(input);
  }

  cancelOrder(venueOrderId: string, clientOrderId?: string | null): Promise<PolymarketCancelOrderResult> {
    return this.client.cancelOrder(venueOrderId, clientOrderId);
  }

  postHeartbeat(heartbeatId = ''): Promise<PolymarketHeartbeatResult> {
    return this.client.postHeartbeat(heartbeatId);
  }
}
