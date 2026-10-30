import { describe, expect, it } from 'vitest'
import { normalizeInstrument } from './instrument.js'

describe('crypto instrument identity', () => {
  it('infers crypto from the venue and normalizes Kraken aliases', () => {
    expect(normalizeInstrument('xbt-aud', 'KRAKEN')).toEqual({
      symbol: 'BTC-AUD',
      assetType: 'CRYPTO',
    })
    expect(normalizeInstrument('eth-usd', 'KRAKEN_USD', 'CRYPTO')).toEqual({
      symbol: 'ETH-USD',
      assetType: 'CRYPTO',
    })
  })
  it.each([
    ['BTC-AUD', 'ASX', 'CRYPTO'],
    ['BTC-AUD', 'ASX', undefined],
    ['BTC-USD', 'KRAKEN', 'CRYPTO'],
    ['BTC', 'KRAKEN', undefined],
    ['BTC-AUD', 'KRAKEN', 'EQUITY'],
  ])('rejects mismatched identity %s / %s / %s', (symbol, exchange, type) => {
    expect(() => normalizeInstrument(symbol, exchange, type)).toThrow()
  })
  it('keeps stocks and ETFs on the existing path', () => {
    expect(normalizeInstrument('aapl', 'NASDAQ')).toEqual({
      symbol: 'AAPL',
      assetType: 'EQUITY',
    })
    expect(normalizeInstrument('ivv.ax', 'ASX', 'ETF').assetType).toBe('ETF')
  })
})
