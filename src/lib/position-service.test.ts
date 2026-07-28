import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('findOrCreateAsset', () => {
  beforeEach(() => vi.clearAllMocks())

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
        exchangeId: 'ex_1',
      },
    })
  })
})

describe('resolveTradingAccount', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the account found by accountId', async () => {
    accountFindFirstMock.mockResolvedValue({ id: 'acc_1', name: 'Main' })

    const result = await resolveTradingAccount('u_1', undefined, 'acc_1')

    expect(result).toEqual({ id: 'acc_1', name: 'Main' })
    expect(accountUpsertMock).not.toHaveBeenCalled()
  })

  it('falls back to upsert by name (defaulting to "Main") when accountId is not found', async () => {
    accountFindFirstMock.mockResolvedValue(null)
    accountUpsertMock.mockResolvedValue({ id: 'acc_2', name: 'Main' })

    const result = await resolveTradingAccount('u_1')

    expect(accountUpsertMock).toHaveBeenCalledWith({
      where: { userId_name: { userId: 'u_1', name: 'Main' } },
      create: { userId: 'u_1', name: 'Main' },
      update: {},
    })
    expect(result).toEqual({ id: 'acc_2', name: 'Main' })
  })
})

describe('toDateOnly', () => {
  it('strips the time component', () => {
    const result = toDateOnly(new Date('2026-05-27T18:32:00.000Z'))
    expect(result.getHours()).toBe(0)
    expect(result.getMinutes()).toBe(0)
    expect(result.getSeconds()).toBe(0)
  })
})

describe('recomputePositionFromTransactions', () => {
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
    expect(callArg.data.closeDate.getHours()).toBe(0)
  })
})
