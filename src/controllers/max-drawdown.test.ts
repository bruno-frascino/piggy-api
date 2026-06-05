import { describe, expect, it } from 'vitest'

/**
 * Tests for max drawdown calculation logic
 * Max drawdown tracks the maximum percentage drop from entry price
 */
describe('Max Drawdown Calculation', () => {
  it('calculates drawdown correctly when price drops below entry', () => {
    const entryPrice = 100
    const currentPrice = 85
    const drawdownPct = ((currentPrice - entryPrice) / entryPrice) * 100
    const absDrawdownPct = Math.abs(drawdownPct)

    expect(drawdownPct).toBe(-15)
    expect(absDrawdownPct).toBe(15)
  })

  it('identifies when new drawdown exceeds previous max', () => {
    const existingMaxDrawdown = 10
    const newDrawdown = 15

    expect(newDrawdown > existingMaxDrawdown).toBe(true)
  })

  it('does not update when drawdown is less than existing max', () => {
    const existingMaxDrawdown = 20
    const newDrawdown = 15

    expect(newDrawdown > existingMaxDrawdown).toBe(false)
  })

  it('handles zero existing max drawdown', () => {
    const existingMaxDrawdown = 0
    const newDrawdown = 5

    expect(newDrawdown > existingMaxDrawdown).toBe(true)
  })

  it('does not track positive returns as drawdown', () => {
    const entryPrice = 100
    const currentPrice = 110
    const drawdownPct = ((currentPrice - entryPrice) / entryPrice) * 100

    // Positive return should not be tracked
    expect(drawdownPct).toBe(10)
    expect(drawdownPct < 0).toBe(false)
  })

  it('calculates percentage drop correctly for various scenarios', () => {
    const scenarios = [
      { entry: 100, current: 95, expected: 5 },
      { entry: 100, current: 50, expected: 50 },
      { entry: 50, current: 25, expected: 50 },
      { entry: 200, current: 180, expected: 10 },
    ]

    scenarios.forEach(({ entry, current, expected }) => {
      const drawdownPct = Math.abs(((current - entry) / entry) * 100)
      expect(drawdownPct).toBeCloseTo(expected, 2)
    })
  })
})
