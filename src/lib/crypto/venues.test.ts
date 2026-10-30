import { describe, expect, it } from 'vitest'
import {
  exchangeCodeFor,
  isCryptoVenue,
  sameVenueExchangeCodes,
  venueOfExchangeCode,
} from './venues.js'

describe('crypto venues', () => {
  it('maps venue + quote to an exchange code', () => {
    expect(exchangeCodeFor('KRAKEN', 'AUD')).toBe('KRAKEN')
    expect(exchangeCodeFor('KRAKEN', 'usd')).toBe('KRAKEN_USD')
    expect(exchangeCodeFor('BINANCE', 'AUD')).toBe('BINANCE_AUD')
    expect(exchangeCodeFor('KRAKEN', 'EUR')).toBeNull()
  })

  it('resolves the venue of an exchange code', () => {
    expect(venueOfExchangeCode('KRAKEN_USD')).toBe('KRAKEN')
    expect(venueOfExchangeCode('coinbase_aud')).toBe('COINBASE')
    expect(venueOfExchangeCode('ASX')).toBeNull()
  })

  it('lists sibling exchange codes of a venue', () => {
    expect(sameVenueExchangeCodes('KRAKEN')).toEqual(['KRAKEN', 'KRAKEN_USD'])
    expect(sameVenueExchangeCodes('KRAKEN_USD')).toEqual([
      'KRAKEN',
      'KRAKEN_USD',
    ])
    expect(sameVenueExchangeCodes('NASDAQ')).toEqual([])
  })

  it('type-guards venue names', () => {
    expect(isCryptoVenue('KRAKEN')).toBe(true)
    expect(isCryptoVenue('NYSE')).toBe(false)
  })
})
