import { describe, expect, it } from 'vitest'
import { AccountingDecimal } from './accounting-values.js'
import { prepareAccountSplit } from './account-split-command.js'
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

describe('mapTradeRows split-adjusted cost allocation', () => {
  const splitTrade = () => {
    const request = {
      idempotencyKey: 'split-key',
      assetId: 'asset1',
      effectiveDate: '2025-08-01',
      newUnits: '2',
      oldUnits: '1',
      sourceReference: 'statement-1',
      statementConfirmed: true,
    }
    const action = {
      id: 'split1',
      accountId: 'a1',
      assetId: 'asset1',
      effectiveDate: new Date(request.effectiveDate),
      newUnits: new AccountingDecimal(2),
      oldUnits: new AccountingDecimal(1),
      sourceReference: request.sourceReference,
      idempotencyKey: request.idempotencyKey,
      payloadHash: prepareAccountSplit(request, 'a1').payloadHash,
      sourceFingerprint: 'verified-fixture-source',
      methodology: 'account-split-v1',
      request,
      recordedAt: new Date('2025-08-02'),
      auditNumber: 1,
      previousFingerprint: 'a'.repeat(64),
      nextFingerprint: 'b'.repeat(64),
    }
    const effect = {
      id: 'effect1',
      actionId: action.id,
      positionId: 'p1',
      beforeQuantity: new AccountingDecimal(10),
      afterQuantity: new AccountingDecimal(20),
      action,
    }
    return {
      id: 'sell1',
      quantity: 4,
      price: 7,
      fees: 1,
      date: new Date('2025-09-01'),
      position: {
        id: 'p1',
        accountId: 'a1',
        assetId: 'asset1',
        openDate: new Date('2025-01-01'),
        entryPrice: 10,
        buyFees: 10,
        quantity: 12,
        transactions: [
          {
            id: 'buy1',
            type: 'BUY',
            date: new Date('2025-01-01'),
            quantity: 10,
            voidedAt: null,
          },
          {
            id: 'sell1',
            type: 'SELL',
            date: new Date('2025-09-01'),
            quantity: 4,
            voidedAt: null,
          },
          {
            id: 'sell2',
            type: 'SELL',
            date: new Date('2025-10-01'),
            quantity: 4,
            voidedAt: null,
          },
        ],
        splitEffects: [effect],
        asset: {
          symbol: 'AAA',
          splitActions: [action],
          exchange: { code: 'ASX', currency: 'AUD' },
        },
      },
    }
  }

  it('allocates each sale by its exact split-adjusted cost fraction', () => {
    const first = splitTrade()
    const second = {
      ...first,
      id: 'sell2',
      date: new Date('2025-10-01'),
    }
    const rows = mapTradeRows([first, second])
    // Both sales allocate 1/5 of the original $110 cost after the 2:1 split.
    expect(rows.map((row) => row.pnl)).toEqual([5, 5])
    expect(rows.map((row) => row.unitsClosed)).toEqual([4, 4])
  })

  it('rejects split history missing the parcel effect instead of using legacy cost', () => {
    const event = splitTrade()
    event.position.splitEffects = []
    expect(() => mapTradeRows([event])).toThrow(
      'Split action is missing its parcel effect'
    )
  })
})
