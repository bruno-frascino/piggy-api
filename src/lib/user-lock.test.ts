import { describe, expect, it, vi } from 'vitest'
vi.mock('./prisma.js', () => ({ prisma: {} }))
import { lockActiveUser, lockUserLifecycle } from './user-lock.js'
import { lockOwnedTradingAccount } from './account-lock.js'

describe('user lifecycle barrier', () => {
  it('takes a parameterized shared user lock before the exclusive account lock', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', deletedAt: null }])
      .mockResolvedValueOnce([{ id: 'a1' }])
    await lockOwnedTradingAccount({ $queryRaw: query }, 'u1', 'a1')
    expect(query.mock.calls[0].slice(1)).toEqual(['u1'])
    expect(query.mock.calls[0][0].join('?')).toContain('FOR SHARE')
    expect(query.mock.calls[1].slice(1)).toEqual(['a1', 'u1'])
    expect(query.mock.calls[1][0].join('?')).toContain('FOR UPDATE')
  })
  it.each([
    { rows: [] },
    { rows: [{ id: 'u1', deletedAt: new Date('2026-01-01') }] },
  ])(
    'rejects a missing/deleted user without locking accounts %#',
    async ({ rows }) => {
      const query = vi.fn().mockResolvedValue(rows)
      await expect(
        lockOwnedTradingAccount({ $queryRaw: query }, 'u1', 'a1')
      ).rejects.toMatchObject({ status: 401, name: 'Unauthorized' })
      expect(query).toHaveBeenCalledTimes(1)
    }
  )
  it('locks deleted users exclusively for restore/deletion coordination', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 'u1' }])
    await lockUserLifecycle({ $queryRaw: query }, 'u1')
    expect(query.mock.calls[0].slice(1)).toEqual(['u1'])
    expect(query.mock.calls[0][0].join('?')).toContain('FOR UPDATE')
  })
  it('rejects a purged user from lifecycle operations', async () => {
    const query = vi.fn().mockResolvedValue([])
    await expect(
      lockUserLifecycle({ $queryRaw: query }, 'u1')
    ).rejects.toMatchObject({ status: 401 })
  })
  it('propagates database errors rather than allowing writes', async () => {
    const error = new Error('Database unavailable')
    const query = vi.fn().mockRejectedValue(error)
    await expect(lockActiveUser({ $queryRaw: query }, 'u1')).rejects.toBe(error)
  })
})
