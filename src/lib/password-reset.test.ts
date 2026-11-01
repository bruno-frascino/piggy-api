import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  query: vi.fn(),
  user: vi.fn(),
  update: vi.fn(),
  consume: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock('./prisma.js', () => ({
  prisma: { $transaction: m.transaction },
}))
import { completePasswordReset, issuePasswordReset } from './password-reset.js'

describe('password reset lifecycle coordination', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.query.mockResolvedValue([{ id: 'u1' }])
    m.user.mockResolvedValue({ deletedAt: null })
    m.consume.mockResolvedValue({ count: 1 })
    m.transaction.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        $queryRaw: m.query,
        user: { findUnique: m.user, update: m.update },
        passwordResetToken: { deleteMany: m.consume, create: m.create },
        refreshToken: { deleteMany: m.revoke },
      })
    )
  })

  it('issues a replacement only after locking and rechecking the active user', async () => {
    const expiresAt = new Date('2030-01-01')
    expect(await issuePasswordReset('u1', 'hash', expiresAt)).toBe(true)
    expect(m.query.mock.calls[0][0].join('?')).toContain('FOR UPDATE')
    expect(m.query.mock.invocationCallOrder[0]).toBeLessThan(
      m.consume.mock.invocationCallOrder[0]
    )
    expect(m.consume).toHaveBeenCalledWith({ where: { userId: 'u1' } })
    expect(m.create).toHaveBeenCalledWith({
      data: { userId: 'u1', token: 'hash', expiresAt },
    })
  })

  it.each([
    { rows: [], user: null },
    { rows: [{ id: 'u1' }], user: null },
    { rows: [{ id: 'u1' }], user: { deletedAt: new Date() } },
  ])(
    'does not issue tokens for missing/deleted users %#',
    async ({ rows, user }) => {
      m.query.mockResolvedValue(rows)
      m.user.mockResolvedValue(user)
      expect(await issuePasswordReset('u1', 'hash', new Date())).toBe(false)
      expect(m.consume).not.toHaveBeenCalled()
      expect(m.create).not.toHaveBeenCalled()
    }
  )

  it('consumes exactly one owned unexpired token and revokes all sessions/reset tokens atomically', async () => {
    await completePasswordReset('u1', 'hash', 'new-password-hash')
    expect(m.consume.mock.calls[0][0]).toEqual({
      where: {
        userId: 'u1',
        token: 'hash',
        expiresAt: { gt: expect.any(Date) },
      },
    })
    expect(m.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { passwordHash: 'new-password-hash' },
    })
    expect(m.consume.mock.calls[1][0]).toEqual({ where: { userId: 'u1' } })
    expect(m.revoke).toHaveBeenCalledWith({ where: { userId: 'u1' } })
    expect(m.query.mock.invocationCallOrder[0]).toBeLessThan(
      m.consume.mock.invocationCallOrder[0]
    )
    expect(m.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      timeout: 15000,
      maxWait: 5000,
    })
  })

  it.each([
    { rows: [], user: null, count: 1 },
    { rows: [{ id: 'u1' }], user: null, count: 1 },
    { rows: [{ id: 'u1' }], user: { deletedAt: new Date() }, count: 1 },
    { rows: [{ id: 'u1' }], user: { deletedAt: null }, count: 0 },
  ])(
    'rejects consumed/expired tokens and missing/deleted users %#',
    async ({ rows, user, count }) => {
      m.query.mockResolvedValue(rows)
      m.user.mockResolvedValue(user)
      m.consume.mockResolvedValue({ count })
      await expect(
        completePasswordReset('u1', 'hash', 'new')
      ).rejects.toMatchObject({
        status: 400,
        name: 'Bad Request',
        message: 'Invalid or expired reset token',
      })
      expect(m.update).not.toHaveBeenCalled()
      expect(m.revoke).not.toHaveBeenCalled()
    }
  )

  it('propagates token persistence and session revocation failures', async () => {
    const error = new Error('Database unavailable')
    m.create.mockRejectedValue(error)
    await expect(issuePasswordReset('u1', 'hash', new Date())).rejects.toBe(
      error
    )
    m.revoke.mockRejectedValue(error)
    await expect(completePasswordReset('u1', 'hash', 'new')).rejects.toBe(error)
  })
})
