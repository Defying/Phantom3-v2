import {
  RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE,
  type RuntimeMarket
} from '../../contracts/src/index.js'
import { OutboundTransport } from '../../transport/src/index.js'
import {
  discoverCryptoWindowMarkets,
  type CryptoAsset,
  type CryptoPriceComparisonHook,
  type CryptoPriceFeedReference,
  type CryptoWindowDiscoveryRejectReason,
  type CryptoWindowDiscoveryRejectReasonCode,
  type CryptoWindowDiscoveryReport,
  type CryptoWindowInterval,
  type CryptoWindowOperationalState,
  type DiscoverCryptoWindowMarketsOptions,
  type DiscoveredCryptoWindowMarket,
  type GammaEventSummary,
  type GammaMarketRecord,
  type RejectedCryptoWindowMarket
} from './discovery.js'

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com'
const CLOB_API_BASE = 'https://clob.polymarket.com'
const USER_AGENT = 'Phantom3-v2/0.1'
const DIRECT_TRANSPORT = new OutboundTransport()

export type PolymarketOperatorEligibility = 'unknown' | 'confirmed-eligible' | 'restricted'

export type PolymarketTransportSummary = {
  route: 'direct' | 'proxy'
  scope: 'polymarket-only'
  note: string
}

export type PolymarketAccessSummary = {
  operatorEligibility: PolymarketOperatorEligibility
  readOnly: true
  note: string
}

type MidpointReferenceResponse = {
  mid?: string | number | null
}

export type MarketSnapshot = {
  fetchedAt: string
  markets: RuntimeMarket[]
  transport: PolymarketTransportSummary
  access: PolymarketAccessSummary
}

export type CryptoWindowMarketSnapshot = MarketSnapshot & {
  discovery: CryptoWindowDiscoveryReport
}

export type FetchTopMarketsOptions = {
  limit: number
  timeoutMs?: number
  transport?: OutboundTransport
  operatorEligibility?: PolymarketOperatorEligibility
  now?: Date | string
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

export function describePolymarketTransport(options: { transport?: OutboundTransport | null; proxyUrl?: string | null } = {}): PolymarketTransportSummary {
  const route = options.transport?.proxy || options.proxyUrl ? 'proxy' : 'direct'
  return {
    route,
    scope: 'polymarket-only',
    note: route === 'proxy'
      ? 'Scoped SOCKS transport is enabled only for Polymarket Gamma + CLOB reads. Dashboard, control, and local health traffic stay direct.'
      : 'Direct HTTPS transport is in use for Polymarket reads. Dashboard, control, and local health traffic remain off any venue proxy.'
  }
}

export function describePolymarketAccess(options: { operatorEligibility?: PolymarketOperatorEligibility } = {}): PolymarketAccessSummary {
  const operatorEligibility = options.operatorEligibility ?? 'unknown'
  switch (operatorEligibility) {
    case 'confirmed-eligible':
      return {
        operatorEligibility,
        readOnly: true,
        note: 'Operator marked Polymarket access as confirmed eligible. Runtime remains read-only and will not place live orders.'
      }
    case 'restricted':
      return {
        operatorEligibility,
        readOnly: true,
        note: 'Operator marked Polymarket access as restricted. Read-only market sync stays disabled instead of attempting bypass behavior.'
      }
    case 'unknown':
    default:
      return {
        operatorEligibility: 'unknown',
        readOnly: true,
        note: 'Operator eligibility is still unconfirmed. Runtime stays read-only and does not attempt geoblock bypass behavior.'
      }
  }
}

async function getJson<T>(url: string, signal: AbortSignal, transport: OutboundTransport): Promise<T> {
  return transport.getJson<T>(url, {
    signal,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json'
    }
  })
}

async function fetchMidpointReference(tokenId: string, signal: AbortSignal, transport: OutboundTransport): Promise<number | null> {
  try {
    const payload = await getJson<MidpointReferenceResponse>(`${CLOB_API_BASE}/midpoint?token_id=${tokenId}`, signal, transport)
    return asNumber(payload.mid)
  } catch {
    return null
  }
}

async function hydrateSelectedMarkets(
  markets: DiscoveredCryptoWindowMarket[],
  signal: AbortSignal,
  transport: OutboundTransport
): Promise<DiscoveredCryptoWindowMarket[]> {
  return Promise.all(markets.map(async (entry) => {
    const yesTokenId = entry.market.yesTokenId
    const noTokenId = entry.market.noTokenId
    const [yesPrice, noPrice] = await Promise.all([
      yesTokenId ? fetchMidpointReference(yesTokenId, signal, transport) : Promise.resolve(null),
      noTokenId ? fetchMidpointReference(noTokenId, signal, transport) : Promise.resolve(null)
    ])

    return {
      ...entry,
      market: {
        ...entry.market,
        yesPrice,
        noPrice,
        priceSource: RUNTIME_MIDPOINT_REFERENCE_PRICE_SOURCE
      }
    }
  }))
}

export async function fetchCryptoWindowMarkets(options: FetchTopMarketsOptions): Promise<CryptoWindowMarketSnapshot> {
  const transport = options.transport ?? DIRECT_TRANSPORT
  const access = describePolymarketAccess({ operatorEligibility: options.operatorEligibility })
  const transportSummary = describePolymarketTransport({ transport })

  if (access.operatorEligibility === 'restricted') {
    throw new Error(access.note)
  }

  const { limit, timeoutMs = 8000, now } = options
  const signal = AbortSignal.timeout(timeoutMs)
  const fetchLimit = Math.min(1000, Math.max(limit * 80, 320))
  const url = `${GAMMA_API_BASE}/markets?active=true&closed=false&limit=${fetchLimit}&order=volume`
  const payload = await getJson<GammaMarketRecord[]>(url, signal, transport)
  const discovered = discoverCryptoWindowMarkets(payload, { limit, now })
  const selected = await hydrateSelectedMarkets(discovered.selected, signal, transport)
  const selectedById = new Map(selected.map((entry) => [entry.market.id, entry]))
  const fetchedAt = typeof now === 'string'
    ? new Date(now).toISOString()
    : now instanceof Date
      ? now.toISOString()
      : new Date().toISOString()

  return {
    fetchedAt,
    markets: selected.map((entry) => entry.market),
    transport: transportSummary,
    access,
    discovery: {
      ...discovered,
      generatedAt: fetchedAt,
      accepted: discovered.accepted.map((entry) => selectedById.get(entry.market.id) ?? entry),
      selected
    }
  }
}

export async function fetchTopMarkets(options: FetchTopMarketsOptions): Promise<MarketSnapshot> {
  const snapshot = await fetchCryptoWindowMarkets(options)
  return {
    fetchedAt: snapshot.fetchedAt,
    markets: snapshot.markets,
    transport: snapshot.transport,
    access: snapshot.access
  }
}

export {
  discoverCryptoWindowMarkets,
  type CryptoAsset,
  type CryptoPriceComparisonHook,
  type CryptoPriceFeedReference,
  type CryptoWindowDiscoveryRejectReason,
  type CryptoWindowDiscoveryRejectReasonCode,
  type CryptoWindowDiscoveryReport,
  type CryptoWindowInterval,
  type CryptoWindowOperationalState,
  type DiscoverCryptoWindowMarketsOptions,
  type DiscoveredCryptoWindowMarket,
  type GammaEventSummary,
  type GammaMarketRecord,
  type RejectedCryptoWindowMarket
}
