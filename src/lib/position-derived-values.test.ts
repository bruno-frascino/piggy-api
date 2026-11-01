import { Decimal } from 'decimal.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  lock: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock('./prisma.js', () => ({ prisma: { $transaction: m.transaction } }))
vi.mock('./account-lock.js', () => ({ lockOwnedPosition: m.lock }))
import {
  savePositionHistory,
  savePositionStopLossHit,
} from './position-derived-values.js'

const source = {
  id: 'p1',
  userId: 'u1',
  accountId: 'a1',
  assetId: 'asset1',
  entryPrice: new Decimal(10),
  openDate: new Date('2026-01-01'),
  status: 'OPEN' as const,
  closeDate: null,
  positionType: 'LONG' as const,
  stopLossPrice: new Decimal(9),
  stopLossSetAt: new Date('2026-02-01'),
  stopLossHitAt: null,
  maxDrawdownPercent: null,
  maxRunUpPercent: null,
}

describe('derived position writes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.update.mockResolvedValue({ count: 1 })
    m.transaction.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ position: { updateMany: m.update } })
    )
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
        assetId: 'asset1',
        entryPrice: source.entryPrice,
        openDate: source.openDate,
        status: 'OPEN',
        closeDate: null,
        maxDrawdownPercent: null,
        maxRunUpPercent: null,
      },
      data,
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
        assetId: 'asset1',
        openDate: source.openDate,
        status: 'OPEN',
        positionType: 'LONG',
        stopLossPrice: source.stopLossPrice,
        stopLossSetAt: source.stopLossSetAt,
        stopLossHitAt: null,
      },
      data: { stopLossHitAt: hitAt },
    })
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
