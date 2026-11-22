import { Decimal } from 'decimal.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  lock: vi.fn(),
  update: vi.fn(),
  split: vi.fn(),
  transaction: vi.fn(),
  ledger: vi.fn(),
}))
vi.mock('./prisma.js', () => ({
  prisma: {
    $transaction: m.transaction,
    accountSplitAction: { findFirst: m.split },
  },
}))
vi.mock('./account-lock.js', () => ({ lockOwnedPosition: m.lock }))
import {
  savePositionHistory,
  savePositionStopLossHit,
  requireSupportedStopLossHistory,
} from './position-derived-values.js'
import { prisma } from './prisma.js'

const source = {
  id: 'p1',
  userId: 'u1',
  accountId: 'a1',
  voidedAt: null,
  assetId: 'asset1',
  entryPrice: new Decimal(10),
  openDate: new Date('2026-01-01'),
  status: 'OPEN' as const,
  closeDate: null,
  positionType: 'LONG' as const,
  stopLossPrice: new Decimal(9),
  stopLossSetAt: new Date('2026-02-01'),
  stopLossReviewedAt: new Date('2026-02-02'),
  stopLossHitAt: null,
  maxDrawdownPercent: null,
  maxRunUpPercent: null,
  updatedAt: new Date('2026-02-02'),
}

describe('derived position writes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.update.mockResolvedValue({ count: 1 })
    m.split.mockResolvedValue(null)
    m.ledger.mockResolvedValue({ accountId: 'a1' })
    m.transaction.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        position: { updateMany: m.update },
        accountSplitAction: { findFirst: m.split },
        accountCashLedger: { findUnique: m.ledger },
      })
    )
  })
  it('leaves legacy position timestamps to Prisma when no cash ledger exists', async () => {
    m.ledger.mockResolvedValue(null)
    await savePositionHistory(source, { maxRunUpPercent: 20 })
    expect(m.update.mock.calls[0][0].where.updatedAt).toEqual(source.updatedAt)
    expect(m.update.mock.calls[0][0].data).toEqual({ maxRunUpPercent: 20 })
  })
  it('retains the source timestamp guard for legacy stop-loss writes', async () => {
    m.ledger.mockResolvedValue(null)
    const hitAt = new Date('2026-03-01')
    await savePositionStopLossHit(source, hitAt)
    expect(m.update.mock.calls[0][0].where.updatedAt).toEqual(source.updatedAt)
    expect(m.update.mock.calls[0][0].data).toEqual({ stopLossHitAt: hitAt })
  })
  it('locks the owned parcel and conditions history on the exact calculation inputs', async () => {
    const data = { maxDrawdownPercent: 12, maxRunUpPercent: null }
    await savePositionHistory(source, data)
    expect(m.lock).toHaveBeenCalledWith(expect.any(Object), 'u1', 'p1')
    expect(m.lock.mock.invocationCallOrder[0]).toBeLessThan(
      m.update.mock.invocationCallOrder[0]
    )
    expect(m.update).toHaveBeenCalledWith({
      where: {
        id: 'p1',
        userId: 'u1',
        accountId: 'a1',
        voidedAt: null,
        assetId: 'asset1',
        entryPrice: source.entryPrice,
        openDate: source.openDate,
        status: 'OPEN',
        closeDate: null,
        updatedAt: source.updatedAt,
        maxDrawdownPercent: null,
        maxRunUpPercent: null,
      },
      data: { ...data, updatedAt: source.updatedAt },
    })
  })
  it('conditions a stop flag on the original stop price, reset timestamp and holding state', async () => {
    const hitAt = new Date('2026-03-01')
    await savePositionStopLossHit(source, hitAt)
    expect(m.update).toHaveBeenCalledWith({
      where: {
        id: 'p1',
        userId: 'u1',
        accountId: 'a1',
        voidedAt: null,
        assetId: 'asset1',
        openDate: source.openDate,
        status: 'OPEN',
        positionType: 'LONG',
        stopLossPrice: source.stopLossPrice,
        stopLossSetAt: source.stopLossSetAt,
        stopLossHitAt: null,
        updatedAt: source.updatedAt,
      },
      data: { stopLossHitAt: hitAt, updatedAt: source.updatedAt },
    })
  })
  it('checks both account/asset split actions and retained parcel effects', async () => {
    await requireSupportedStopLossHistory(prisma, source)
    expect(m.split).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            OR: [
              {
                accountId: 'a1',
                assetId: 'asset1',
                effectiveDate: { gte: new Date('2026-01-01T00:00:00Z') },
              },
              { effects: { some: { positionId: 'p1' } } },
            ],
          },
          {
            OR: [
              { recordedAt: { gt: source.stopLossReviewedAt } },
              {
                reversal: {
                  is: { recordedAt: { gt: source.stopLossReviewedAt } },
                },
              },
              { effectiveDate: { gt: new Date('2026-02-02T00:00:00Z') } },
            ],
          },
        ],
      },
      select: { id: true },
    })
  })
  it('rejects a split recorded while a stop-loss check was in flight', async () => {
    m.split.mockResolvedValue({ id: 'split1' })
    await expect(
      savePositionStopLossHit(source, new Date('2026-03-01'))
    ).rejects.toMatchObject({ status: 409, name: 'Conflict' })
    expect(m.lock).toHaveBeenCalledOnce()
    expect(m.update).not.toHaveBeenCalled()
  })
  it('rejects price history if a split was recorded while the scan was in flight', async () => {
    m.split.mockResolvedValue({ id: 'split1' })
    await expect(
      savePositionHistory(source, { maxDrawdownPercent: 50 })
    ).rejects.toMatchObject({ status: 409, name: 'Conflict' })
    expect(m.lock).toHaveBeenCalledOnce()
    expect(m.update).not.toHaveBeenCalled()
  })
  it('guards only the target metric so independent background calculations can both save', async () => {
    await savePositionHistory(source, { maxDrawdownPercent: 12 })
    expect(m.update.mock.calls[0][0].where).toMatchObject({
      maxDrawdownPercent: null,
    })
    expect(m.update.mock.calls[0][0].where).not.toHaveProperty(
      'maxRunUpPercent'
    )
    await savePositionHistory(source, { maxRunUpPercent: 20 })
    expect(m.update.mock.calls[1][0].where).toMatchObject({
      maxRunUpPercent: null,
    })
    expect(m.update.mock.calls[1][0].where).not.toHaveProperty(
      'maxDrawdownPercent'
    )
  })
  it.each(['history', 'stop'] as const)(
    'rejects stale %s without success',
    async (kind) => {
      m.update.mockResolvedValue({ count: 0 })
      const work =
        kind === 'history'
          ? savePositionHistory(source, { maxRunUpPercent: 1 })
          : savePositionStopLossHit(source, new Date())
      await expect(work).rejects.toMatchObject({
        status: 409,
        name: 'Conflict',
      })
    }
  )
  it('does not write after deletion/ownership lock failures', async () => {
    const error = Object.assign(new Error('Deleted'), { status: 401 })
    m.lock.mockRejectedValue(error)
    await expect(
      savePositionHistory(source, { maxRunUpPercent: 1 })
    ).rejects.toBe(error)
    expect(m.update).not.toHaveBeenCalled()
  })
  it('propagates database failures', async () => {
    const error = new Error('Database unavailable')
    m.update.mockRejectedValue(error)
    await expect(savePositionStopLossHit(source, new Date())).rejects.toBe(
      error
    )
  })
})
