import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  lock: vi.fn(),
  account: vi.fn(),
  count: vi.fn(),
  reports: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock('./account-lock.js', () => ({ lockOwnedTradingAccount: m.lock }))
vi.mock('./prisma.js', () => ({ prisma: { $transaction: m.transaction } }))
import {
  closeTradingAccount,
  reopenTradingAccount,
  renameTradingAccount,
  deleteTradingAccount,
} from './trading-account-mutations.js'

const db = {
  tradingAccount: { findFirst: m.account, update: m.update, delete: m.remove },
  position: { count: m.count },
  taxReport: { findMany: m.reports },
}
beforeEach(() => {
  vi.resetAllMocks()
  m.transaction.mockImplementation(
    (callback: (tx: typeof db) => Promise<unknown>) => callback(db)
  )
  m.account.mockResolvedValue({
    id: 'a1',
    name: 'Main',
    status: 'ACTIVE',
    isDemo: false,
  })
  m.count.mockResolvedValue(0)
  m.reports.mockResolvedValue([])
  m.update.mockResolvedValue({ id: 'a1' })
})

describe('locked trading account lifecycle', () => {
  it.each([
    { operation: closeTradingAccount },
    { operation: reopenTradingAccount },
    { operation: deleteTradingAccount },
    {
      operation: (user: string, id: string) =>
        renameTradingAccount(user, id, 'Renamed'),
    },
  ])(
    'locks and rereads ownership for every lifecycle operation %#',
    async ({ operation }) => {
      m.account
        .mockResolvedValueOnce({
          id: 'a1',
          name: 'Main',
          status: 'ACTIVE',
          isDemo: false,
        })
        .mockResolvedValue(null)
      await operation('u1', 'a1')
      expect(m.lock).toHaveBeenCalledWith(db, 'u1', 'a1')
      expect(m.lock.mock.invocationCallOrder[0]).toBeLessThan(
        m.account.mock.invocationCallOrder[0]
      )
      expect(m.account.mock.calls[0][0].where).toEqual({
        id: 'a1',
        userId: 'u1',
      })
      expect(m.transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'ReadCommitted',
        timeout: 15000,
        maxWait: 5000,
      })
    }
  )

  it.each([
    { operation: closeTradingAccount },
    { operation: reopenTradingAccount },
    { operation: deleteTradingAccount },
    {
      operation: (user: string, id: string) =>
        renameTradingAccount(user, id, 'Renamed'),
    },
  ])('rejects a missing account after locking %#', async ({ operation }) => {
    m.account.mockResolvedValue(null)
    await expect(operation('u1', 'a1')).rejects.toMatchObject({
      status: 404,
      name: 'Not Found',
    })
    expect(m.update).not.toHaveBeenCalled()
    expect(m.remove).not.toHaveBeenCalled()
  })

  it('checks inventory even when an already-closed legacy account contains open parcels', async () => {
    m.account.mockResolvedValue({ id: 'a1', status: 'CLOSED' })
    m.count.mockResolvedValue(1)
    await expect(closeTradingAccount('u1', 'a1')).rejects.toMatchObject({
      status: 409,
    })
    expect(m.update).not.toHaveBeenCalled()
  })

  it('returns an already-closed empty account without changing its archival timestamp', async () => {
    const account = {
      id: 'a1',
      status: 'CLOSED',
      closedAt: new Date('2026-01-01'),
    }
    m.account.mockResolvedValue(account)
    expect(await closeTradingAccount('u1', 'a1')).toBe(account)
    expect(m.update).not.toHaveBeenCalled()
  })

  it('rolls a failing account delete through the transaction rather than claiming success', async () => {
    m.remove.mockRejectedValue(new Error('Injected delete failure'))
    await expect(deleteTradingAccount('u1', 'a1')).rejects.toThrow(
      'Injected delete'
    )
  })

  it('propagates lock failures without performing reads or writes', async () => {
    m.lock.mockRejectedValue(
      Object.assign(new Error('Not owned'), { status: 404 })
    )
    await expect(deleteTradingAccount('u1', 'a1')).rejects.toMatchObject({
      status: 404,
    })
    expect(m.account).not.toHaveBeenCalled()
  })
})
