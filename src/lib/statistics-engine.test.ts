import { describe, expect, it } from 'vitest'
import { mapTradeRows } from './statistics-engine.js'

const event = (overrides: {
  sellQty: number
  remainingQty: number
  boughtQty?: number
}) => ({
  id: 'tx1',
  quantity: overrides.sellQty,
  price: 9,
  fees: 0,
  date: '2026-02-01T00:00:00.000Z',
  position: {
    id: 'p1',
    openDate: '2026-01-01T00:00:00.000Z',
    entryPrice: 10,
    buyFees: 3,
    quantity: overrides.remainingQty,
    ...(overrides.boughtQty !== undefined
      ? { transactions: [{ quantity: overrides.boughtQty }] }
      : {}),
    accountId: 'a1',
    asset: { symbol: 'AAA', exchange: { code: 'ASX', currency: 'AUD' } },
  },
})

describe('mapTradeRows buy fee allocation', () => {
  it('includes the full buy fee on a fully closed position', () => {
    // Remaining quantity is 0 after a full close; the fee must still count.
    const [row] = mapTradeRows([
      event({ sellQty: 16, remainingQty: 0, boughtQty: 16 }),
    ])
    // proceeds 144 - cost (160 + 3) = -19
    expect(row.pnl).toBe(-19)
  })

  it('prorates the buy fee by total bought units on a partial close', () => {
    const [row] = mapTradeRows([
      event({ sellQty: 4, remainingQty: 12, boughtQty: 16 }),
    ])
    // proceeds 36 - cost (40 + 3 * 4/16) = -4.75
    expect(row.pnl).toBe(-4.75)
  })

  it('falls back to position.quantity when no BUY transactions are provided', () => {
    const [row] = mapTradeRows([event({ sellQty: 16, remainingQty: 16 })])
    expect(row.pnl).toBe(-19)
  })
})
