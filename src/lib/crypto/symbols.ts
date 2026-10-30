import type { CryptoVenue } from './venues.js'

const KRAKEN_ASSET_ALIASES: Record<string, string> = {
  XXBT: 'BTC',
  XBT: 'BTC',
  XETH: 'ETH',
  ETH2: 'ETH',
  XXDG: 'DOGE',
  XDG: 'DOGE',
  XLTC: 'LTC',
  XXRP: 'XRP',
  XXLM: 'XLM',
  XETC: 'ETC',
  XZEC: 'ZEC',
  XXMR: 'XMR',
  ZAUD: 'AUD',
  ZUSD: 'USD',
  ZEUR: 'EUR',
  ZGBP: 'GBP',
  ZCAD: 'CAD',
  ZJPY: 'JPY',
}

const EARN_SUFFIX = /\.(S|M|P|F|B|HOLD)$/

// Longest first so e.g. "USDT" wins over "USD" and "ZAUD" over "AUD".
const KNOWN_QUOTES = [
  'ZAUD',
  'ZUSD',
  'ZEUR',
  'ZGBP',
  'ZCAD',
  'ZJPY',
  'USDT',
  'USDC',
  'XXBT',
  'XETH',
  'AUD',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'JPY',
  'XBT',
  'ETH',
  'BTC',
]

export function normalizeAssetCode(venue: CryptoVenue, raw: string): string {
  const upper = raw.trim().toUpperCase()
  if (venue !== 'KRAKEN') return upper

  const withoutSuffix = upper.replace(EARN_SUFFIX, '')
  return KRAKEN_ASSET_ALIASES[withoutSuffix] ?? withoutSuffix
}

export function parsePair(
  venue: CryptoVenue,
  raw: string
): { base: string; quote: string } | null {
  const upper = raw.trim().toUpperCase()
  if (!upper) return null

  const slash = upper.split('/')
  if (slash.length === 2 && slash[0] && slash[1]) {
    return {
      base: normalizeAssetCode(venue, slash[0]),
      quote: normalizeAssetCode(venue, slash[1]),
    }
  }
  if (slash.length > 2) return null

  for (const quote of KNOWN_QUOTES) {
    if (upper.length > quote.length && upper.endsWith(quote)) {
      const base = upper.slice(0, -quote.length)
      return {
        base: normalizeAssetCode(venue, base),
        quote: normalizeAssetCode(venue, quote),
      }
    }
  }
  return null
}

export function toCanonicalSymbol(base: string, quote: string): string {
  return `${base.trim().toUpperCase()}-${quote.trim().toUpperCase()}`
}
