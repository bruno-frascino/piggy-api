import { describe, expect, it } from 'vitest'
import { computeSnapshotValues } from './portfolio-calc.js'

describe('computeSnapshotValues', () => {
  it('returns zeros when no positions exist', () => {
    const result = computeSnapshotValues([], [])
    expect(result).toEqual({
      totalInvested: 0,
      totalPnL: 0,
      totalValue: 0,
      totalReturnPct: 0,
    })
  })

  it('calculates totalValue from open position capital + unrealised PnL', () => {
    const result = computeSnapshotValues(
      [{ capitalAllocated: 1000, unrealizedPnL: 200 }],
      []
    )
    expect(result.totalInvested).toBe(1000)
    expect(result.totalValue).toBe(1200)
    expect(result.totalPnL).toBe(200)
    expect(result.totalReturnPct).toBeCloseTo(20)
  })

  it('includes realised PnL from closed positions in totalValue', () => {
    // This is the key behaviour: equity remains > 0 even when all positions
    // are closed, reflecting the cumulative wealth after profitable trades.
    const result = computeSnapshotValues(
      [],
      [{ realizedPnL: 500 }, { realizedPnL: 300 }]
    )
    expect(result.totalValue).toBe(800)
    expect(result.totalPnL).toBe(800)
    expect(result.totalInvested).toBe(0)
    // totalReturnPct is 0 when totalInvested is 0 (no open positions)
    expect(result.totalReturnPct).toBe(0)
  })

  it('combines open unrealised and closed realised PnL', () => {
    const result = computeSnapshotValues(
      [
        { capitalAllocated: 2000, unrealizedPnL: 100 },
        { capitalAllocated: 1000, unrealizedPnL: -50 },
      ],
      [{ realizedPnL: 400 }, { realizedPnL: -100 }]
    )
    // totalInvested = 2000 + 1000 = 3000
    expect(result.totalInvested).toBe(3000)
    // totalUnrealised = 100 - 50 = 50
    // totalRealised   = 400 - 100 = 300
    // totalPnL        = 50 + 300 = 350
    expect(result.totalPnL).toBe(350)
    // totalValue = 3000 + 50 + 300 = 3350
    expect(result.totalValue).toBe(3350)
    expect(result.totalReturnPct).toBeCloseTo((350 / 3000) * 100)
  })

  it('treats null unrealizedPnL and realizedPnL as zero', () => {
    const result = computeSnapshotValues(
      [{ capitalAllocated: 500, unrealizedPnL: null }],
      [{ realizedPnL: null }]
    )
    expect(result.totalValue).toBe(500)
    expect(result.totalPnL).toBe(0)
  })
})
