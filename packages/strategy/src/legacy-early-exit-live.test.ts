import assert from 'node:assert/strict'
import test from 'node:test'

import type { RuntimeMarket } from '../../contracts/src/index.js'
import type { MarketSnapshot } from '../../market-data/src/index.js'
import {
  buildLegacyEarlyExitLiveSignalReport,
  evaluateLegacyEarlyExitLiveSignalAt
} from './index.js'

const AS_OF = '2026-04-21T16:00:00.000Z'

function makeMarket(overrides: Partial<RuntimeMarket> = {}): RuntimeMarket {
  return {
    id: 'market-1',
    eventId: 'event-1',
    slug: 'btc-5m-up-down',
    eventTitle: 'BTC 5m Up or Down',
    question: 'Will BTC be up in the next 5 minutes?',
    yesLabel: 'Up',
    noLabel: 'Down',
    yesTokenId: 'yes-token',
    noTokenId: 'no-token',
    yesPrice: 0.86,
    noPrice: 0.14,
    spread: 0.02,
    volume24hr: 25000,
    liquidity: 40000,
    endDate: '2026-04-21T16:05:00.000Z',
    url: 'https://polymarket.com/event/btc-5m-up-down',
    ...overrides
  }
}

function makeSnapshot(markets: RuntimeMarket[]): MarketSnapshot {
  return {
    fetchedAt: AS_OF,
    markets,
    transport: {
      route: 'direct',
      scope: 'polymarket-only',
      note: 'test transport'
    },
    access: {
      operatorEligibility: 'unknown',
      readOnly: true,
      note: 'test access'
    }
  }
}

test('marks in-scope markets as pending confirmation before the delayed re-check exists', () => {
  const market = makeMarket()
  const signal = evaluateLegacyEarlyExitLiveSignalAt(market, AS_OF)

  assert.equal(signal.status, 'pending-confirmation')
  assert.equal(signal.intent, null)
  assert.equal(signal.diagnostics.asset, 'BTC')
  assert.equal(signal.diagnostics.timeframe, '5m')
  assert.equal(signal.diagnostics.confirmation.status, 'pending')
  assert.ok(signal.skipReasons.includes('confirmation-pending'))
  assert.ok(signal.supportReasons.includes('asset-scope-match'))
  assert.ok(signal.supportReasons.includes('within-time-window'))
})

test('accepts a confirmed ETH setup and preserves managed exit semantics in diagnostics and intent', () => {
  const market = makeMarket({
    id: 'market-eth',
    eventId: 'event-eth',
    slug: 'eth-5m-up-down',
    eventTitle: 'ETH 5m Up or Down',
    question: 'Will ETH be up in the next 5 minutes?',
    yesPrice: 0.84,
    noPrice: 0.16,
    url: 'https://polymarket.com/event/eth-5m-up-down'
  })

  const signal = evaluateLegacyEarlyExitLiveSignalAt(market, AS_OF, {
    triggerPrice: 0.84,
    confirmedPrice: 0.86,
    askPrice: 0.87,
    observedPrices: [0.84, 0.85, 0.86],
    oracleDirectionConfirmed: true
  })

  assert.equal(signal.status, 'accepted')
  assert.ok(signal.intent)
  assert.equal(signal.intent?.side, 'yes')
  assert.equal(signal.intent?.entry.probabilityBand.trigger, 0.81)
  assert.equal(signal.intent?.entry.confirmation.delaySeconds, 4)
  assert.equal(signal.intent?.exit.takeProfitPrice, 0.93)
  assert.equal(signal.intent?.exit.stopLossPrice, 0.81)
  assert.equal(signal.intent?.exit.latestExitAt, '2026-04-21T16:04:30.000Z')
  assert.equal(signal.intent?.exit.managed.trailingStopActivation, 0.05)
  assert.equal(signal.intent?.exit.managed.timeDecayExitBands.length, 3)
  assert.equal(signal.diagnostics.asset, 'ETH')
  assert.equal(signal.diagnostics.execution.status, 'ask-validated')
  assert.equal(signal.diagnostics.confirmation.status, 'confirmed')
  assert.ok(signal.supportReasons.includes('entry-band-confirmed'))
  assert.ok(signal.supportReasons.includes('oracle-confirmed'))
  assert.ok(signal.confidence < signal.diagnostics.rawConfidence)
})

test('rejects confirmed SOL setups when observed range breaches the volatility cap', () => {
  const market = makeMarket({
    id: 'market-sol',
    eventId: 'event-sol',
    slug: 'sol-15m-up-down',
    eventTitle: 'SOL 15m Up or Down',
    question: 'Will SOL be up in the next 15 minutes?',
    yesPrice: 0.85,
    noPrice: 0.15,
    endDate: '2026-04-21T16:08:00.000Z',
    url: 'https://polymarket.com/event/sol-15m-up-down'
  })

  const signal = evaluateLegacyEarlyExitLiveSignalAt(market, AS_OF, {
    triggerPrice: 0.84,
    confirmedPrice: 0.86,
    observedPrices: [0.79, 0.88, 0.81]
  })

  assert.equal(signal.status, 'rejected')
  assert.equal(signal.intent, null)
  assert.equal(signal.diagnostics.volatility.status, 'rejected')
  assert.ok(signal.skipReasons.includes('volatility-too-high'))
  assert.equal(signal.diagnostics.assetWeight, 0.65)
})

test('builds report totals and limits emitted intents without mutating accepted ranking', () => {
  const btcPending = makeMarket({ id: 'btc-pending' })
  const ethAccepted = makeMarket({
    id: 'eth-accepted',
    slug: 'eth-5m-up-down',
    eventTitle: 'ETH 5m Up or Down',
    question: 'Will ETH be up in the next 5 minutes?',
    yesPrice: 0.84,
    noPrice: 0.16,
    url: 'https://polymarket.com/event/eth-5m-up-down'
  })
  const solAccepted = makeMarket({
    id: 'sol-accepted',
    slug: 'sol-15m-up-down',
    eventTitle: 'SOL 15m Up or Down',
    question: 'Will SOL be up in the next 15 minutes?',
    yesPrice: 0.85,
    noPrice: 0.15,
    endDate: '2026-04-21T16:08:00.000Z',
    url: 'https://polymarket.com/event/sol-15m-up-down'
  })

  const report = buildLegacyEarlyExitLiveSignalReport(
    makeSnapshot([btcPending, ethAccepted, solAccepted]),
    {
      marketContexts: {
        'eth-accepted': {
          triggerPrice: 0.84,
          confirmedPrice: 0.86,
          askPrice: 0.87,
          observedPrices: [0.84, 0.85, 0.86]
        },
        'sol-accepted': {
          triggerPrice: 0.84,
          confirmedPrice: 0.85,
          observedPrices: [0.83, 0.84, 0.85]
        }
      },
      overrides: {
        maxIntents: 1
      }
    },
    AS_OF
  )

  assert.equal(report.totals.marketsSeen, 3)
  assert.equal(report.totals.pendingConfirmation, 1)
  assert.equal(report.totals.accepted, 2)
  assert.equal(report.totals.emittedIntents, 1)
  assert.equal(report.accepted.length, 2)
  assert.equal(report.intents.length, 1)
  assert.ok(report.accepted[0].confidence >= report.accepted[1].confidence)
  assert.equal(report.accepted[1].intent, null)
})
