import type { RuntimeMarket } from '../../contracts/src/index.js'

export type CryptoAsset = 'BTC' | 'ETH' | 'SOL'
export type CryptoWindowInterval = '5m' | '15m'
export type CryptoWindowOperationalState = 'live' | 'orders-disabled' | 'book-disabled'

export type CryptoPriceFeedReference = {
  provider: 'chainlink-stream' | 'external-url'
  asset: CryptoAsset
  pair: `${CryptoAsset}-USD`
  url: string
}

export type CryptoPriceComparisonHook = {
  kind: 'spot-price-window'
  asset: CryptoAsset
  pair: `${CryptoAsset}-USD`
  windowStart: string
  windowEnd: string
  resolutionSourceUrl: string | null
  referenceFeed: CryptoPriceFeedReference | null
}

export type CryptoWindowDiscoveryRejectReasonCode =
  | 'duplicate-market'
  | 'inactive-market'
  | 'closed-market'
  | 'asset-out-of-scope'
  | 'asset-mismatch'
  | 'window-out-of-scope'
  | 'question-format-mismatch'
  | 'slug-format-mismatch'
  | 'window-duration-mismatch'
  | 'missing-token-ids'
  | 'missing-binary-outcomes'
  | 'invalid-end-date'
  | 'expired-window'

export type CryptoWindowDiscoveryRejectReason = {
  code: CryptoWindowDiscoveryRejectReasonCode
  message: string
  detail?: Record<string, boolean | number | string | null>
}

export type GammaEventSummary = {
  id: string | number
  slug?: string | null
  title?: string | null
  volume24hr?: number | string | null
}

export type GammaMarketRecord = {
  id: string | number
  slug?: string | null
  question?: string | null
  outcomes?: string | null | string[]
  clobTokenIds?: string | null | string[]
  spread?: number | string | null
  liquidity?: number | string | null
  liquidityClob?: number | string | null
  volume24hr?: number | string | null
  endDate?: string | null
  startDate?: string | null
  resolutionSource?: string | null
  active?: boolean | null
  closed?: boolean | null
  acceptingOrders?: boolean | null
  enableOrderBook?: boolean | null
  events?: GammaEventSummary[] | null
}

export type DiscoveredCryptoWindowMarket = {
  market: RuntimeMarket
  classification: {
    asset: CryptoAsset
    timeframe: CryptoWindowInterval
    marketKind: 'up-or-down'
    windowDurationMinutes: 5 | 15
    windowStart: string
    windowEnd: string
    questionWindowMinutes: number | null
    comparisonHook: CryptoPriceComparisonHook
  }
  operationalState: CryptoWindowOperationalState
  ranking: {
    assetWeight: number
    minutesToEnd: number
    liquidity: number | null
    volume24hr: number | null
  }
  notes: string[]
}

export type RejectedCryptoWindowMarket = {
  marketId: string
  eventId: string | null
  slug: string
  question: string
  rejectReasons: CryptoWindowDiscoveryRejectReason[]
}

export type CryptoWindowDiscoveryReport = {
  generatedAt: string
  requestedLimit: number
  selected: DiscoveredCryptoWindowMarket[]
  accepted: DiscoveredCryptoWindowMarket[]
  rejected: RejectedCryptoWindowMarket[]
}

export type DiscoverCryptoWindowMarketsOptions = {
  limit: number
  now?: Date | string
}

const QUESTION_PATTERN = /^(Bitcoin|Ethereum|Solana)\s+Up or Down\s+-\s+[A-Za-z]+\s+\d{1,2},\s+(\d{1,2}:\d{2}(?:AM|PM))-(\d{1,2}:\d{2}(?:AM|PM))\s+ET$/i
const SLUG_PATTERN = /^(btc|eth|sol)-updown-(5m|15m)-(\d+)$/i
const MINUTES_BY_TIMEFRAME: Record<CryptoWindowInterval, 5 | 15> = {
  '5m': 5,
  '15m': 15
}
const ASSET_WEIGHTS: Record<CryptoAsset, number> = {
  BTC: 1,
  ETH: 0.9,
  SOL: 0.65
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string')
      }
    } catch {
      return []
    }
  }
  return []
}

function parseClockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(AM|PM)$/i.exec(value.trim())
  if (!match) {
    return null
  }

  const rawHour = Number(match[1])
  const minute = Number(match[2])
  const meridiem = match[3].toUpperCase()
  if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null
  }

  let hour = rawHour % 12
  if (meridiem === 'PM') {
    hour += 12
  }
  return (hour * 60) + minute
}

function diffClockMinutes(start: string, end: string): number | null {
  const startMinutes = parseClockMinutes(start)
  const endMinutes = parseClockMinutes(end)
  if (startMinutes === null || endMinutes === null) {
    return null
  }

  return endMinutes >= startMinutes
    ? endMinutes - startMinutes
    : (24 * 60) - startMinutes + endMinutes
}

function parseNow(value?: Date | string): Date {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed
    }
  }
  return new Date()
}

function assetFromQuestionToken(value: string): CryptoAsset {
  switch (value.toLowerCase()) {
    case 'bitcoin':
      return 'BTC'
    case 'ethereum':
      return 'ETH'
    case 'solana':
    default:
      return 'SOL'
  }
}

function assetFromSlugToken(value: string): CryptoAsset {
  switch (value.toLowerCase()) {
    case 'btc':
      return 'BTC'
    case 'eth':
      return 'ETH'
    case 'sol':
    default:
      return 'SOL'
  }
}

function pairForAsset(asset: CryptoAsset): `${CryptoAsset}-USD` {
  switch (asset) {
    case 'BTC':
      return 'BTC-USD'
    case 'ETH':
      return 'ETH-USD'
    case 'SOL':
    default:
      return 'SOL-USD'
  }
}

function parseReferenceFeed(asset: CryptoAsset, resolutionSource: string | null | undefined): CryptoPriceFeedReference | null {
  if (typeof resolutionSource !== 'string' || resolutionSource.trim().length === 0) {
    return null
  }

  const normalized = resolutionSource.trim()
  return {
    provider: normalized.includes('chain.link') ? 'chainlink-stream' : 'external-url',
    asset,
    pair: pairForAsset(asset),
    url: normalized
  }
}

function operationalStateFor(record: GammaMarketRecord): CryptoWindowOperationalState {
  if (record.enableOrderBook === false) {
    return 'book-disabled'
  }
  if (record.acceptingOrders === false) {
    return 'orders-disabled'
  }
  return 'live'
}

function operationalRank(state: CryptoWindowOperationalState): number {
  switch (state) {
    case 'live':
      return 0
    case 'orders-disabled':
      return 1
    case 'book-disabled':
    default:
      return 2
  }
}

function compareAcceptedMarkets(left: DiscoveredCryptoWindowMarket, right: DiscoveredCryptoWindowMarket): number {
  const stateDelta = operationalRank(left.operationalState) - operationalRank(right.operationalState)
  if (stateDelta !== 0) {
    return stateDelta
  }

  const minutesDelta = left.ranking.minutesToEnd - right.ranking.minutesToEnd
  if (minutesDelta !== 0) {
    return minutesDelta
  }

  const assetDelta = right.ranking.assetWeight - left.ranking.assetWeight
  if (assetDelta !== 0) {
    return assetDelta > 0 ? 1 : -1
  }

  const liquidityDelta = (right.ranking.liquidity ?? 0) - (left.ranking.liquidity ?? 0)
  if (liquidityDelta !== 0) {
    return liquidityDelta > 0 ? 1 : -1
  }

  const volumeDelta = (right.ranking.volume24hr ?? 0) - (left.ranking.volume24hr ?? 0)
  if (volumeDelta !== 0) {
    return volumeDelta > 0 ? 1 : -1
  }

  return left.market.id.localeCompare(right.market.id)
}

export function discoverCryptoWindowMarkets(
  records: GammaMarketRecord[],
  options: DiscoverCryptoWindowMarketsOptions
): CryptoWindowDiscoveryReport {
  const now = parseNow(options.now)
  const nowMs = now.valueOf()
  const seen = new Set<string>()
  const accepted: DiscoveredCryptoWindowMarket[] = []
  const rejected: RejectedCryptoWindowMarket[] = []

  for (const record of records) {
    const marketId = String(record.id)
    const primaryEvent = Array.isArray(record.events) && record.events.length > 0 ? record.events[0] : null
    const slug = record.slug ?? primaryEvent?.slug ?? marketId
    const question = record.question ?? primaryEvent?.title ?? 'Untitled market'
    const rejectReasons: CryptoWindowDiscoveryRejectReason[] = []

    if (seen.has(marketId)) {
      rejectReasons.push({
        code: 'duplicate-market',
        message: 'Market id appeared more than once in the discovery payload.',
        detail: { marketId }
      })
    }
    seen.add(marketId)

    if (record.active === false) {
      rejectReasons.push({
        code: 'inactive-market',
        message: 'Market is not marked active.',
        detail: { active: false }
      })
    }

    if (record.closed === true) {
      rejectReasons.push({
        code: 'closed-market',
        message: 'Market is already closed.',
        detail: { closed: true }
      })
    }

    const slugMatch = SLUG_PATTERN.exec(slug)
    if (!slugMatch) {
      rejectReasons.push({
        code: 'slug-format-mismatch',
        message: 'Slug does not match the expected btc/eth/sol updown 5m/15m pattern.',
        detail: { slug }
      })
    }

    const questionMatch = QUESTION_PATTERN.exec(question)
    if (!questionMatch) {
      rejectReasons.push({
        code: 'question-format-mismatch',
        message: 'Question does not match the expected short-window crypto format.',
        detail: { question }
      })
    }

    const slugAsset = slugMatch ? assetFromSlugToken(slugMatch[1]) : null
    const questionAsset = questionMatch ? assetFromQuestionToken(questionMatch[1]) : null
    if (slugAsset && questionAsset && slugAsset !== questionAsset) {
      rejectReasons.push({
        code: 'asset-mismatch',
        message: 'Slug asset and question asset disagree.',
        detail: { slugAsset, questionAsset }
      })
    }

    const asset = slugAsset ?? questionAsset
    if (!asset) {
      rejectReasons.push({
        code: 'asset-out-of-scope',
        message: 'Market is not one of the supported BTC, ETH, or SOL short-window contracts.',
        detail: { slug, question }
      })
    }

    const slugTimeframe = slugMatch ? (slugMatch[2] as CryptoWindowInterval) : null
    const questionMinutes = questionMatch ? diffClockMinutes(questionMatch[2], questionMatch[3]) : null
    const questionTimeframe = questionMinutes === 5 || questionMinutes === 15
      ? `${questionMinutes}m` as CryptoWindowInterval
      : null

    if (questionMatch && questionTimeframe === null) {
      rejectReasons.push({
        code: 'window-out-of-scope',
        message: 'Question window is not a supported 5m or 15m interval.',
        detail: { questionMinutes }
      })
    }

    const timeframe = slugTimeframe ?? questionTimeframe
    if (!timeframe) {
      rejectReasons.push({
        code: 'window-out-of-scope',
        message: 'Market is not a supported 5m or 15m crypto window.',
        detail: { slug, question }
      })
    }

    if (slugTimeframe && questionTimeframe && slugTimeframe !== questionTimeframe) {
      rejectReasons.push({
        code: 'window-duration-mismatch',
        message: 'Slug timeframe and question timeframe do not agree.',
        detail: { slugTimeframe, questionTimeframe }
      })
    }

    const tokenIds = parseStringArray(record.clobTokenIds)
    if (tokenIds.length < 2) {
      rejectReasons.push({
        code: 'missing-token-ids',
        message: 'Market is missing the two binary token ids needed for read-only price lookup.',
        detail: { tokenCount: tokenIds.length }
      })
    }

    const outcomes = parseStringArray(record.outcomes)
    if (outcomes.length < 2) {
      rejectReasons.push({
        code: 'missing-binary-outcomes',
        message: 'Market is missing two binary outcome labels.',
        detail: { outcomeCount: outcomes.length }
      })
    }

    const endMs = typeof record.endDate === 'string' ? Date.parse(record.endDate) : Number.NaN
    if (!Number.isFinite(endMs)) {
      rejectReasons.push({
        code: 'invalid-end-date',
        message: 'Market is missing a usable endDate.',
        detail: { endDate: record.endDate ?? null }
      })
    } else if (endMs <= nowMs) {
      rejectReasons.push({
        code: 'expired-window',
        message: 'Market window has already ended relative to the discovery clock.',
        detail: {
          endDate: record.endDate ?? null,
          now: now.toISOString()
        }
      })
    }

    if (rejectReasons.length > 0 || !asset || !timeframe || !Number.isFinite(endMs)) {
      rejected.push({
        marketId,
        eventId: primaryEvent ? String(primaryEvent.id) : null,
        slug,
        question,
        rejectReasons
      })
      continue
    }

    const durationMinutes = MINUTES_BY_TIMEFRAME[timeframe]
    const endDate = new Date(endMs).toISOString()
    const windowStart = new Date(endMs - (durationMinutes * 60_000)).toISOString()
    const liquidity = asNumber(record.liquidityClob) ?? asNumber(record.liquidity)
    const volume24hr = asNumber(record.volume24hr) ?? asNumber(primaryEvent?.volume24hr)
    const notes: string[] = []
    const operationalState = operationalStateFor(record)

    if (operationalState === 'book-disabled') {
      notes.push('Order book is disabled, so the market is in-scope but not currently priceable from the live book.')
    } else if (operationalState === 'orders-disabled') {
      notes.push('Market is in-scope but not currently accepting orders.')
    }

    const comparisonHook: CryptoPriceComparisonHook = {
      kind: 'spot-price-window',
      asset,
      pair: pairForAsset(asset),
      windowStart,
      windowEnd: endDate,
      resolutionSourceUrl: record.resolutionSource?.trim() || null,
      referenceFeed: parseReferenceFeed(asset, record.resolutionSource)
    }

    accepted.push({
      market: {
        id: marketId,
        eventId: primaryEvent ? String(primaryEvent.id) : marketId,
        slug,
        eventTitle: primaryEvent?.title ?? question,
        question,
        yesLabel: outcomes[0] ?? 'Up',
        noLabel: outcomes[1] ?? 'Down',
        yesTokenId: tokenIds[0] ?? null,
        noTokenId: tokenIds[1] ?? null,
        yesPrice: null,
        noPrice: null,
        spread: asNumber(record.spread),
        volume24hr,
        liquidity,
        endDate,
        url: `https://polymarket.com/event/${primaryEvent?.slug ?? slug}`
      },
      classification: {
        asset,
        timeframe,
        marketKind: 'up-or-down',
        windowDurationMinutes: durationMinutes,
        windowStart,
        windowEnd: endDate,
        questionWindowMinutes: questionMinutes,
        comparisonHook
      },
      operationalState,
      ranking: {
        assetWeight: ASSET_WEIGHTS[asset],
        minutesToEnd: Math.max(0, Math.round((endMs - nowMs) / 60_000)),
        liquidity,
        volume24hr
      },
      notes
    })
  }

  accepted.sort(compareAcceptedMarkets)

  return {
    generatedAt: now.toISOString(),
    requestedLimit: options.limit,
    selected: accepted.slice(0, Math.max(0, options.limit)),
    accepted,
    rejected
  }
}
