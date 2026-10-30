import { describe, expect, it } from 'vitest'
import { normalizeAssetCode, parsePair, toCanonicalSymbol } from './symbols.js'

describe('normalizeAssetCode', () => {
  it.each([
    ['XXBT', 'BTC'],
    ['XBT', 'BTC'],
    ['XETH', 'ETH'],
    ['XXDG', 'DOGE'],
    ['ZAUD', 'AUD'],
    ['ZUSD', 'USD'],
    ['SOL.S', 'SOL'],
    ['DOT.P', 'DOT'],
    ['ETH2.S', 'ETH'],
    ['ETH2', 'ETH'],
    ['sol', 'SOL'],
  ])('normalises Kraken %s -> %s', (raw, expected) => {
    expect(normalizeAssetCode('KRAKEN', raw)).toBe(expected)
  })

  it('only uppercases for other venues', () => {
    expect(normalizeAssetCode('BINANCE', 'xbt')).toBe('XBT')
  })
})

describe('parsePair', () => {
  it.each([
    ['SOL/AUD', 'SOL', 'AUD'],
    ['XBT/USD', 'BTC', 'USD'],
    ['XXBTZAUD', 'BTC', 'AUD'],
    ['XBTAUD', 'BTC', 'AUD'],
    ['ETHAUD', 'ETH', 'AUD'],
    ['SOLUSD', 'SOL', 'USD'],
    ['BTCUSDT', 'BTC', 'USDT'],
    ['ETHBTC', 'ETH', 'BTC'],
  ])('parses %s', (raw, base, quote) => {
    expect(parsePair('KRAKEN', raw)).toEqual({ base, quote })
  })

  it('returns null for unparseable pairs', () => {
    expect(parsePair('KRAKEN', '')).toBeNull()
    expect(parsePair('KRAKEN', 'AUD')).toBeNull()
    expect(parsePair('KRAKEN', 'A/B/C')).toBeNull()
  })
})

describe('toCanonicalSymbol', () => {
  it('builds BASE-QUOTE', () => {
    expect(toCanonicalSymbol('btc', 'aud')).toBe('BTC-AUD')
  })
})
