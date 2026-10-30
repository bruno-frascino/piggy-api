// Crypto venues are modelled as one Exchange row per quote currency so the
// "1 Exchange = 1 currency" assumption holds everywhere (see ADR 0014).
export const CRYPTO_VENUES = {
  KRAKEN: { AUD: 'KRAKEN', USD: 'KRAKEN_USD' },
  BINANCE: { USD: 'BINANCE', AUD: 'BINANCE_AUD' },
  COINBASE: { USD: 'COINBASE', AUD: 'COINBASE_AUD' },
} as const

export type CryptoVenue = keyof typeof CRYPTO_VENUES

const VENUE_NAMES = Object.keys(CRYPTO_VENUES) as CryptoVenue[]

export function isCryptoVenue(value: string): value is CryptoVenue {
  return (VENUE_NAMES as string[]).includes(value)
}

export function exchangeCodeFor(
  venue: CryptoVenue,
  quote: string
): string | null {
  const codes: Record<string, string> = CRYPTO_VENUES[venue]
  return codes[quote.trim().toUpperCase()] ?? null
}

export function venueOfExchangeCode(code: string): CryptoVenue | null {
  const normalized = code.trim().toUpperCase()
  for (const venue of VENUE_NAMES) {
    const codes: string[] = Object.values(CRYPTO_VENUES[venue])
    if (codes.includes(normalized)) return venue
  }
  return null
}

/** All exchange codes of the same venue, e.g. KRAKEN -> [KRAKEN, KRAKEN_USD]. */
export function sameVenueExchangeCodes(code: string): string[] {
  const venue = venueOfExchangeCode(code)
  return venue ? Object.values(CRYPTO_VENUES[venue]) : []
}
