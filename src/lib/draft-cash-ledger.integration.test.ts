import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('./prisma.js').prisma
let userId: string | undefined
let exchangeId: string | undefined

async function fixture(
  amount = '100',
  withTrade = false,
  withImportedTrade = false
) {
  if (!userId) throw new Error('Missing isolated cash fixture')
  const account = await prisma.tradingAccount.create({
    data: { userId, name: `Cash fixture ${randomUUID()}` },
  })
  let transactionId: string | undefined
  let eventId: string | undefined
  if (withTrade) {
    if (!exchangeId) throw new Error('Missing fixture exchange')
    const asset = await prisma.asset.create({
      data: {
        symbol: `FIXTURE-${randomUUID()}`,
        name: 'Disposable cash test asset',
        exchangeId,
      },
    })
    const position = await prisma.position.create({
      data: {
        userId,
        accountId: account.id,
        assetId: asset.id,
        openDate: new Date('2026-10-02T00:00:00Z'),
        entryPrice: '60',
        quantity: 1,
        totalBuyValue: '60',
        buyFees: '1',
        capitalAllocated: '61',
        transactions: {
          create: {
            type: 'BUY',
            date: new Date('2026-10-02T00:00:00Z'),
            quantity: 1,
            price: '60',
            totalValue: '60',
            fees: '1',
          },
        },
      },
      include: { transactions: true },
    })
    transactionId = position.transactions[0].id
  } else if (withImportedTrade) {
    if (!exchangeId) throw new Error('Missing fixture exchange')
    const externalId = `KRAKEN:order:${randomUUID()}`
    const asset = await prisma.asset.create({
      data: {
        symbol: `FIXTURE-${randomUUID()}`,
        name: 'Disposable imported cash test asset',
        exchangeId,
      },
    })
    const position = await prisma.position.create({
      data: {
        userId,
        accountId: account.id,
        assetId: asset.id,
        openDate: new Date('2026-10-02T00:00:00Z'),
        entryPrice: '60',
        quantity: 1,
        totalBuyValue: '60',
        buyFees: '1',
        capitalAllocated: '61',
        origin: 'IMPORT_TRADE',
        externalRef: externalId,
        transactions: {
          create: {
            type: 'BUY',
            date: new Date('2026-10-02T00:00:00Z'),
            quantity: 1,
            price: '60',
            totalValue: '60',
            fees: '1',
            brokerRef: externalId,
          },
        },
      },
      include: { transactions: true },
    })
    transactionId = position.transactions[0].id
    const batch = await prisma.importBatch.create({
      data: {
        userId,
        accountId: account.id,
        source: 'KRAKEN',
        method: 'CSV',
        status: 'COMMITTED',
        fileNames: ['cash-fixture.csv'],
      },
    })
    const event = await prisma.importedEvent.create({
      data: {
        batchId: batch.id,
        userId,
        source: 'KRAKEN',
        externalId,
        kind: 'BUY',
        status: 'APPLIED',
        occurredAt: new Date('2026-10-02T00:00:00Z'),
        baseAsset: 'FIXTURE',
        quoteCurrency: 'AUD',
        exchangeCode: 'KRAKEN:AUD',
        quantity: '1',
        price: '60',
        grossValue: '60',
        fee: '1',
        feeCurrency: 'AUD',
        appliedPositionIds: [position.id],
        raw: {},
      },
    })
    eventId = event.id
  }
  const { previewAccountOpening } =
    await import('./accounting-preview-service.js')
  const { saveOpeningStatement } = await import('./opening-statements.js')
  const input = {
    openingDate: '2026-10-01',
    cashBalances: [{ currency: 'AUD', amount }],
  }
  const preview = await previewAccountOpening(userId, account.id, input)
  const saved = await saveOpeningStatement(userId, account.id, {
    ...input,
    sourceFingerprint: preview.sourceFingerprint,
  })
  return {
    userId,
    accountId: account.id,
    statementId: saved.statement.id,
    transactionId,
    eventId,
  }
}

function capital(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    kind: 'DEPOSIT',
    idempotencyKey: 'capital-1',
    source: { origin: 'MANUAL', reference: 'cash-statement-1' },
    effectiveDate: '2026-10-03',
    sequence: 1,
    cash: { currency: 'AUD', amount: '0.000000000001' },
    ...overrides,
  }
}

describe.skipIf(!enabled)(
  'inactive cash persistence on disposable localhost fixtures',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Cash integration tests require a localhost database')
      prisma = (await import('./prisma.js')).prisma
      const user = await prisma.user.create({
        data: {
          email: `cash-fixture-${randomUUID()}@example.invalid`,
          passwordHash: 'test-fixture-not-a-login',
        },
      })
      userId = user.id
      exchangeId = (
        await prisma.exchange.create({
          data: {
            code: `FIXTURE-${randomUUID()}`,
            name: 'Disposable cash fixture',
            currency: 'AUD',
            countryName: 'Australia',
            countryCode: 'AU',
          },
        })
      ).id
    })
    afterAll(async () => {
      try {
        if (userId) {
          const statements = await prisma.accountOpeningStatement.findMany({
            where: { account: { userId } },
            select: { id: true },
          })
          const operationIds = (
            await prisma.draftCashOperation.findMany({
              where: { statementId: { in: statements.map((row) => row.id) } },
              select: { id: true },
            })
          ).map((row) => row.id)
          await prisma.user.delete({ where: { id: userId } })
          expect(
            await prisma.draftCashOperation.count({
              where: { id: { in: operationIds } },
            })
          ).toBe(0)
          expect(
            await prisma.draftCashPosting.count({
              where: { operationId: { in: operationIds } },
            })
          ).toBe(0)
          expect(
            await prisma.draftOperationTradeLink.count({
              where: { operationId: { in: operationIds } },
            })
          ).toBe(0)
        }
        if (exchangeId) {
          await prisma.asset.deleteMany({ where: { exchangeId } })
          await prisma.exchange.delete({ where: { id: exchangeId } })
        }
      } finally {
        if (prisma) await prisma.$disconnect()
      }
    })
    it('deduplicates concurrent identical commands and persists exact posting decimals', async () => {
      const { saveDraftCashOperation } = await import('./draft-cash-ledger.js')
      const f = await fixture()
      const raw = capital(f.accountId)
      const results = await Promise.all([
        saveDraftCashOperation(f.userId, f.statementId, raw),
        saveDraftCashOperation(f.userId, f.statementId, raw),
      ])
      expect(results.map((row) => row.created).sort()).toEqual([false, true])
      expect(results[0].operationId).toBe(results[1].operationId)
      expect(results[0].replay.balances[0].endingAmount).toBe(
        '100.000000000001'
      )
      const rows = await prisma.draftCashOperation.findMany({
        where: { statementId: f.statementId },
        include: { postings: true },
      })
      expect(rows).toHaveLength(1)
      expect(rows[0].postings[0].amount.toFixed()).toBe('0.000000000001')
      expect(rows[0].state).toBe('DRAFT')
      expect(
        await prisma.portfolioSnapshot.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
      expect(
        await prisma.position.count({ where: { accountId: f.accountId } })
      ).toBe(0)
    })
    it('stages manual BUY and SELL cash once with source-derived values and rejects unsupported source identities', async () => {
      const { saveDraftManualExecutionCash, reconcileDraftOpening } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100', true)
      if (!f.transactionId) throw new Error('Missing fixture trade')
      const buy = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.transactionId },
      })
      const sale = await prisma.transaction.create({
        data: {
          positionId: buy.positionId,
          type: 'SELL',
          date: new Date('2026-10-03T00:00:00Z'),
          quantity: 0.5,
          price: '80',
          totalValue: '40',
          fees: '1',
        },
      })
      const { recomputePositionFromTransactions } =
        await import('./position-service.js')
      await recomputePositionFromTransactions(buy.positionId)
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const { saveOpeningStatement } = await import('./opening-statements.js')
      const input = {
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '100' }],
      }
      const preview = await previewAccountOpening(f.userId, f.accountId, input)
      const statement = await saveOpeningStatement(f.userId, f.accountId, {
        ...input,
        sourceFingerprint: preview.sourceFingerprint,
      })
      const statementId = statement.statement.id
      const initialReport = await reconcileDraftOpening(
        f.userId,
        statementId,
        f.accountId
      )
      expect(initialReport.cashManualExecutions).toHaveLength(2)
      expect(
        initialReport.cashManualExecutions.every((row) => row.stageable)
      ).toBe(true)
      const results = await Promise.all([
        saveDraftManualExecutionCash(
          f.userId,
          f.accountId,
          statementId,
          buy.id,
          1
        ),
        saveDraftManualExecutionCash(
          f.userId,
          f.accountId,
          statementId,
          buy.id,
          1
        ),
      ])
      expect(results.map((row) => row.created).sort()).toEqual([false, true])
      const sold = await saveDraftManualExecutionCash(
        f.userId,
        f.accountId,
        statementId,
        sale.id,
        1
      )
      expect(sold.replay.balances[0].endingAmount).toBe('78')
      const report = await reconcileDraftOpening(
        f.userId,
        statementId,
        f.accountId
      )
      expect(
        report.cashManualExecutions.every(
          (row) => row.reason === 'ALREADY_LINKED'
        )
      ).toBe(true)
      expect(report.tradeSources.every((row) => row.linkage === 'LINKED')).toBe(
        true
      )
      expect(report.accountingActive).toBe(false)
      await expect(
        saveDraftManualExecutionCash(
          f.userId,
          'wrong-account',
          statementId,
          buy.id,
          1
        )
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        saveDraftManualExecutionCash(
          f.userId,
          f.accountId,
          statementId,
          buy.id,
          2
        )
      ).rejects.toMatchObject({ status: 409 })
      await prisma.transaction.update({
        where: { id: sale.id },
        data: { brokerRef: 'KRAKEN:order:reserved' },
      })
      await expect(
        saveDraftManualExecutionCash(
          f.userId,
          f.accountId,
          statementId,
          sale.id,
          1
        )
      ).rejects.toMatchObject({ status: 404 })
      expect(
        await prisma.transaction.count({
          where: { positionId: buy.positionId },
        })
      ).toBe(2)
    })
    it('rolls back unaffordable manual staging without changing the source trade', async () => {
      const { saveDraftManualExecutionCash } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('60', true)
      if (!f.transactionId) throw new Error('Missing fixture trade')
      const before = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.transactionId },
      })
      await expect(
        saveDraftManualExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          f.transactionId,
          1
        )
      ).rejects.toMatchObject({ status: 422 })
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
      expect(
        await prisma.draftCashPosting.count({
          where: { operation: { statementId: f.statementId } },
        })
      ).toBe(0)
      expect(
        await prisma.draftOperationTradeLink.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
      expect(
        await prisma.transaction.findUniqueOrThrow({
          where: { id: f.transactionId },
        })
      ).toEqual(before)
    })
    it('stages applied Kraken execution cash from persisted event and parcel identities', async () => {
      const { saveDraftImportedExecutionCash, reconcileDraftOpening } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, true)
      if (!f.eventId || !f.transactionId)
        throw new Error('Missing imported execution fixture')

      const result = await saveDraftImportedExecutionCash(
        f.userId,
        f.accountId,
        f.statementId,
        f.eventId,
        1
      )
      const retry = await saveDraftImportedExecutionCash(
        f.userId,
        f.accountId,
        f.statementId,
        f.eventId,
        1
      )

      expect(result.replay.balances[0].endingAmount).toBe('39')
      expect(retry).toMatchObject({
        operationId: result.operationId,
        created: false,
      })
      expect(
        await prisma.draftOperationTradeLink.findMany({
          where: { operationId: result.operationId },
          select: { transactionId: true },
        })
      ).toEqual([{ transactionId: f.transactionId }])
      const report = await reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.cashImportExecutions).toMatchObject([
        {
          eventId: f.eventId,
          transactionIds: [f.transactionId],
          stageable: false,
          reason: 'ALREADY_STAGED',
          operationId: result.operationId,
        },
      ])
      expect(
        await prisma.transaction.count({
          where: { position: { accountId: f.accountId } },
        })
      ).toBe(1)
    })
    it('resequences imported cash with immutable execution values, retry identity and source revalidation', async () => {
      const {
        saveDraftImportedExecutionCash,
        correctDraftImportedExecutionCash,
        reconcileDraftOpening,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, true)
      if (!f.eventId || !f.transactionId)
        throw new Error('Missing import fixture')
      const saved = await saveDraftImportedExecutionCash(
        f.userId,
        f.accountId,
        f.statementId,
        f.eventId,
        1
      )
      const input = {
        idempotencyKey: 'import-sequence-1',
        expectedRevisionId: saved.operationId,
        reason: 'Broker sequence confirmed',
        sequence: 3,
      }
      const corrected = await correctDraftImportedExecutionCash(
        f.userId,
        f.accountId,
        f.statementId,
        saved.operationId,
        input
      )
      expect(corrected.replay.balances[0].endingAmount).toBe('39')
      expect(corrected.replay.activity[0].sequence).toBe(3)
      expect(
        await correctDraftImportedExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          saved.operationId,
          input
        )
      ).toMatchObject({ created: false, revisionId: corrected.revisionId })
      const next = await correctDraftImportedExecutionCash(
        f.userId,
        f.accountId,
        f.statementId,
        saved.operationId,
        {
          ...input,
          idempotencyKey: 'import-sequence-2',
          expectedRevisionId: corrected.revisionId,
          sequence: 4,
        }
      )
      const oldRetry = await correctDraftImportedExecutionCash(
        f.userId,
        f.accountId,
        f.statementId,
        saved.operationId,
        input
      )
      expect(oldRetry).toMatchObject({
        created: false,
        revisionId: corrected.revisionId,
      })
      expect(oldRetry.replay.activity[0].sequence).toBe(4)
      expect(
        await saveDraftImportedExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          f.eventId,
          1
        )
      ).toMatchObject({ created: false, operationId: saved.operationId })
      const report = await reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.accountingActive).toBe(false)
      expect(report.cashOperations[0]).toMatchObject({
        status: 'CORRECTED',
        currentRevisionId: next.revisionId,
        sequence: 4,
      })
      const audit = await prisma.draftCashOperation.findUniqueOrThrow({
        where: { id: saved.operationId },
        include: {
          postings: true,
          revisions: {
            orderBy: { revisionNumber: 'asc' },
            include: { postings: true },
          },
        },
      })
      expect(audit.sequence).toBe(1n)
      expect(audit.revisions).toHaveLength(2)
      expect(audit.revisions[0].request).toMatchObject({
        replacement: {
          effectiveDate: '2026-10-02',
          consideration: { currency: 'AUD', amount: '60' },
          fees: [{ currency: 'AUD', amount: '1' }],
          transactionIds: [f.transactionId],
          sequence: 3,
        },
      })
      expect(
        audit.revisions[0].postings
          .map((row) => `${row.phase}:${row.amount.toFixed()}`)
          .sort()
      ).toEqual([
        'REPLACEMENT:-1',
        'REPLACEMENT:-60',
        'REVERSAL:1',
        'REVERSAL:60',
      ])
      await expect(
        correctDraftImportedExecutionCash(
          f.userId,
          'wrong-account',
          f.statementId,
          saved.operationId,
          input
        )
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        correctDraftImportedExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          saved.operationId,
          { ...input, sequence: 5 }
        )
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        correctDraftImportedExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          saved.operationId,
          {
            ...input,
            idempotencyKey: 'stale-revision',
            sequence: 5,
          }
        )
      ).rejects.toMatchObject({ status: 409 })
      await prisma.importedEvent.update({
        where: { id: f.eventId },
        data: { fee: '2' },
      })
      await expect(
        correctDraftImportedExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          saved.operationId,
          {
            ...input,
            idempotencyKey: 'source-changed',
            expectedRevisionId: next.revisionId,
            sequence: 5,
          }
        )
      ).rejects.toMatchObject({ status: 409 })
      await prisma.importedEvent.update({
        where: { id: f.eventId },
        data: { fee: '1' },
      })
      await prisma.transaction.update({
        where: { id: f.transactionId },
        data: { brokerRef: 'changed-broker-reference' },
      })
      await expect(
        correctDraftImportedExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          saved.operationId,
          {
            ...input,
            idempotencyKey: 'link-changed',
            expectedRevisionId: next.revisionId,
            sequence: 5,
          }
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: saved.operationId },
        })
      ).toBe(2)
      expect(
        (
          await prisma.transaction.findUniqueOrThrow({
            where: { id: f.transactionId },
          })
        ).fees.toFixed()
      ).toBe('1')
    })
    it('rejects imported sequence changes that cross funding or occupied slots and serializes competing revisions', async () => {
      const {
        saveDraftCashOperation,
        saveDraftImportedExecutionCash,
        correctDraftImportedExecutionCash,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, true)
      if (!f.eventId) throw new Error('Missing import fixture')
      await saveDraftCashOperation(
        f.userId,
        f.statementId,
        capital(f.accountId, {
          effectiveDate: '2026-10-02',
          cash: { currency: 'AUD', amount: '100' },
          sequence: 2,
        })
      )
      const saved = await saveDraftImportedExecutionCash(
        f.userId,
        f.accountId,
        f.statementId,
        f.eventId,
        3
      )
      const input = {
        idempotencyKey: 'too-early',
        expectedRevisionId: saved.operationId,
        reason: 'Review ordering',
        sequence: 1,
      }
      await expect(
        correctDraftImportedExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          saved.operationId,
          input
        )
      ).rejects.toMatchObject({ status: 422 })
      await expect(
        correctDraftImportedExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          saved.operationId,
          { ...input, sequence: 2 }
        )
      ).rejects.toMatchObject({ status: 409 })
      const results = await Promise.allSettled(
        [4, 5].map((sequence) =>
          correctDraftImportedExecutionCash(
            f.userId,
            f.accountId,
            f.statementId,
            saved.operationId,
            {
              ...input,
              idempotencyKey: `concurrent-${sequence}`,
              sequence,
            }
          )
        )
      )
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        results.find((result) => result.status === 'rejected')
      ).toMatchObject({ status: 'rejected', reason: { status: 409 } })
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: saved.operationId },
        })
      ).toBe(1)
    })
    it('corrects capital through the account-scoped review workflow with immutable audit, retries and funding rollback', async () => {
      const {
        saveDraftCashOperation,
        correctDraftReconciliationCashOperation,
        reconcileDraftOpening,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0')
      const original = capital(f.accountId, {
        cash: { currency: 'AUD', amount: '100' },
      })
      const saved = await saveDraftCashOperation(
        f.userId,
        f.statementId,
        original
      )
      const raw = {
        idempotencyKey: 'review-correction',
        expectedRevisionId: saved.operationId,
        reason: 'Correct bank amount',
        replacement: {
          effectiveDate: original.effectiveDate,
          sequence: 1,
          amount: '80',
        },
      }
      const corrected = await correctDraftReconciliationCashOperation(
        f.userId,
        f.accountId,
        f.statementId,
        saved.operationId,
        raw
      )
      expect(corrected.replay.balances[0].endingAmount).toBe('80')
      const retry = await correctDraftReconciliationCashOperation(
        f.userId,
        f.accountId,
        f.statementId,
        saved.operationId,
        raw
      )
      expect(retry).toMatchObject({
        created: false,
        revisionId: corrected.revisionId,
      })
      const retained = await prisma.draftCashOperation.findUniqueOrThrow({
        where: { id: saved.operationId },
        include: { postings: true, revisions: { include: { postings: true } } },
      })
      expect(retained.command).toMatchObject({ cash: { amount: '100' } })
      expect(retained.postings[0].amount.toFixed()).toBe('100')
      expect(retained.revisions).toHaveLength(1)
      expect(
        retained.revisions[0].postings.map((row) => row.amount.toFixed()).sort()
      ).toEqual(['-100', '80'])
      const report = await reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.cashOperations[0]).toMatchObject({
        currentRevisionId: corrected.revisionId,
        cash: { currency: 'AUD', amount: '80' },
        status: 'CORRECTED',
        revisions: [
          {
            revisionId: corrected.revisionId,
            reason: raw.reason,
            replacement: true,
          },
        ],
      })
      await saveDraftCashOperation(
        f.userId,
        f.statementId,
        capital(f.accountId, {
          kind: 'WITHDRAWAL',
          idempotencyKey: 'spend',
          source: { origin: 'MANUAL', reference: 'spend' },
          sequence: 2,
          cash: { currency: 'AUD', amount: '75' },
        })
      )
      await expect(
        correctDraftReconciliationCashOperation(
          f.userId,
          f.accountId,
          f.statementId,
          saved.operationId,
          {
            ...raw,
            idempotencyKey: 'reverse',
            expectedRevisionId: corrected.revisionId,
            replacement: null,
          }
        )
      ).rejects.toMatchObject({ status: 422 })
      await expect(
        correctDraftReconciliationCashOperation(
          f.userId,
          'wrong-account',
          f.statementId,
          saved.operationId,
          raw
        )
      ).rejects.toMatchObject({ status: 404 })
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: saved.operationId },
        })
      ).toBe(1)
    })
    it('serializes competing review corrections and permits a terminal capital reversal only once', async () => {
      const {
        saveDraftCashOperation,
        correctDraftReconciliationCashOperation,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture()
      const saved = await saveDraftCashOperation(
        f.userId,
        f.statementId,
        capital(f.accountId)
      )
      const results = await Promise.allSettled(
        [1, 2].map((index) =>
          correctDraftReconciliationCashOperation(
            f.userId,
            f.accountId,
            f.statementId,
            saved.operationId,
            {
              idempotencyKey: `reverse-${index}`,
              expectedRevisionId: saved.operationId,
              reason: 'Remove mistaken entry',
              replacement: null,
            }
          )
        )
      )
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      const failure = results.find((result) => result.status === 'rejected')
      expect(failure).toMatchObject({
        status: 'rejected',
        reason: { status: 409 },
      })
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: saved.operationId },
        })
      ).toBe(1)
    })
    it('serializes competing withdrawals: one spends, the other cannot overdraw the draft', async () => {
      const { saveDraftCashOperation } = await import('./draft-cash-ledger.js')
      const f = await fixture()
      const results = await Promise.allSettled(
        [1, 2].map((index) =>
          saveDraftCashOperation(
            f.userId,
            f.statementId,
            capital(f.accountId, {
              kind: 'WITHDRAWAL',
              idempotencyKey: `spend-${index}`,
              source: { origin: 'MANUAL', reference: `spend-${index}` },
              sequence: index,
              cash: { currency: 'AUD', amount: '60' },
            })
          )
        )
      )
      const fulfilled = results.filter((row) => row.status === 'fulfilled')
      const rejected = results.filter((row) => row.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      if (
        fulfilled[0].status !== 'fulfilled' ||
        rejected[0].status !== 'rejected'
      )
        throw new Error('Unexpected result')
      expect(fulfilled[0].value.replay.balances[0].endingAmount).toBe('40')
      expect(rejected[0].reason).toMatchObject({ status: 422 })
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(1)
      expect(
        await prisma.draftCashPosting.count({
          where: { operation: { statementId: f.statementId } },
        })
      ).toBe(1)
    })
    it('rejects a backdated cash deficit despite a funded ending balance, with no partial write', async () => {
      const { saveDraftCashOperation } = await import('./draft-cash-ledger.js')
      const f = await fixture()
      await saveDraftCashOperation(
        f.userId,
        f.statementId,
        capital(f.accountId, {
          effectiveDate: '2026-10-04',
          cash: { currency: 'AUD', amount: '100' },
        })
      )
      await expect(
        saveDraftCashOperation(
          f.userId,
          f.statementId,
          capital(f.accountId, {
            kind: 'WITHDRAWAL',
            idempotencyKey: 'backdated',
            source: { origin: 'MANUAL', reference: 'backdated' },
            effectiveDate: '2026-10-03',
            cash: { currency: 'AUD', amount: '150' },
          })
        )
      ).rejects.toMatchObject({ status: 422 })
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(1)
    })
    it('persists trade/posting/source snapshots, detects stale sources and preserves history after legacy deletion', async () => {
      const { saveDraftCashOperation } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', true)
      if (!f.transactionId) throw new Error('Missing fixture trade')
      const raw = {
        accountId: f.accountId,
        kind: 'BUY',
        idempotencyKey: 'buy-1',
        source: { origin: 'MANUAL', reference: `manual:${f.transactionId}` },
        effectiveDate: '2026-10-02',
        sequence: 1,
        transactionIds: [f.transactionId],
        consideration: { currency: 'AUD', amount: '60' },
        fees: [{ currency: 'AUD', amount: '1' }],
      }
      const saved = await saveDraftCashOperation(f.userId, f.statementId, raw)
      expect(saved.replay.balances[0].endingAmount).toBe('39')
      const operation = await prisma.draftCashOperation.findUniqueOrThrow({
        where: { id: saved.operationId },
        include: { postings: true, tradeLinks: true },
      })
      expect(
        operation.postings.map((row) => row.amount.toFixed()).sort()
      ).toEqual(['-1', '-60'])
      expect(operation.tradeLinks[0].transactionId).toBe(f.transactionId)
      expect(
        (
          await prisma.transaction.findUniqueOrThrow({
            where: { id: f.transactionId },
          })
        ).fees.toFixed()
      ).toBe('1')
      await prisma.transaction.delete({ where: { id: f.transactionId } })
      expect(
        await prisma.draftOperationTradeLink.count({
          where: { operationId: saved.operationId },
        })
      ).toBe(1)
      const retried = await saveDraftCashOperation(f.userId, f.statementId, raw)
      expect(retried.created).toBe(false)
      expect(retried.operationId).toBe(saved.operationId)
      await expect(
        saveDraftCashOperation(f.userId, f.statementId, capital(f.accountId))
      ).rejects.toThrow('source records have changed')
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(1)
    })
    it('rolls back operation and cash children when a nested source link violates uniqueness', async () => {
      const { saveDraftCashOperation } = await import('./draft-cash-ledger.js')
      const { prepareCashCommand } = await import('./cash-ledger.js')
      const f = await fixture('100', true)
      if (!f.transactionId) throw new Error('Missing fixture trade')
      const raw = {
        accountId: f.accountId,
        kind: 'BUY',
        idempotencyKey: 'buy-1',
        source: { origin: 'MANUAL', reference: 'manual-1' },
        effectiveDate: '2026-10-02',
        sequence: 1,
        transactionIds: [f.transactionId],
        consideration: { currency: 'AUD', amount: '60' },
        fees: [{ currency: 'AUD', amount: '1' }],
      }
      await saveDraftCashOperation(f.userId, f.statementId, raw)
      const duplicate = prepareCashCommand({
        ...raw,
        idempotencyKey: 'buy-2',
        source: { origin: 'MANUAL', reference: 'manual-2' },
        sequence: 2,
      })
      await expect(
        prisma.$transaction((db) =>
          db.draftCashOperation.create({
            data: {
              statementId: f.statementId,
              state: 'DRAFT',
              methodology: duplicate.methodology,
              idempotencyKey: duplicate.command.idempotencyKey,
              payloadHash: duplicate.payloadHash,
              kind: 'BUY',
              effectiveDate: new Date('2026-10-02T00:00:00Z'),
              sequence: 2n,
              sourceOrigin: 'MANUAL',
              sourceReference: 'manual-2',
              command: { ...duplicate.command },
              postings: {
                create: duplicate.legs.map((leg, legIndex) => ({
                  ...leg,
                  legIndex,
                })),
              },
              tradeLinks: {
                create: [
                  {
                    transactionId: raw.transactionIds[0],
                  },
                ],
              },
            },
          })
        )
      ).rejects.toMatchObject({ code: 'P2002' })
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(1)
      expect(
        await prisma.draftCashPosting.count({
          where: { operation: { statementId: f.statementId } },
        })
      ).toBe(2)
    })
    it('does not return a false funded success when stored posting content is inconsistent', async () => {
      const { saveDraftCashOperation } = await import('./draft-cash-ledger.js')
      const f = await fixture()
      const raw = capital(f.accountId)
      const saved = await saveDraftCashOperation(f.userId, f.statementId, raw)
      await prisma.draftCashPosting.update({
        where: {
          operationId_legIndex: { operationId: saved.operationId, legIndex: 0 },
        },
        data: { amount: '99' },
      })
      await expect(
        saveDraftCashOperation(f.userId, f.statementId, raw)
      ).rejects.toThrow('inconsistent')
    })
    it('rejects cross-user, cross-account and soft-deleted ownership before any posting', async () => {
      const { saveDraftCashOperation } = await import('./draft-cash-ledger.js')
      const f = await fixture()
      await expect(
        saveDraftCashOperation(
          'not-the-owner',
          f.statementId,
          capital(f.accountId)
        )
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        saveDraftCashOperation(
          f.userId,
          f.statementId,
          capital('not-the-account')
        )
      ).rejects.toMatchObject({ status: 409 })
      await prisma.user.update({
        where: { id: f.userId },
        data: { deletedAt: new Date() },
      })
      try {
        await expect(
          saveDraftCashOperation(f.userId, f.statementId, capital(f.accountId))
        ).rejects.toMatchObject({ status: 404 })
      } finally {
        await prisma.user.update({
          where: { id: f.userId },
          data: { deletedAt: null },
        })
      }
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
    })
  }
)
