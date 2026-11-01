import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('./prisma.js').prisma
let ledger: typeof import('./draft-cash-ledger.js')
let userId: string | undefined
const statementIds: string[] = []

async function fixture(amount = '100') {
  if (!userId) throw new Error('Missing disposable correction fixture user')
  const account = await prisma.tradingAccount.create({
    data: { userId, name: `Correction fixture ${randomUUID()}` },
  })
  const opening = {
    openingDate: '2026-10-01',
    cashBalances: [{ currency: 'AUD', amount }],
  }
  const preview = await (
    await import('./accounting-preview-service.js')
  ).previewAccountOpening(userId, account.id, opening)
  const saved = await (
    await import('./opening-statements.js')
  ).saveOpeningStatement(userId, account.id, {
    ...opening,
    sourceFingerprint: preview.sourceFingerprint,
  })
  statementIds.push(saved.statement.id)
  const command = {
    accountId: account.id,
    kind: 'DEPOSIT',
    idempotencyKey: randomUUID(),
    source: { origin: 'MANUAL', reference: randomUUID() },
    effectiveDate: '2026-10-02',
    sequence: 1,
    cash: { currency: 'AUD', amount: '100' },
  }
  const root = await ledger.saveDraftCashOperation(
    userId,
    saved.statement.id,
    command
  )
  const key = randomUUID()
  const correction = {
    idempotencyKey: key,
    expectedRevisionId: root.operationId,
    reason: 'Fix fixture bank amount',
    replacement: {
      ...command,
      idempotencyKey: key,
      cash: { currency: 'AUD', amount: '60' },
    },
  }
  return {
    userId,
    accountId: account.id,
    statementId: saved.statement.id,
    root,
    command,
    correction,
  }
}

describe.skipIf(!enabled)(
  'cash correction audit on disposable localhost fixtures',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Correction tests require a localhost database')
      prisma = (await import('./prisma.js')).prisma
      ledger = await import('./draft-cash-ledger.js')
      userId = (
        await prisma.user.create({
          data: {
            email: `correction-fixture-${randomUUID()}@example.invalid`,
            passwordHash: 'fixture-not-a-login',
          },
        })
      ).id
    })
    afterEach(() => vi.restoreAllMocks())
    afterAll(async () => {
      vi.restoreAllMocks()
      try {
        if (userId) await prisma.user.delete({ where: { id: userId } })
        expect(
          await prisma.draftCashRevision.count({
            where: { statementId: { in: statementIds } },
          })
        ).toBe(0)
        expect(
          await prisma.draftCashRevisionPosting.count({
            where: { revision: { statementId: { in: statementIds } } },
          })
        ).toBe(0)
      } finally {
        if (prisma) await prisma.$disconnect()
      }
    })

    it('retains immutable original/postings and appends exact linked correction revisions', async () => {
      const f = await fixture()
      const before = await prisma.draftCashOperation.findUniqueOrThrow({
        where: { id: f.root.operationId },
        include: { postings: true },
      })
      const corrected = await ledger.correctDraftCashOperation(
        f.userId,
        f.statementId,
        f.root.operationId,
        f.correction
      )
      expect(corrected.replay.balances[0].endingAmount).toBe('160')
      expect(
        await prisma.draftCashOperation.findUniqueOrThrow({
          where: { id: f.root.operationId },
          include: { postings: true },
        })
      ).toEqual(before)
      const revision = await prisma.draftCashRevision.findUniqueOrThrow({
        where: { id: corrected.revisionId },
        include: { postings: { orderBy: { legIndex: 'asc' } } },
      })
      expect(revision.revisionNumber).toBe(1)
      expect(
        revision.postings.map((row) => [row.phase, row.amount.toFixed()])
      ).toEqual([
        ['REVERSAL', '-100'],
        ['REPLACEMENT', '60'],
      ])
      const key = randomUUID()
      const second = {
        ...f.correction,
        idempotencyKey: key,
        expectedRevisionId: revision.id,
        replacement: {
          ...f.command,
          idempotencyKey: key,
          cash: { currency: 'AUD', amount: '70' },
        },
      }
      const next = await ledger.correctDraftCashOperation(
        f.userId,
        f.statementId,
        f.root.operationId,
        second
      )
      expect(next.replay.balances[0].endingAmount).toBe('170')
      expect(
        await prisma.draftCashRevision.findUniqueOrThrow({
          where: { id: next.revisionId },
        })
      ).toMatchObject({ previousRevisionId: revision.id, revisionNumber: 2 })
      const retry = await ledger.correctDraftCashOperation(
        f.userId,
        f.statementId,
        f.root.operationId,
        f.correction
      )
      expect(retry).toMatchObject({ revisionId: revision.id, created: false })
      expect(retry.replay.balances[0].endingAmount).toBe('170')
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: f.root.operationId },
        })
      ).toBe(2)
    })

    it('competing corrections to one head succeed at most once; identical retries reuse the winner', async () => {
      const f = await fixture()
      const key = randomUUID()
      const second = {
        ...f.correction,
        idempotencyKey: key,
        replacement: {
          ...f.correction.replacement,
          idempotencyKey: key,
          cash: { currency: 'AUD', amount: '80' },
        },
      }
      const results = await Promise.allSettled([
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          f.root.operationId,
          f.correction
        ),
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          f.root.operationId,
          second
        ),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { status: 409 },
      })
      const winner = results[0].status === 'fulfilled' ? f.correction : second
      const retries = await Promise.all([
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          f.root.operationId,
          winner
        ),
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          f.root.operationId,
          winner
        ),
      ])
      expect(retries.every((r) => !r.created)).toBe(true)
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: f.root.operationId },
        })
      ).toBe(1)
    })

    it('rechecks all historical funding when reducing or moving a deposit, not just ending cash', async () => {
      const f = await fixture('0')
      await ledger.saveDraftCashOperation(f.userId, f.statementId, {
        ...f.command,
        kind: 'WITHDRAWAL',
        idempotencyKey: randomUUID(),
        source: { origin: 'MANUAL', reference: randomUUID() },
        sequence: 2,
        cash: { currency: 'AUD', amount: '90' },
      })
      await ledger.saveDraftCashOperation(f.userId, f.statementId, {
        ...f.command,
        idempotencyKey: randomUUID(),
        source: { origin: 'MANUAL', reference: randomUUID() },
        effectiveDate: '2026-10-03',
      })
      for (const replacement of [
        f.correction.replacement,
        null,
        {
          ...f.correction.replacement,
          effectiveDate: '2026-10-04',
          cash: { currency: 'AUD', amount: '100' },
        },
      ]) {
        await expect(
          ledger.correctDraftCashOperation(
            f.userId,
            f.statementId,
            f.root.operationId,
            {
              ...f.correction,
              replacement,
            }
          )
        ).rejects.toMatchObject({ status: 422, name: 'Insufficient Cash' })
      }
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: f.root.operationId },
        })
      ).toBe(0)
    })

    it('correction and competing withdrawal cannot both spend the same cash', async () => {
      const f = await fixture('0')
      const results = await Promise.allSettled([
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          f.root.operationId,
          f.correction
        ),
        ledger.saveDraftCashOperation(f.userId, f.statementId, {
          ...f.command,
          kind: 'WITHDRAWAL',
          idempotencyKey: randomUUID(),
          source: { origin: 'MANUAL', reference: randomUUID() },
          sequence: 2,
          cash: { currency: 'AUD', amount: '90' },
        }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { status: 422 },
      })
    })

    it('reversal removes only the original economic cash and never allows source reuse', async () => {
      const f = await fixture()
      const voided = { ...f.correction, replacement: null }
      const result = await ledger.correctDraftCashOperation(
        f.userId,
        f.statementId,
        f.root.operationId,
        voided
      )
      expect(result.replay.balances[0]).toMatchObject({
        endingAmount: '100',
        netExternalContribution: '0',
      })
      await expect(
        ledger.saveDraftCashOperation(f.userId, f.statementId, {
          ...f.command,
          idempotencyKey: randomUUID(),
          sequence: 2,
        })
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          f.root.operationId,
          {
            ...voided,
            idempotencyKey: randomUUID(),
            expectedRevisionId: result.revisionId,
          }
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(
        (
          await ledger.saveDraftCashOperation(
            f.userId,
            f.statementId,
            f.command
          )
        ).replay.balances[0].endingAmount
      ).toBe('100')
    })

    it('rolls back the revision and all its postings if commit fails', async () => {
      const f = await fixture()
      const transact = prisma.$transaction.bind(prisma)
      const failure = new Error('Injected rollback after child writes')
      vi.spyOn(prisma, '$transaction').mockImplementationOnce((callback) => {
        if (typeof callback !== 'function')
          throw new Error('Expected interactive transaction')
        return transact(async (db) => {
          await callback(db)
          throw failure
        })
      })
      await expect(
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          f.root.operationId,
          f.correction
        )
      ).rejects.toBe(failure)
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: f.root.operationId },
        })
      ).toBe(0)
      expect(
        (
          await ledger.saveDraftCashOperation(
            f.userId,
            f.statementId,
            f.command
          )
        ).replay.balances[0].endingAmount
      ).toBe('200')
    })

    it('database foreign keys prevent crossing opening statements or operation predecessor chains', async () => {
      const f = await fixture()
      const other = await fixture()
      const saved = await ledger.correctDraftCashOperation(
        f.userId,
        f.statementId,
        f.root.operationId,
        f.correction
      )
      const base = {
        operationId: f.root.operationId,
        statementId: other.statementId,
        revisionNumber: 2,
        idempotencyKey: randomUUID(),
        payloadHash: 'fixture-hash',
        reason: 'Invalid fixture cross-statement link',
        request: { ...f.correction },
      }
      await expect(
        prisma.draftCashRevision.create({ data: base })
      ).rejects.toMatchObject({ code: 'P2003' })
      await expect(
        prisma.draftCashRevision.create({
          data: {
            ...base,
            operationId: other.root.operationId,
            previousRevisionId: saved.revisionId,
            idempotencyKey: randomUUID(),
          },
        })
      ).rejects.toMatchObject({ code: 'P2003' })
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: other.root.operationId },
        })
      ).toBe(0)
    })

    it('rejects cross-statement corrections and detects tampered reversal postings', async () => {
      const f = await fixture()
      const other = await fixture()
      await expect(
        ledger.correctDraftCashOperation(
          f.userId,
          other.statementId,
          f.root.operationId,
          f.correction
        )
      ).rejects.toMatchObject({ status: 404 })
      const result = await ledger.correctDraftCashOperation(
        f.userId,
        f.statementId,
        f.root.operationId,
        f.correction
      )
      const posting = await prisma.draftCashRevisionPosting.findFirstOrThrow({
        where: { revisionId: result.revisionId, phase: 'REVERSAL' },
      })
      await prisma.draftCashRevisionPosting.update({
        where: { id: posting.id },
        data: { amount: '-99' },
      })
      await expect(
        ledger.saveDraftCashOperation(f.userId, f.statementId, f.command)
      ).rejects.toThrow('inconsistent')
    })
  }
)
