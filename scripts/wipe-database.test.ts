import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { wipeDatabase } from './wipe-database.js'

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $executeRaw: mocks.executeRaw,
    $disconnect: mocks.disconnect,
  },
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('DATABASE_URL', 'postgresql://user:secret@localhost:5432/piggy')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  mocks.executeRaw.mockResolvedValue(0)
  mocks.disconnect.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('wipeDatabase', () => {
  it('previews without connecting to the database or requiring DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', '')

    await wipeDatabase([])

    expect(mocks.executeRaw).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Preview only')
    )
  })

  it.each([['--force'], ['--confirm', '--force'], ['--confirm', '--confirm']])(
    'rejects invalid arguments: %j',
    async (...args) => {
      await expect(wipeDatabase(args)).rejects.toThrow('Usage:')
      expect(mocks.executeRaw).not.toHaveBeenCalled()
    }
  )

  it.each([
    '',
    'not-a-url',
    'mysql://localhost/piggy',
    'postgresql://localhost/',
  ])('refuses a missing or invalid target: %j', async (url) => {
    vi.stubEnv('DATABASE_URL', url)

    await expect(wipeDatabase(['--confirm'])).rejects.toThrow()
    expect(mocks.executeRaw).not.toHaveBeenCalled()
  })

  it('atomically truncates every modeled table except exchanges, without CASCADE', async () => {
    await wipeDatabase(['--confirm'])

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1)
    const sql = (
      mocks.executeRaw.mock.calls[0][0] as TemplateStringsArray
    ).join('')
    const tables = [...sql.matchAll(/public\."([^"]+)"/g)].map(
      (match) => match[1]
    )
    const schema = readFileSync(
      new URL('../prisma/schema.prisma', import.meta.url),
      'utf8'
    )
    const expectedTables = [...schema.matchAll(/@@map\("([^"]+)"\)/g)]
      .map((match) => match[1])
      .filter((table) => table !== 'exchanges')

    expect(tables.sort()).toEqual(expectedTables.sort())
    expect(sql).toMatch(/^\s*TRUNCATE TABLE/)
    expect(sql).toContain('RESTART IDENTITY RESTRICT')
    expect(sql).not.toContain('CASCADE')
    expect(sql).not.toContain('_prisma_migrations')
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledWith('Database: localhost:5432/piggy')
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain(
      'secret'
    )
  })

  it('disconnects and propagates database errors without reporting success', async () => {
    mocks.executeRaw.mockRejectedValue(
      new Error('Unexpected foreign key dependency')
    )

    await expect(wipeDatabase(['--confirm'])).rejects.toThrow(
      'Unexpected foreign key dependency'
    )

    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Database wiped.')
    )
  })
})
