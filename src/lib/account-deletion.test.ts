import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, deleteMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  deleteMock: vi.fn(),
}))

vi.mock('./prisma.js', () => ({
  prisma: {
    user: {
      findMany: findManyMock,
      delete: deleteMock,
    },
  },
}))

import {
  DELETION_GRACE_DAYS,
  purgeAfterFrom,
  purgeExpiredAccounts,
} from './account-deletion.js'

describe('account-deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'u_1' } })
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'u_2' } })
    expect(purged).toEqual(['u_1', 'u_2'])
  })

  it('does nothing when no account is due', async () => {
    findManyMock.mockResolvedValue([])

    const purged = await purgeExpiredAccounts()

    expect(deleteMock).not.toHaveBeenCalled()
    expect(purged).toEqual([])
  })
})
