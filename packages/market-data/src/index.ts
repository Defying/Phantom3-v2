import type { RuntimeMarket } from '../../contracts/src/index.js';
import { OutboundTransport } from '../../transport/src/index.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';
const USER_AGENT = 'Phantom3-v2/0.1';
const DIRECT_TRANSPORT = new OutboundTransport();

export type PolymarketOperatorEligibility = 'unknown' | 'confirmed-eligible' | 'restricted';

export type PolymarketTransportSummary = {
  route: 'direct' | 'proxy';
  scope: 'polymarket-only';
  note: string;
};

export type PolymarketAccessSummary = {
  operatorEligibility: PolymarketOperatorEligibility;
  readOnly: true;
  note: string;
};

type GammaEvent = {
  id: string | number;
  slug?: string | null;
  title?: string | null;
  volume24hr?: number | string | null;
  markets?: GammaMarket[] | null;
};

type GammaMarket = {
  id: string | number;
  slug?: string | null;
  question?: string | null;
  outcomes?: string | null | string[];
  clobTokenIds?: string | null | string[];
  spread?: number | string | null;
  liquidity?: number | string | null;
  liquidityClob?: number | string | null;
  volume24hr?: number | string | null;
  endDate?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  acceptingOrders?: boolean | null;
  enableOrderBook?: boolean | null;
};

type MidpointResponse = {
  mid?: string | number | null;
};

export type MarketSnapshot = {
  fetchedAt: string;
  markets: RuntimeMarket[];
  transport: PolymarketTransportSummary;
  access: PolymarketAccessSummary;
};

export type FetchTopMarketsOptions = {
  limit: number;
  timeoutMs?: number;
  transport?: OutboundTransport;
  operatorEligibility?: PolymarketOperatorEligibility;
};

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      return [];
    }
  }
  return [];
}

export function describePolymarketTransport(options: { transport?: OutboundTransport | null; proxyUrl?: string | null } = {}): PolymarketTransportSummary {
  const route = options.transport?.proxy || options.proxyUrl ? 'proxy' : 'direct';
  return {
    route,
    scope: 'polymarket-only',
    note: route === 'proxy'
      ? 'Scoped SOCKS transport is enabled only for Polymarket Gamma + CLOB reads. Dashboard, control, and local health traffic stay direct.'
      : 'Direct HTTPS transport is in use for Polymarket reads. Dashboard, control, and local health traffic remain off any venue proxy.'
  };
}

export function describePolymarketAccess(options: { operatorEligibility?: PolymarketOperatorEligibility } = {}): PolymarketAccessSummary {
  const operatorEligibility = options.operatorEligibility ?? 'unknown';
  switch (operatorEligibility) {
    case 'confirmed-eligible':
      return {
        operatorEligibility,
        readOnly: true,
        note: 'Operator marked Polymarket access as confirmed eligible. Runtime remains read-only and will not place live orders.'
      };
    case 'restricted':
      return {
        operatorEligibility,
        readOnly: true,
        note: 'Operator marked Polymarket access as restricted. Read-only market sync stays disabled instead of attempting bypass behavior.'
      };
    case 'unknown':
    default:
      return {
        operatorEligibility: 'unknown',
        readOnly: true,
        note: 'Operator eligibility is still unconfirmed. Runtime stays read-only and does not attempt geoblock bypass behavior.'
      };
  }
}

async function getJson<T>(url: string, signal: AbortSignal, transport: OutboundTransport): Promise<T> {
  return transport.getJson<T>(url, {
    signal,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json'
    }
  });
}

async function fetchMidpoint(tokenId: string, signal: AbortSignal, transport: OutboundTransport): Promise<number | null> {
  try {
    const payload = await getJson<MidpointResponse>(`${CLOB_API_BASE}/midpoint?token_id=${tokenId}`, signal, transport);
    return asNumber(payload.mid);
  } catch {
    return null;
  }
}

export async function fetchTopMarkets(options: FetchTopMarketsOptions): Promise<MarketSnapshot> {
  const transport = options.transport ?? DIRECT_TRANSPORT;
  const access = describePolymarketAccess({ operatorEligibility: options.operatorEligibility });
  const transportSummary = describePolymarketTransport({ transport });

  if (access.operatorEligibility === 'restricted') {
    throw new Error(access.note);
  }

  const { limit, timeoutMs = 8000 } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  const fetchLimit = Math.max(limit * 4, 24);
  const url = `${GAMMA_API_BASE}/events?active=true&closed=false&limit=${fetchLimit}&order=volume_24hr&ascending=false`;
  const events = await getJson<GammaEvent[]>(url, signal, transport);

  const selected: Array<{ event: GammaEvent; market: GammaMarket }> = [];
  const seen = new Set<string>();

  for (const event of events) {
    for (const market of event.markets ?? []) {
      const marketId = String(market.id);
      if (seen.has(marketId)) {
        continue;
      }
      const tradable = market.active !== false && market.closed !== true && market.enableOrderBook !== false && market.acceptingOrders !== false;
      const tokenIds = parseStringArray(market.clobTokenIds);
      if (!tradable || tokenIds.length < 2) {
        continue;
      }
      seen.add(marketId);
      selected.push({ event, market });
      if (selected.length >= limit) {
        break;
      }
    }
    if (selected.length >= limit) {
      break;
    }
  }

  const markets = await Promise.all(selected.map(async ({ event, market }) => {
    const tokenIds = parseStringArray(market.clobTokenIds);
    const outcomes = parseStringArray(market.outcomes);
    const [yesPrice, noPrice] = await Promise.all([
      fetchMidpoint(tokenIds[0], signal, transport),
      fetchMidpoint(tokenIds[1], signal, transport)
    ]);

    return {
      id: String(market.id),
      eventId: String(event.id),
      slug: market.slug ?? event.slug ?? String(market.id),
      eventTitle: event.title ?? market.question ?? 'Untitled event',
      question: market.question ?? event.title ?? 'Untitled market',
      yesLabel: outcomes[0] ?? 'Yes',
      noLabel: outcomes[1] ?? 'No',
      yesTokenId: tokenIds[0] ?? null,
      noTokenId: tokenIds[1] ?? null,
      yesPrice,
      noPrice,
      spread: asNumber(market.spread),
      volume24hr: asNumber(market.volume24hr) ?? asNumber(event.volume24hr),
      liquidity: asNumber(market.liquidityClob) ?? asNumber(market.liquidity),
      endDate: market.endDate ?? null,
      url: `https://polymarket.com/event/${event.slug ?? market.slug ?? ''}`
    } satisfies RuntimeMarket;
  }));

  return {
    fetchedAt: new Date().toISOString(),
    markets,
    transport: transportSummary,
    access
  };
}
