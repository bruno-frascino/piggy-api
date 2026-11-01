import { Decimal } from 'decimal.js'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareCashCommand } from './cash-ledger.js'
import { prepareCashRevision, prepareRevisionLegs } from './cash-revisions.js'

const mocks = vi.hoisted(() => ({
  statement: vi.fn(),
  lock: vi.fn(),
  rows: vi.fn(),
  create: vi.fn(),
  transactions: vi.fn(),
  preview: vi.fn(),
  transaction: vi.fn(),
  linkCount: vi.fn(),
  postingCount: vi.fn(),
  revisionCount: vi.fn(),
  revisionPostingCount: vi.fn(),
  createRevision: vi.fn(),
}))
vi.mock('./prisma.js', () => ({ prisma: { $transaction: mocks.transaction } }))
vi.mock('./user-lock.js', () => ({ lockActiveUser: vi.fn() }))
vi.mock('./accounting-preview-service.js', () => ({
  readAccountOpeningPreview: mocks.preview,
}))
import {
  saveDraftCashOperation,
  correctDraftCashOperation,
} from './draft-cash-ledger.js'

const fingerprint = 'a'.repeat(64)
const deposit = {
  accountId: 'a1',
  kind: 'DEPOSIT',
  idempotencyKey: 'deposit-1',
  source: { origin: 'MANUAL', reference: 'bank-statement-1' },
  effectiveDate: '2026-10-02',
  sequence: 1,
  cash: { currency: 'AUD', amount: '100' },
}
const buy = {
  accountId: 'a1',
  kind: 'BUY',
  idempotencyKey: 'buy-1',
  source: { origin: 'MANUAL', reference: 'manual-buy' },
  effectiveDate: '2026-10-02',
  sequence: 2,
  consideration: { currency: 'AUD', amount: '60' },
  fees: [{ currency: 'AUD', amount: '1' }],
  transactionIds: ['t1'],
}
const statement = {
  id: 's1',
  accountId: 'a1',
  state: 'DRAFT',
  timezone: 'Australia/Sydney',
  openingDate: new Date('2026-10-01T00:00:00Z'),
  cashBalances: [{ currency: 'AUD', amount: new Decimal('100') }],
  account: { id: 'a1', status: 'ACTIVE', isDemo: false },
  sourceFingerprint: fingerprint,
  inputHash: createHash('sha256')
    .update(
      JSON.stringify({
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '100' }],
      })
    )
    .digest('hex'),
  previewSnapshot: { asOfDate: '2026-10-31' },
}
const trade = {
  id: 't1',
  type: 'BUY',
  date: new Date('2026-10-02T00:00:00Z'),
  totalValue: new Decimal('60'),
  fees: new Decimal('1'),
  quantity: 1,
  position: {
    origin: 'MANUAL',
    positionType: 'LONG',
    asset: { exchange: { currency: 'AUD' } },
  },
}
function stored(raw: unknown = deposit) {
  const prepared = prepareCashCommand(raw)
  const command = prepared.command
  return {
    id: 'op1',
    statementId: 's1',
    state: 'DRAFT',
    methodology: prepared.methodology,
    command,
    payloadHash: prepared.payloadHash,
    idempotencyKey: command.idempotencyKey,
    kind: command.kind,
    sourceOrigin: command.source.origin,
    sourceReference: command.source.reference,
    effectiveDate: new Date(`${command.effectiveDate}T00:00:00Z`),
    sequence: BigInt(command.sequence),
    postings: prepared.legs.map((leg, legIndex) => ({
      ...leg,
      legIndex,
      amount: new Decimal(leg.amount),
    })),
    tradeLinks: [],
    revisions: [],
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.statement.mockResolvedValue(statement)
  mocks.lock.mockResolvedValue([{ id: 'a1' }])
  mocks.rows.mockResolvedValue([])
  mocks.linkCount.mockResolvedValue(0)
  mocks.postingCount.mockResolvedValue(0)
  mocks.revisionCount.mockResolvedValue(0)
  mocks.revisionPostingCount.mockResolvedValue(0)
  mocks.createRevision.mockResolvedValue({ id: 'rev1' })
  mocks.preview.mockResolvedValue({ sourceFingerprint: fingerprint })
  mocks.transactions.mockResolvedValue([trade])
  mocks.create.mockResolvedValue({ id: 'op-new' })
  mocks.transaction.mockImplementation(
    async (callback: (db: unknown) => Promise<unknown>) =>
      callback({
        accountOpeningStatement: { findFirst: mocks.statement },
        draftCashOperation: { findMany: mocks.rows, create: mocks.create },
        draftOperationTradeLink: { count: mocks.linkCount },
        draftCashPosting: { count: mocks.postingCount },
        draftCashRevision: {
          count: mocks.revisionCount,
          create: mocks.createRevision,
        },
        draftCashRevisionPosting: { count: mocks.revisionPostingCount },
        transaction: { findMany: mocks.transactions },
        $queryRaw: mocks.lock,
      })
  )
})

describe('persistent inactive cash staging', () => {
  it('rejects opening-cash tampering instead of replaying against unreviewed capital', async () => {
    mocks.statement.mockResolvedValue({
      ...statement,
      cashBalances: [{ currency: 'AUD', amount: new Decimal('1000') }],
    })
    await expect(saveDraftCashOperation('u1', 's1', deposit)).rejects.toThrow(
      'reviewed input identity'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('locks the owned account, rereads after the lock and atomically stores normalized command/postings', async () => {
    const result = await saveDraftCashOperation('u1', 's1', deposit)
    expect(result).toMatchObject({
      operationId: 'op-new',
      state: 'DRAFT',
      created: true,
    })
    expect(result.replay.balances[0]).toMatchObject({
      endingAmount: '200',
      netExternalContribution: '100',
    })
    expect(mocks.statement).toHaveBeenCalledTimes(2)
    expect(mocks.statement.mock.calls[0][0].where).toEqual({
      id: 's1',
      account: { userId: 'u1', user: { deletedAt: null } },
    })
    expect(mocks.lock.mock.calls[0].slice(1)).toEqual(['a1', 'u1'])
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'ReadCommitted',
      timeout: 15000,
      maxWait: 5000,
    })
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      statementId: 's1',
      state: 'DRAFT',
      sequence: 1n,
      postings: {
        create: [
          {
            currency: 'AUD',
            amount: '100',
            role: 'EXTERNAL_CAPITAL',
            legIndex: 0,
          },
        ],
      },
      tradeLinks: { create: [] },
    })
    expect(mocks.preview.mock.calls[0][4]).toEqual(
      new Date('2026-10-31T01:00:00Z')
    )
  })
  it('stores a checked manual trade reference and separate gross/fee postings without modifying the trade', async () => {
    const result = await saveDraftCashOperation('u1', 's1', buy)
    expect(result.replay.balances[0].endingAmount).toBe('39')
    expect(mocks.transactions.mock.calls[0][0].where).toEqual({
      id: { in: ['t1'] },
      position: { accountId: 'a1', userId: 'u1' },
    })
    expect(mocks.create.mock.calls[0][0].data.tradeLinks).toEqual({
      create: [{ transactionId: 't1' }],
    })
    expect(mocks.create.mock.calls[0][0].data.postings.create).toHaveLength(2)
  })
  it('reuses an identical saved command even after its source preview changes, without posting again', async () => {
    mocks.rows.mockResolvedValue([stored()])
    mocks.preview.mockResolvedValue({ sourceFingerprint: 'b'.repeat(64) })
    const result = await saveDraftCashOperation('u1', 's1', {
      ...deposit,
      cash: { currency: 'AUD', amount: '100.00' },
    })
    expect(result).toMatchObject({
      operationId: 'op1',
      created: false,
      state: 'DRAFT',
    })
    expect(result.replay.balances[0].endingAmount).toBe('200')
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rejects different contents under the same idempotency key', async () => {
    mocks.rows.mockResolvedValue([stored()])
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...deposit,
        cash: { currency: 'AUD', amount: '101' },
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('reuses a manual trade snapshot only when retained transaction links still match', async () => {
    const row = { ...stored(buy), tradeLinks: [{ transactionId: 't1' }] }
    mocks.rows.mockResolvedValue([row])
    expect((await saveDraftCashOperation('u1', 's1', buy)).created).toBe(false)
    expect(mocks.transactions).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('refuses a stored imported cash command even when its metadata and hash match', async () => {
    mocks.rows.mockResolvedValue([
      stored({
        ...deposit,
        source: { origin: 'IMPORT', reference: 'import-1' },
      }),
    ])
    await expect(saveDraftCashOperation('u1', 's1', deposit)).rejects.toThrow(
      'inconsistent'
    )
  })
  it('rejects stale opening source data before append', async () => {
    mocks.preview.mockResolvedValue({ sourceFingerprint: 'b'.repeat(64) })
    await expect(saveDraftCashOperation('u1', 's1', deposit)).rejects.toThrow(
      'source records have changed'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each([
    null,
    { ...statement, state: 'CONFIRMED' },
    { ...statement, timezone: 'UTC' },
  ])(
    'does not permit unknown, confirmed or incompatible opening statements %#',
    async (row) => {
      mocks.statement.mockResolvedValue(row)
      await expect(
        saveDraftCashOperation('u1', 's1', deposit)
      ).rejects.toThrow()
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )
  it('handles an account disappearing before the row lock', async () => {
    mocks.lock.mockResolvedValue([])
    await expect(
      saveDraftCashOperation('u1', 's1', deposit)
    ).rejects.toMatchObject({ status: 404 })
  })
  it.each([
    { ...statement.account, status: 'CLOSED' },
    { ...statement.account, isDemo: true },
  ])('refuses closed/demo account cash writes %#', async (account) => {
    mocks.statement.mockResolvedValue({ ...statement, account })
    await expect(saveDraftCashOperation('u1', 's1', deposit)).rejects.toThrow(
      'active real'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rejects cross-account commands and imported execution cash before posting', async () => {
    await expect(
      saveDraftCashOperation('u1', 's1', { ...deposit, accountId: 'other' })
    ).rejects.toThrow('does not match')
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...deposit,
        source: { origin: 'IMPORT', reference: 'import' },
      })
    ).rejects.toThrow('not enabled')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each([null, {}, { asOfDate: '2026-02-30' }])(
    'refuses malformed stored preview metadata %#',
    async (previewSnapshot) => {
      mocks.statement.mockResolvedValue({ ...statement, previewSnapshot })
      await expect(saveDraftCashOperation('u1', 's1', deposit)).rejects.toThrow(
        'source snapshot date'
      )
    }
  )
  it('rejects insufficient historical funding and never creates balancing deposits', async () => {
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...deposit,
        kind: 'WITHDRAWAL',
        cash: { currency: 'AUD', amount: '101' },
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each([
    { ...trade, type: 'SELL' },
    { ...trade, date: new Date('2026-10-03T00:00:00Z') },
    { ...trade, totalValue: new Decimal('59') },
    { ...trade, fees: new Decimal('2') },
    { ...trade, quantity: -1 },
    { ...trade, quantity: Number.NaN },
    { ...trade, position: { ...trade.position, origin: 'IMPORT_TRADE' } },
    { ...trade, position: { ...trade.position, positionType: 'SHORT' } },
    {
      ...trade,
      position: { ...trade.position, asset: { exchange: { currency: 'USD' } } },
    },
  ])(
    'rejects trade source/date/currency/gross/fee mismatches %#',
    async (transaction) => {
      mocks.transactions.mockResolvedValue([transaction])
      await expect(
        saveDraftCashOperation('u1', 's1', buy)
      ).rejects.toMatchObject({ status: 409 })
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )
  it('rejects missing or foreign trade IDs and unsupported foreign cash fees', async () => {
    mocks.transactions.mockResolvedValue([])
    await expect(saveDraftCashOperation('u1', 's1', buy)).rejects.toThrow(
      'Every cash trade link'
    )
    mocks.transactions.mockResolvedValue([trade])
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...buy,
        fees: [{ currency: 'USD', amount: '1' }],
      })
    ).rejects.toThrow('foreign fee currencies')
  })
  it.each([
    { ...stored(), state: 'CONFIRMED' },
    { ...stored(), methodology: 'unknown' },
    { ...stored(), payloadHash: 'invalid' },
    { ...stored(), idempotencyKey: 'other' },
    { ...stored(), kind: 'WITHDRAWAL' },
    { ...stored(), sourceOrigin: 'IMPORT' },
    { ...stored(), sourceReference: 'other' },
    { ...stored(), effectiveDate: new Date('2026-10-03T00:00:00Z') },
    { ...stored(), sequence: 2n },
    { ...stored(), tradeLinks: [{ transactionId: 'foreign-tx' }] },
    { ...stored(), postings: [] },
    {
      ...stored(),
      postings: [{ ...stored().postings[0], amount: new Decimal('99') }],
    },
  ])(
    'refuses inconsistent persisted operation and posting history %#',
    async (row) => {
      mocks.rows.mockResolvedValue([row])
      await expect(saveDraftCashOperation('u1', 's1', deposit)).rejects.toThrow(
        'inconsistent'
      )
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )
  it('refuses a corrupt stored command account even with a valid recomputed hash', async () => {
    mocks.rows.mockResolvedValue([stored({ ...deposit, accountId: 'other' })])
    await expect(saveDraftCashOperation('u1', 's1', deposit)).rejects.toThrow(
      'inconsistent'
    )
  })
  it('bounds history loading before returning any partial balances', async () => {
    mocks.linkCount.mockResolvedValue(50001)
    await expect(
      saveDraftCashOperation('u1', 's1', deposit)
    ).rejects.toMatchObject({ status: 422 })
    expect(mocks.rows).not.toHaveBeenCalled()
    mocks.linkCount.mockResolvedValue(0)
    mocks.postingCount.mockResolvedValue(100001)
    await expect(
      saveDraftCashOperation('u1', 's1', deposit)
    ).rejects.toMatchObject({ status: 422 })
    mocks.postingCount.mockResolvedValue(0)
    mocks.rows.mockResolvedValue(Array(50001).fill(stored()))
    await expect(
      saveDraftCashOperation('u1', 's1', deposit)
    ).rejects.toMatchObject({ status: 422 })
  })
  it('propagates transaction/database failures without success-shaped fallback', async () => {
    mocks.create.mockRejectedValue(new Error('Database unavailable'))
    await expect(saveDraftCashOperation('u1', 's1', deposit)).rejects.toThrow(
      'Database unavailable'
    )
  })
})

const correction = {
  idempotencyKey: 'correction-1',
  expectedRevisionId: 'op1',
  reason: 'Correct statement amount',
  replacement: {
    ...deposit,
    idempotencyKey: 'correction-1',
    cash: { currency: 'AUD', amount: '60' },
  },
}

function storedRevision(raw: unknown = correction, previous = deposit) {
  const prepared = prepareCashRevision(raw)
  return {
    id: 'rev1',
    operationId: 'op1',
    statementId: 's1',
    revisionNumber: 1,
    previousRevisionId: null,
    request: prepared.request,
    idempotencyKey: prepared.request.idempotencyKey,
    payloadHash: prepared.payloadHash,
    reason: prepared.request.reason,
    postings: prepareRevisionLegs(
      prepareCashCommand(previous).command,
      prepared.request.replacement
    ).map((leg, legIndex) => ({
      ...leg,
      legIndex,
      amount: new Decimal(leg.amount),
    })),
  }
}

describe('immutable inactive cash corrections', () => {
  beforeEach(() => mocks.rows.mockResolvedValue([stored()]))

  it('appends reversal and replacement with a reason and an expected head; never updates the original', async () => {
    const result = await correctDraftCashOperation(
      'u1',
      's1',
      'op1',
      correction
    )
    expect(result).toMatchObject({
      operationId: 'op1',
      revisionId: 'rev1',
      state: 'DRAFT',
      created: true,
    })
    expect(result.replay.balances[0]).toMatchObject({
      endingAmount: '160',
      netExternalContribution: '60',
    })
    const data = mocks.createRevision.mock.calls[0][0].data
    expect(data).toMatchObject({
      operationId: 'op1',
      statementId: 's1',
      revisionNumber: 1,
      previousRevisionId: null,
      reason: correction.reason,
    })
    expect(data.postings.create).toEqual([
      {
        phase: 'REVERSAL',
        currency: 'AUD',
        role: 'EXTERNAL_CAPITAL',
        amount: '-100',
        legIndex: 0,
      },
      {
        phase: 'REPLACEMENT',
        currency: 'AUD',
        role: 'EXTERNAL_CAPITAL',
        amount: '60',
        legIndex: 1,
      },
    ])
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('reuses an identical old retry even after a later correction, without appending or checking stale source', async () => {
    mocks.rows.mockResolvedValue([
      { ...stored(), revisions: [storedRevision()] },
    ])
    mocks.preview.mockResolvedValue({ sourceFingerprint: 'changed' })
    expect(
      await correctDraftCashOperation('u1', 's1', 'op1', correction)
    ).toMatchObject({
      revisionId: 'rev1',
      created: false,
    })
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
  it('uses the corrected economic command for future staging and original retries', async () => {
    mocks.rows.mockResolvedValue([
      { ...stored(), revisions: [storedRevision()] },
    ])
    const retry = await saveDraftCashOperation('u1', 's1', deposit)
    expect(retry.replay.balances[0].endingAmount).toBe('160')
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...deposit,
        kind: 'WITHDRAWAL',
        idempotencyKey: 'withdrawal',
        source: { origin: 'MANUAL', reference: 'withdrawal' },
        sequence: 2,
        cash: { currency: 'AUD', amount: '170' },
      })
    ).rejects.toMatchObject({ status: 422 })
  })
  it('rejects funding-dependent reversal despite a positive ending balance from a later deposit', async () => {
    const purchase = {
      ...stored(buy),
      id: 'buy-op',
      tradeLinks: [{ transactionId: 't1' }],
    }
    mocks.statement.mockResolvedValue({
      ...statement,
      cashBalances: [{ currency: 'AUD', amount: new Decimal('0') }],
      inputHash: createHash('sha256')
        .update(
          JSON.stringify({
            openingDate: '2026-10-01',
            cashBalances: [{ currency: 'AUD', amount: '0' }],
          })
        )
        .digest('hex'),
    })
    const later = stored({
      ...deposit,
      idempotencyKey: 'later',
      source: { origin: 'MANUAL', reference: 'later' },
      effectiveDate: '2026-10-03',
    })
    mocks.rows.mockResolvedValue([
      stored(),
      purchase,
      { ...later, id: 'later-op' },
    ])
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', {
        ...correction,
        replacement: null,
      })
    ).rejects.toMatchObject({ status: 422, name: 'Insufficient Cash' })
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
  it('supports terminal reversal and refuses new corrections or duplicate source reuse', async () => {
    const voided = { ...correction, replacement: null }
    mocks.rows.mockResolvedValue([
      { ...stored(), revisions: [storedRevision(voided)] },
    ])
    const retry = await correctDraftCashOperation('u1', 's1', 'op1', voided)
    expect(retry.replay.balances[0]).toMatchObject({
      endingAmount: '100',
      netExternalContribution: '0',
    })
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', {
        ...correction,
        idempotencyKey: 'next',
        expectedRevisionId: 'rev1',
        replacement: null,
      })
    ).rejects.toThrow('reversed operation')
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...deposit,
        idempotencyKey: 'new-key',
        sequence: 2,
      })
    ).rejects.toThrow('durable operation identity')
  })
  it.each([
    { ...correction, expectedRevisionId: 'stale' },
    { ...correction, idempotencyKey: 'deposit-1', replacement: null },
    {
      ...correction,
      replacement: {
        ...correction.replacement,
        source: { origin: 'MANUAL', reference: 'other' },
      },
    },
  ])(
    'rejects stale heads, shared key conflicts and source rebinding %#',
    async (raw) => {
      await expect(
        correctDraftCashOperation('u1', 's1', 'op1', raw)
      ).rejects.toMatchObject({ status: 409 })
      expect(mocks.createRevision).not.toHaveBeenCalled()
    }
  )
  it('rejects correction key reuse with different content or another operation', async () => {
    mocks.rows.mockResolvedValue([
      { ...stored(), revisions: [storedRevision()] },
    ])
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', {
        ...correction,
        reason: 'Other',
      })
    ).rejects.toThrow('different correction content')
    const other = {
      ...stored({
        ...deposit,
        idempotencyKey: 'other',
        source: { origin: 'MANUAL', reference: 'other' },
        sequence: 2,
      }),
      id: 'other',
    }
    mocks.rows.mockResolvedValue([
      { ...stored(), revisions: [storedRevision()] },
      other,
    ])
    await expect(
      correctDraftCashOperation('u1', 's1', 'other', correction)
    ).rejects.toThrow('different correction content')
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...deposit,
        idempotencyKey: 'correction-1',
      })
    ).rejects.toThrow('cash correction')
  })
  it('does not allow unsupported trade corrections, stale opening source, closed/demo accounts or missing operations', async () => {
    mocks.rows.mockResolvedValue([
      { ...stored(buy), tradeLinks: [{ transactionId: 't1' }] },
    ])
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', {
        ...correction,
        replacement: null,
      })
    ).rejects.toThrow('atomic parcel')
    mocks.rows.mockResolvedValue([stored()])
    mocks.preview.mockResolvedValue({ sourceFingerprint: 'changed' })
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', correction)
    ).rejects.toThrow('source records have changed')
    mocks.preview.mockResolvedValue({ sourceFingerprint: fingerprint })
    for (const account of [
      { ...statement.account, status: 'CLOSED' },
      { ...statement.account, isDemo: true },
    ]) {
      mocks.statement.mockResolvedValue({ ...statement, account })
      await expect(
        correctDraftCashOperation('u1', 's1', 'op1', correction)
      ).rejects.toThrow('active real')
    }
    mocks.statement.mockResolvedValue(statement)
    await expect(
      correctDraftCashOperation('u1', 's1', 'missing', correction)
    ).rejects.toMatchObject({ status: 404 })
  })
  it.each([
    { ...storedRevision(), revisionNumber: 2 },
    { ...storedRevision(), previousRevisionId: 'other' },
    { ...storedRevision(), payloadHash: 'corrupt' },
    { ...storedRevision(), reason: 'corrupt' },
    { ...storedRevision(), operationId: 'other' },
    { ...storedRevision(), statementId: 'other' },
    { ...storedRevision(), idempotencyKey: 'deposit-1' },
    { ...storedRevision(), postings: [] },
    {
      ...storedRevision(),
      postings: [
        { ...storedRevision().postings[0], phase: 'REPLACEMENT' },
        storedRevision().postings[1],
      ],
    },
    {
      ...storedRevision(),
      postings: [
        { ...storedRevision().postings[0], amount: new Decimal('-99') },
        storedRevision().postings[1],
      ],
    },
  ])('rejects corrupt stored revision audit %#', async (revision) => {
    mocks.rows.mockResolvedValue([{ ...stored(), revisions: [revision] }])
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', correction)
    ).rejects.toThrow('inconsistent')
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
  it('rejects audit growth before appending and propagates persistence failures', async () => {
    mocks.revisionCount.mockResolvedValue(50000)
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', correction)
    ).rejects.toMatchObject({ status: 422 })
    mocks.revisionCount.mockResolvedValue(0)
    mocks.revisionPostingCount.mockResolvedValue(99999)
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', correction)
    ).rejects.toMatchObject({ status: 422 })
    mocks.revisionPostingCount.mockResolvedValue(0)
    mocks.createRevision.mockRejectedValue(new Error('Database unavailable'))
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', correction)
    ).rejects.toThrow('Database unavailable')
  })
})
