import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({
  lock: vi.fn(),
  positions: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
  splitCost: vi.fn(),
}))
vi.mock('./prisma.js', () => ({ prisma: { $transaction: m.transaction } }))
vi.mock('./account-lock.js', () => ({ lockOwnedTradingAccount: m.lock }))
vi.mock('./stored-parcel-inventory.js', () => ({
  projectStoredParcelCostBasis: m.splitCost,
}))
import { savePortfolioSnapshot } from './portfolio-snapshot.js'
const db = {
  position: { findMany: m.positions },
  portfolioSnapshot: { upsert: m.upsert },
}
beforeEach(() => {
  vi.resetAllMocks()
  m.transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db)
  )
  m.splitCost.mockReturnValue(null)
})
it('uses the validated remaining cost for split-affected holdings', async () => {
  m.positions
    .mockResolvedValueOnce([
      { capitalAllocated: 110, unrealizedPnL: 5 },
      { capitalAllocated: 50, unrealizedPnL: null },
    ])
    .mockResolvedValueOnce([{ realizedPnL: 10 }])
  m.splitCost
    .mockReturnValueOnce({ remainingCostBasis: '55.000000000000' })
    .mockReturnValueOnce(null)
  m.upsert.mockResolvedValue({ id: 's1' })

  await savePortfolioSnapshot('u1', 'a1', 'e1')

  expect(m.positions.mock.calls[0][0]).toMatchObject({
    select: {
      transactions: {
        where: { type: { in: ['BUY', 'SELL'] }, voidedAt: null },
      },
      splitEffects: {
        include: { action: { include: { reversal: true } } },
      },
      asset: {
        select: {
          splitActions: {
            where: { accountId: 'a1' },
            include: { reversal: true },
          },
        },
      },
    },
  })
  expect(m.upsert.mock.calls[0][0]).toMatchObject({
    create: { totalInvested: 105, totalPnL: 15, totalValue: 120 },
    update: { totalInvested: 105, totalPnL: 15, totalValue: 120 },
  })
})
it('does not save a snapshot when split evidence is invalid', async () => {
  m.positions
    .mockResolvedValueOnce([{ capitalAllocated: 110, unrealizedPnL: 5 }])
    .mockResolvedValueOnce([])
  m.splitCost.mockImplementation(() => {
    throw new Error('Invalid split history')
  })

  await expect(savePortfolioSnapshot('u1', 'a1', 'e1')).rejects.toThrow(
    'Invalid split history'
  )
  expect(m.upsert).not.toHaveBeenCalled()
})
describe('locked legacy portfolio snapshots', () => {
  it('reads holdings and saves unchanged legacy totals under the account/user barrier', async () => {
    m.positions
      .mockResolvedValueOnce([
        { capitalAllocated: 102, unrealizedPnL: 18 },
        { capitalAllocated: 50, unrealizedPnL: null },
      ])
      .mockResolvedValueOnce([{ realizedPnL: 10 }, { realizedPnL: null }])
    m.upsert.mockResolvedValue({ id: 's1' })
    expect(await savePortfolioSnapshot('u1', 'a1', 'e1')).toEqual({ id: 's1' })
    expect(m.lock).toHaveBeenCalledWith(db, 'u1', 'a1')
    expect(m.lock.mock.invocationCallOrder[0]).toBeLessThan(
      m.positions.mock.invocationCallOrder[0]
    )
    expect(m.upsert.mock.calls[0][0]).toMatchObject({
      create: {
        userId: 'u1',
        accountId: 'a1',
        exchangeId: 'e1',
        totalInvested: 152,
        totalPnL: 28,
        totalValue: 180,
      },
      update: { totalInvested: 152, totalPnL: 28, totalValue: 180 },
    })
  })
  it('rejects a deleted account/user before any snapshot reads or writes', async () => {
    m.lock.mockRejectedValue(
      Object.assign(new Error('Session expired'), { status: 401 })
    )
    await expect(savePortfolioSnapshot('u1', 'a1', 'e1')).rejects.toMatchObject(
      { status: 401 }
    )
    expect(m.positions).not.toHaveBeenCalled()
    expect(m.upsert).not.toHaveBeenCalled()
  })
})
