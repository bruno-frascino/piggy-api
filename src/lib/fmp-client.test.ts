import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadModule() {
  vi.resetModules()
  return import('./fmp-client.js')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.stubEnv('FMP_API_KEY', 'test-key')
})

describe('screenStocks', () => {
  it('throws FmpUnavailableError when FMP_API_KEY is not configured', async () => {
    vi.stubEnv('FMP_API_KEY', '')
    const { screenStocks, FmpUnavailableError } = await loadModule()

    await expect(screenStocks({})).rejects.toBeInstanceOf(FmpUnavailableError)
  })

  it('maps raw screener items to ScreenerResult and forwards criteria as query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            symbol: 'AAPL',
            companyName: 'Apple Inc.',
            marketCap: 4885602246714,
            sector: 'Technology',
            industry: 'Consumer Electronics',
            price: 332.64,
            lastAnnualDividend: 1.05,
            exchangeShortName: 'NASDAQ',
            country: 'US',
            isEtf: false,
          },
        ]),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { screenStocks } = await loadModule()

    const result = await screenStocks({
      marketCapMoreThan: 1_000_000_000,
      sector: 'Technology',
      limit: 10,
    })

    expect(result).toEqual([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        marketCap: 4885602246714,
        price: 332.64,
        lastAnnualDividend: 1.05,
        isEtf: false,
        country: 'US',
      },
    ])

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string)
    expect(calledUrl.pathname).toBe('/stable/company-screener')
    expect(calledUrl.searchParams.get('marketCapMoreThan')).toBe('1000000000')
    expect(calledUrl.searchParams.get('sector')).toBe('Technology')
    expect(calledUrl.searchParams.get('apikey')).toBe('test-key')
  })

  it('throws FmpUnavailableError on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    )
    const { screenStocks, FmpUnavailableError } = await loadModule()

    await expect(screenStocks({})).rejects.toBeInstanceOf(FmpUnavailableError)
  })

  it('throws FmpUnavailableError when the request throws (e.g. timeout)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network error'))
    )
    const { screenStocks, FmpUnavailableError } = await loadModule()

    await expect(screenStocks({})).rejects.toBeInstanceOf(FmpUnavailableError)
  })
})

describe('searchSymbol', () => {
  it('maps raw symbol search items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              symbol: 'AAPL',
              name: 'Apple Inc.',
              exchange: 'NASDAQ',
              currency: 'USD',
            },
          ]),
      })
    )
    const { searchSymbol } = await loadModule()

    const result = await searchSymbol('apple')

    expect(result).toEqual([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        currency: 'USD',
      },
    ])
  })
})

describe('getDividendsCalendar', () => {
  it('maps raw dividend calendar items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              symbol: 'AAPL',
              date: '2026-08-20',
              paymentDate: '2026-09-10',
              dividend: 0.26,
              yield: 0.5,
              frequency: 'Quarterly',
            },
          ]),
      })
    )
    const { getDividendsCalendar } = await loadModule()

    const result = await getDividendsCalendar('2026-08-01', '2026-09-01')

    expect(result).toEqual([
      {
        symbol: 'AAPL',
        exDate: '2026-08-20',
        paymentDate: '2026-09-10',
        dividend: 0.26,
        yield: 0.5,
        frequency: 'Quarterly',
      },
    ])
  })
})
