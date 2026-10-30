import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getQuotesMock,
  getHistoricalPricesMock,
  quoteMock,
  historicalMock,
  fxMock,
} = vi.hoisted(() => ({
  getQuotesMock: vi.fn(),
  getHistoricalPricesMock: vi.fn(),
  quoteMock: vi.fn(),
  historicalMock: vi.fn(),
  fxMock: vi.fn(),
}))

vi.mock('../fmp-client.js', () => ({
  getQuotes: getQuotesMock,
  getHistoricalPrices: getHistoricalPricesMock,
}))
vi.mock('../fx-rates.js', () => ({ getHistoricalFxRateToAud: fxMock }))
vi.mock('yahoo-finance2', () => ({
  default: class {
    quote = quoteMock
    historical = historicalMock
  },
}))

import { getCryptoDailyCloses, getCryptoQuote } from './pricing.js'

describe('getCryptoQuote', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getQuotesMock.mockResolvedValue([])
    quoteMock.mockRejectedValue(new Error('not found'))
    fxMock.mockResolvedValue({ rate: 1.5, source: 'RBA' })
  })

  it('returns the direct FMP price', async () => {
    getQuotesMock.mockResolvedValue([{ symbol: 'BTCAUD', price: 100000 }])
    expect(await getCryptoQuote('btc', 'aud')).toBe(100000)
    expect(getQuotesMock).toHaveBeenCalledWith(['BTCAUD'])
  })

  it('falls back to Yahoo when FMP has nothing', async () => {
    quoteMock.mockResolvedValue({ regularMarketPrice: 0.00002 })
    expect(await getCryptoQuote('SHIB', 'USD')).toBe(0.00002)
    expect(quoteMock).toHaveBeenCalledWith('SHIB-USD')
  })

  it('does not use a provider price explicitly denominated in another currency', async () => {
    getQuotesMock.mockResolvedValue([
      { symbol: 'BTCUSD', price: 60000, currency: 'AUD' },
    ])
    quoteMock.mockResolvedValue({ regularMarketPrice: 40000, currency: 'USD' })
    expect(await getCryptoQuote('BTC', 'USD')).toBe(40000)
  })

  it('converts the USD pair when the AUD pair is missing', async () => {
    quoteMock.mockImplementation(async (symbol: string) => {
      if (symbol === 'BABY-USD') return { regularMarketPrice: 2 }
      throw new Error('not found')
    })
    expect(await getCryptoQuote('BABY', 'AUD')).toBe(3)
  })

  it('returns null when nothing is available', async () => {
    expect(await getCryptoQuote('NOPE', 'AUD')).toBeNull()
  })
})

describe('getCryptoDailyCloses', () => {
  const from = new Date('2026-01-01T00:00:00Z')
  const to = new Date('2026-01-03T00:00:00Z')

  beforeEach(() => {
    vi.resetAllMocks()
    getHistoricalPricesMock.mockRejectedValue(new Error('fmp down'))
    historicalMock.mockResolvedValue([])
    fxMock.mockResolvedValue({ rate: 2, source: 'RBA' })
  })

  it('keys FMP closes by date', async () => {
    getHistoricalPricesMock.mockResolvedValue([
      { date: '2026-01-01', close: 10, high: 11, low: 9 },
      { date: '2026-01-02', close: null, high: null, low: null },
    ])
    const closes = await getCryptoDailyCloses('BTC', 'AUD', from, to)
    expect([...closes]).toEqual([['2026-01-01', 10]])
  })

  it('uses Yahoo history when FMP fails', async () => {
    historicalMock.mockResolvedValue([
      { date: new Date('2026-01-02T00:00:00Z'), close: 5 },
    ])
    const closes = await getCryptoDailyCloses('ETH', 'USD', from, to)
    expect(closes.get('2026-01-02')).toBe(5)
  })

  it('converts USD closes to AUD when the AUD pair has no history', async () => {
    historicalMock.mockImplementation(async (symbol: string) =>
      symbol === 'BABY-USD'
        ? [{ date: new Date('2026-01-01T00:00:00Z'), close: 4 }]
        : []
    )
    const closes = await getCryptoDailyCloses('BABY', 'AUD', from, to)
    expect(closes.get('2026-01-01')).toBe(8)
    expect(fxMock).toHaveBeenCalledWith('USD', new Date('2026-01-01T00:00:00Z'))
  })
})
