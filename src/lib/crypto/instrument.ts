import { normalizeAssetCode, toCanonicalSymbol } from './symbols.js'
import { CRYPTO_VENUES, venueOfExchangeCode } from './venues.js'

export function normalizeInstrument(
  symbol: string,
  exchangeCode: string,
  assetType?: string
): { symbol: string; assetType: 'CRYPTO' | 'EQUITY' | 'ETF' } {
  const code = exchangeCode.trim().toUpperCase()
  const venue = venueOfExchangeCode(code)
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { status: 400 })
  }
  if (!venue) {
    if (/^[A-Z0-9]+-(AUD|USD)$/i.test(symbol.trim()))
      fail('Crypto symbols require a supported crypto venue')
    if (assetType === 'CRYPTO')
      fail('Choose a supported crypto venue for this position')
    if (assetType && assetType !== 'EQUITY' && assetType !== 'ETF')
      fail('Invalid asset type')
    return {
      symbol: symbol.trim().toUpperCase(),
      assetType: assetType === 'ETF' ? 'ETF' : 'EQUITY',
    }
  }
  if (assetType && assetType !== 'CRYPTO')
    fail('Crypto venues require a crypto asset')
  const [base, quote, extra] = symbol.trim().toUpperCase().split('-')
  const codes: Record<string, string> = CRYPTO_VENUES[venue]
  if (!base || !quote || extra !== undefined || codes[quote] !== code) {
    fail(
      'Crypto symbol must use BASE-QUOTE and match the venue currency (AUD or USD)'
    )
  }
  return {
    symbol: toCanonicalSymbol(normalizeAssetCode(venue, base), quote),
    assetType: 'CRYPTO',
  }
}
