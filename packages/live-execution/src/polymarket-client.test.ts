import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, Side, type ApiKeyCreds, type MarketDetails, type OpenOrder, type Trade, type TradesPaginatedResponse } from '@polymarket/clob-client-v2';
import type { PolymarketLiveVenueConfig } from '../../config/src/index.js';
import { PolymarketLiveClient, type PolymarketSdkClientFactoryInput, type PolymarketSdkClientLike } from './polymarket-client.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const FIXED_NOW = '2026-04-22T05:00:00.000Z';

function clock(): Date {
  return new Date(FIXED_NOW);
}

function makeConfig(overrides: Partial<PolymarketLiveVenueConfig> = {}): PolymarketLiveVenueConfig {
  return {
    host: 'https://clob.polymarket.com',
    chainId: 137,
    useServerTime: true,
    auth: {
      signatureType: 0,
      funderAddress: null,
      privateKey: PRIVATE_KEY,
      allowApiKeyDerivation: false,
      apiCredentials: {
        key: 'pm-key',
        secret: 'pm-secret',
        passphrase: 'pm-passphrase'
      },
      hasPrivateKey: true,
      hasApiCredentials: true,
      needsApiKeyDerivation: false,
      canAccessAuthenticatedApi: true,
      canPlaceOrders: true
    },
    ...overrides
  };
}

function makeMarketDetails(): MarketDetails {
  return {
    c: 'market-1',
    t: [{ t: 'token-yes', o: 'YES' }, null],
    mts: 0.01,
    nr: false,
    fd: {
      r: 0.04,
      e: 1,
      to: true
    }
  };
}

function makeOpenOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: 'venue-order-1',
    status: 'live',
    owner: '0xowner',
    maker_address: '0xmaker',
    market: 'market-1',
    asset_id: 'token-yes',
    side: 'BUY',
    original_size: '10',
    size_matched: '2',
    price: '0.4',
    associate_trades: ['trade-1'],
    outcome: 'YES',
    created_at: 1713762000,
    expiration: '0',
    order_type: 'GTC',
    ...overrides
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    taker_order_id: 'venue-order-1',
    market: 'market-1',
    asset_id: 'token-yes',
    side: Side.BUY,
    size: '2',
    fee_rate_bps: '4',
    price: '0.4',
    status: 'matched',
    match_time: '2026-04-22T04:59:58.000Z',
    last_update: '2026-04-22T04:59:58.000Z',
    outcome: 'YES',
    bucket_index: 1,
    owner: '0xowner',
    maker_address: '0xmaker',
    maker_orders: [],
    transaction_hash: '0xhash',
    trader_side: 'TAKER',
    ...overrides
  };
}

function makeTradePage(trades: Trade[]): TradesPaginatedResponse {
  return {
    trades,
    next_cursor: 'LTE=',
    limit: trades.length,
    count: trades.length
  };
}

test('submitLimitOrder normalizes Polymarket order and fill evidence into live adapter shapes', async () => {
  const sdk: PolymarketSdkClientLike = {
    async createOrDeriveApiKey(): Promise<ApiKeyCreds> {
      return {
        key: 'unused',
        secret: 'unused',
        passphrase: 'unused'
      };
    },
    async createAndPostOrder() {
      return {
        success: true,
        orderID: 'venue-order-1',
        status: 'live'
      };
    },
    async getOrder() {
      return makeOpenOrder();
    },
    async getOpenOrders() {
      return [makeOpenOrder()];
    },
    async getTradesPaginated() {
      return makeTradePage([makeTrade()]);
    },
    async cancelOrder() {
      return { canceled: true };
    },
    async postHeartbeat() {
      return { heartbeat_id: 'hb-1' };
    },
    async getClobMarketInfo() {
      return makeMarketDetails();
    }
  };

  const client = new PolymarketLiveClient(sdk, makeConfig(), { clock });
  const result = await client.submitLimitOrder({
    clientOrderId: 'client-order-1',
    marketId: 'market-1',
    tokenId: 'token-yes',
    side: 'buy',
    limitPrice: 0.4,
    quantity: 10
  });

  assert.equal(result.transportStatus, 'acknowledged');
  assert.equal(result.order?.venueOrderId, 'venue-order-1');
  assert.equal(result.order?.clientOrderId, 'client-order-1');
  assert.equal(result.order?.status, 'partially-filled');
  assert.equal(result.order?.filledQuantity, 2);
  assert.equal(result.order?.remainingQuantity, 8);
  assert.equal(result.fills?.length, 1);
  assert.equal(result.fills?.[0]?.venueFillId, 'trade-1');
  assert.equal(result.fills?.[0]?.clientOrderId, 'client-order-1');
  assert.equal(result.fills?.[0]?.liquidityRole, 'taker');
  assert.equal(result.fills?.[0]?.fee, 0.0192);
});

test('submitLimitOrder classifies explicit Polymarket API failures as rejected, not acknowledged', async () => {
  const sdk: PolymarketSdkClientLike = {
    async createOrDeriveApiKey(): Promise<ApiKeyCreds> {
      return {
        key: 'unused',
        secret: 'unused',
        passphrase: 'unused'
      };
    },
    async createAndPostOrder() {
      throw new ApiError('insufficient balance', 400);
    },
    async getOrder() {
      throw new Error('not reached');
    },
    async getOpenOrders() {
      return [];
    },
    async getTradesPaginated() {
      return makeTradePage([]);
    },
    async cancelOrder() {
      return { canceled: true };
    },
    async postHeartbeat() {
      return { heartbeat_id: 'hb-1' };
    },
    async getClobMarketInfo() {
      return makeMarketDetails();
    }
  };

  const client = new PolymarketLiveClient(sdk, makeConfig(), { clock });
  const result = await client.submitLimitOrder({
    clientOrderId: 'client-order-2',
    marketId: 'market-1',
    tokenId: 'token-yes',
    side: 'buy',
    limitPrice: 0.4,
    quantity: 1
  });

  assert.equal(result.transportStatus, 'rejected');
  assert.match(result.reason ?? '', /insufficient balance/i);
  assert.equal(result.order, undefined);
});

test('fromConfig derives missing API credentials once and upgrades the returned config to authenticated-ready', async () => {
  const derivedCreds: ApiKeyCreds = {
    key: 'derived-key',
    secret: 'derived-secret',
    passphrase: 'derived-passphrase'
  };
  const factoryCalls: PolymarketSdkClientFactoryInput[] = [];
  const preAuthClient: PolymarketSdkClientLike = {
    async createOrDeriveApiKey() {
      return derivedCreds;
    },
    async createAndPostOrder() {
      throw new Error('not used');
    },
    async getOrder() {
      throw new Error('not used');
    },
    async getOpenOrders() {
      return [];
    },
    async getTradesPaginated() {
      return makeTradePage([]);
    },
    async cancelOrder() {
      return {};
    },
    async postHeartbeat() {
      return { heartbeat_id: 'hb-1' };
    },
    async getClobMarketInfo() {
      return makeMarketDetails();
    }
  };
  const postAuthClient: PolymarketSdkClientLike = {
    ...preAuthClient,
    async createOrDeriveApiKey() {
      throw new Error('already authenticated');
    }
  };

  const client = await PolymarketLiveClient.fromConfig(makeConfig({
    auth: {
      ...makeConfig().auth,
      apiCredentials: null,
      hasApiCredentials: false,
      allowApiKeyDerivation: true,
      needsApiKeyDerivation: true
    }
  }), {
    clock,
    clientFactory: (input) => {
      factoryCalls.push(input);
      return input.creds ? postAuthClient : preAuthClient;
    }
  });

  assert.equal(factoryCalls.length, 2);
  assert.equal(factoryCalls[0]?.creds, undefined);
  assert.deepEqual(factoryCalls[1]?.creds, derivedCreds);
  assert.deepEqual(client.config.auth.apiCredentials, derivedCreds);
  assert.equal(client.config.auth.needsApiKeyDerivation, false);
  assert.equal(client.config.auth.canPlaceOrders, true);
});
