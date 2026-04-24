import assert from 'node:assert/strict';
import test from 'node:test';
import { readPolymarketLiveVenueConfig } from './index.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const FUNDER_ADDRESS = `0x${'22'.repeat(20)}`;

function makeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    WRAITH_POLYMARKET_CLOB_HOST: 'https://clob.polymarket.com',
    WRAITH_POLYMARKET_CHAIN_ID: '137',
    WRAITH_POLYMARKET_SIGNATURE_TYPE: '0',
    WRAITH_POLYMARKET_USE_SERVER_TIME: 'true',
    WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION: 'false',
    WRAITH_POLYMARKET_FUNDER_ADDRESS: '',
    WRAITH_POLYMARKET_PRIVATE_KEY: '',
    WRAITH_POLYMARKET_API_KEY: '',
    WRAITH_POLYMARKET_API_SECRET: '',
    WRAITH_POLYMARKET_API_PASSPHRASE: '',
    ...overrides
  };
}

test('readPolymarketLiveVenueConfig marks derivation-ready auth without overstating API-key readiness', () => {
  const config = readPolymarketLiveVenueConfig(makeEnv({
    WRAITH_POLYMARKET_PRIVATE_KEY: PRIVATE_KEY,
    WRAITH_POLYMARKET_SIGNATURE_TYPE: '2',
    WRAITH_POLYMARKET_FUNDER_ADDRESS: FUNDER_ADDRESS,
    WRAITH_POLYMARKET_ALLOW_API_KEY_DERIVATION: 'true'
  }));

  assert.equal(config.chainId, 137);
  assert.equal(config.auth.signatureType, 2);
  assert.equal(config.auth.privateKey, PRIVATE_KEY);
  assert.equal(config.auth.funderAddress, FUNDER_ADDRESS);
  assert.equal(config.auth.hasPrivateKey, true);
  assert.equal(config.auth.hasApiCredentials, false);
  assert.equal(config.auth.needsApiKeyDerivation, true);
  assert.equal(config.auth.canAccessAuthenticatedApi, true);
  assert.equal(config.auth.canPlaceOrders, true);
});

test('readPolymarketLiveVenueConfig rejects partial API credential triples', () => {
  assert.throws(
    () => readPolymarketLiveVenueConfig(makeEnv({
      WRAITH_POLYMARKET_PRIVATE_KEY: PRIVATE_KEY,
      WRAITH_POLYMARKET_API_KEY: 'pm-key-only'
    })),
    /must be supplied together/i
  );
});

test('readPolymarketLiveVenueConfig requires a funder address for non-EOA signature types when a private key is present', () => {
  assert.throws(
    () => readPolymarketLiveVenueConfig(makeEnv({
      WRAITH_POLYMARKET_PRIVATE_KEY: PRIVATE_KEY,
      WRAITH_POLYMARKET_SIGNATURE_TYPE: '1'
    })),
    /FUNDER_ADDRESS/i
  );
});
