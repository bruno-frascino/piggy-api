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

import { fetchHistoricalMaxDrawdown } from './historical-drawdown.js'

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
