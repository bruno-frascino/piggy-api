import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockHistorical = vi.fn()

// Mock yahoo-finance2 as a class whose instances have a `historical` method
vi.mock('yahoo-finance2', () => {
  return {
    default: class MockYahooFinance {
      historical = mockHistorical
    },
  }
})

import {
  fetchHistoricalMaxDrawdown,
  fetchHistoricalMaxRunUp,
} from './historical-drawdown.js'

beforeEach(() => {
  vi.clearAllMocks()
})

const ENTRY = 3.24
const OPEN_DATE = new Date('2025-01-10')

describe('fetchHistoricalMaxDrawdown', () => {
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
