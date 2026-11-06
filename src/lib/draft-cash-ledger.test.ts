import { Decimal } from 'decimal.js'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareCashCommand } from './cash-ledger.js'
import {
  prepareCashRevision,
  prepareRevisionLegs,
  prepareDraftTradeRevision,
} from './cash-revisions.js'
import { prepareDraftCashEvidence } from './draft-cash-evidence.js'
import {
  prepareDraftTradeRequest,
  prepareDraftTradeCash,
} from './draft-trade-command.js'

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
  asset: vi.fn(),
  position: vi.fn(),
  evidenceFindMany: vi.fn(),
  evidenceFindUnique: vi.fn(),
  evidenceCreate: vi.fn(),
  evidencePreview: vi.fn(),
  importedEvents: vi.fn(),
  importedEvent: vi.fn(),
}))
vi.mock('./prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    transaction: { findMany: mocks.transactions },
    importedEvent: {
      findMany: mocks.importedEvents,
      findFirst: mocks.importedEvent,
    },
  },
}))
vi.mock('./user-lock.js', () => ({ lockActiveUser: vi.fn() }))
vi.mock('./accounting-preview-service.js', () => ({
  readAccountOpeningPreview: mocks.preview,
}))
import {
  saveDraftCashOperation,
  saveDraftImportedExecutionCash,
  saveDraftManualExecutionCash,
  correctDraftCashOperation,
  correctDraftReconciliationCashOperation,
  correctDraftImportedExecutionCash,
  correctDraftManualTrade,
  saveDraftManualTrade,
  reconcileDraftOpening,
  recordDraftCashEvidence,
  saveDraftReconciliationCashOperation,
  previewDraftCashEvidence,
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
  parcels: [],
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
  previewSnapshot: { asOfDate: '2026-10-31', parcels: [] },
}
const trade = {
  id: 't1',
  type: 'BUY',
  date: new Date('2026-10-02T00:00:00Z'),
  totalValue: new Decimal('60'),
  price: new Decimal('60'),
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
  mocks.asset.mockResolvedValue({
    id: 'asset1',
    symbol: 'TEST',
    isActive: true,
    exchange: { currency: 'AUD' },
  })
  mocks.preview.mockResolvedValue({
    sourceFingerprint: fingerprint,
    parcels: [],
  })
  mocks.position.mockResolvedValue({
    assetId: 'asset1',
    asset: { symbol: 'TEST', exchange: { currency: 'AUD' } },
  })
  mocks.evidenceFindMany.mockResolvedValue([])
  mocks.evidenceFindUnique.mockResolvedValue(null)
  mocks.evidenceCreate.mockResolvedValue({ id: 'evidence-1' })
  mocks.evidencePreview.mockResolvedValue({})
  mocks.importedEvents.mockResolvedValue([])
  mocks.importedEvent.mockResolvedValue(null)
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
        draftCashEvidence: {
          findMany: mocks.evidenceFindMany,
          findUnique: mocks.evidenceFindUnique,
          create: mocks.evidenceCreate,
        },
        importedEvent: {
          findMany: mocks.importedEvents,
          findFirst: mocks.importedEvent,
        },
        transaction: { findMany: mocks.transactions },
        $queryRaw: mocks.lock,
        asset: { findUnique: mocks.asset },
        position: { findFirst: mocks.position },
      })
  )
})

describe('persistent inactive cash staging', () => {
  it('stages a zero-fee manual SELL without inventing a fee posting', async () => {
    mocks.transactions.mockResolvedValue([
      { ...trade, type: 'SELL', fees: new Decimal('0'), brokerRef: null },
    ])
    const result = await saveDraftManualExecutionCash('u1', 'a1', 's1', 't1', 3)
    expect(result.replay.balances[0].endingAmount).toBe('160')
    expect(mocks.create.mock.calls[0][0].data.command).toMatchObject({
      kind: 'SELL',
      fees: [],
    })
  })
  it('stages persisted manual execution cash with only a caller-supplied sequence', async () => {
    mocks.transactions.mockResolvedValue([{ ...trade, brokerRef: null }])
    const result = await saveDraftManualExecutionCash('u1', 'a1', 's1', 't1', 3)
    expect(result.replay.balances[0].endingAmount).toBe('39')
    expect(mocks.transactions.mock.calls[0][0].where).toEqual({
      id: 't1',
      brokerRef: null,
      position: {
        accountId: 'a1',
        userId: 'u1',
        origin: 'MANUAL',
        positionType: 'LONG',
      },
    })
    expect(mocks.create.mock.calls[0][0].data.command).toMatchObject({
      kind: 'BUY',
      sequence: 3,
      effectiveDate: '2026-10-02',
      consideration: { currency: 'AUD', amount: '60' },
      fees: [{ currency: 'AUD', amount: '1' }],
      transactionIds: ['t1'],
      source: { origin: 'MANUAL', reference: 'manual-transaction:t1' },
    })
  })
  it('rejects missing/foreign manual transactions and source changes discovered under the account lock', async () => {
    mocks.transactions.mockResolvedValueOnce([])
    await expect(
      saveDraftManualExecutionCash('u1', 'a1', 's1', 't1', 3)
    ).rejects.toMatchObject({ status: 404 })
    mocks.transactions
      .mockResolvedValueOnce([{ ...trade, brokerRef: null }])
      .mockResolvedValue([{ ...trade, brokerRef: 'KRAKEN:order:1' }])
    await expect(
      saveDraftManualExecutionCash('u1', 'a1', 's1', 't1', 3)
    ).rejects.toMatchObject({ status: 409 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rejects a manual execution amount changed between loading and locking', async () => {
    mocks.transactions
      .mockResolvedValueOnce([{ ...trade, brokerRef: null }])
      .mockResolvedValue([
        { ...trade, brokerRef: null, totalValue: new Decimal('61') },
      ])
    await expect(
      saveDraftManualExecutionCash('u1', 'a1', 's1', 't1', 3)
    ).rejects.toMatchObject({ status: 409 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
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
  it('rejects cash operations on the opening boundary', async () => {
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...deposit,
        effectiveDate: '2026-10-01',
      })
    ).rejects.toThrow('after the opening statement boundary')
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
  it('stages cash from an applied Kraken event and its exact persisted transaction links', async () => {
    const event = {
      id: 'event-1',
      userId: 'u1',
      source: 'KRAKEN',
      externalId: 'KRAKEN:order:1',
      kind: 'BUY',
      status: 'APPLIED',
      occurredAt: new Date('2026-10-02T00:00:00.000Z'),
      quoteCurrency: 'AUD',
      grossValue: new Decimal('60.12345678'),
      fee: new Decimal('1'),
      feeCurrency: 'AUD',
      appliedPositionIds: ['p1'],
      batch: { accountId: 'a1', userId: 'u1' },
    }
    const importedTransaction = {
      id: 'it1',
      positionId: 'p1',
      brokerRef: event.externalId,
      type: 'BUY',
      date: event.occurredAt,
      totalValue: new Decimal('60'),
      fees: new Decimal('1'),
      quantity: 1,
      position: {
        origin: 'IMPORT_TRADE',
        positionType: 'LONG',
        asset: { exchange: { currency: 'AUD' } },
      },
    }
    mocks.importedEvent.mockResolvedValue(event)
    mocks.transactions.mockResolvedValue([importedTransaction])

    const result = await saveDraftImportedExecutionCash(
      'u1',
      'a1',
      's1',
      'event-1',
      2
    )

    expect(result).toMatchObject({ created: true, state: 'DRAFT' })
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceOrigin: 'IMPORT',
          sourceReference: event.externalId,
          command: expect.objectContaining({
            kind: 'BUY',
            idempotencyKey: 'import-event:event-1',
            effectiveDate: '2026-10-02',
            sequence: 2,
            consideration: { currency: 'AUD', amount: '60.12345678' },
            fees: [{ currency: 'AUD', amount: '1' }],
            transactionIds: ['it1'],
          }),
        }),
      })
    )
  })
  it('refuses to stage an imported execution whose transaction is already linked to another draft operation', async () => {
    const event = {
      id: 'event-duplicate',
      userId: 'u1',
      source: 'KRAKEN',
      externalId: 'KRAKEN:order:duplicate',
      kind: 'SELL',
      status: 'APPLIED',
      occurredAt: new Date('2026-10-02T00:00:00.000Z'),
      quoteCurrency: 'AUD',
      grossValue: new Decimal('60'),
      fee: new Decimal('1'),
      feeCurrency: 'AUD',
      appliedPositionIds: ['p1'],
      batch: { accountId: 'a1', userId: 'u1' },
    }
    mocks.importedEvent.mockResolvedValue(event)
    mocks.transactions.mockResolvedValue([
      {
        ...trade,
        id: 'imported-transaction',
        positionId: 'p1',
        brokerRef: event.externalId,
        type: 'SELL',
        position: { ...trade.position, origin: 'MANUAL' },
      },
    ])
    const existing = {
      ...stored({
        ...buy,
        kind: 'SELL',
        fees: [{ currency: 'AUD', amount: '1' }],
        source: { origin: 'MANUAL', reference: 'reviewed-before-import' },
        transactionIds: ['imported-transaction'],
      }),
      tradeLinks: [{ transactionId: 'imported-transaction' }],
    }
    mocks.rows.mockResolvedValue([existing])

    await expect(
      saveDraftImportedExecutionCash('u1', 'a1', 's1', event.id, 3)
    ).rejects.toThrow('already linked to a draft cash operation')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('uses the Kraken quote-currency values when a multi-currency SELL is allocated to a parcel', async () => {
    const event = {
      id: 'event-sell-1',
      userId: 'u1',
      source: 'KRAKEN',
      externalId: 'KRAKEN:order:sell-1',
      kind: 'SELL',
      status: 'APPLIED',
      occurredAt: new Date('2026-10-02T00:00:00.000Z'),
      quoteCurrency: 'AUD',
      grossValue: new Decimal('60'),
      fee: new Decimal('1'),
      feeCurrency: 'AUD',
      appliedPositionIds: ['p1'],
      batch: { accountId: 'a1', userId: 'u1' },
    }
    mocks.importedEvent.mockResolvedValue(event)
    mocks.transactions.mockResolvedValue([
      {
        id: 'it-sell-1',
        positionId: 'p1',
        brokerRef: event.externalId,
        type: 'SELL',
        date: event.occurredAt,
        totalValue: new Decimal('90'),
        fees: new Decimal('1.5'),
        quantity: 1,
        position: {
          origin: 'MANUAL',
          positionType: 'LONG',
          asset: { exchange: { currency: 'USD' } },
        },
      },
    ])

    await saveDraftImportedExecutionCash('u1', 'a1', 's1', event.id, 2)

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          command: expect.objectContaining({
            kind: 'SELL',
            consideration: { currency: 'AUD', amount: '60' },
            fees: [{ currency: 'AUD', amount: '1' }],
            transactionIds: ['it-sell-1'],
          }),
        }),
      })
    )
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
      'unsupported commands'
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
        'snapshot'
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

const proposedBuy = {
  accountId: 'a1',
  idempotencyKey: 'proposal-1',
  effectiveDate: '2026-10-02',
  sequence: 1,
  kind: 'BUY',
  assetId: 'asset1',
  currency: 'AUD',
  quantity: '10',
  price: '5',
  fees: '1',
}
function proposal(raw: unknown = proposedBuy, id = 'draft-buy') {
  const parsed = prepareDraftTradeRequest(raw)
  const command = prepareDraftTradeCash(parsed.request, id).command
  const row = stored(command)
  return {
    ...row,
    tradeLinks: [{ transactionId: id }],
    proposedTrade: {
      id,
      operationId: row.id,
      parcelKey: parsed.request.kind === 'BUY' ? id : parsed.request.parcelKey,
      assetId: 'asset1',
      symbol: 'TEST',
      currency: parsed.request.currency,
      quantity: new Decimal(parsed.request.quantity),
      price: new Decimal(parsed.request.price),
      fees: new Decimal(parsed.request.fees),
      requestHash: parsed.requestHash,
      request: parsed.request,
    },
  }
}
const proposedSell = {
  accountId: 'a1',
  idempotencyKey: 'proposal-sell',
  effectiveDate: '2026-10-03',
  sequence: 1,
  kind: 'SELL',
  parcelKey: 'draft-buy',
  currency: 'AUD',
  quantity: '4',
  price: '6',
  fees: '1',
}
const cashEvidence = {
  idempotencyKey: 'cash-evidence-1',
  asOfDate: '2026-10-31',
  source: 'Example Bank',
  reference: 'Statement 2026-10',
  attested: true,
  cashBalances: [{ currency: 'AUD', amount: '100' }],
  decisions: [],
}

const openingRow = {
  id: 'opening-row',
  statementId: 's1',
  positionId: 'legacy-position',
  symbol: 'TEST',
  currency: 'AUD',
  quantity: new Decimal('10'),
}
const openingStatement = {
  ...statement,
  parcels: [openingRow],
  previewSnapshot: {
    ...statement.previewSnapshot,
    parcels: [
      {
        positionId: openingRow.positionId,
        symbol: openingRow.symbol,
        currency: openingRow.currency,
        openingQuantity: '10',
      },
    ],
  },
}
const openingSell = { ...proposedSell, parcelKey: 'opening:opening-row' }

describe('isolated sales against confirmed opening parcels', () => {
  beforeEach(() => {
    mocks.statement.mockResolvedValue(openingStatement)
    mocks.preview.mockResolvedValue({
      sourceFingerprint: fingerprint,
      parcels: openingStatement.previewSnapshot.parcels,
    })
  })

  it('rejects jointly changed child/snapshot units that no longer match the verified source', async () => {
    mocks.statement.mockResolvedValue({
      ...openingStatement,
      parcels: [{ ...openingRow, quantity: new Decimal('11') }],
      previewSnapshot: {
        ...openingStatement.previewSnapshot,
        parcels: [
          {
            ...openingStatement.previewSnapshot.parcels[0],
            openingQuantity: '11',
          },
        ],
      },
    })
    await expect(saveDraftManualTrade('u1', 's1', openingSell)).rejects.toThrow(
      'verified source inventory'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('refuses orphaned/rebound opening audit identities and mixed recorded-trade history on replay', async () => {
    const first = proposal(openingSell, 'opening-sell')
    mocks.rows.mockResolvedValue([
      first,
      { ...stored(buy), id: 'real-op', tradeLinks: [{ transactionId: 't1' }] },
    ])
    await expect(saveDraftManualTrade('u1', 's1', openingSell)).rejects.toThrow(
      'cannot mix'
    )
    const second = proposal(
      { ...openingSell, quantity: '1', sequence: 2, idempotencyKey: 'second' },
      'second-sale'
    )
    mocks.rows.mockResolvedValue([
      first,
      {
        ...second,
        id: 'second-op',
        proposedTrade: {
          ...second.proposedTrade,
          operationId: 'second-op',
          assetId: 'other',
        },
      },
    ])
    await expect(saveDraftManualTrade('u1', 's1', openingSell)).rejects.toThrow(
      'snapshot identity'
    )
    mocks.rows.mockResolvedValue([
      {
        ...first,
        revisions: [
          proposedRevision(
            proposedCorrection(null),
            openingSell,
            'opening-sell'
          ),
        ],
      },
    ])
    mocks.statement.mockResolvedValue(statement)
    await expect(saveDraftManualTrade('u1', 's1', openingSell)).rejects.toThrow(
      'lost its confirmed'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('rejects duplicate and over-limit snapshot inventories without partial replay', async () => {
    mocks.statement.mockResolvedValue({
      ...openingStatement,
      parcels: [openingRow, openingRow],
      previewSnapshot: {
        ...openingStatement.previewSnapshot,
        parcels: [
          ...openingStatement.previewSnapshot.parcels,
          ...openingStatement.previewSnapshot.parcels,
        ],
      },
    })
    await expect(saveDraftManualTrade('u1', 's1', openingSell)).rejects.toThrow(
      'snapshot identities'
    )
    mocks.statement.mockResolvedValue({
      ...openingStatement,
      parcels: Array(5001).fill(openingRow),
    })
    await expect(saveDraftManualTrade('u1', 's1', openingSell)).rejects.toThrow(
      'snapshot is inconsistent'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('seeds reviewed units without a synthetic BUY or opening cash posting', async () => {
    const result = await saveDraftManualTrade('u1', 's1', openingSell)
    expect(result.parcels).toEqual([
      {
        parcelKey: openingSell.parcelKey,
        positionId: 'legacy-position',
        symbol: 'TEST',
        assetId: null,
        currency: 'AUD',
        acquired: '10',
        remaining: '6',
      },
    ])
    expect(result.replay.balances[0].endingAmount).toBe('123')
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(
      mocks.create.mock.calls[0][0].data.proposedTrade.create
    ).toMatchObject({
      parcelKey: openingSell.parcelKey,
      assetId: 'asset1',
      symbol: 'TEST',
    })
    expect(mocks.position.mock.calls[0][0].where).toEqual({
      id: 'legacy-position',
      accountId: 'a1',
      userId: 'u1',
      positionType: 'LONG',
    })
    expect(mocks.transactions).not.toHaveBeenCalled()
  })

  it('replays and corrects old proposals using snapshots, not mutable live inventory', async () => {
    mocks.rows.mockResolvedValue([proposal(openingSell, 'opening-sell')])
    mocks.position.mockRejectedValue(
      new Error('Source must not be read on retry')
    )
    const retry = await saveDraftManualTrade('u1', 's1', openingSell)
    expect(retry.created).toBe(false)
    expect(retry.parcels[0].remaining).toBe('6')
    expect(mocks.position).not.toHaveBeenCalled()
    const result = await correctDraftManualTrade(
      'u1',
      's1',
      'op1',
      proposedCorrection({ ...openingSell, quantity: '7' })
    )
    expect(result.parcels[0].remaining).toBe('3')
    expect(result.replay.balances[0].endingAmount).toBe('141')
    const reversed = await correctDraftManualTrade(
      'u1',
      's1',
      'op1',
      proposedCorrection(null)
    )
    expect(reversed.parcels[0].remaining).toBe('10')
    expect(reversed.replay.balances[0].endingAmount).toBe('100')
  })

  it.each([
    { ...openingSell, quantity: '11' },
    { ...openingSell, currency: 'USD' },
    { ...openingSell, effectiveDate: '2026-10-01' },
  ])(
    'rejects excess units, currency mismatch and boundary reposting %#',
    async (raw) => {
      await expect(saveDraftManualTrade('u1', 's1', raw)).rejects.toMatchObject(
        { status: 422 }
      )
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )

  it.each([
    null,
    {
      assetId: 'other',
      asset: { symbol: 'OTHER', exchange: { currency: 'AUD' } },
    },
    {
      assetId: 'asset1',
      asset: { symbol: 'TEST', exchange: { currency: 'USD' } },
    },
  ])(
    'rejects missing or changed owned source identities %#',
    async (position) => {
      mocks.position.mockResolvedValue(position)
      await expect(
        saveDraftManualTrade('u1', 's1', openingSell)
      ).rejects.toThrow('unchanged owned source')
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )

  it('requires a statement-scoped opening row key, not a live position or another revision key', async () => {
    for (const parcelKey of ['legacy-position', 'opening:other-revision']) {
      await expect(
        saveDraftManualTrade('u1', 's1', { ...openingSell, parcelKey })
      ).rejects.toThrow('confirmed opening parcel')
    }
    expect(mocks.position).not.toHaveBeenCalled()
  })

  it.each([
    { ...openingRow, statementId: 'other' },
    { ...openingRow, quantity: new Decimal('11') },
    { ...openingRow, symbol: 'OTHER' },
    { ...openingRow, currency: 'USD' },
  ])(
    'rejects child balances detached from reviewed inventory %#',
    async (row) => {
      mocks.statement.mockResolvedValue({ ...openingStatement, parcels: [row] })
      await expect(
        saveDraftManualTrade('u1', 's1', openingSell)
      ).rejects.toThrow('reviewed snapshot')
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )

  it.each([
    null,
    {},
    [],
    { parcels: [] },
    { parcels: [null] },
    {
      parcels: [
        {
          ...openingStatement.previewSnapshot.parcels[0],
          openingQuantity: '-1',
        },
      ],
    },
  ])(
    'rejects missing/malformed opening snapshots instead of silently assuming no units %#',
    async (previewSnapshot) => {
      mocks.statement.mockResolvedValue({
        ...openingStatement,
        previewSnapshot,
      })
      await expect(
        saveDraftManualTrade('u1', 's1', openingSell)
      ).rejects.toThrow()
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )

  it('rejects replay identity tampering and live/proposed double counting in either direction', async () => {
    const row = proposal(openingSell, 'opening-sell')
    mocks.rows.mockResolvedValue([
      { ...row, proposedTrade: { ...row.proposedTrade, symbol: 'OTHER' } },
    ])
    await expect(saveDraftManualTrade('u1', 's1', openingSell)).rejects.toThrow(
      'snapshot identity'
    )
    mocks.rows.mockResolvedValue([row])
    await expect(
      saveDraftCashOperation('u1', 's1', { ...buy, sequence: 2 })
    ).rejects.toThrow('cannot mix')
    mocks.rows.mockResolvedValue([
      { ...stored(buy), tradeLinks: [{ transactionId: 't1' }] },
    ])
    await expect(saveDraftManualTrade('u1', 's1', openingSell)).rejects.toThrow(
      'cannot mix'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('atomic isolated proposed trade staging', () => {
  it('keeps original date/order slots reserved after a capital reversal for both writers', async () => {
    mocks.rows.mockResolvedValue([
      {
        ...stored(),
        revisions: [storedRevision({ ...correction, replacement: null })],
      },
    ])
    await expect(saveDraftManualTrade('u1', 's1', proposedBuy)).rejects.toThrow(
      'slots remain reserved'
    )
    await expect(
      saveDraftCashOperation('u1', 's1', {
        ...deposit,
        idempotencyKey: 'new',
        source: { origin: 'MANUAL', reference: 'new' },
      })
    ).rejects.toThrow('slots remain reserved')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('stores a draft BUY, trade identity and cash legs in one nested write without any live trade delegate', async () => {
    const result = await saveDraftManualTrade('u1', 's1', proposedBuy)
    expect(result).toMatchObject({ created: true, state: 'DRAFT' })
    expect(result.replay.balances[0].endingAmount).toBe('49')
    expect(result.parcels[0]).toMatchObject({ acquired: '10', remaining: '10' })
    const data = mocks.create.mock.calls[0][0].data
    expect(data.proposedTrade.create).toMatchObject({
      quantity: '10',
      price: '5',
      fees: '1',
      assetId: 'asset1',
    })
    expect(data.proposedTrade.create.parcelKey).toBe(result.tradeId)
    expect(data.tradeLinks.create).toEqual({ transactionId: result.tradeId })
    expect(
      data.postings.create.map((leg: { amount: string }) => leg.amount)
    ).toEqual(['-50', '-1'])
    expect(mocks.transactions).not.toHaveBeenCalled()
  })
  it('stages a partial SELL against an earlier proposed BUY, releasing cash once', async () => {
    mocks.rows.mockResolvedValue([proposal()])
    const result = await saveDraftManualTrade('u1', 's1', proposedSell)
    expect(result.parcels[0].remaining).toBe('6')
    expect(result.replay.balances[0].endingAmount).toBe('72')
    expect(
      mocks.create.mock.calls[0][0].data.proposedTrade.create.parcelKey
    ).toBe('draft-buy')
    expect(mocks.asset).not.toHaveBeenCalled()
  })
  it('reuses the proposal identity and normalized hash on retries without fetching mutable source', async () => {
    mocks.rows.mockResolvedValue([proposal()])
    const retry = await saveDraftManualTrade('u1', 's1', {
      ...proposedBuy,
      quantity: '10.00',
    })
    expect(retry).toMatchObject({
      created: false,
      tradeId: 'draft-buy',
      parcelKey: 'draft-buy',
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.preview).not.toHaveBeenCalled()
  })
  it('rejects key reuse with a changed proposal or a capital operation', async () => {
    mocks.rows.mockResolvedValue([proposal()])
    await expect(
      saveDraftManualTrade('u1', 's1', { ...proposedBuy, quantity: '9' })
    ).rejects.toThrow('different proposed trade')
    mocks.rows.mockResolvedValue([stored()])
    await expect(
      saveDraftManualTrade('u1', 's1', {
        ...proposedBuy,
        idempotencyKey: deposit.idempotencyKey,
      })
    ).rejects.toThrow('different proposed trade')
  })
  it.each([
    { ...proposedBuy, quantity: '20' },
    { ...proposedBuy, effectiveDate: '2026-10-01' },
  ])(
    'rejects funding and opening-boundary failures before writes %#',
    async (raw) => {
      await expect(saveDraftManualTrade('u1', 's1', raw)).rejects.toMatchObject(
        { status: 422 }
      )
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )
  it.each([
    { ...proposedSell, quantity: '11' },
    { ...proposedSell, effectiveDate: '2026-10-01' },
    { ...proposedSell, currency: 'USD' },
  ])(
    'rejects overselling, premature sales and wrong currency %#',
    async (raw) => {
      mocks.rows.mockResolvedValue([proposal()])
      await expect(saveDraftManualTrade('u1', 's1', raw)).rejects.toMatchObject(
        { status: 422 }
      )
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )
  it('rejects cross-draft parcel keys, wrong account, closed/demo accounts and stale opening source', async () => {
    await expect(
      saveDraftManualTrade('u1', 's1', proposedSell)
    ).rejects.toThrow('BUY parcel in this opening draft')
    await expect(
      saveDraftManualTrade('u1', 's1', { ...proposedBuy, accountId: 'other' })
    ).rejects.toThrow('owned active')
    for (const account of [
      { ...statement.account, isDemo: true },
      { ...statement.account, status: 'CLOSED' },
    ]) {
      mocks.statement.mockResolvedValue({ ...statement, account })
      await expect(
        saveDraftManualTrade('u1', 's1', proposedBuy)
      ).rejects.toThrow('owned active')
    }
    mocks.statement.mockResolvedValue(statement)
    mocks.preview.mockResolvedValue({ sourceFingerprint: 'changed' })
    await expect(saveDraftManualTrade('u1', 's1', proposedBuy)).rejects.toThrow(
      'source records have changed'
    )
  })
  it.each([
    null,
    { id: 'asset1', isActive: false, exchange: { currency: 'AUD' } },
    { id: 'asset1', isActive: true, exchange: { currency: 'USD' } },
  ])(
    'rejects missing/inactive/currency-mismatched assets %#',
    async (asset) => {
      mocks.asset.mockResolvedValue(asset)
      await expect(
        saveDraftManualTrade('u1', 's1', proposedBuy)
      ).rejects.toThrow('active asset')
    }
  )
  it('does not let standalone cash staging create or retry a proposed execution independently', async () => {
    await expect(
      saveDraftCashOperation(
        'u1',
        's1',
        prepareDraftTradeCash(
          prepareDraftTradeRequest(proposedBuy).request,
          'draft-buy'
        ).command
      )
    ).rejects.toThrow('atomic draft trade writer')
  })
  it.each([
    { ...proposal().proposedTrade, requestHash: 'corrupt' },
    { ...proposal().proposedTrade, quantity: new Decimal('9') },
    { ...proposal().proposedTrade, price: new Decimal('9') },
    { ...proposal().proposedTrade, fees: new Decimal('9') },
    { ...proposal().proposedTrade, currency: 'USD' },
    { ...proposal().proposedTrade, assetId: 'other' },
    { ...proposal().proposedTrade, operationId: 'other' },
  ])(
    'rejects inconsistent proposed trade snapshots before retrying %#',
    async (trade) => {
      mocks.rows.mockResolvedValue([{ ...proposal(), proposedTrade: trade }])
      await expect(
        saveDraftManualTrade('u1', 's1', proposedBuy)
      ).rejects.toThrow('inconsistent')
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )
  it('rejects missing atomic trade snapshots and propagates nested-write failures', async () => {
    mocks.rows.mockResolvedValue([{ ...proposal(), proposedTrade: null }])
    await expect(saveDraftManualTrade('u1', 's1', proposedBuy)).rejects.toThrow(
      'atomic trade snapshot'
    )
    mocks.rows.mockResolvedValue([])
    mocks.create.mockRejectedValue(new Error('Nested write failed'))
    await expect(saveDraftManualTrade('u1', 's1', proposedBuy)).rejects.toThrow(
      'Nested write failed'
    )
  })
  it('bounds audit growth and refuses correction-key reuse before proposing a trade', async () => {
    mocks.revisionCount.mockResolvedValue(50000)
    await expect(
      saveDraftManualTrade('u1', 's1', proposedBuy)
    ).rejects.toMatchObject({ status: 422 })
    mocks.revisionCount.mockResolvedValue(0)
    mocks.revisionPostingCount.mockResolvedValue(99999)
    await expect(
      saveDraftManualTrade('u1', 's1', proposedBuy)
    ).rejects.toMatchObject({ status: 422 })
    mocks.revisionPostingCount.mockResolvedValue(0)
    mocks.rows.mockResolvedValue([
      { ...stored(), revisions: [storedRevision()] },
    ])
    await expect(
      saveDraftManualTrade('u1', 's1', {
        ...proposedBuy,
        idempotencyKey: 'correction-1',
        sequence: 2,
      })
    ).rejects.toThrow('cash correction')
  })
})

describe('read-only opening reconciliation', () => {
  const liveParcel = {
    positionId: 'legacy-position',
    symbol: 'TEST',
    currency: 'AUD',
    openingQuantity: '10',
    expectedCurrentQuantity: '8',
    recordedCurrentQuantity: '8',
  }
  const livePreview = {
    sourceFingerprint: fingerprint,
    asOfDate: '2026-10-31',
    parcels: [liveParcel],
    issues: [],
  }
  const recordedSell = {
    id: 'recorded-sell',
    positionId: 'legacy-position',
    type: 'SELL',
    date: new Date('2026-10-02T00:00:00Z'),
    quantity: 2,
  }
  beforeEach(() => {
    mocks.statement.mockResolvedValue(openingStatement)
    mocks.preview.mockResolvedValue(livePreview)
    mocks.transactions.mockResolvedValue([recordedSell])
  })

  it('reports exact manual money separately from imported allocations and existing links', async () => {
    const row = { ...trade, brokerRef: null, positionId: 'legacy-position' }
    mocks.transactions.mockResolvedValue([
      row,
      { ...row, id: 'allocation', brokerRef: 'KRAKEN:order:1' },
      {
        ...row,
        id: 'imported',
        position: { ...row.position, origin: 'IMPORT_TRADE' },
      },
    ])
    let result = await reconcileDraftOpening('u1', 's1', 'a1')
    expect(result.cashManualExecutions).toEqual([
      {
        transactionId: 't1',
        positionId: 'legacy-position',
        kind: 'BUY',
        effectiveDate: '2026-10-02',
        currency: 'AUD',
        grossValue: '60',
        fee: '1',
        price: '60',
        occurredAt: '2026-10-02T00:00:00.000Z',
        quantity: '1',
        stageable: true,
        reason: null,
        operationId: null,
      },
    ])
    const operation = { ...stored(buy), tradeLinks: [{ transactionId: 't1' }] }
    mocks.rows.mockResolvedValue([operation])
    result = await reconcileDraftOpening('u1', 's1', 'a1')
    expect(result.cashManualExecutions[0]).toMatchObject({
      stageable: false,
      reason: 'ALREADY_LINKED',
      operationId: 'op1',
    })
  })
  it.each([
    [
      'boundary',
      { date: new Date('2026-10-01T00:00:00Z') },
      'ON_OR_BEFORE_BOUNDARY',
    ],
    [
      'future',
      { date: new Date('2099-01-01T00:00:00Z') },
      'AFTER_OBSERVATION_DATE',
    ],
    [
      'non-positive gross',
      { totalValue: new Decimal('0') },
      'UNSUPPORTED_EXECUTION',
    ],
    ['invalid fee', { fees: new Decimal('-1') }, 'UNSUPPORTED_EXECUTION'],
    ['invalid quantity', { quantity: 0 }, 'UNSUPPORTED_EXECUTION'],
    [
      'short',
      { position: { ...trade.position, positionType: 'SHORT' } },
      'UNSUPPORTED_EXECUTION',
    ],
    [
      'unsupported currency',
      {
        position: {
          ...trade.position,
          asset: { exchange: { currency: 'BTC' } },
        },
      },
      'UNSUPPORTED_EXECUTION',
    ],
  ])(
    'does not offer manual staging for %s executions',
    async (_label, overrides, reason) => {
      mocks.transactions.mockResolvedValue([
        {
          ...trade,
          brokerRef: null,
          positionId: 'legacy-position',
          ...overrides,
        },
      ])
      const result = await reconcileDraftOpening('u1', 's1', 'a1')
      expect(result.cashManualExecutions[0]).toMatchObject({
        stageable: false,
        reason,
      })
    }
  )
  it('disables manual staging when the opening source or account is not eligible', async () => {
    mocks.transactions.mockResolvedValue([
      { ...trade, brokerRef: null, positionId: 'legacy-position' },
    ])
    mocks.preview.mockResolvedValue({
      ...livePreview,
      sourceFingerprint: 'b'.repeat(64),
    })
    expect(
      (await reconcileDraftOpening('u1', 's1', 'a1')).cashManualExecutions[0]
        .reason
    ).toBe('STALE_OPENING_SOURCE')
    mocks.preview.mockResolvedValue(livePreview)
    mocks.statement.mockResolvedValue({
      ...openingStatement,
      account: { ...statement.account, status: 'CLOSED' },
    })
    expect(
      (await reconcileDraftOpening('u1', 's1', 'a1')).cashManualExecutions[0]
        .reason
    ).toBe('ACCOUNT_NOT_ELIGIBLE')
  })
  describe('persisted dated cash evidence and external capital operations', () => {
    beforeEach(() => {
      mocks.preview.mockResolvedValue({
        sourceFingerprint: fingerprint,
        parcels: openingStatement.previewSnapshot.parcels,
      })
    })

    it('previews exact statement-date differences without writing evidence or cash operations', async () => {
      const result = await previewDraftCashEvidence(
        'u1',
        's1',
        {
          ...cashEvidence,
          cashBalances: [{ currency: 'AUD', amount: '125' }],
          decisions: [],
        },
        'a1'
      )
      expect(result).toMatchObject({
        asOfDate: '2026-10-31',
        comparison: {
          matchesReplay: false,
          variances: [
            {
              currency: 'AUD',
              expectedAmount: '100',
              statementAmount: '125',
              difference: '25',
            },
          ],
        },
      })
      expect(mocks.evidenceCreate).not.toHaveBeenCalled()
      expect(mocks.create).not.toHaveBeenCalled()
    })

    it('records an immutable explicitly attested exact statement balance without financial postings', async () => {
      const result = await recordDraftCashEvidence(
        'u1',
        's1',
        cashEvidence,
        'a1'
      )
      expect(result).toMatchObject({
        evidenceId: 'evidence-1',
        created: true,
        comparison: { matchesReplay: true, variances: [] },
      })
      expect(mocks.evidenceCreate.mock.calls[0][0].data).toMatchObject({
        statementId: 's1',
        asOfDate: new Date('2026-10-31T00:00:00Z'),
        source: 'Example Bank',
        reference: 'Statement 2026-10',
        attested: true,
        balances: { create: [{ currency: 'AUD', amount: '100' }] },
        decisions: { create: [] },
      })
      expect(mocks.create).not.toHaveBeenCalled()
      expect(mocks.createRevision).not.toHaveBeenCalled()
    })

    it('records exact signed variances with explicit reason/note without treating them as resolved', async () => {
      const result = await recordDraftCashEvidence(
        'u1',
        's1',
        {
          ...cashEvidence,
          cashBalances: [{ currency: 'AUD', amount: '125' }],
          decisions: [
            {
              currency: 'AUD',
              reason: 'UNRECORDED_OPERATION',
              note: 'Expected transfer from another bank account',
            },
          ],
        },
        'a1'
      )
      expect(result.comparison).toMatchObject({
        matchesReplay: false,
        variances: [
          {
            currency: 'AUD',
            expectedAmount: '100',
            statementAmount: '125',
            difference: '25',
          },
        ],
      })
      expect(
        mocks.evidenceCreate.mock.calls[0][0].data.decisions.create
      ).toEqual([
        {
          currency: 'AUD',
          reason: 'UNRECORDED_OPERATION',
          note: 'Expected transfer from another bank account',
        },
      ])
      expect(mocks.create).not.toHaveBeenCalled()
    })

    it('rejects unexplained variances and an account path that does not own the statement', async () => {
      await expect(
        recordDraftCashEvidence(
          'u1',
          's1',
          {
            ...cashEvidence,
            cashBalances: [{ currency: 'AUD', amount: '99' }],
          },
          'a1'
        )
      ).rejects.toThrow('one explicit decision')
      await expect(
        recordDraftCashEvidence('u1', 's1', cashEvidence, 'other')
      ).rejects.toMatchObject({ status: 404 })
      expect(mocks.evidenceCreate).not.toHaveBeenCalled()
    })

    it('reuses same evidence key/content after replay changes, but rejects key rebinding', async () => {
      mocks.evidenceFindUnique.mockResolvedValue({
        id: 'existing-evidence',
        payloadHash: prepareDraftCashEvidence(
          cashEvidence,
          '2026-10-01',
          new Date('2026-11-02T10:00:00Z')
        ).payloadHash,
        balances: [{ currency: 'AUD', amount: new Decimal('100') }],
        decisions: [],
      })
      const retry = await recordDraftCashEvidence(
        'u1',
        's1',
        cashEvidence,
        'a1'
      )
      expect(retry).toMatchObject({
        evidenceId: 'existing-evidence',
        created: false,
      })
      expect(mocks.evidenceCreate).not.toHaveBeenCalled()
      await expect(
        recordDraftCashEvidence(
          'u1',
          's1',
          { ...cashEvidence, reference: 'different statement' },
          'a1'
        )
      ).rejects.toThrow('different content')
    })

    it('allows only sourced, positive, dated external deposit/withdrawal commands through the review workflow', async () => {
      const result = await saveDraftReconciliationCashOperation(
        'u1',
        's1',
        {
          idempotencyKey: 'bank-transfer-1',
          effectiveDate: '2026-10-02',
          sequence: 1,
          kind: 'DEPOSIT',
          currency: 'AUD',
          amount: '25',
          sourceReference: 'bank-ref-1',
        },
        'a1'
      )
      expect(result.replay.balances[0].endingAmount).toBe('125')
      expect(mocks.create.mock.calls[0][0].data.command).toMatchObject({
        source: { origin: 'MANUAL', reference: 'bank-ref-1' },
        kind: 'DEPOSIT',
      })
      expect(mocks.transactions).not.toHaveBeenCalled()
      await expect(
        saveDraftReconciliationCashOperation('u1', 's1', { kind: 'BUY' }, 'a1')
      ).rejects.toThrow('Only explicit dated manual deposits')
    })
  })

  it('reports changed boundary quantities separately from scenario differences', async () => {
    mocks.preview.mockResolvedValue({
      ...livePreview,
      parcels: [{ ...liveParcel, openingQuantity: '9' }],
    })
    const result = await reconcileDraftOpening('u1', 's1')
    expect(result.inventory[0]).toMatchObject({
      openingQuantity: '10',
      liveOpeningQuantity: '9',
      openingDifference: '1',
      proposedRemaining: '10',
      liveExpectedRemaining: '8',
      scenarioDifference: '2',
    })
    expect(result.reviewReasons).toContain('OPENING_INVENTORY_CHANGED')
  })

  it('bounds repeated overlap references rather than producing a quadratic partial report', async () => {
    mocks.rows.mockResolvedValue([
      proposal(openingSell, 'opening-sell'),
      {
        ...proposal(
          {
            ...openingSell,
            sequence: 2,
            quantity: '1',
            idempotencyKey: 'second',
          },
          'second-sale'
        ),
        id: 'second-op',
        proposedTrade: {
          ...proposal(
            {
              ...openingSell,
              sequence: 2,
              quantity: '1',
              idempotencyKey: 'second',
            },
            'second-sale'
          ).proposedTrade,
          operationId: 'second-op',
        },
      },
      {
        ...proposal(
          {
            ...openingSell,
            sequence: 3,
            quantity: '1',
            idempotencyKey: 'third',
          },
          'third-sale'
        ),
        id: 'third-op',
        proposedTrade: {
          ...proposal(
            {
              ...openingSell,
              sequence: 3,
              quantity: '1',
              idempotencyKey: 'third',
            },
            'third-sale'
          ).proposedTrade,
          operationId: 'third-op',
        },
      },
    ])
    mocks.transactions.mockResolvedValue(
      Array.from({ length: 33334 }, (_, index) => ({
        ...recordedSell,
        id: `source-${index}`,
      }))
    )
    await expect(reconcileDraftOpening('u1', 's1')).rejects.toMatchObject({
      status: 422,
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('retains missing and re-dated live source references as explicit review items', async () => {
    mocks.rows.mockResolvedValue([
      { ...stored(buy), tradeLinks: [{ transactionId: 't1' }] },
    ])
    for (const [transactions, reason] of [
      [[], 'MISSING_SOURCE'],
      [
        [{ ...recordedSell, id: 't1', date: new Date('2026-10-01') }],
        'ON_OR_BEFORE_BOUNDARY',
      ],
      [
        [{ ...recordedSell, id: 't1', date: new Date('2026-11-02') }],
        'AFTER_OBSERVATION_DATE',
      ],
    ] as const) {
      mocks.transactions.mockResolvedValue(transactions)
      const result = await reconcileDraftOpening('u1', 's1')
      expect(result.excludedLinkedSources).toEqual([
        { transactionId: 't1', operationId: 'op1', reason },
      ])
      expect(result.reviewReasons).toContain('LINKED_SOURCE_REQUIRES_REVIEW')
    }
  })

  it('separates a proposed scenario from live units and flags possible overlap without assigning live executions', async () => {
    mocks.rows.mockResolvedValue([proposal(openingSell, 'opening-sell')])
    const result = await reconcileDraftOpening('u1', 's1')
    expect(result).toMatchObject({
      mode: 'RECONCILIATION_ONLY',
      state: 'DRAFT',
      accountingActive: false,
      activationReady: false,
      source: { changed: false },
      cash: { verification: 'UNVERIFIED', funded: true },
    })
    expect(result.cash.balances[0].endingAmount).toBe('123')
    expect(result.inventory).toEqual([
      {
        positionId: 'legacy-position',
        openingParcelKey: 'opening:opening-row',
        openingQuantity: '10',
        liveOpeningQuantity: '10',
        openingDifference: '0',
        proposedRemaining: '6',
        liveExpectedRemaining: '8',
        liveRecordedRemaining: '8',
        scenarioDifference: '-2',
      },
    ])
    expect(result.tradeSources[0]).toMatchObject({
      transactionId: recordedSell.id,
      linkage: 'UNLINKED',
      operationId: null,
      potentialOverlapOperationIds: ['op1'],
    })
    expect(result.reviewReasons).toContain('PROPOSED_RECORDED_TRADE_OVERLAP')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.createRevision).not.toHaveBeenCalled()
    expect(mocks.position).not.toHaveBeenCalled()
    expect(mocks.statement).toHaveBeenCalledTimes(2)
    expect(mocks.transactions.mock.calls[0][0].where).toEqual({
      position: { accountId: 'a1', userId: 'u1' },
    })
  })

  it('reports source drift and missing/new live parcels without falsely confirming their units', async () => {
    mocks.preview.mockResolvedValue({
      ...livePreview,
      sourceFingerprint: 'b'.repeat(64),
      parcels: [{ ...liveParcel, positionId: 'new-position' }],
      issues: [
        {
          code: 'INVENTORY_MISMATCH',
          severity: 'BLOCKING',
          message: 'Mismatch',
          sourceId: 'new-position',
        },
      ],
    })
    const result = await reconcileDraftOpening('u1', 's1')
    expect(result.source.changed).toBe(true)
    expect(result.inventory).toEqual([
      expect.objectContaining({
        positionId: 'legacy-position',
        proposedRemaining: '10',
        liveRecordedRemaining: null,
        scenarioDifference: null,
      }),
      expect.objectContaining({
        positionId: 'new-position',
        openingQuantity: null,
        proposedRemaining: null,
        liveRecordedRemaining: '8',
        scenarioDifference: null,
      }),
    ])
    expect(result.reviewReasons).toContain('OPENING_SOURCE_CHANGED')
    expect(result.reviewReasons).toContain('LIVE_PREVIEW_BLOCKING_ISSUES')
  })

  it('compares source identity at the saved observation date rather than treating a new day as drift', async () => {
    mocks.preview.mockResolvedValueOnce({
      ...livePreview,
      asOfDate: '2026-11-01',
      sourceFingerprint: 'b'.repeat(64),
    })
    mocks.preview.mockResolvedValueOnce(livePreview)
    const result = await reconcileDraftOpening('u1', 's1')
    expect(result.asOfDate).toBe('2026-11-01')
    expect(result.source.changed).toBe(false)
    expect(mocks.preview.mock.calls[1][4]).toEqual(
      new Date('2026-10-31T01:00:00Z')
    )
  })

  it('classifies exact original live execution links and terminal reversed links separately', async () => {
    const command = {
      ...buy,
      kind: 'SELL',
      transactionIds: [recordedSell.id],
    }
    const row = {
      ...stored(command),
      tradeLinks: [{ transactionId: recordedSell.id }],
    }
    mocks.rows.mockResolvedValue([row])
    const linked = await reconcileDraftOpening('u1', 's1')
    expect(linked.tradeSources[0]).toMatchObject({
      linkage: 'LINKED',
      operationId: 'op1',
      potentialOverlapOperationIds: [],
    })
    expect(linked.reviewReasons).not.toContain(
      'RECORDED_TRADES_NOT_FULLY_LINKED'
    )
    const raw = { ...correction, replacement: null }
    const revision = storedRevision(raw)
    const prepared = prepareCashRevision(raw)
    mocks.rows.mockResolvedValue([
      {
        ...row,
        revisions: [
          {
            ...revision,
            postings: prepareRevisionLegs(
              prepareCashCommand(command).command,
              prepared.request.replacement
            ).map((leg, legIndex) => ({
              ...leg,
              legIndex,
              amount: new Decimal(leg.amount),
            })),
          },
        ],
      },
    ])
    const reversed = await reconcileDraftOpening('u1', 's1')
    expect(reversed.tradeSources[0].linkage).toBe('REVERSED')
    expect(reversed.reviewReasons).toContain('RECORDED_TRADES_NOT_FULLY_LINKED')
  })

  it('reports an imported execution as already represented when its transaction is linked under another source reference', async () => {
    const event = {
      id: 'event-duplicate',
      batchId: 'batch-1',
      externalId: 'KRAKEN:order:duplicate',
      kind: 'SELL',
      occurredAt: new Date('2026-10-02T00:00:00.000Z'),
      quoteCurrency: 'AUD',
      grossValue: new Decimal('60'),
      fee: new Decimal('1'),
      feeCurrency: 'AUD',
      appliedPositionIds: ['legacy-position'],
    }
    const transaction = {
      ...recordedSell,
      id: 'imported-transaction',
      type: 'SELL',
      brokerRef: event.externalId,
      position: {
        origin: 'MANUAL',
        positionType: 'LONG',
        asset: { exchange: { currency: 'AUD' } },
      },
    }
    const existing = {
      ...stored({
        ...buy,
        kind: 'SELL',
        fees: [{ currency: 'AUD', amount: '1' }],
        source: { origin: 'MANUAL', reference: 'reviewed-before-import' },
        transactionIds: [transaction.id],
      }),
      tradeLinks: [{ transactionId: transaction.id }],
    }
    mocks.rows.mockResolvedValue([existing])
    mocks.transactions.mockResolvedValue([transaction])
    mocks.importedEvents.mockResolvedValue([event])

    const result = await reconcileDraftOpening('u1', 's1')

    expect(result.cashImportExecutions).toMatchObject([
      {
        eventId: event.id,
        stageable: false,
        reason: 'TRANSACTION_ALREADY_LINKED',
        operationId: existing.id,
      },
    ])
  })

  it('excludes pre-boundary and future live transactions from the observed linkage report', async () => {
    mocks.transactions.mockResolvedValue([
      recordedSell,
      { ...recordedSell, id: 'boundary', date: new Date('2026-10-01') },
      { ...recordedSell, id: 'future', date: new Date('2026-11-02') },
    ])
    const result = await reconcileDraftOpening('u1', 's1')
    expect(result.tradeSources.map((row) => row.transactionId)).toEqual([
      recordedSell.id,
    ])
  })

  it('reports dated cash source references and operation status', async () => {
    mocks.rows.mockResolvedValue([stored(deposit)])

    const result = await reconcileDraftOpening('u1', 's1')

    expect(result.cashOperations).toEqual([
      {
        operationId: 'op1',
        currentRevisionId: 'op1',
        idempotencyKey: 'deposit-1',
        kind: 'DEPOSIT',
        effectiveDate: '2026-10-02',
        sequence: 1,
        sourceOrigin: 'MANUAL',
        sourceReference: 'bank-statement-1',
        cash: { currency: 'AUD', amount: '100' },
        revisions: [],
        status: 'EFFECTIVE',
      },
    ])
  })

  it('reports dated funding gaps without inventing funding or failing on a positive ending balance', async () => {
    mocks.rows.mockResolvedValue([
      {
        ...stored({
          ...buy,
          consideration: { currency: 'AUD', amount: '120' },
        }),
        tradeLinks: [{ transactionId: 't1' }],
      },
      {
        ...stored({ ...deposit, effectiveDate: '2026-10-03' }),
        id: 'deposit-op',
      },
    ])
    const result = await reconcileDraftOpening('u1', 's1')
    expect(result.cash.funded).toBe(false)
    expect(result.cash.balances[0].endingAmount).toBe('79')
    expect(result.cash.fundingIssues[0].balance).toBe('-21')
    expect(result.reviewReasons).toContain('DATED_FUNDING_GAP')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps new proposed parcels separate from live position references', async () => {
    mocks.rows.mockResolvedValue([proposal()])
    const result = await reconcileDraftOpening('u1', 's1')
    expect(result.proposedParcels).toEqual([
      expect.objectContaining({
        parcelKey: 'draft-buy',
        acquired: '10',
        remaining: '10',
      }),
    ])
    expect(result.inventory).toHaveLength(1)
    expect(result.inventory[0].proposedRemaining).toBe('10')
  })

  it('fails explicitly for missing ownership, corrupt history, invalid metadata and oversized reads', async () => {
    mocks.statement.mockResolvedValueOnce(null)
    await expect(reconcileDraftOpening('other', 's1')).rejects.toMatchObject({
      status: 404,
    })
    mocks.rows.mockResolvedValue([{ ...stored(), payloadHash: 'corrupt' }])
    await expect(reconcileDraftOpening('u1', 's1')).rejects.toThrow(
      'inconsistent'
    )
    mocks.rows.mockResolvedValue([])
    mocks.statement.mockResolvedValue({
      ...openingStatement,
      previewSnapshot: { ...openingStatement.previewSnapshot, asOfDate: 'bad' },
    })
    await expect(reconcileDraftOpening('u1', 's1')).rejects.toThrow(
      'source snapshot date'
    )
    mocks.statement.mockResolvedValue(openingStatement)
    mocks.transactions.mockResolvedValue(Array(50001).fill(recordedSell))
    await expect(reconcileDraftOpening('u1', 's1')).rejects.toMatchObject({
      status: 422,
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
})

function proposedCorrection(
  replacement: Record<string, unknown> | null = {
    ...proposedBuy,
    quantity: '8',
  }
) {
  return {
    idempotencyKey: 'trade-correction',
    expectedRevisionId: 'op1',
    reason: 'Correct proposed units',
    replacement: replacement
      ? {
          ...replacement,
          idempotencyKey: 'trade-correction',
        }
      : null,
  }
}

function proposedRevision(
  raw: unknown = proposedCorrection(),
  originalRequest: unknown = proposedBuy,
  tradeId = 'draft-buy'
) {
  const prepared = prepareDraftTradeRevision(raw, tradeId)
  const original = prepareDraftTradeCash(
    prepareDraftTradeRequest(originalRequest).request,
    tradeId
  ).command
  return {
    id: 'rev-trade',
    operationId: 'op1',
    statementId: 's1',
    revisionNumber: 1,
    previousRevisionId: null,
    request: prepared.request,
    payloadHash: prepared.payloadHash,
    idempotencyKey: prepared.request.idempotencyKey,
    reason: prepared.request.reason,
    postings: prepareRevisionLegs(original, prepared.request.replacement).map(
      (leg, legIndex) => ({ ...leg, legIndex, amount: new Decimal(leg.amount) })
    ),
  }
}

describe('atomic proposed trade corrections', () => {
  it('detects tampered replacement identities even when the combined audit hash is recomputed', async () => {
    const raw = proposedCorrection({ ...proposedBuy, assetId: 'other' })
    mocks.rows.mockResolvedValue([
      { ...proposal(), revisions: [proposedRevision(raw)] },
    ])
    await expect(saveDraftManualTrade('u1', 's1', proposedBuy)).rejects.toThrow(
      'cannot rebind'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })

  beforeEach(() => mocks.rows.mockResolvedValue([proposal()]))
  it('appends immutable combined trade/cash content and projects corrected units/cash', async () => {
    const result = await correctDraftManualTrade(
      'u1',
      's1',
      'op1',
      proposedCorrection()
    )
    expect(result).toMatchObject({ created: true, revisionId: 'rev1' })
    expect(result.parcels[0]).toMatchObject({ acquired: '8', remaining: '8' })
    expect(result.replay.balances[0].endingAmount).toBe('59')
    const data = mocks.createRevision.mock.calls[0][0].data
    expect(data.request.proposedTrade.quantity).toBe('8')
    expect(
      data.postings.create.map((leg: { amount: string }) => leg.amount)
    ).toEqual(['50', '1', '-40', '-1'])
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('replays corrected inventory for subsequent proposals and original retries', async () => {
    mocks.rows.mockResolvedValue([
      { ...proposal(), revisions: [proposedRevision()] },
    ])
    const originalRetry = await saveDraftManualTrade('u1', 's1', proposedBuy)
    expect(originalRetry.parcels[0].acquired).toBe('8')
    expect(originalRetry.replay.balances[0].endingAmount).toBe('59')
    const sale = await saveDraftManualTrade('u1', 's1', proposedSell)
    expect(sale.parcels[0].remaining).toBe('4')
    expect(sale.replay.balances[0].endingAmount).toBe('82')
    const retry = await correctDraftManualTrade(
      'u1',
      's1',
      'op1',
      proposedCorrection()
    )
    expect(retry.created).toBe(false)
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
  it('rejects reversals and quantity reductions that invalidate a dependent sale', async () => {
    const sold = proposal(proposedSell, 'sell1')
    mocks.rows.mockResolvedValue([
      proposal(),
      {
        ...sold,
        id: 'sale-op',
        proposedTrade: { ...sold.proposedTrade, operationId: 'sale-op' },
      },
    ])
    for (const correction of [
      proposedCorrection(null),
      proposedCorrection({ ...proposedBuy, quantity: '3' }),
    ])
      await expect(
        correctDraftManualTrade('u1', 's1', 'op1', correction)
      ).rejects.toMatchObject({ status: 422, name: 'Insufficient Draft Units' })
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
  it('reverses an unused BUY, preserving original retry identity with no economic parcel', async () => {
    const voided = proposedCorrection(null)
    mocks.rows.mockResolvedValue([
      { ...proposal(), revisions: [proposedRevision(voided)] },
    ])
    const retry = await saveDraftManualTrade('u1', 's1', proposedBuy)
    expect(retry.parcels).toEqual([])
    expect(retry.replay.balances[0].endingAmount).toBe('100')
    await expect(
      correctDraftManualTrade('u1', 's1', 'op1', {
        ...voided,
        idempotencyKey: 'next',
        expectedRevisionId: 'rev-trade',
      })
    ).rejects.toThrow('reversed operation')
  })
  it('rejects changing cash-equivalent trade content on an existing retry key', async () => {
    mocks.rows.mockResolvedValue([
      { ...proposal(), revisions: [proposedRevision()] },
    ])
    await expect(
      correctDraftManualTrade(
        'u1',
        's1',
        'op1',
        proposedCorrection({
          ...proposedBuy,
          quantity: '4',
          price: '10',
        })
      )
    ).rejects.toThrow('different correction content')
  })
  it.each([
    { ...proposedBuy, assetId: 'other' },
    { ...proposedBuy, currency: 'USD' },
  ])('refuses asset/currency rebinding %#', async (replacement) => {
    await expect(
      correctDraftManualTrade(
        'u1',
        's1',
        'op1',
        proposedCorrection(replacement)
      )
    ).rejects.toMatchObject({ status: 409 })
  })
  it('refuses cash-only operations and prevents independent cash corrections acquiring trade content', async () => {
    mocks.rows.mockResolvedValue([stored()])
    await expect(
      correctDraftManualTrade('u1', 's1', 'op1', proposedCorrection())
    ).rejects.toThrow('Only isolated proposed trades')
    await expect(
      correctDraftCashOperation(
        'u1',
        's1',
        'op1',
        prepareDraftTradeRevision(proposedCorrection(), 'draft-buy').request
      )
    ).rejects.toThrow('atomic draft trade correction writer')
  })
  it('rejects a cash-only audit attached to a proposal and proposed audit attached to capital', async () => {
    mocks.rows.mockResolvedValue([
      {
        ...proposal(),
        revisions: [storedRevision({ ...correction, replacement: null })],
      },
    ])
    await expect(
      correctDraftManualTrade('u1', 's1', 'op1', proposedCorrection())
    ).rejects.toThrow('atomic trade request')
    mocks.rows.mockResolvedValue([
      { ...stored(), revisions: [proposedRevision()] },
    ])
    await expect(
      correctDraftCashOperation('u1', 's1', 'op1', correction)
    ).rejects.toThrow('cannot acquire a proposed trade')
  })
  it('propagates revision-write failures rather than reporting corrected balances', async () => {
    mocks.createRevision.mockRejectedValue(
      new Error('Correction persistence failed')
    )
    await expect(
      correctDraftManualTrade('u1', 's1', 'op1', proposedCorrection())
    ).rejects.toThrow('Correction persistence failed')
  })
})

describe('immutable inactive cash corrections', () => {
  it('rejects imported sequence correction on a manual operation and validates URL ownership', async () => {
    mocks.rows.mockResolvedValue([stored()])
    const raw = {
      idempotencyKey: 'import-fix',
      expectedRevisionId: 'op1',
      reason: 'Broker sequence',
      sequence: 3,
    }
    await expect(
      correctDraftImportedExecutionCash('u1', 'a1', 's1', 'op1', raw)
    ).rejects.toThrow('Only imported')
    await expect(
      correctDraftImportedExecutionCash('u1', 'other', 's1', 'op1', raw)
    ).rejects.toMatchObject({ status: 404 })
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })

  it('rejects stored imported financial changes or reversal even if hashes and posting audit match', async () => {
    const imported = {
      ...buy,
      idempotencyKey: 'import-event:e1',
      source: { origin: 'IMPORT', reference: 'KRAKEN:order:1' },
    }
    for (const replacement of [
      null,
      {
        ...imported,
        idempotencyKey: 'correction-1',
        consideration: { currency: 'AUD', amount: '59' },
      },
      {
        ...imported,
        idempotencyKey: 'correction-1',
        effectiveDate: '2026-10-03',
      },
      { ...imported, idempotencyKey: 'correction-1', fees: [] },
    ]) {
      mocks.rows.mockResolvedValue([
        {
          ...stored(imported),
          tradeLinks: [{ transactionId: 't1' }],
          revisions: [
            storedRevision(
              {
                idempotencyKey: 'correction-1',
                expectedRevisionId: 'op1',
                reason: 'Corrupt source economics',
                replacement,
              },
              imported
            ),
          ],
        },
      ])
      await expect(
        correctDraftImportedExecutionCash('u1', 'a1', 's1', 'op1', {
          idempotencyKey: 'next',
          expectedRevisionId: 'rev1',
          reason: 'Review',
          sequence: 3,
        })
      ).rejects.toThrow(
        'Stored imported correction must retain execution values'
      )
    }
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
  it('scopes review corrections to the URL account and derives unchanged source identity', async () => {
    mocks.rows.mockResolvedValue([stored()])
    const raw = {
      idempotencyKey: 'capital-correction',
      expectedRevisionId: 'op1',
      reason: 'Correct bank amount',
      replacement: { effectiveDate: '2026-10-03', sequence: 3, amount: '80' },
    }
    await expect(
      correctDraftReconciliationCashOperation(
        'u1',
        'wrong-account',
        's1',
        'op1',
        raw
      )
    ).rejects.toMatchObject({ status: 404 })
    expect(mocks.createRevision).not.toHaveBeenCalled()
    const result = await correctDraftReconciliationCashOperation(
      'u1',
      'a1',
      's1',
      'op1',
      raw
    )
    expect(result).toMatchObject({ revisionId: 'rev1', created: true })
    expect(result.replay.balances[0].endingAmount).toBe('180')
    expect(
      mocks.createRevision.mock.calls[0][0].data.request.replacement
    ).toMatchObject({
      accountId: 'a1',
      kind: 'DEPOSIT',
      source: deposit.source,
      cash: { currency: 'AUD', amount: '80' },
    })
  })

  it('rechecks the URL account after locking and refuses trade corrections through review', async () => {
    const raw = {
      idempotencyKey: 'k',
      expectedRevisionId: 'op1',
      reason: 'Fix',
      replacement: null,
    }
    mocks.statement
      .mockResolvedValueOnce(statement)
      .mockResolvedValueOnce({ ...statement, accountId: 'other' })
    await expect(
      correctDraftReconciliationCashOperation('u1', 'a1', 's1', 'op1', raw)
    ).rejects.toMatchObject({ status: 404 })
    mocks.statement.mockResolvedValue(statement)
    mocks.rows.mockResolvedValue([
      { ...stored(buy), tradeLinks: [{ transactionId: 't1' }] },
    ])
    await expect(
      correctDraftReconciliationCashOperation('u1', 'a1', 's1', 'op1', raw)
    ).rejects.toThrow('Only manual deposits and withdrawals')
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
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
