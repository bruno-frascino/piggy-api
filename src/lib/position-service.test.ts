import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountingDecimal } from './accounting-values.js'
import { prepareAccountSplit } from './account-split-command.js'

const {
  exchangeFindUniqueMock,
  assetFindUniqueMock,
  assetUpdateMock,
  assetCreateMock,
  accountFindFirstMock,
  accountUpsertMock,
  positionFindUniqueMock,
  positionUpdateMock,
} = vi.hoisted(() => ({
  exchangeFindUniqueMock: vi.fn(),
  assetFindUniqueMock: vi.fn(),
  assetUpdateMock: vi.fn(),
  assetCreateMock: vi.fn(),
  accountFindFirstMock: vi.fn(),
  accountUpsertMock: vi.fn(),
  positionFindUniqueMock: vi.fn(),
  positionUpdateMock: vi.fn(),
}))

vi.mock('./prisma.js', () => ({
  prisma: {
    exchange: { findUnique: exchangeFindUniqueMock },
    asset: {
      findUnique: assetFindUniqueMock,
      update: assetUpdateMock,
      create: assetCreateMock,
    },
    tradingAccount: {
      findFirst: accountFindFirstMock,
      upsert: accountUpsertMock,
    },
    position: {
      findUnique: positionFindUniqueMock,
      update: positionUpdateMock,
    },
  },
}))

import {
  findOrCreateAsset,
  resolveTradingAccount,
  toDateOnly,
  recomputePositionFromTransactions,
} from './position-service.js'

describe('effective parcel recomputation after voids', () => {
  beforeEach(() => vi.clearAllMocks())
  it.each([
    {
      voidBuy: false,
      voidSell: true,
      quantity: 10,
      status: 'OPEN',
      realizedPnL: null,
    },
    {
      voidBuy: true,
      voidSell: true,
      quantity: 0,
      status: 'OPEN',
      realizedPnL: null,
    },
    {
      voidBuy: false,
      voidSell: false,
      quantity: 6,
      status: 'PARTIAL',
      realizedPnL: 18,
    },
  ])('excludes retained voided economic effects %j', async (row) => {
    positionFindUniqueMock.mockResolvedValue({
      id: 'p1',
      openDate: new Date('2026-01-01'),
      splitEffects: [],
      asset: { splitActions: [] },
      entryPrice: 10,
      buyFees: 0,
      transactions: [
        {
          type: 'BUY',
          quantity: 10,
          totalValue: 100,
          fees: 0,
          price: 10,
          date: new Date('2026-01-01'),
          voidedAt: row.voidBuy ? new Date() : null,
        },
        {
          type: 'SELL',
          quantity: 4,
          totalValue: 60,
          fees: 2,
          price: 15,
          date: new Date('2026-02-01'),
          voidedAt: row.voidSell ? new Date() : null,
        },
      ],
    })
    await recomputePositionFromTransactions('p1')
    expect(positionUpdateMock).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({
        quantity: row.quantity,
        status: row.status,
        realizedPnL: row.realizedPnL,
      }),
    })
  })
})

describe('split-aware parcel recomputation', () => {
  beforeEach(() => vi.clearAllMocks())
  it.each([
    { prior: 0, sold: 0, remaining: 20, status: 'OPEN', pnl: null },
    { prior: 2, sold: 0, remaining: 16, status: 'PARTIAL', pnl: 18 },
    { prior: 2, sold: 4, remaining: 12, status: 'PARTIAL', pnl: 56 },
    { prior: 2, sold: 16, remaining: 0, status: 'CLOSED', pnl: 170 },
  ])(
    'recomputes split-adjusted inventory and cost for $sold later units sold',
    async ({ prior, sold, remaining, status, pnl }) => {
      const request = {
        idempotencyKey: 'split-key',
        assetId: 'asset',
        effectiveDate: '2025-08-01',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: 'statement',
        statementConfirmed: true,
      }
      const action = {
        id: 'split',
        accountId: 'account',
        assetId: 'asset',
        effectiveDate: new Date(request.effectiveDate),
        newUnits: new AccountingDecimal('2'),
        oldUnits: new AccountingDecimal('1'),
        sourceReference: request.sourceReference,
        idempotencyKey: request.idempotencyKey,
        payloadHash: prepareAccountSplit(request, 'account').payloadHash,
        sourceFingerprint: 'source',
        methodology: 'account-split-v1',
        request,
      }
      const position = {
        id: 'parcel',
        accountId: 'account',
        assetId: 'asset',
        positionType: 'LONG',
        openDate: new Date('2024-01-01'),
        entryPrice: new AccountingDecimal('100'),
        buyFees: new AccountingDecimal('10'),
        asset: { splitActions: [action] },
        splitEffects: [
          {
            actionId: action.id,
            positionId: 'parcel',
            beforeQuantity: new AccountingDecimal(String(10 - prior)),
            afterQuantity: new AccountingDecimal(String((10 - prior) * 2)),
            action,
          },
        ],
        transactions: [
          {
            id: 'buy',
            type: 'BUY',
            date: new Date('2024-01-01'),
            quantity: 10,
            totalValue: 1000,
            fees: 10,
            price: 100,
          },
          ...(prior
            ? [
                {
                  id: 'prior',
                  type: 'SELL',
                  date: new Date('2025-07-01'),
                  quantity: prior,
                  totalValue: prior * 110,
                  fees: 0,
                  price: 110,
                },
              ]
            : []),
          ...(sold
            ? [
                {
                  id: 'later',
                  type: 'SELL',
                  date: new Date('2025-10-01'),
                  quantity: sold,
                  totalValue: sold * 60,
                  fees: 0,
                  price: 60,
                },
              ]
            : []),
          {
            id: 'voided',
            type: 'SELL',
            date: new Date('2025-11-01'),
            quantity: 100,
            totalValue: 6000,
            fees: 0,
            price: 60,
            voidedAt: new Date(),
          },
        ],
      }
      positionFindUniqueMock.mockResolvedValue(position)
      await recomputePositionFromTransactions('parcel')
      expect(positionUpdateMock).toHaveBeenCalledWith({
        where: { id: 'parcel' },
        data: expect.objectContaining({
          quantity: remaining,
          status,
          realizedPnL: pnl,
          closeDate: status === 'CLOSED' ? new Date('2025-10-01') : null,
        }),
      })
      expect(positionUpdateMock.mock.calls[0][0].data).not.toHaveProperty(
        'entryPrice'
      )
      expect(positionUpdateMock.mock.calls[0][0].data).not.toHaveProperty(
        'openDate'
      )
      positionUpdateMock.mockClear()
      positionFindUniqueMock.mockResolvedValue({
        ...position,
        splitEffects: [
          {
            ...position.splitEffects[0],
            afterQuantity: new AccountingDecimal('15'),
          },
        ],
      })
      await expect(recomputePositionFromTransactions('parcel')).rejects.toThrow(
        'Split parcel quantities do not match'
      )
      expect(positionUpdateMock).not.toHaveBeenCalled()
    }
  )
})

describe('findOrCreateAsset', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not silently reclassify a shared stock asset as crypto', async () => {
    exchangeFindUniqueMock.mockResolvedValue({ id: 'kraken', code: 'KRAKEN' })
    assetFindUniqueMock.mockResolvedValue({
      id: 'btc',
      symbol: 'BTC-AUD',
      assetType: 'EQUITY',
    })
    await expect(
      findOrCreateAsset('XBT-AUD', 'KRAKEN', 'Bitcoin', 'CRYPTO')
    ).rejects.toMatchObject({ status: 409 })
    expect(assetUpdateMock).not.toHaveBeenCalled()
    expect(assetCreateMock).not.toHaveBeenCalled()
  })

  it('throws a 404-flagged error when the exchange does not exist', async () => {
    exchangeFindUniqueMock.mockResolvedValue(null)

    await expect(findOrCreateAsset('aapl', 'nasdaq')).rejects.toMatchObject({
      message: "Exchange 'NASDAQ' not found",
      status: 404,
    })
  })

  it('returns the existing asset unchanged when industry matches', async () => {
    exchangeFindUniqueMock.mockResolvedValue({ id: 'ex_1', code: 'NASDAQ' })
    assetFindUniqueMock.mockResolvedValue({
      id: 'a_1',
      symbol: 'AAPL',
      industry: 'Technology',
    })

    const result = await findOrCreateAsset(
      'aapl',
      'nasdaq',
      undefined,
      undefined,
      'Technology'
    )

    expect(result).toEqual({
      id: 'a_1',
      symbol: 'AAPL',
      industry: 'Technology',
    })
    expect(assetUpdateMock).not.toHaveBeenCalled()
  })

  it('updates the industry when a different one is provided', async () => {
    exchangeFindUniqueMock.mockResolvedValue({ id: 'ex_1', code: 'NASDAQ' })
    assetFindUniqueMock.mockResolvedValue({
      id: 'a_1',
      symbol: 'AAPL',
      industry: 'Old',
    })
    assetUpdateMock.mockResolvedValue({
      id: 'a_1',
      symbol: 'AAPL',
      industry: 'New',
    })

    const result = await findOrCreateAsset(
      'aapl',
      'nasdaq',
      undefined,
      undefined,
      'New'
    )

    expect(assetUpdateMock).toHaveBeenCalledWith({
      where: { id: 'a_1' },
      data: { industry: 'New' },
    })
    expect(result.industry).toBe('New')
  })

  it('creates a new asset with defaults when none exists', async () => {
    exchangeFindUniqueMock.mockResolvedValue({ id: 'ex_1', code: 'NASDAQ' })
    assetFindUniqueMock.mockResolvedValue(null)
    assetCreateMock.mockResolvedValue({ id: 'a_new', symbol: 'AAPL' })

    await findOrCreateAsset('aapl', 'nasdaq')

    expect(assetCreateMock).toHaveBeenCalledWith({
      data: {
        symbol: 'AAPL',
        name: 'AAPL',
        assetType: 'EQUITY',
        industry: null,
        sector: null,
        marketCap: null,
        exchangeId: 'ex_1',
      },
    })
  })
})

describe('resolveTradingAccount', () => {
  it('rejects a missing explicit account instead of silently redirecting the trade to Main', async () => {
    accountFindFirstMock.mockResolvedValue(null)
    await expect(
      resolveTradingAccount('u_1', 'Main', 'deleted-account')
    ).rejects.toMatchObject({
      status: 404,
      message: 'Trading account not found',
    })
    expect(accountUpsertMock).not.toHaveBeenCalled()
  })
  beforeEach(() => vi.clearAllMocks())

  it('returns the account found by accountId', async () => {
    accountFindFirstMock.mockResolvedValue({ id: 'acc_1', name: 'Main' })

    const result = await resolveTradingAccount('u_1', undefined, 'acc_1')

    expect(result).toEqual({ id: 'acc_1', name: 'Main' })
    expect(accountUpsertMock).not.toHaveBeenCalled()
  })

  it('upserts by name (defaulting to "Main") when no accountId is supplied', async () => {
    accountFindFirstMock.mockResolvedValue(null)
    accountUpsertMock.mockResolvedValue({ id: 'acc_2', name: 'Main' })

    const result = await resolveTradingAccount('u_1')

    expect(accountUpsertMock).toHaveBeenCalledWith({
      where: { userId_name: { userId: 'u_1', name: 'Main' } },
      create: { userId: 'u_1', name: 'Main', isDemo: false },
      update: {},
    })
    expect(result).toEqual({ id: 'acc_2', name: 'Main' })
  })
})

describe('toDateOnly', () => {
  it('strips the time component', () => {
    const result = toDateOnly(new Date('2026-05-27T18:32:00.000Z'))
    expect(result.toISOString()).toBe('2026-05-27T00:00:00.000Z')
  })
})

describe('recomputePositionFromTransactions', () => {
  it.each([
    { sold: 0, expected: 'OPEN', remaining: 0.00000000001 },
    { sold: 0.000000000002, expected: 'PARTIAL', remaining: 0.000000000008 },
    { sold: 0.00000000001, expected: 'CLOSED', remaining: 0 },
  ])(
    'does not treat tiny remaining balances as fully sold: $expected',
    async ({ sold, expected, remaining }) => {
      positionFindUniqueMock.mockResolvedValue({
        id: 'tiny',
        openDate: new Date('2026-01-01'),
        splitEffects: [],
        asset: { splitActions: [] },
        entryPrice: 100000,
        buyFees: 0,
        transactions: [
          {
            type: 'BUY',
            quantity: 0.00000000001,
            totalValue: 0.000001,
            fees: 0,
            date: new Date('2026-01-01'),
          },
          ...(sold
            ? [
                {
                  type: 'SELL',
                  quantity: sold,
                  totalValue: sold * 100000,
                  fees: 0,
                  price: 100000,
                  date: new Date('2026-01-02'),
                },
              ]
            : []),
        ],
      })
      await recomputePositionFromTransactions('tiny')
      const data = positionUpdateMock.mock.calls[0][0].data
      expect(data.status).toBe(expected)
      expect(data.quantity).toBeCloseTo(remaining, 15)
    }
  )
  beforeEach(() => vi.clearAllMocks())

  it('returns null when the position does not exist', async () => {
    positionFindUniqueMock.mockResolvedValue(null)

    const result = await recomputePositionFromTransactions('missing')

    expect(result).toBeNull()
    expect(positionUpdateMock).not.toHaveBeenCalled()
  })

  it('keeps status OPEN when there are no sell transactions', async () => {
    positionFindUniqueMock.mockResolvedValue({
      id: 'p_1',
      entryPrice: 10,
      buyFees: 5,
      openDate: new Date('2026-01-01'),
      splitEffects: [],
      asset: { splitActions: [] },
      transactions: [
        {
          type: 'BUY',
          quantity: 10,
          price: 10,
          totalValue: 100,
          fees: 5,
          date: new Date('2026-01-01'),
        },
      ],
    })
    positionUpdateMock.mockResolvedValue({ id: 'p_1', status: 'OPEN' })

    await recomputePositionFromTransactions('p_1')

    expect(positionUpdateMock).toHaveBeenCalledWith({
      where: { id: 'p_1' },
      data: expect.objectContaining({
        status: 'OPEN',
        quantity: 10,
        realizedPnL: null,
      }),
    })
  })

  it('computes PARTIAL status and realized PnL for a partial close', async () => {
    positionFindUniqueMock.mockResolvedValue({
      id: 'p_1',
      entryPrice: 10,
      buyFees: 10,
      openDate: new Date('2026-01-01'),
      splitEffects: [],
      asset: { splitActions: [] },
      transactions: [
        {
          type: 'BUY',
          quantity: 10,
          price: 10,
          totalValue: 100,
          fees: 10,
          date: new Date('2026-01-01'),
        },
        {
          type: 'SELL',
          quantity: 4,
          price: 15,
          totalValue: 60,
          fees: 2,
          date: new Date('2026-02-01'),
        },
      ],
    })
    positionUpdateMock.mockResolvedValue({ id: 'p_1', status: 'PARTIAL' })

    await recomputePositionFromTransactions('p_1')

    // costBasisSold = 10 * 4 = 40, proratedBuyFees = 10 * (4/10) = 4
    // realizedPnL = 60 - 2 - 40 - 4 = 14
    expect(positionUpdateMock).toHaveBeenCalledWith({
      where: { id: 'p_1' },
      data: expect.objectContaining({
        status: 'PARTIAL',
        quantity: 6,
        realizedPnL: 14,
      }),
    })
  })

  it('computes CLOSED status and closeDate when fully sold', async () => {
    positionFindUniqueMock.mockResolvedValue({
      id: 'p_1',
      entryPrice: 10,
      buyFees: 0,
      openDate: new Date('2026-01-01'),
      splitEffects: [],
      asset: { splitActions: [] },
      transactions: [
        {
          type: 'BUY',
          quantity: 10,
          price: 10,
          totalValue: 100,
          fees: 0,
          date: new Date('2026-01-01'),
        },
        {
          type: 'SELL',
          quantity: 10,
          price: 12,
          totalValue: 120,
          fees: 0,
          date: new Date('2026-03-05T10:00:00.000Z'),
        },
      ],
    })
    positionUpdateMock.mockResolvedValue({ id: 'p_1', status: 'CLOSED' })

    await recomputePositionFromTransactions('p_1')

    const callArg = positionUpdateMock.mock.calls[0][0]
    expect(callArg.data.status).toBe('CLOSED')
    expect(callArg.data.quantity).toBe(0)
    expect(callArg.data.closeDate).toBeInstanceOf(Date)
    expect(callArg.data.closeDate.getUTCHours()).toBe(0)
  })
})
