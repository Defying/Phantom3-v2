#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { RuntimeStore } from '../apps/api/src/runtime-store.js'
import { paperStrategyViewSchema, runtimeStateSchema } from '../packages/contracts/src/index.js'
import { getOpenOrders, JsonlLedger } from '../packages/ledger/src/index.js'
import { discoverCryptoWindowMarkets, fetchTopMarkets } from '../packages/market-data/src/index.js'
import { PaperExecutionAdapter } from '../packages/paper-execution/src/index.js'
import { parseSocksProxyUrl } from '../packages/transport/src/index.js'
import { evaluateLegacyManagedExit, evaluateLegacyManagedSessionGuards } from '../packages/strategy/src/index.js'
import type { AppConfig } from '../packages/config/src/index.js'
import type { RuntimeMarket } from '../packages/contracts/src/index.js'

const checks: Array<{ ok: boolean; label: string; detail: string }> = []

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  assert(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`)
}

async function expect(label: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await fn()
    checks.push({ ok: true, label, detail })
  } catch (error) {
    checks.push({
      ok: false,
      label,
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'phantom3-paper-runtime-'))

  try {
    const dataDir = join(root, 'data')
    const logDir = join(root, 'logs')
    await mkdir(dataDir, { recursive: true })
    await mkdir(logDir, { recursive: true })

    const market: RuntimeMarket = {
      id: 'market-restart-truth',
      eventId: 'event-restart-truth',
      slug: 'restart-truth',
      eventTitle: 'Restart truth smoke test',
      question: 'Will bootstrap restart preserve ledger truth?',
      yesLabel: 'Yes',
      noLabel: 'No',
      yesTokenId: 'token-yes',
      noTokenId: 'token-no',
      yesPrice: 0.58,
      noPrice: 0.42,
      spread: 0.02,
      volume24hr: 12_500,
      liquidity: 20_000,
      endDate: '2026-12-31T00:00:00.000Z',
      url: 'https://example.com/markets/restart-truth'
    }

    await writeFile(
      join(dataDir, 'runtime-state.json'),
      `${JSON.stringify({
        marketData: {
          source: 'Polymarket Gamma + CLOB',
          syncedAt: '2026-04-20T20:00:00.000Z',
          stale: true,
          refreshIntervalMs: 30_000,
          error: 'Offline smoke test bootstrap.'
        },
        markets: [market],
        strategy: { invalid: true },
        events: [
          {
            id: 'seed-event',
            at: '2026-04-20T20:00:00.000Z',
            level: 'info',
            message: 'Seeded restart-truth smoke test.'
          }
        ]
      }, null, 2)}\n`,
      'utf8'
    )

    let now = new Date('2026-04-20T20:00:00.000Z')
    const clock = () => now
    const ledger = new JsonlLedger({ directory: dataDir, clock })
    await ledger.init()

    const execution = new PaperExecutionAdapter(ledger, {
      clock,
      allowPartialFills: false
    })

    const buyResult = await execution.submitApprovedIntent({
      intent: {
        sessionId: 'paper-runtime-smoke',
        intentId: 'intent-buy',
        strategyId: 'paper-runtime-smoke',
        marketId: market.id,
        tokenId: market.yesTokenId ?? 'token-yes',
        side: 'buy',
        limitPrice: 0.41,
        quantity: 10,
        approvedAt: now.toISOString(),
        thesis: 'Open a paper position so restart recovery has ledger truth to replay.'
      },
      quote: {
        quoteId: 'quote-buy',
        marketId: market.id,
        tokenId: market.yesTokenId ?? 'token-yes',
        observedAt: now.toISOString(),
        bestBid: 0.39,
        bestAsk: 0.4,
        midpoint: 0.395,
        source: 'paper-runtime-smoke'
      }
    })

    now = new Date('2026-04-20T20:05:00.000Z')

    const sellResult = await execution.submitApprovedIntent({
      intent: {
        sessionId: 'paper-runtime-smoke',
        intentId: 'intent-sell',
        strategyId: 'paper-runtime-smoke',
        marketId: market.id,
        tokenId: market.yesTokenId ?? 'token-yes',
        side: 'sell',
        limitPrice: 0.54,
        quantity: 4,
        approvedAt: now.toISOString(),
        thesis: 'Trim part of the paper position so realized PnL and remaining lots can be checked.'
      },
      quote: {
        quoteId: 'quote-sell',
        marketId: market.id,
        tokenId: market.yesTokenId ?? 'token-yes',
        observedAt: now.toISOString(),
        bestBid: 0.55,
        bestAsk: 0.56,
        midpoint: 0.555,
        source: 'paper-runtime-smoke'
      }
    })

    await expect('crypto window discovery narrows to BTC/ETH/SOL 5m/15m markets with explicit reject reasons', () => {
      const report = discoverCryptoWindowMarkets([
        {
          id: 'btc-live',
          question: 'Bitcoin Up or Down - April 21, 12:25PM-12:30PM ET',
          slug: 'btc-updown-5m-1776789000',
          outcomes: '["Up", "Down"]',
          clobTokenIds: '["btc-up", "btc-down"]',
          spread: '0.02',
          liquidityClob: '12000',
          volume24hr: '220',
          endDate: '2026-04-21T16:30:00.000Z',
          resolutionSource: 'https://data.chain.link/streams/btc-usd',
          active: true,
          closed: false,
          acceptingOrders: true,
          enableOrderBook: true,
          events: [{ id: 'event-btc-live', title: 'Bitcoin Up or Down - April 21, 12:25PM-12:30PM ET', slug: 'btc-updown-5m-1776789000' }]
        },
        {
          id: 'eth-disabled',
          question: 'Ethereum Up or Down - April 21, 12:30PM-12:45PM ET',
          slug: 'eth-updown-15m-1776789900',
          outcomes: '["Up", "Down"]',
          clobTokenIds: '["eth-up", "eth-down"]',
          spread: '0.03',
          liquidityClob: '9000',
          volume24hr: '90',
          endDate: '2026-04-21T16:45:00.000Z',
          resolutionSource: 'https://data.chain.link/streams/eth-usd',
          active: true,
          closed: false,
          acceptingOrders: true,
          enableOrderBook: false,
          events: [{ id: 'event-eth-disabled', title: 'Ethereum Up or Down - April 21, 12:30PM-12:45PM ET', slug: 'eth-updown-15m-1776789900' }]
        },
        {
          id: 'xrp-out-of-scope',
          question: 'XRP Up or Down - April 21, 12:25PM-12:30PM ET',
          slug: 'xrp-updown-5m-1776789000',
          outcomes: '["Up", "Down"]',
          clobTokenIds: '["xrp-up", "xrp-down"]',
          endDate: '2026-04-21T16:30:00.000Z',
          active: true,
          closed: false,
          acceptingOrders: true,
          enableOrderBook: true,
          events: [{ id: 'event-xrp', title: 'XRP Up or Down - April 21, 12:25PM-12:30PM ET', slug: 'xrp-updown-5m-1776789000' }]
        },
        {
          id: 'btc-malformed',
          question: 'Bitcoin Up or Down - April 21, 12:40PM-12:50PM ET',
          slug: 'btc-updown-10m-1776790200',
          outcomes: '["Up", "Down"]',
          clobTokenIds: '["btc-bad-up"]',
          endDate: '2026-04-21T16:50:00.000Z',
          active: true,
          closed: false,
          acceptingOrders: true,
          enableOrderBook: true,
          events: [{ id: 'event-btc-bad', title: 'Bitcoin Up or Down - April 21, 12:40PM-12:50PM ET', slug: 'btc-updown-10m-1776790200' }]
        }
      ], {
        limit: 1,
        now: '2026-04-21T16:21:00.000Z'
      })

      assert.equal(report.accepted.length, 2)
      assert.equal(report.selected.length, 1)
      assert.equal(report.selected[0]?.market.id, 'btc-live')
      assert.equal(report.selected[0]?.classification.asset, 'BTC')
      assert.equal(report.selected[0]?.classification.timeframe, '5m')
      assert.equal(report.selected[0]?.classification.windowDurationMinutes, 5)
      assert.equal(report.selected[0]?.classification.comparisonHook.pair, 'BTC-USD')
      assert.equal(report.accepted[1]?.operationalState, 'book-disabled')

      const rejectCodes = report.rejected.flatMap((market) => market.rejectReasons.map((reason) => reason.code))
      assert(rejectCodes.includes('asset-out-of-scope'))
      assert(rejectCodes.includes('window-out-of-scope'))
      assert(rejectCodes.includes('missing-token-ids'))

      return `${report.selected[0]?.market.question} selected, ${report.rejected.length} rejected with typed reasons`
    })

    await expect('restricted Polymarket eligibility fails closed before any live request', async () => {
      await assert.rejects(
        fetchTopMarkets({ limit: 1, operatorEligibility: 'restricted' }),
        /Read-only market sync stays disabled/
      )
      return 'restricted eligibility blocked market-data preflight before network I/O'
    })

    await expect('paper execution fills crossing quotes immediately', () => {
      assert.equal(buyResult.status, 'filled')
      assert.equal(sellResult.status, 'filled')
      return `buy=${buyResult.filledQuantity}, sell=${sellResult.filledQuantity}`
    })

    await expect('ledger projection keeps quantity, PnL, and open-order invariants coherent', async () => {
      const projection = await ledger.readProjection()
      const position = projection.positions.get(`${market.id}:${market.yesTokenId}`)
      assert(position, 'expected an open projected position after the smoke fills')
      approx(position.netQuantity, 6)
      approx(position.averageEntryPrice ?? -1, 0.4)
      approx(position.realizedPnl, 0.6)
      assert.deepEqual(projection.anomalies, [])
      assert.equal(getOpenOrders(projection).length, 0)
      return `net=${position.netQuantity}, avg=${position.averageEntryPrice}, realized=${position.realizedPnl}`
    })

    await expect('legacy managed exit evaluation tracks trailing, break-even, time-decay, and stop states', () => {
      const trailingSeed = evaluateLegacyManagedExit({
        entryPrice: 0.85,
        observedAt: '2026-04-20T20:00:00.000Z',
        markPrice: 0.91,
        marketEndDate: '2026-04-20T20:05:00.000Z'
      })
      const trailing = evaluateLegacyManagedExit({
        entryPrice: 0.85,
        observedAt: '2026-04-20T20:02:00.000Z',
        markPrice: 0.858,
        marketEndDate: '2026-04-20T20:05:00.000Z',
        previousState: trailingSeed.state
      })
      assert.ok(trailing.triggers.includes('managed-trailing-stop'))

      const damagedSeed = evaluateLegacyManagedExit({
        entryPrice: 0.85,
        observedAt: '2026-04-20T20:00:00.000Z',
        markPrice: 0.8,
        marketEndDate: '2026-04-20T20:05:00.000Z'
      })
      const damaged = evaluateLegacyManagedExit({
        entryPrice: 0.85,
        observedAt: '2026-04-20T20:03:45.000Z',
        markPrice: 0.89,
        marketEndDate: '2026-04-20T20:05:00.000Z',
        previousState: damagedSeed.state
      })
      assert.ok(damaged.triggers.includes('managed-break-even'))
      assert.ok(damaged.triggers.includes('managed-time-decay-profit'))

      const forceExit = evaluateLegacyManagedExit({
        entryPrice: 0.85,
        observedAt: '2026-04-20T20:04:40.000Z',
        markPrice: 0.84,
        marketEndDate: '2026-04-20T20:05:00.000Z'
      })
      assert.ok(forceExit.triggers.includes('managed-market-closing'))

      const stopExit = evaluateLegacyManagedExit({
        entryPrice: 0.85,
        observedAt: '2026-04-20T20:01:00.000Z',
        markPrice: 0.78,
        marketEndDate: '2026-04-20T20:05:00.000Z'
      })
      assert.ok(stopExit.triggers.includes('managed-stop-hit'))

      return trailing.triggers.join(', ')
    })

    await expect('legacy session guard evaluation derives cooldown and drawdown stops from closed paper outcomes', () => {
      const cooldown = evaluateLegacyManagedSessionGuards({
        now: '2026-04-20T20:10:00.000Z',
        config: {
          maxSessionDrawdownUsd: null,
          dailyProfitTargetUsd: 999,
          maxConsecutiveLosses: 3,
          cooldownMs: 10 * 60 * 1000
        },
        positionEvents: [
          { positionId: 'p1', recordedAt: '2026-04-20T20:00:00.000Z', transition: 'opened', realizedPnlDelta: 0 },
          { positionId: 'p1', recordedAt: '2026-04-20T20:01:00.000Z', transition: 'closed', realizedPnlDelta: -5 },
          { positionId: 'p2', recordedAt: '2026-04-20T20:02:00.000Z', transition: 'opened', realizedPnlDelta: 0 },
          { positionId: 'p2', recordedAt: '2026-04-20T20:03:00.000Z', transition: 'closed', realizedPnlDelta: -4 },
          { positionId: 'p3', recordedAt: '2026-04-20T20:04:00.000Z', transition: 'opened', realizedPnlDelta: 0 },
          { positionId: 'p3', recordedAt: '2026-04-20T20:05:00.000Z', transition: 'closed', realizedPnlDelta: -6 }
        ]
      })
      assert.equal(cooldown.status, 'cooldown')
      assert.ok(cooldown.cooldownUntil)

      const blocked = evaluateLegacyManagedSessionGuards({
        now: '2026-04-20T20:10:00.000Z',
        positionEvents: [
          { positionId: 'p1', recordedAt: '2026-04-20T20:00:00.000Z', transition: 'opened', realizedPnlDelta: 0 },
          { positionId: 'p1', recordedAt: '2026-04-20T20:01:00.000Z', transition: 'closed', realizedPnlDelta: -15 },
          { positionId: 'p2', recordedAt: '2026-04-20T20:02:00.000Z', transition: 'opened', realizedPnlDelta: 0 },
          { positionId: 'p2', recordedAt: '2026-04-20T20:03:00.000Z', transition: 'closed', realizedPnlDelta: -20 }
        ]
      })
      assert.equal(blocked.status, 'blocked')
      assert.ok(blocked.reasons.some((reason) => reason.code === 'session-drawdown-stop'))

      return `cooldownUntil=${cooldown.cooldownUntil}, blockedPnl=${blocked.realizedPnlUsd}`
    })

    await expect('runtime bootstrap rehydrates paper positions from ledger truth and keeps the API schema valid', async () => {
      const proxy = parseSocksProxyUrl('socks5h://127.0.0.1:9050')
      const config = {
        host: '127.0.0.1',
        port: 4317,
        remoteDashboardEnabled: false,
        publicBaseUrl: 'http://127.0.0.1:4317',
        dataDir,
        logDir,
        marketRefreshMs: 30_000,
        marketLimit: 4,
        polymarketProxy: proxy,
        polymarketProxyUrl: proxy.url,
        polymarketOperatorEligibility: 'confirmed-eligible',
        liveModeEnabled: false,
        liveArmingEnabled: false,
        liveExecution: {
          enabled: false,
          venue: 'polymarket',
          maxQuoteAgeMs: 5_000,
          maxReconcileAgeMs: 15_000,
          missingOrderGraceMs: 30_000
        },
        controlToken: 'paper-runtime-smoke-token'
      } satisfies AppConfig

      const store = new RuntimeStore(config)
      Reflect.set(store, 'refreshMarketData', async () => {})
      await store.init()

      const state = runtimeStateSchema.parse(store.getState())
      assert.equal(state.mode, 'paper')
      assert.equal(state.strategy.positions.length, 1)
      assert.equal(state.strategy.openPositionCount, 1)
      assert.equal(state.marketData.transport.route, 'proxy')
      assert.equal(state.marketData.transport.scope, 'polymarket-only')
      assert.equal(state.marketData.access.operatorEligibility, 'confirmed-eligible')
      assert.equal(state.modules.find((module) => module.id === 'ledger')?.status, 'healthy')
      assert.equal(state.watchlist.find((entry) => entry.id === 'paper-ledger')?.status, 'active')
      assert.equal(state.strategy.lastEvaluatedAt, '2026-04-20T20:05:00.000Z')
      assert.match(state.strategy.notes.join(' '), /Recovered 1 open paper position from append-only ledger truth during bootstrap\./)

      const position = state.strategy.positions[0]
      assert(position)
      assert.equal(position.marketId, market.id)
      assert.equal(position.marketQuestion, market.question)
      assert.equal(position.side, 'yes')
      approx(position.quantity, 6)
      approx(position.averageEntryPrice, 0.4)
      approx(position.markPrice ?? -1, 0.58)
      approx(position.unrealizedPnlUsd ?? -1, 1.08)

      const view = store.getPaperStrategyView(6)
      assert(view, 'expected a sanitized paper strategy view in paper mode')
      const parsedView = paperStrategyViewSchema.parse(view)
      assert.equal(parsedView.summary.positions.length, 1)
      assert.equal(parsedView.latestSnapshot?.trigger, 'bootstrap')
      assert.equal(parsedView.latestSnapshot?.positions.length, 1)

      store.setTradingPreference('legacy-early-exit-live')
      await wait(150)
      const managedState = runtimeStateSchema.parse(store.getState())
      const managedPosition = managedState.strategy.positions[0]
      assert(managedPosition?.exit, 'expected a typed exit state after switching to the managed profile')
      assert.equal(managedPosition.exit?.profile, 'legacy-early-exit-live')
      assert.equal(managedPosition.exit?.managed?.profile, 'legacy-early-exit-live')
      assert.equal(managedPosition.exit?.managed?.liveExecutionArmed, false)
      assert.equal(managedPosition.exit?.sessionGuard?.liveExecutionArmed, false)
      assert.match(managedState.strategy.notes.join(' '), /Legacy early-exit live\/managed is selected in paper-only managed mode\./)

      await wait(100)
      return `${managedPosition.quantity} contracts restored with ${managedPosition.exit?.profile} exit state for ${managedPosition.marketQuestion}`
    })
  } finally {
    await wait(100)
    await rm(root, { recursive: true, force: true })
  }

  const passed = checks.filter((check) => check.ok).length
  const failed = checks.length - passed

  console.log('Paper runtime smoke verification')
  console.log('===============================')
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`)
    console.log(`      ${check.detail}`)
  }
  console.log('-------------------------------')
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  console.log('Note: this smoke verifier exercises ledger projection invariants, bootstrap restart truth, and the sanitized paper runtime API shape without contacting live market data.')

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Paper runtime smoke verification crashed')
  console.error(error)
  process.exit(1)
})
