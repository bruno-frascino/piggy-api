import { Decimal } from 'decimal.js'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lock: vi.fn(),
  statementFindFirst: vi.fn(),
  statementFindMany: vi.fn(),
  statementUpdate: vi.fn(),
  ledgerFindUnique: vi.fn(),
  ledgerCreate: vi.fn(),
  operationCount: vi.fn(),
  postingCount: vi.fn(),
  revisionCount: vi.fn(),
  revisionPostingCount: vi.fn(),
  operationFindMany: vi.fn(),
  evidenceFindMany: vi.fn(),
  preview: vi.fn(),
  lockActiveUser: vi.fn(),
}))

vi.mock('./prisma.js', () => ({
  prisma: { $transaction: mocks.transaction },
}))
vi.mock('./user-lock.js', () => ({
  lockActiveUser: mocks.lockActiveUser,
}))
vi.mock('./accounting-preview-service.js', () => ({
  readAccountOpeningPreview: mocks.preview,
}))

import { confirmOpeningStatement } from './draft-cash-ledger.js'
import { prepareDraftCashEvidence } from './draft-cash-evidence.js'
import { prepareOpeningConfirmation } from './opening-confirmation.js'
import {
  parseOpeningPreviewInput,
  sydneyCalendarDate,
} from './accounting-preview.js'
import { prepareCashCommand } from './cash-ledger.js'

const fingerprint = 'a'.repeat(64)
const userId = 'u1'
const accountId = 'a1'
const statementId = 's1'
const confirmation = {
  idempotencyKey: 'confirm-1',
  expectedSourceFingerprint: fingerprint,
  acknowledgements: {
    openingBalancesReviewed: true,
    cashEvidenceUserAttested: true,
    priorDraftActivityExcluded: true,
    returnsUnavailableWithoutValuations: true,
  },
}

function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T12:00:00.000Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

beforeEach(() => {
  vi.resetAllMocks()
  const today = sydneyCalendarDate(new Date())
  const evidenceDate = shiftDate(today, -1)
  const openingDate = shiftDate(today, -3)
  const cashBalances = [{ currency: 'AUD', amount: '100' }]
  const openingInput = parseOpeningPreviewInput({
    openingDate,
    cashBalances,
  })
  const rawEvidence = {
    idempotencyKey: 'evidence-1',
    asOfDate: evidenceDate,
    source: 'Example Bank',
    reference: 'Statement 1',
    attested: true,
    cashBalances,
    decisions: [],
  }
  const evidence = prepareDraftCashEvidence(rawEvidence, openingDate)
  const statement = {
    id: statementId,
    accountId,
    state: 'DRAFT',
    timezone: 'Australia/Sydney',
    openingDate: new Date(`${openingDate}T00:00:00.000Z`),
    cashBalances: [{ currency: 'AUD', amount: new Decimal('100') }],
    parcels: [],
    previewSnapshot: { asOfDate: evidenceDate, parcels: [] },
    sourceFingerprint: fingerprint,
    inputHash: createHash('sha256')
      .update(JSON.stringify(openingInput))
      .digest('hex'),
    account: { id: accountId, status: 'ACTIVE', isDemo: false },
  }
  mocks.lock.mockResolvedValue([{ id: accountId }])
  mocks.statementFindFirst.mockResolvedValue(statement)
  mocks.statementFindMany.mockResolvedValue([])
  mocks.statementUpdate.mockResolvedValue({ id: statementId })
  mocks.ledgerFindUnique.mockResolvedValue(null)
  mocks.ledgerCreate.mockResolvedValue({ accountId })
  mocks.operationCount.mockResolvedValue(0)
  mocks.postingCount.mockResolvedValue(0)
  mocks.revisionCount.mockResolvedValue(0)
  mocks.revisionPostingCount.mockResolvedValue(0)
  mocks.operationFindMany.mockResolvedValue([])
  mocks.evidenceFindMany.mockResolvedValue([
    {
      id: 'evidence-row-1',
      idempotencyKey: rawEvidence.idempotencyKey,
      asOfDate: new Date(`${evidenceDate}T00:00:00.000Z`),
      source: rawEvidence.source,
      reference: rawEvidence.reference,
      attested: rawEvidence.attested,
      payloadHash: evidence.payloadHash,
      balances: [{ currency: 'AUD', amount: new Decimal('100') }],
      decisions: [],
    },
  ])
  mocks.preview.mockResolvedValue({
    asOfDate: today,
    sourceFingerprint: fingerprint,
    issues: [],
    counts: { postBoundaryTrades: 0 },
  })
  mocks.transaction.mockImplementation(
    async (callback: (db: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: mocks.lock,
        accountOpeningStatement: {
          findFirst: mocks.statementFindFirst,
          findMany: mocks.statementFindMany,
          update: mocks.statementUpdate,
        },
        accountCashLedger: {
          findUnique: mocks.ledgerFindUnique,
          create: mocks.ledgerCreate,
        },
        draftOperationTradeLink: { count: mocks.operationCount },
        draftCashPosting: { count: mocks.postingCount },
        draftCashRevision: { count: mocks.revisionCount },
        draftCashRevisionPosting: { count: mocks.revisionPostingCount },
        draftCashOperation: { findMany: mocks.operationFindMany },
        draftCashEvidence: { findMany: mocks.evidenceFindMany },
        importedEvent: { findMany: vi.fn() },
        transaction: { findMany: vi.fn() },
      })
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reviewed opening confirmation', () => {
  it('retries a serialization conflict without changing the request identity', async () => {
    mocks.transaction.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Serialization conflict'), {
        code: 'P2034',
      })
    })

    await expect(
      confirmOpeningStatement(userId, accountId, statementId, confirmation)
    ).resolves.toMatchObject({ created: true, statementId, accountId })
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
    expect(mocks.ledgerCreate).toHaveBeenCalledTimes(1)
  })

  it('creates an audited ledger once and returns the original result on an identical retry', async () => {
    const first = await confirmOpeningStatement(
      userId,
      accountId,
      statementId,
      confirmation
    )

    expect(first).toMatchObject({
      accountId,
      statementId,
      ledgerState: 'ACTIVE',
      created: true,
    })
    expect(mocks.statementUpdate).toHaveBeenCalledWith({
      where: { id: statementId },
      data: { state: 'CONFIRMED' },
    })
    expect(mocks.ledgerCreate).toHaveBeenCalledTimes(1)
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId,
          openingStatementId: statementId,
          state: 'ACTIVE',
          confirmedByUserId: userId,
          confirmationIdempotencyKey: confirmation.idempotencyKey,
        }),
      })
    )

    const prepared = prepareOpeningConfirmation(confirmation)
    const savedStatement = await mocks.statementFindFirst.mock.results[0]?.value
    mocks.statementFindFirst.mockResolvedValueOnce({
      ...savedStatement,
      state: 'CONFIRMED',
    })
    mocks.ledgerFindUnique.mockResolvedValueOnce({
      openingStatementId: statementId,
      state: 'ACTIVE',
      confirmationIdempotencyKey: confirmation.idempotencyKey,
      confirmationPayloadHash: prepared.payloadHash,
      confirmedAt: new Date(),
      confirmedByUserId: userId,
      confirmationAudit: first.confirmationAudit,
    })

    const retry = await confirmOpeningStatement(
      userId,
      accountId,
      statementId,
      confirmation
    )
    expect(retry).toMatchObject({ created: false, statementId, accountId })
    expect(mocks.ledgerCreate).toHaveBeenCalledTimes(1)
  })

  it('blocks saved activity on the selected draft before creating a ledger', async () => {
    const evidenceDate = shiftDate(sydneyCalendarDate(new Date()), -1)
    const command = prepareCashCommand({
      accountId,
      idempotencyKey: 'saved-operation',
      source: { origin: 'MANUAL', reference: 'deposit-1' },
      effectiveDate: evidenceDate,
      sequence: 1,
      kind: 'DEPOSIT',
      cash: { currency: 'AUD', amount: '1' },
    })
    mocks.operationFindMany.mockResolvedValue([
      {
        id: 'saved-operation',
        statementId,
        state: 'DRAFT',
        methodology: command.methodology,
        command: command.command,
        payloadHash: command.payloadHash,
        idempotencyKey: command.command.idempotencyKey,
        kind: command.command.kind,
        sourceOrigin: command.command.source.origin,
        sourceReference: command.command.source.reference,
        effectiveDate: new Date(`${evidenceDate}T00:00:00.000Z`),
        sequence: BigInt(command.command.sequence),
        postings: command.legs.map((leg, legIndex) => ({
          ...leg,
          legIndex,
          amount: new Decimal(leg.amount),
        })),
        tradeLinks: [],
        revisions: [],
        proposedTrade: null,
      },
    ])

    await expect(
      confirmOpeningStatement(userId, accountId, statementId, confirmation)
    ).rejects.toThrow(/contains saved activity/)
    expect(mocks.ledgerCreate).not.toHaveBeenCalled()
    expect(mocks.statementUpdate).not.toHaveBeenCalled()
  })

  it('blocks source drift discovered at the reviewed observation date', async () => {
    mocks.preview.mockResolvedValue({
      asOfDate: '2000-01-01',
      sourceFingerprint: 'b'.repeat(64),
      issues: [],
      counts: { postBoundaryTrades: 0 },
    })

    await expect(
      confirmOpeningStatement(userId, accountId, statementId, confirmation)
    ).rejects.toThrow(/source records changed after review/)
    expect(mocks.ledgerCreate).not.toHaveBeenCalled()
  })
})
