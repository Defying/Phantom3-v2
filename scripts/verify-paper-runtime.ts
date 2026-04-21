#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { RuntimeStore } from '../apps/api/src/runtime-store.js'
import { paperStrategyViewSchema, runtimeStateSchema } from '../packages/contracts/src/index.js'
import { getOpenOrders, JsonlLedger } from '../packages/ledger/src/index.js'
import { PaperExecutionAdapter } from '../packages/paper-execution/src/index.js'
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

    await expect('runtime bootstrap rehydrates paper positions from ledger truth and keeps the API schema valid', async () => {
      const config = {
        host: '127.0.0.1',
        port: 4317,
        remoteDashboardEnabled: false,
        publicBaseUrl: 'http://127.0.0.1:4317',
        dataDir,
        logDir,
        marketRefreshMs: 30_000,
        marketLimit: 4,
        controlToken: 'paper-runtime-smoke-token'
      } satisfies AppConfig

      const store = new RuntimeStore(config)
      Reflect.set(store, 'refreshMarketData', async () => {})
      await store.init()

      const state = runtimeStateSchema.parse(store.getState())
      assert.equal(state.mode, 'paper')
      assert.equal(state.strategy.positions.length, 1)
      assert.equal(state.strategy.openPositionCount, 1)
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

      await wait(100)
      return `${position.quantity} contracts restored for ${position.marketQuestion}`
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
