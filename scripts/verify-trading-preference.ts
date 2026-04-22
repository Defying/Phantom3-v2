#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createApiApp } from '../apps/api/src/app.js'
import { RuntimeStore } from '../apps/api/src/runtime-store.js'
import {
  runtimeStateSchema,
  tradingPreferenceStateSchema,
  updateTradingPreferenceResponseSchema
} from '../packages/contracts/src/index.js'
import type { AppConfig } from '../packages/config/src/index.js'

const checks: Array<{ ok: boolean; label: string; detail: string }> = []

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-phantom3-token': token
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function createHarness(root: string): Promise<{
  app: Awaited<ReturnType<typeof createApiApp>>['app']
  config: AppConfig
  dataDir: string
}> {
  const dataDir = join(root, 'data')
  const logDir = join(root, 'logs')
  await mkdir(dataDir, { recursive: true })
  await mkdir(logDir, { recursive: true })

  const config = {
    host: '127.0.0.1',
    port: 4317,
    remoteDashboardEnabled: false,
    publicBaseUrl: 'http://127.0.0.1:4317',
    dataDir,
    logDir,
    marketRefreshMs: 30_000,
    marketLimit: 4,
    polymarketProxy: null,
    polymarketProxyUrl: null,
    polymarketOperatorEligibility: 'unknown',
    liveModeEnabled: false,
    liveArmingEnabled: false,
    liveExecution: {
      enabled: false,
      venue: 'polymarket',
      maxQuoteAgeMs: 5_000,
      maxReconcileAgeMs: 15_000,
      missingOrderGraceMs: 30_000
    },
    controlToken: 'trading-preference-smoke-token'
  } satisfies AppConfig

  const store = new RuntimeStore(config)
  Reflect.set(store, 'refreshMarketData', async () => {})

  const { app } = await createApiApp(config, {
    logger: false,
    store,
    registerStatic: false,
    startHeartbeat: false,
    startMarketRefresh: false
  })

  return { app, config, dataDir }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'phantom3-trading-preference-'))
  const repoRoot = process.cwd()
  let primary: Awaited<ReturnType<typeof createHarness>> | null = null
  let restart: Awaited<ReturnType<typeof createHarness>> | null = null

  try {
    primary = await createHarness(root)
    if (!primary) {
      throw new Error('failed to create primary verifier harness')
    }
    const activePrimary = primary

    await expect('control endpoints fail closed without a token', async () => {
      for (const path of ['/api/control/pause', '/api/control/resume', '/api/control/trading-preference']) {
        const response = await activePrimary.app.inject({
          method: 'POST',
          url: path,
          payload: path.endsWith('trading-preference') ? { profile: 'legacy-early-exit-live' } : undefined
        })
        assert.equal(response.statusCode, 401, `${path} should reject missing auth`)
        assert.deepEqual(response.json(), { error: 'Unauthorized' })
      }
      return 'pause, resume, and trading-preference writes all rejected missing auth'
    })

    await expect('authorized pause and resume stay paper-safe while exposing paused state honestly', async () => {
      const pauseResponse = await activePrimary.app.inject({
        method: 'POST',
        url: '/api/control/pause',
        headers: { 'x-phantom3-token': activePrimary.config.controlToken }
      })
      assert.equal(pauseResponse.statusCode, 200)
      assert.deepEqual(pauseResponse.json(), { ok: true, paused: true })

      const pausedState = runtimeStateSchema.parse((await activePrimary.app.inject({
        method: 'GET',
        url: '/api/runtime',
        headers: authHeaders(activePrimary.config.controlToken)
      })).json())
      assert.equal(pausedState.mode, 'paper')
      assert.equal(pausedState.paused, true)
      assert.equal(pausedState.strategy.status, 'paused')
      assert.equal(pausedState.modules.find((module) => module.id === 'execution')?.status, 'blocked')
      assert.equal(pausedState.watchlist.find((entry) => entry.id === 'paper-mode')?.status, 'active')

      const resumeResponse = await activePrimary.app.inject({
        method: 'POST',
        url: '/api/control/resume',
        headers: { authorization: `Bearer ${activePrimary.config.controlToken}` }
      })
      assert.equal(resumeResponse.statusCode, 200)
      assert.deepEqual(resumeResponse.json(), { ok: true, paused: false })

      const resumedState = runtimeStateSchema.parse((await activePrimary.app.inject({
        method: 'GET',
        url: '/api/runtime',
        headers: authHeaders(activePrimary.config.controlToken)
      })).json())
      assert.equal(resumedState.mode, 'paper')
      assert.equal(resumedState.paused, false)
      assert.equal(resumedState.strategy.status, 'idle')
      return 'pause/resume toggled state, strategy status, and auth modes without leaving paper mode'
    })

    await expect('trading preference control validates payloads', async () => {
      const response = await activePrimary.app.inject({
        method: 'POST',
        url: '/api/control/trading-preference',
        headers: { 'x-phantom3-token': activePrimary.config.controlToken },
        payload: { profile: 'legacy-imaginary-profile' }
      })
      assert.equal(response.statusCode, 400)
      assert.deepEqual(response.json(), { error: 'Invalid trading preference profile.' })
      return 'invalid profile rejected with 400'
    })

    await expect('authorized trading preference update returns schema-valid reference state and honest runtime exposure', async () => {
      const response = await activePrimary.app.inject({
        method: 'POST',
        url: '/api/control/trading-preference',
        headers: { 'x-phantom3-token': activePrimary.config.controlToken },
        payload: { profile: 'legacy-early-exit-live' }
      })
      assert.equal(response.statusCode, 200)

      const payload = updateTradingPreferenceResponseSchema.parse(response.json())
      assert.equal(payload.tradingPreference.selected.profile, 'legacy-early-exit-live')
      assert.equal(payload.tradingPreference.selected.parityStatus, 'legacy-reference')
      assert.match(payload.tradingPreference.selected.note, /Paper-only partial parity|Reference-only for now|does not switch/i)
      assert.deepEqual(
        payload.tradingPreference.available.map((option) => option.profile),
        [
          'current-v2-generic',
          'legacy-early-exit-classic',
          'legacy-early-exit-live',
          'legacy-sniper-hold'
        ]
      )
      assert.equal(
        payload.tradingPreference.available.filter((option) => option.parityStatus === 'current-runtime').length,
        1
      )

      const accessResponse = await activePrimary.app.inject({ method: 'GET', url: '/api/access' })
      assert.equal(accessResponse.statusCode, 200)
      const access = accessResponse.json()
      assert.equal(access.tradingPreferenceControlEndpoint, '/api/control/trading-preference')
      assert.match(access.note, /legacy profiles stay reference-only/i)

      const runtimeState = runtimeStateSchema.parse((await activePrimary.app.inject({
        method: 'GET',
        url: '/api/runtime',
        headers: authHeaders(activePrimary.config.controlToken)
      })).json())
      assert.equal(runtimeState.mode, 'paper')
      assert.equal(runtimeState.tradingPreference.selected.profile, 'legacy-early-exit-live')
      assert.equal(runtimeState.tradingPreference.selected.parityStatus, 'legacy-reference')
      assert.equal(runtimeState.modules.find((module) => module.id === 'execution')?.status, 'blocked')
      assert.equal(runtimeState.watchlist.find((entry) => entry.id === 'paper-mode')?.status, 'active')
      assert.match(runtimeState.watchlist.find((entry) => entry.id === 'trading-preference')?.note ?? '', /paper-only managed mode|Paper-only partial parity|Reference-only for now|does not switch/i)
      assert.match(runtimeState.events[0]?.message ?? '', /Operator selected trading preference/i)
      return `${runtimeState.tradingPreference.selected.profile} exposed as ${runtimeState.tradingPreference.selected.parityStatus}`
    })

    await expect('selected trading preference persists on disk with the shared schema shape', async () => {
      await wait(150)
      const raw = JSON.parse(await readFile(join(activePrimary.dataDir, 'runtime-state.json'), 'utf8')) as { tradingPreference?: unknown }
      const persisted = tradingPreferenceStateSchema.parse(raw.tradingPreference)
      assert.equal(persisted.selected.profile, 'legacy-early-exit-live')
      return `persisted ${persisted.selected.profile} with ${persisted.available.length} available profiles`
    })

    await activePrimary.app.close()
    primary = null

    restart = await createHarness(root)
    if (!restart) {
      throw new Error('failed to create restart verifier harness')
    }
    const activeRestart = restart

    await expect('restart rehydrates the selected profile and bearer auth can switch back to the current runtime profile', async () => {
      const rehydratedState = runtimeStateSchema.parse((await activeRestart.app.inject({
        method: 'GET',
        url: '/api/runtime',
        headers: authHeaders(activeRestart.config.controlToken)
      })).json())
      assert.equal(rehydratedState.tradingPreference.selected.profile, 'legacy-early-exit-live')
      assert.equal(rehydratedState.tradingPreference.selected.parityStatus, 'legacy-reference')
      assert.equal(rehydratedState.mode, 'paper')
      assert.equal(rehydratedState.modules.find((module) => module.id === 'execution')?.status, 'blocked')

      const response = await activeRestart.app.inject({
        method: 'POST',
        url: '/api/control/trading-preference',
        headers: { authorization: `Bearer ${activeRestart.config.controlToken}` },
        payload: { profile: 'current-v2-generic' }
      })
      assert.equal(response.statusCode, 200)

      const payload = updateTradingPreferenceResponseSchema.parse(response.json())
      assert.equal(payload.tradingPreference.selected.profile, 'current-v2-generic')
      assert.equal(payload.tradingPreference.selected.parityStatus, 'current-runtime')
      assert.match(payload.tradingPreference.selected.note, /only strategy profile .* today|emit new paper entries today/i)
      return 'rehydrated legacy preference, then switched back to current-runtime through bearer auth'
    })

    await expect('legacy reference doc still carries the parity-target thresholds and intended scope', async () => {
      const doc = await readFile(join(repoRoot, 'docs/architecture/TRADING_PREFERENCE_PROFILES.md'), 'utf8')
      assert.match(doc, /Bitcoin, Ethereum, and Solana/i)
      assert.match(doc, /5 minute and 15 minute/i)
      assert.match(doc, /entry band: \*\*0\.80 to 0\.88\*\*/)
      assert.match(doc, /exit target: \*\*0\.92\*\*/)
      assert.match(doc, /stop loss: \*\*0\.77\*\*/)
      assert.match(doc, /entry band: \*\*0\.83 to 0\.91\*\*/)
      assert.match(doc, /confirmation trigger: \*\*0\.81\*\*/)
      assert.match(doc, /exit target: \*\*0\.93\*\*/)
      assert.match(doc, /stop-loss floor: \*\*0\.70\*\*/)
      assert.match(doc, /min_probability`: \*\*0\.95\*\*/)
      return 'classic 80-88/92/77, managed 83-91 trigger 0.81 target 0.93 stop floor 0.70, sniper 95%+, BTC/ETH/SOL 5m/15m scope'
    })
  } finally {
    if (restart) {
      await restart.app.close()
    }
    if (primary) {
      await primary.app.close()
    }
    await rm(root, { recursive: true, force: true })
  }

  const passed = checks.filter((check) => check.ok).length
  const failed = checks.length - passed

  console.log('Trading preference verification')
  console.log('==============================')
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`)
    console.log(`      ${check.detail}`)
  }
  console.log('------------------------------')
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  console.log('Note: this verifier covers token-gated control behavior, persisted trading-preference state, honest runtime exposure of legacy-reference profiles, and documentation-backed legacy threshold markers without contacting live market data.')

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Trading preference verification crashed')
  console.error(error)
  process.exit(1)
})
