import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockHistorical, mockFmpHistorical } = vi.hoisted(() => ({
  mockHistorical: vi.fn(),
  mockFmpHistorical: vi.fn(),
}))

// Mock yahoo-finance2 as a class whose instances have a `historical` method
vi.mock('yahoo-finance2', () => {
  return {
    default: class MockYahooFinance {
      historical = mockHistorical
    },
  }
})

vi.mock('./fmp-client.js', () => ({
  getHistoricalPrices: mockFmpHistorical,
}))

import {
  fetchHistoricalMaxDrawdown,
  fetchHistoricalMaxRunUp,
  fetchHistoricalStopLossHit,
  normalizeRawOhlcForSplits,
  splitAdjustedEntryPrice,
  splitRawOhlcProvider,
} from './historical-drawdown.js'

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.HISTORICAL_OHLC_BASIS
  delete process.env.HISTORICAL_OHLC_PROVIDER
  mockFmpHistorical.mockResolvedValue([])
})

const ENTRY = 3.24
const OPEN_DATE = new Date('2025-01-10')

describe('fetchHistoricalMaxDrawdown', () => {
  it('keeps raw-OHLC provider pinning unavailable until a source is verified', () => {
    process.env.HISTORICAL_OHLC_BASIS = 'raw-unadjusted'
    process.env.HISTORICAL_OHLC_PROVIDER = 'yahoo'
    expect(splitRawOhlcProvider()).toBeNull()
  })

  it('does not mix FMP OHLC into a pinned Yahoo split calculation', async () => {
    process.env.HISTORICAL_OHLC_BASIS = 'raw-unadjusted'
    process.env.HISTORICAL_OHLC_PROVIDER = 'yahoo'
    mockFmpHistorical.mockResolvedValue([
      { date: '2025-02-01', low: 80, high: 100 },
    ])
    mockHistorical.mockResolvedValue([
      { date: new Date('2025-02-01'), low: 40, high: 50 },
    ])

    await fetchHistoricalMaxDrawdown('AAPL', 100, new Date('2025-01-10'), [
      {
        effectiveDate: '2025-05-01',
        newUnits: '2',
        oldUnits: '1',
      },
    ])

    expect(mockFmpHistorical).not.toHaveBeenCalled()
  })

  it('requests Yahoo raw OHLC without adjusted close metadata', async () => {
    mockHistorical.mockResolvedValue([{ low: 3.1 }])

    await fetchHistoricalMaxDrawdown('LYC.AX', ENTRY, OPEN_DATE)

    expect(mockHistorical).toHaveBeenCalledWith(
      'LYC.AX',
      expect.objectContaining({
        interval: '1d',
        includeAdjustedClose: false,
      })
    )
  })

  it('normalizes raw bars exactly once for retained splits', () => {
    const bars = normalizeRawOhlcForSplits(
      [
        { date: '2025-02-01', low: 40, high: 50 },
        { date: '2025-06-01', low: 20, high: 25 },
      ],
      [
        {
          effectiveDate: '2025-05-01',
          newUnits: '2',
          oldUnits: '1',
        },
      ]
    )
    expect(bars).toEqual([
      { date: '2025-02-01', low: 20, high: 25 },
      { date: '2025-06-01', low: 20, high: 25 },
    ])
  })

  it('fails closed when a split-adjusted bar has no usable date', () => {
    expect(
      normalizeRawOhlcForSplits(
        [{ low: 40, high: 50 }],
        [
          {
            effectiveDate: '2025-05-01',
            newUnits: '2',
            oldUnits: '1',
          },
        ]
      )
    ).toBeNull()
  })

  it('uses the split-adjusted entry price as the drawdown base', () => {
    expect(
      splitAdjustedEntryPrice(100, new Date('2025-01-10'), [
        {
          effectiveDate: '2025-05-01',
          newUnits: '2',
          oldUnits: '1',
        },
      ])
    ).toBe(50)
  })

  it('still suppresses split metrics even if provider env flags are set', async () => {
    process.env.HISTORICAL_OHLC_BASIS = 'raw-unadjusted'
    process.env.HISTORICAL_OHLC_PROVIDER = 'yahoo'
    mockHistorical.mockResolvedValue([
      { date: new Date('2025-02-01'), low: 80 },
      { date: new Date('2025-06-01'), low: 40 },
    ])
    const result = await fetchHistoricalMaxDrawdown(
      'AAPL',
      100,
      new Date('2025-01-10'),
      [
        {
          effectiveDate: '2025-05-01',
          newUnits: '2',
          oldUnits: '1',
        },
      ]
    )
    expect(result).toBeNull()
  })

  it('suppresses split-adjusted metrics unless raw OHLC basis is declared', async () => {
    mockHistorical.mockResolvedValue([{ low: 25 }])
    const result = await fetchHistoricalMaxDrawdown(
      'AAPL',
      100,
      new Date('2025-01-10'),
      [
        {
          effectiveDate: '2025-06-01',
          newUnits: '2',
          oldUnits: '1',
        },
      ]
    )
    expect(result).toBeNull()
  })
  it('returns the correct drawdown when the lowest low is below entry price', async () => {
    mockHistorical.mockResolvedValue([
      { low: 3.1 },
      { low: 3.0 }, // worst — (~7.4% below entry)
      { low: 3.15 },
    ])

    const result = await fetchHistoricalMaxDrawdown('LYC.AX', ENTRY, OPEN_DATE)

    const expected = Math.abs(((3.0 - ENTRY) / ENTRY) * 100)
    expect(result).toBeCloseTo(expected, 4)
  })

  it('returns null when every low is above the entry price (no drawdown)', async () => {
    mockHistorical.mockResolvedValue([
      { low: 3.3 },
      { low: 3.5 },
      { low: 3.25 },
    ])

    const result = await fetchHistoricalMaxDrawdown('LYC.AX', ENTRY, OPEN_DATE)
    expect(result).toBeNull()
  })

  it('returns null when yahoo-finance2 throws', async () => {
    mockHistorical.mockRejectedValue(new Error('rate limited'))

    const result = await fetchHistoricalMaxDrawdown('LYC.AX', ENTRY, OPEN_DATE)
    expect(result).toBeNull()
  })

  it('returns null when history array is empty', async () => {
    mockHistorical.mockResolvedValue([])

    const result = await fetchHistoricalMaxDrawdown('LYC.AX', ENTRY, OPEN_DATE)
    expect(result).toBeNull()
  })

  it('returns null when openDate is today or future', async () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    const result = await fetchHistoricalMaxDrawdown('LYC.AX', ENTRY, tomorrow)
    expect(result).toBeNull()
  })

  it('ignores bars with non-numeric lows', async () => {
    mockHistorical.mockResolvedValue([
      { low: null },
      { low: undefined },
      { low: 3.5 }, // only valid bar — above entry, so no drawdown
    ])

    const result = await fetchHistoricalMaxDrawdown('LYC.AX', ENTRY, OPEN_DATE)
    expect(result).toBeNull()
  })
})

describe('fetchHistoricalMaxRunUp', () => {
  it('suppresses split-affected run-up without raw OHLC declaration', async () => {
    mockHistorical.mockResolvedValue([{ high: 150 }])

    const result = await fetchHistoricalMaxRunUp(
      'AAPL',
      100,
      new Date('2025-01-10'),
      undefined,
      [
        {
          effectiveDate: '2025-05-01',
          newUnits: '2',
          oldUnits: '1',
        },
      ]
    )

    expect(result).toBeNull()
  })

  it('returns the peak gain relative to entry from the highest high', async () => {
    mockHistorical.mockResolvedValue([
      { high: 3.4 },
      { high: 3.726 }, // peak — 15% above entry
      { high: 3.5 },
    ])

    const result = await fetchHistoricalMaxRunUp('LYC.AX', ENTRY, OPEN_DATE)
    expect(result).toBeCloseTo(15, 4)
  })

  it('returns null when price never traded above entry', async () => {
    mockHistorical.mockResolvedValue([{ high: 3.2 }, { high: 3.24 }])

    const result = await fetchHistoricalMaxRunUp('LYC.AX', ENTRY, OPEN_DATE)
    expect(result).toBeNull()
  })

  it('returns null when yahoo-finance2 throws', async () => {
    mockHistorical.mockRejectedValue(new Error('rate limited'))

    const result = await fetchHistoricalMaxRunUp('LYC.AX', ENTRY, OPEN_DATE)
    expect(result).toBeNull()
  })

  it('ignores bars with non-numeric highs', async () => {
    mockHistorical.mockResolvedValue([{ high: null }, { high: undefined }])

    const result = await fetchHistoricalMaxRunUp('LYC.AX', ENTRY, OPEN_DATE)
    expect(result).toBeNull()
  })

  it('restricts the scan window to the supplied end date', async () => {
    mockHistorical.mockResolvedValue([{ high: 4 }])
    const endDate = new Date('2025-02-01')

    await fetchHistoricalMaxRunUp('LYC.AX', ENTRY, OPEN_DATE, endDate)

    const opts = mockHistorical.mock.calls[0][1]
    expect(opts.period2.getFullYear()).toBe(2025)
    expect(opts.period2.getMonth()).toBeLessThanOrEqual(1)
  })

  it('returns null when open date is on/after the end date', async () => {
    const result = await fetchHistoricalMaxRunUp(
      'LYC.AX',
      ENTRY,
      new Date('2025-03-01'),
      new Date('2025-02-01')
    )
    expect(result).toBeNull()
    expect(mockHistorical).not.toHaveBeenCalled()
  })
})

describe('fetchHistoricalStopLossHit', () => {
  const SINCE = new Date('2025-01-10')

  it('returns the earliest bar date whose low reached the stop', async () => {
    mockHistorical.mockResolvedValue([
      { date: new Date('2025-02-05'), low: 2.9 },
      { date: new Date('2025-01-20'), low: 3.0 }, // earliest hit (low == stop)
      { date: new Date('2025-01-15'), low: 3.2 },
    ])

    const result = await fetchHistoricalStopLossHit('LYC.AX', 3.0, SINCE)
    expect(result).toEqual(new Date('2025-01-20'))
  })

  it('returns null when no low reached the stop', async () => {
    mockHistorical.mockResolvedValue([
      { date: new Date('2025-01-15'), low: 3.2 },
      { date: new Date('2025-01-16'), low: 3.01 },
    ])

    const result = await fetchHistoricalStopLossHit('LYC.AX', 3.0, SINCE)
    expect(result).toBeNull()
  })

  it('ignores bars with a missing low or date', async () => {
    mockHistorical.mockResolvedValue([
      { date: new Date('2025-01-15'), low: null },
      { low: 1 },
      { date: 'not-a-date', low: 1 },
    ])

    const result = await fetchHistoricalStopLossHit('LYC.AX', 3.0, SINCE)
    expect(result).toBeNull()
  })

  it('returns null when history is unavailable', async () => {
    mockHistorical.mockRejectedValue(new Error('rate limited'))

    const result = await fetchHistoricalStopLossHit('LYC.AX', 3.0, SINCE)
    expect(result).toBeNull()
  })
})
