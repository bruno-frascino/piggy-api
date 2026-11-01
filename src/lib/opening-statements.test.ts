import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  unique: vi.fn(),
  latest: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  transaction: vi.fn(),
  preview: vi.fn(),
}))
vi.mock('./prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    tradingAccount: { findFirst: mocks.account },
    accountOpeningStatement: { findMany: mocks.list },
  },
}))
vi.mock('./accounting-preview-service.js', () => ({
  readAccountOpeningPreview: mocks.preview,
}))
vi.mock('./user-lock.js', () => ({ lockActiveUser: vi.fn() }))
import {
  listOpeningStatements,
  saveOpeningStatement,
} from './opening-statements.js'

const fingerprint = 'a'.repeat(64)
const input = {
  openingDate: '2026-10-01',
  cashBalances: [{ currency: 'AUD', amount: '1000' }],
}
const inputHash = createHash('sha256')
  .update(JSON.stringify(input))
  .digest('hex')
const preview = {
  ...input,
  accountId: 'a1',
  timezone: 'Australia/Sydney',
  boundary: 'END_OF_DAY',
  asOfDate: '2026-10-31',
  mode: 'PREVIEW_ONLY',
  sourceFingerprint: fingerprint,
  parcels: [
    {
      positionId: 'p1',
      symbol: 'ABC.AX',
      currency: 'AUD',
      openingQuantity: '10',
      expectedCurrentQuantity: '6',
      recordedCurrentQuantity: '6',
    },
  ],
  issues: [
    {
      code: 'FUNDING_GAP',
      severity: 'BLOCKING',
      message: 'Actual funding required',
      sourceId: 'b',
    },
  ],
  counts: { parcels: 1, postBoundaryTrades: 1, blockingIssues: 1 },
}
const row = {
  id: 's1',
  accountId: 'a1',
  version: 1,
  openingDate: new Date('2026-10-01'),
  timezone: 'Australia/Sydney',
  state: 'DRAFT',
  sourceFingerprint: fingerprint,
  inputHash,
  createdAt: new Date('2026-10-31T00:00:00Z'),
  cashBalances: [{ currency: 'AUD', amount: { toFixed: () => '1000' } }],
  _count: { parcels: 1 },
}
const db = {
  tradingAccount: { findFirst: mocks.account },
  accountOpeningStatement: {
    findUnique: mocks.unique,
    findFirst: mocks.latest,
    create: mocks.create,
  },
}
const request = { ...input, sourceFingerprint: fingerprint }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.transaction.mockImplementation(
    (callback: (value: typeof db) => unknown) => callback(db)
  )
  mocks.account.mockResolvedValue({ id: 'a1', isDemo: false, status: 'ACTIVE' })
  mocks.unique.mockResolvedValue(null)
  mocks.latest.mockResolvedValue(null)
  mocks.preview.mockResolvedValue(preview)
  mocks.create.mockResolvedValue(row)
  mocks.list.mockResolvedValue([])
})

describe('inactive opening statement revisions', () => {
  it('atomically saves exact cash, parcel snapshots and blockers without enabling accounting', async () => {
    const result = await saveOpeningStatement('u1', 'a1', request)
    expect(result.created).toBe(true)
    expect(result.statement).toMatchObject({
      state: 'DRAFT',
      version: 1,
      parcelCount: 1,
    })
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'Serializable',
      timeout: 15000,
    })
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      state: 'DRAFT',
      version: 1,
      sourceFingerprint: fingerprint,
      inputHash,
      cashBalances: { create: input.cashBalances },
      parcels: {
        create: [
          {
            positionId: 'p1',
            symbol: 'ABC.AX',
            currency: 'AUD',
            quantity: '10',
          },
        ],
      },
      previewSnapshot: { issues: preview.issues },
    })
  })
  it('returns the saved revision for retries, including on later calendar dates', async () => {
    mocks.unique.mockResolvedValue(row)
    const result = await saveOpeningStatement('u1', 'a1', {
      ...request,
      cashBalances: [{ currency: 'AUD', amount: '1000.00' }],
    })
    expect(result.created).toBe(false)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.preview).not.toHaveBeenCalled()
  })
  it('rejects mismatched inputs when reusing a saved fingerprint', async () => {
    mocks.unique.mockResolvedValue(row)
    await expect(
      saveOpeningStatement('u1', 'a1', {
        ...request,
        cashBalances: [{ currency: 'AUD', amount: '2000' }],
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rechecks the actual preview instead of trusting client-submitted inventory', async () => {
    mocks.preview.mockResolvedValue({
      ...preview,
      sourceFingerprint: 'b'.repeat(64),
    })
    await expect(
      saveOpeningStatement('u1', 'a1', request)
    ).rejects.toMatchObject({ status: 409 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each([
    {},
    { ...request, sourceFingerprint: 'bad' },
    { ...request, openingDate: '2026-02-30' },
  ])(
    'rejects invalid save input before reading/writing the database %#',
    async (raw) => {
      await expect(saveOpeningStatement('u1', 'a1', raw)).rejects.toMatchObject(
        { status: 400 }
      )
      expect(mocks.transaction).not.toHaveBeenCalled()
    }
  )
  it('does not expose or save another users statement', async () => {
    mocks.account.mockResolvedValue(null)
    await expect(
      saveOpeningStatement('u1', 'a1', request)
    ).rejects.toMatchObject({ status: 404 })
    expect(mocks.unique).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each([
    { isDemo: true, status: 'ACTIVE' },
    { isDemo: false, status: 'CLOSED' },
  ])('refuses save for an inactive or demo account %#', async (flags) => {
    mocks.account.mockResolvedValue({ id: 'a1', ...flags })
    await expect(
      saveOpeningStatement('u1', 'a1', request)
    ).rejects.toMatchObject({ status: 409 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each(['-1', '0.0000000000001', '100000000000000000000000000'])(
    'does not silently round or truncate opening inventory %s',
    async (quantity) => {
      mocks.preview.mockResolvedValue({
        ...preview,
        parcels: [{ ...preview.parcels[0], openingQuantity: quantity }],
      })
      await expect(
        saveOpeningStatement('u1', 'a1', request)
      ).rejects.toMatchObject({ status: 422 })
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )
  it('appends a new revision instead of updating earlier drafts', async () => {
    mocks.latest.mockResolvedValue({ version: 5 })
    mocks.create.mockResolvedValue({ ...row, version: 6 })
    expect(
      (await saveOpeningStatement('u1', 'a1', request)).statement.version
    ).toBe(6)
    expect(mocks.create.mock.calls[0][0].data.version).toBe(6)
  })
  it('retries serializable conflicts and then returns a deduplicated concurrent save', async () => {
    mocks.transaction.mockRejectedValueOnce({ code: 'P2034' })
    mocks.unique.mockResolvedValue(row)
    expect((await saveOpeningStatement('u1', 'a1', request)).created).toBe(
      false
    )
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
  })
  it('retries PostgreSQL adapter serialization failures raised at COMMIT', async () => {
    mocks.transaction.mockRejectedValueOnce(
      Object.assign(new Error('TransactionWriteConflict'), {
        name: 'DriverAdapterError',
        cause: { kind: 'TransactionWriteConflict', originalCode: '40001' },
      })
    )
    mocks.unique.mockResolvedValue(row)
    expect((await saveOpeningStatement('u1', 'a1', request)).created).toBe(
      false
    )
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
  })
  it.each([
    null,
    { kind: 'ConnectionClosed', originalCode: '08006' },
    { kind: 'TransactionWriteConflict', originalCode: 'other' },
  ])(
    'does not retry unrelated PostgreSQL adapter failures %#',
    async (cause) => {
      const error = Object.assign(new Error('Adapter failure'), {
        name: 'DriverAdapterError',
        cause,
      })
      mocks.transaction.mockRejectedValue(error)
      await expect(saveOpeningStatement('u1', 'a1', request)).rejects.toBe(
        error
      )
      expect(mocks.transaction).toHaveBeenCalledTimes(1)
    }
  )
  it('bounds concurrency retries and surfaces unrelated database failures', async () => {
    mocks.transaction.mockRejectedValue({ code: 'P2002' })
    await expect(
      saveOpeningStatement('u1', 'a1', request)
    ).rejects.toMatchObject({ status: 409 })
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
    mocks.transaction.mockReset().mockRejectedValue(new Error('Database down'))
    await expect(saveOpeningStatement('u1', 'a1', request)).rejects.toThrow(
      'Database down'
    )
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })
  it('pages saved revisions with account ownership filtering and decimal output', async () => {
    mocks.list.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({
        ...row,
        version: 30 - index,
      }))
    )
    const result = await listOpeningStatements('u1', 'a1', 31)
    expect(result.statements).toHaveLength(20)
    expect(result.nextBeforeVersion).toBe(11)
    expect(result.statements[0].cashBalances[0].amount).toBe('1000')
    expect(mocks.list.mock.calls[0][0].where).toEqual({
      accountId: 'a1',
      account: { userId: 'u1' },
      version: { lt: 31 },
    })
  })
  it('returns an explicit empty page, and rejects non-owned accounts before listing', async () => {
    expect(await listOpeningStatements('u1', 'a1')).toEqual({
      statements: [],
      nextBeforeVersion: null,
    })
    mocks.account.mockResolvedValue(null)
    mocks.list.mockClear()
    await expect(listOpeningStatements('u1', 'a1')).rejects.toMatchObject({
      status: 404,
    })
    expect(mocks.list).not.toHaveBeenCalled()
  })
  it('fails explicitly on unsupported stored state or timezone', async () => {
    mocks.unique.mockResolvedValue({ ...row, state: 'CONFIRMED' })
    await expect(saveOpeningStatement('u1', 'a1', request)).rejects.toThrow(
      'Unsupported opening statement'
    )
  })
})
