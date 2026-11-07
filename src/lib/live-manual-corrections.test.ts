import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  account: vi.fn(),
  ledger: vi.fn(),
  write: vi.fn(),
  lock: vi.fn(),
}))
vi.mock('./account-lock.js', () => ({
  lockOwnedTradingAccount: mocks.lock,
  lockOwnedPosition: vi.fn(),
}))
vi.mock('./prisma.js', () => ({
  prisma: { $transaction: mocks.transaction },
}))
import {
  correctLiveManualAcquisition,
  voidLiveManualTrade,
  readLiveManualTradeVoids,
} from './draft-cash-ledger.js'

const input = {
  idempotencyKey: 'fix1',
  expectedRevisionId: 'op1',
  expectedSourceFingerprint: 'a'.repeat(64),
  reason: 'Correct purchase',
  effectiveDate: '2026-10-02',
  sequence: 1,
  quantity: '2',
  price: '12.345678901234',
  fees: '0.12345678',
}
const db = {
  tradingAccount: { findFirst: mocks.account },
  accountCashLedger: { findUnique: mocks.ledger },
  transaction: { update: mocks.write },
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.transaction.mockImplementation(
    (run: (client: typeof db) => Promise<unknown>) => run(db)
  )
  mocks.account.mockResolvedValue({ id: 'a1', status: 'ACTIVE', isDemo: false })
  mocks.ledger.mockResolvedValue(null)
})
describe('live manual acquisition correction boundary', () => {
  it('requires strict void input before database access', async () => {
    await expect(
      voidLiveManualTrade('u1', 'a1', 'tx1', input)
    ).rejects.toMatchObject({ status: 400 })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it.each([
    { id: 'a1', status: 'ACTIVE', isDemo: true },
    { id: 'a1', status: 'CLOSED', isDemo: false },
    { id: 'a1', status: 'ACTIVE', isDemo: false },
  ])(
    'does not enable accounts through voids or audit reads %j',
    async (account) => {
      mocks.account.mockResolvedValue(account)
      const {
        idempotencyKey,
        expectedRevisionId,
        expectedSourceFingerprint,
        reason,
      } = input
      await expect(
        voidLiveManualTrade('u1', 'a1', 'tx1', {
          idempotencyKey,
          expectedRevisionId,
          expectedSourceFingerprint,
          reason,
        })
      ).rejects.toMatchObject({ status: 409 })
      await expect(readLiveManualTradeVoids('u1', 'a1')).rejects.toMatchObject({
        status: 409,
      })
      expect(mocks.write).not.toHaveBeenCalled()
    }
  )
  it.each([
    { quantity: 2 },
    { quantity: '9007199254740992' },
    { quantity: '0' },
    { quantity: '2.0000000000001' },
    { price: '0' },
    { fees: '-1' },
    { quantity: '1.000000000001', sequence: 0 },
    { assetId: 'other-asset' },
  ])(
    'rejects invalid or identity-changing input %j before any database write',
    async (extra) => {
      await expect(
        correctLiveManualAcquisition('u1', 'a1', 'buy1', { ...input, ...extra })
      ).rejects.toMatchObject({ status: 400 })
      expect(mocks.transaction).not.toHaveBeenCalled()
    }
  )
  it.each([
    { id: 'a1', status: 'ACTIVE', isDemo: true },
    { id: 'a1', status: 'CLOSED', isDemo: false },
  ])(
    'does not provision or mutate unsupported accounts %j',
    async (account) => {
      mocks.account.mockResolvedValue(account)
      await expect(
        correctLiveManualAcquisition('u1', 'a1', 'buy1', input)
      ).rejects.toMatchObject({ status: 409 })
      expect(mocks.ledger).not.toHaveBeenCalled()
      expect(mocks.write).not.toHaveBeenCalled()
    }
  )
  it('checks ownership under the account lock and leaves legacy posting unchanged', async () => {
    await expect(
      correctLiveManualAcquisition('u1', 'a1', 'buy1', input)
    ).rejects.toMatchObject({
      status: 409,
      message: /legacy account has no active/i,
    })
    expect(mocks.lock).toHaveBeenCalledWith(db, 'u1', 'a1')
    expect(mocks.account).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a1', userId: 'u1', user: { deletedAt: null } },
      })
    )
    expect(mocks.write).not.toHaveBeenCalled()
    mocks.account.mockResolvedValue(null)
    await expect(
      correctLiveManualAcquisition('u2', 'a1', 'buy1', input)
    ).rejects.toMatchObject({ status: 404 })
  })
})
