import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUniqueMock, upsertMock, mockHistorical } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  upsertMock: vi.fn(),
  mockHistorical: vi.fn(),
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    fxRateCache: {
      findUnique: findUniqueMock,
      upsert: upsertMock,
    },
  },
}))

vi.mock('yahoo-finance2', () => {
  return {
    default: class MockYahooFinance {
      historical = mockHistorical
    },
  }
})

const SAMPLE_CSV = [
  'F11.1  EXCHANGE RATES',
  'Title,A$1=USD,Trade-weighted Index May 1970 = 100,A$1=EUR',
  'Description,AUD/USD Exchange Rate,Australian Dollar Trade-weighted Index,AUD/EUR Exchange Rate',
  'Frequency,Daily,Daily,Daily',
  'Type,Indicative,Indicative,Indicative',
  'Units,USD,Index,EUR',
  '',
  'Source,WM/Reuters,RBA,RBA',
  'Publication date,24-Jul-2026,24-Jul-2026,24-Jul-2026',
  'Series ID,FXRUSD,FXRTWI,FXREUR',
  '03-Jan-2023,0.6828,61.40,0.6400',
  '04-Jan-2023,0.6809,61.50,0.6439',
].join('\n')

// `fx-rates.ts` caches the parsed RBA table in a module-level variable for an
// hour. Each test re-imports the module fresh (via resetModules) so that
// in-process cache never leaks between tests that need different fetch/Yahoo
// mock behaviour.
async function loadModule() {
  vi.resetModules()
  return import('./fx-rates.js')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_CSV),
    })
  )
})

describe('getHistoricalFxRateToAud', () => {
  it('returns rate 1 for AUD without touching cache or network', async () => {
    const { getHistoricalFxRateToAud } = await loadModule()

    const result = await getHistoricalFxRateToAud('AUD', new Date('2023-01-03'))
    expect(result).toEqual({ rate: 1, source: 'RBA' })
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns the cached rate when present, without re-fetching', async () => {
    const { getHistoricalFxRateToAud } = await loadModule()
    findUniqueMock.mockResolvedValue({
      rateToAud: 1.4646,
      source: 'RBA',
    })

    const result = await getHistoricalFxRateToAud('USD', new Date('2023-01-03'))

    expect(result).toEqual({ rate: 1.4646, source: 'RBA' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('parses the RBA CSV, inverts the rate, and caches the result on a cache miss', async () => {
    const { getHistoricalFxRateToAud } = await loadModule()
    findUniqueMock.mockResolvedValue(null)

    const result = await getHistoricalFxRateToAud('USD', new Date('2023-01-03'))

    expect(result.source).toBe('RBA')
    expect(result.rate).toBeCloseTo(1 / 0.6828, 6)
    expect(upsertMock).toHaveBeenCalledTimes(1)
    expect(upsertMock.mock.calls[0][0].create).toMatchObject({
      currency: 'USD',
      source: 'RBA',
    })
  })

  it('walks back to the nearest earlier published day when the exact date is missing', async () => {
    const { getHistoricalFxRateToAud } = await loadModule()
    findUniqueMock.mockResolvedValue(null)

    // 5th Jan has no row in the sample CSV — should fall back to 4th Jan.
    const result = await getHistoricalFxRateToAud('USD', new Date('2023-01-05'))

    expect(result.source).toBe('RBA')
    expect(result.rate).toBeCloseTo(1 / 0.6809, 6)
  })

  it('falls back to Yahoo Finance when RBA fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const { getHistoricalFxRateToAud } = await loadModule()
    findUniqueMock.mockResolvedValue(null)
    mockHistorical.mockResolvedValue([
      { date: new Date('2023-01-03'), close: 0.68 },
    ])

    const result = await getHistoricalFxRateToAud('USD', new Date('2023-01-03'))

    expect(result.source).toBe('YAHOO_FALLBACK')
    expect(result.rate).toBeCloseTo(1 / 0.68, 6)
    expect(upsertMock).toHaveBeenCalledTimes(1)
  })

  it('throws when neither RBA nor Yahoo can resolve a rate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const { getHistoricalFxRateToAud } = await loadModule()
    findUniqueMock.mockResolvedValue(null)
    mockHistorical.mockResolvedValue([])

    await expect(
      getHistoricalFxRateToAud('USD', new Date('2023-01-03'))
    ).rejects.toThrow(/Unable to resolve historical FX rate/)
  })
})
