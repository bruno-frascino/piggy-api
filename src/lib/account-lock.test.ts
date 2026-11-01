import { describe, expect, it, vi } from 'vitest'
import { lockOwnedPosition, lockOwnedTradingAccount } from './account-lock.js'

vi.mock('./prisma.js', () => ({ prisma: {} }))
vi.mock('./user-lock.js', () => ({ lockActiveUser: vi.fn() }))

describe('owned financial account/parcel locks', () => {
  it('locks move accounts in lexical order before the parcel, including moves to an earlier ID', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ accountId: 'z-source' }])
      .mockResolvedValueOnce([{ id: 'a-target' }])
      .mockResolvedValueOnce([{ id: 'z-source' }])
      .mockResolvedValueOnce([{ accountId: 'z-source' }])
    await lockOwnedPosition({ $queryRaw: query }, 'u1', 'p1', 'a-target')
    expect(query.mock.calls.map((args) => args.slice(1))).toEqual([
      ['p1', 'u1'],
      ['a-target', 'u1'],
      ['z-source', 'u1'],
      ['p1', 'u1'],
    ])
  })
  it('does not lock the same account twice when an edit retains its current account', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ accountId: 'a1' }])
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([{ accountId: 'a1' }])
    await lockOwnedPosition({ $queryRaw: query }, 'u1', 'p1', 'a1')
    expect(query).toHaveBeenCalledTimes(3)
  })
  it('locks the owned account with parameterized SQL, never interpolated identifiers', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 'a1' }])
    await lockOwnedTradingAccount({ $queryRaw: query }, 'u1', 'a1')
    expect(query.mock.calls[0].slice(1)).toEqual(['a1', 'u1'])
    expect(query.mock.calls[0][0].join('?')).toContain('FOR UPDATE')
  })
  it('refuses absent or foreign accounts', async () => {
    const query = vi.fn().mockResolvedValue([])
    await expect(
      lockOwnedTradingAccount({ $queryRaw: query }, 'u1', 'a1')
    ).rejects.toMatchObject({ status: 404 })
  })
  it('locks account then parcel and verifies the post-lock account identity', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ accountId: 'a1' }])
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([{ accountId: 'a1' }])
    await lockOwnedPosition({ $queryRaw: query }, 'u1', 'p1')
    expect(query.mock.calls.map((args) => args.slice(1))).toEqual([
      ['p1', 'u1'],
      ['a1', 'u1'],
      ['p1', 'u1'],
    ])
    expect(query.mock.calls[0][0].join('?')).not.toContain('FOR UPDATE')
    expect(query.mock.calls[1][0].join('?')).toContain('FOR UPDATE')
    expect(query.mock.calls[2][0].join('?')).toContain('FOR UPDATE')
  })
  it.each(
    [
      [[], [], []],
      [[{ accountId: 'a1' }], [], []],
      [[{ accountId: 'a1' }], [{ id: 'a1' }], []],
    ].map((rows) => ({ rows }))
  )(
    'rejects disappearing parcels/accounts at each lock stage %#',
    async ({ rows }) => {
      const query = vi
        .fn()
        .mockResolvedValueOnce(rows[0])
        .mockResolvedValueOnce(rows[1])
        .mockResolvedValueOnce(rows[2])
      await expect(
        lockOwnedPosition({ $queryRaw: query }, 'u1', 'p1')
      ).rejects.toMatchObject({ status: 404 })
    }
  )
  it('rejects a concurrent account move instead of writing under the wrong account lock', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ accountId: 'a1' }])
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([{ accountId: 'a2' }])
    await expect(
      lockOwnedPosition({ $queryRaw: query }, 'u1', 'p1')
    ).rejects.toMatchObject({ status: 409 })
  })
})
