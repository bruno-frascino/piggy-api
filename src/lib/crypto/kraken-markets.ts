import { normalizeAssetCode, toCanonicalSymbol } from './symbols.js'

export class KrakenMarketsUnavailable extends Error {}

export interface KrakenMarket {
  base: string
  name: string
  quote: 'AUD' | 'USD'
  symbol: string
  exchangeCode: string
}

const COIN_NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
  XRP: 'XRP',
  LTC: 'Litecoin',
  DOT: 'Polkadot',
  AVAX: 'Avalanche',
  SHIB: 'Shiba Inu',
  BABY: 'Babylon',
  LINK: 'Chainlink',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let cache: { expiresAt: number; markets: KrakenMarket[] } | undefined
let pending: Promise<KrakenMarket[]> | undefined

async function fetchMarkets(): Promise<KrakenMarket[]> {
  try {
    const response = await fetch('https://api.kraken.com/0/public/AssetPairs', {
      signal: globalThis.AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`Kraken HTTP ${response.status}`)
    const data: unknown = await response.json()
    if (
      !isRecord(data) ||
      !Array.isArray(data.error) ||
      data.error.length > 0 ||
      !isRecord(data.result)
    ) {
      throw new Error('Invalid Kraken markets response')
    }
    const markets = new Map<string, KrakenMarket>()
    for (const pair of Object.values(data.result)) {
      if (
        !isRecord(pair) ||
        typeof pair.base !== 'string' ||
        typeof pair.quote !== 'string' ||
        pair.aclass_base !== 'currency'
      )
        continue
      const base = normalizeAssetCode('KRAKEN', pair.base)
      const quote = normalizeAssetCode('KRAKEN', pair.quote)
      if (quote !== 'AUD' && quote !== 'USD') continue
      const symbol = toCanonicalSymbol(base, quote)
      markets.set(symbol, {
        base,
        name: COIN_NAMES[base] ?? base,
        quote,
        symbol,
        exchangeCode: quote === 'AUD' ? 'KRAKEN' : 'KRAKEN_USD',
      })
    }
    if (!markets.size) throw new Error('Kraken returned no supported markets')
    return [...markets.values()].sort((a, b) => a.base.localeCompare(b.base))
  } catch (error) {
    throw new KrakenMarketsUnavailable(
      error instanceof Error ? error.message : 'Kraken market lookup failed'
    )
  }
}

export async function getKrakenMarkets(): Promise<KrakenMarket[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.markets
  if (!pending) {
    pending = fetchMarkets()
      .then((markets) => {
        cache = { expiresAt: Date.now() + 10 * 60_000, markets }
        return markets
      })
      .finally(() => {
        pending = undefined
      })
  }
  return pending
}

export async function searchKrakenMarkets(quote: 'AUD' | 'USD', query: string) {
  const search = query.trim().toUpperCase()
  const alias = normalizeAssetCode('KRAKEN', search)
  return (await getKrakenMarkets())
    .filter(
      (market) =>
        market.quote === quote &&
        (market.base.includes(alias) ||
          market.name.toUpperCase().includes(search))
    )
    .slice(0, 30)
}
