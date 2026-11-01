import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findManyMock,
  deleteMock,
  query,
  findUser,
  updateUser,
  revoke,
  revokeReset,
  createToken,
  transaction,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  deleteMock: vi.fn(),
  query: vi.fn(),
  findUser: vi.fn(),
  updateUser: vi.fn(),
  revoke: vi.fn(),
  revokeReset: vi.fn(),
  createToken: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('./prisma.js', () => ({
  prisma: {
    user: {
      findMany: findManyMock,
      deleteMany: deleteMock,
    },
    $transaction: transaction,
  },
}))

import {
  DELETION_GRACE_DAYS,
  purgeAfterFrom,
  purgeExpiredAccounts,
  scheduleUserDeletion,
  restoreDeletedUser,
  persistUserSession,
  rotateUserSession,
} from './account-deletion.js'

describe('account-deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteMock.mockResolvedValue({ count: 1 })
    query.mockResolvedValue([{ id: 'u1' }])
    findUser.mockResolvedValue({
      passwordHash: 'verified-hash',
      deletedAt: null,
    })
    transaction.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        $queryRaw: query,
        user: { findUnique: findUser, update: updateUser },
        refreshToken: { deleteMany: revoke, create: createToken },
        passwordResetToken: { deleteMany: revokeReset },
      })
    )
  })

  describe('transactional deletion/restoration', () => {
    beforeEach(() => {
      vi.resetAllMocks()
      query.mockResolvedValue([{ id: 'u1' }])
      transaction.mockImplementation((callback: (db: unknown) => unknown) =>
        callback({
          $queryRaw: query,
          user: { findUnique: findUser, update: updateUser },
          refreshToken: { deleteMany: revoke, create: createToken },
          passwordResetToken: { deleteMany: revokeReset },
        })
      )
    })
    it('rechecks password/state after an exclusive user lock and atomically revokes sessions', async () => {
      findUser.mockResolvedValue({
        passwordHash: 'verified-hash',
        deletedAt: null,
      })
      const date = new Date('2026-01-01')
      expect(await scheduleUserDeletion('u1', 'verified-hash', date)).toEqual({
        deletedAt: date,
        purgeAfter: new Date('2026-01-31'),
      })
      expect(query.mock.invocationCallOrder[0]).toBeLessThan(
        findUser.mock.invocationCallOrder[0]
      )
      expect(updateUser).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { deletedAt: date, purgeAfter: new Date('2026-01-31') },
      })
      expect(revoke).toHaveBeenCalledWith({ where: { userId: 'u1' } })
      expect(revokeReset).toHaveBeenCalledWith({ where: { userId: 'u1' } })
    })
    it.each([
      { user: null },
      { user: { passwordHash: 'changed', deletedAt: null } },
      {
        user: {
          passwordHash: 'verified-hash',
          deletedAt: new Date('2026-01-01'),
        },
      },
    ])('rejects stale deletion authentication/state %#', async ({ user }) => {
      findUser.mockResolvedValue(user)
      await expect(
        scheduleUserDeletion('u1', 'verified-hash')
      ).rejects.toMatchObject({ status: 401 })
      expect(updateUser).not.toHaveBeenCalled()
      expect(revoke).not.toHaveBeenCalled()
    })
    it('restores and creates a session inside one transaction', async () => {
      const deletedAt = new Date('2026-01-01')
      const expiresAt = new Date('2026-03-01')
      findUser.mockResolvedValue({ passwordHash: 'verified-hash', deletedAt })
      await restoreDeletedUser(
        'u1',
        'verified-hash',
        deletedAt,
        'fixture-token',
        expiresAt
      )
      expect(updateUser).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { deletedAt: null, purgeAfter: null },
      })
      expect(createToken).toHaveBeenCalledWith({
        data: { userId: 'u1', token: 'fixture-token', expiresAt },
      })
    })
    it.each([
      { user: null, status: 401 },
      {
        user: { passwordHash: 'changed', deletedAt: new Date('2026-01-01') },
        status: 401,
      },
      { user: { passwordHash: 'verified-hash', deletedAt: null }, status: 409 },
      {
        user: {
          passwordHash: 'verified-hash',
          deletedAt: new Date('2026-01-02'),
        },
        status: 409,
      },
    ])(
      'rejects stale restoration without issuing a session %#',
      async ({ user, status }) => {
        findUser.mockResolvedValue(user)
        await expect(
          restoreDeletedUser(
            'u1',
            'verified-hash',
            new Date('2026-01-01'),
            'token',
            new Date()
          )
        ).rejects.toMatchObject({ status })
        expect(updateUser).not.toHaveBeenCalled()
        expect(createToken).not.toHaveBeenCalled()
      }
    )
    it('propagates revocation and token persistence failures to abort the transaction', async () => {
      findUser.mockResolvedValue({
        passwordHash: 'verified-hash',
        deletedAt: null,
      })
      revoke.mockRejectedValue(new Error('Revocation failed'))
      await expect(scheduleUserDeletion('u1', 'verified-hash')).rejects.toThrow(
        'Revocation failed'
      )
      findUser.mockResolvedValue({
        passwordHash: 'verified-hash',
        deletedAt: new Date('2026-01-01'),
      })
      createToken.mockRejectedValue(new Error('Session failed'))
      await expect(
        restoreDeletedUser(
          'u1',
          'verified-hash',
          new Date('2026-01-01'),
          'token',
          new Date()
        )
      ).rejects.toThrow('Session failed')
    })

    it('persists login sessions only after rechecking active state and verified password', async () => {
      findUser.mockResolvedValue({ passwordHash: 'verified-hash' })
      const expiresAt = new Date('2030-01-01')
      await persistUserSession('u1', 'verified-hash', 'token', expiresAt)
      expect(createToken).toHaveBeenCalledWith({
        data: { userId: 'u1', token: 'token', expiresAt },
      })
      expect(query.mock.invocationCallOrder[0]).toBeLessThan(
        createToken.mock.invocationCallOrder[0]
      )
    })
    it.each([{ user: null }, { user: { passwordHash: 'changed' } }])(
      'rejects stale login authentication %#',
      async ({ user }) => {
        findUser.mockResolvedValue(user)
        await expect(
          persistUserSession('u1', 'verified-hash', 'token', new Date())
        ).rejects.toMatchObject({ status: 401 })
        expect(createToken).not.toHaveBeenCalled()
      }
    )
    it('rotates one owned unexpired token atomically', async () => {
      revoke.mockResolvedValue({ count: 1 })
      const expiresAt = new Date('2030-01-01')
      await rotateUserSession('u1', 'old', 'new', expiresAt)
      expect(revoke).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          token: 'old',
          expiresAt: { gt: expect.any(Date) },
        },
      })
      expect(createToken).toHaveBeenCalledWith({
        data: { userId: 'u1', token: 'new', expiresAt },
      })
    })
    it('rejects a token already rotated, expired or owned by another user', async () => {
      revoke.mockResolvedValue({ count: 0 })
      await expect(
        rotateUserSession('u1', 'old', 'new', new Date())
      ).rejects.toMatchObject({ status: 401 })
      expect(createToken).not.toHaveBeenCalled()
    })
  })

  it('places the purge date a full grace period after deletion', () => {
    const deletedAt = new Date('2026-09-01T00:00:00.000Z')

    expect(purgeAfterFrom(deletedAt).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z'
    )
    expect(DELETION_GRACE_DAYS).toBe(30)
  })

  it('deletes only accounts whose grace period has expired', async () => {
    const now = new Date('2026-10-02T00:00:00.000Z')
    findManyMock.mockResolvedValue([{ id: 'u_1' }, { id: 'u_2' }])

    const purged = await purgeExpiredAccounts(now)

    expect(findManyMock).toHaveBeenCalledWith({
      where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
      select: { id: true },
    })
    expect(deleteMock).toHaveBeenCalledWith({
      where: { id: 'u_1', deletedAt: { not: null }, purgeAfter: { lte: now } },
    })
    expect(deleteMock).toHaveBeenCalledWith({
      where: { id: 'u_2', deletedAt: { not: null }, purgeAfter: { lte: now } },
    })
    expect(purged).toEqual(['u_1', 'u_2'])
  })

  it('does nothing when no account is due', async () => {
    findManyMock.mockResolvedValue([])

    const purged = await purgeExpiredAccounts()

    expect(deleteMock).not.toHaveBeenCalled()
    expect(purged).toEqual([])
  })
  it('does not erase or report an account restored after the initial scan', async () => {
    findManyMock.mockResolvedValue([{ id: 'restored' }, { id: 'still-due' }])
    deleteMock
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
    expect(await purgeExpiredAccounts(new Date('2026-10-02'))).toEqual([
      'still-due',
    ])
  })
})
