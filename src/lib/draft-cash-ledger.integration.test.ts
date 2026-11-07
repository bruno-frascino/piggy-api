import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
    async function correctedSaleFixture(withSecondSale = false) {
      const f = await fixture('100', true)
      if (!f.transactionId) throw new Error('Missing fixture trade')
      const buy = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.transactionId },
      })
      const sale = await prisma.transaction.create({
        data: {
          positionId: buy.positionId,
          type: 'SELL',
          date: new Date('2026-10-03T02:34:56Z'),
          quantity: 0.5,
          price: '80',
          totalValue: '40',
          fees: '1',
        },
      })
      const secondSale = withSecondSale
        ? await prisma.transaction.create({
            data: {
              positionId: buy.positionId,
              type: 'SELL',
              date: new Date('2026-10-04T02:34:56Z'),
              quantity: 0.25,
              price: '60',
              totalValue: '15',
              fees: '0',
            },
          })
        : null
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
      const saved = await saveOpeningStatement(f.userId, f.accountId, {
        ...input,
        sourceFingerprint: preview.sourceFingerprint,
      })
      const ledger = await import('./draft-cash-ledger.js')
      const stagedBuy = await ledger.saveDraftManualExecutionCash(
        f.userId,
        f.accountId,
        saved.statement.id,
        buy.id,
        1
      )
      const staged = await ledger.saveDraftManualExecutionCash(
        f.userId,
        f.accountId,
        saved.statement.id,
        sale.id,
        1
      )
      return {
        ...f,
        statementId: saved.statement.id,
        operationId: staged.operationId,
        buyOperationId: stagedBuy.operationId,
        buy,
        sale,
        secondSale,
        ledger,
        sourceFingerprint: preview.sourceFingerprint,
      }
    }
    function saleCorrection(
      f: { operationId: string; sourceFingerprint: string },
      extra: Record<string, unknown> = {}
    ) {
      return {
        idempotencyKey: 'sale-correction',
        expectedRevisionId: f.operationId,
        expectedSourceFingerprint: f.sourceFingerprint,
        reason: 'Correct recorded sale against statement',
        effectiveDate: '2026-10-03',
        sequence: 1,
        price: '100.123456789012',
        fees: '1.12345678',
        ...extra,
      }
    }
    function acquisitionCorrection(
      f: { buyOperationId: string; sourceFingerprint: string },
      extra: Record<string, unknown> = {}
    ) {
      return {
        ...saleCorrection({
          operationId: f.buyOperationId,
          sourceFingerprint: f.sourceFingerprint,
        }),
        idempotencyKey: 'buy-correction',
        effectiveDate: '2026-10-02',
        reason: 'Correct purchase transcription against statement',
        price: '40',
        fees: '2',
        quantity: '1.25',
        ...extra,
      }
    }
    it('atomically corrects purchase quantity and cost basis without changing sale allocations or immutable openings', async () => {
      const f = await correctedSaleFixture()
      const statement = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: f.statementId },
        include: { cashBalances: true, parcels: true },
      })
      const result = await f.ledger.correctDraftRecordedAcquisition(
        f.userId,
        f.accountId,
        f.statementId,
        f.buyOperationId,
        acquisitionCorrection(f)
      )
      expect(result.created).toBe(true)
      expect(result.replay.balances[0].endingAmount).toBe('87')
      const position = await prisma.position.findUniqueOrThrow({
        where: { id: f.buy.positionId },
        include: { transactions: true },
      })
      expect(position.quantity).toBe(0.75)
      expect(position.entryPrice.toFixed()).toBe('40')
      expect(position.totalBuyValue.toFixed()).toBe('50')
      expect(position.buyFees.toFixed()).toBe('2')
      expect(position.capitalAllocated.toFixed()).toBe('52')
      expect(position.realizedPnL?.toFixed()).toBe('18.2')
      expect(position.status).toBe('PARTIAL')
      expect(position.transactions.find((row) => row.id === f.sale.id)).toEqual(
        f.sale
      )
      expect(
        position.transactions.find((row) => row.id === f.buy.id)
      ).toMatchObject({
        quantity: 1.25,
        date: f.buy.date,
      })
      expect(
        await prisma.accountOpeningStatement.findUniqueOrThrow({
          where: { id: f.statementId },
          include: { cashBalances: true, parcels: true },
        })
      ).toEqual(statement)
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.source.changed).toBe(false)
      expect(report.source.correctionCount).toBe(1)
      expect(
        report.cashOperations.find(
          (row) => row.operationId === f.buyOperationId
        )?.revisions[0].executionAudit
      ).toMatchObject({
        kind: 'BUY',
        number: 1,
        before: { quantity: '1' },
        after: { quantity: '1.25' },
      })
      const retry = await f.ledger.correctDraftRecordedAcquisition(
        f.userId,
        f.accountId,
        f.statementId,
        f.buyOperationId,
        acquisitionCorrection(f)
      )
      expect(retry).toMatchObject({
        created: false,
        revisionId: result.revisionId,
      })
      expect(
        await f.ledger.saveDraftManualExecutionCash(
          f.userId,
          f.accountId,
          f.statementId,
          f.buy.id,
          1
        )
      ).toMatchObject({ created: false, operationId: f.buyOperationId })
    })
    it('can close and reopen a parcel by correcting bought quantity while retaining all sales', async () => {
      const f = await correctedSaleFixture()
      const closed = await f.ledger.correctDraftRecordedAcquisition(
        f.userId,
        f.accountId,
        f.statementId,
        f.buyOperationId,
        acquisitionCorrection(f, { quantity: '0.5' })
      )
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.buy.positionId },
        })
      ).toMatchObject({ quantity: 0, status: 'CLOSED' })
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      await f.ledger.correctDraftRecordedAcquisition(
        f.userId,
        f.accountId,
        f.statementId,
        f.buyOperationId,
        acquisitionCorrection(f, {
          idempotencyKey: 'reopen-buy',
          expectedRevisionId: closed.revisionId,
          expectedSourceFingerprint: report.source.acceptedFingerprint,
        })
      )
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.buy.positionId },
        })
      ).toMatchObject({ quantity: 0.75, status: 'PARTIAL', closeDate: null })
    })
    it('records an acquisition sequence correction without rewriting the purchase or derived parcel', async () => {
      const f = await correctedSaleFixture()
      const before = await prisma.position.findUniqueOrThrow({
        where: { id: f.buy.positionId },
        include: { transactions: { orderBy: { id: 'asc' } } },
      })
      await f.ledger.correctDraftRecordedAcquisition(
        f.userId,
        f.accountId,
        f.statementId,
        f.buyOperationId,
        acquisitionCorrection(f, {
          quantity: '1',
          price: '60',
          fees: '1',
          sequence: 2,
        })
      )
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.buy.positionId },
          include: { transactions: { orderBy: { id: 'asc' } } },
        })
      ).toEqual(before)
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.source).toMatchObject({
        changed: false,
        acceptedFingerprint: f.sourceFingerprint,
        correctionCount: 1,
      })
    })
    it('continues a mixed acquisition/sale audit chain and permits an original retry after later revisions', async () => {
      const f = await correctedSaleFixture()
      const buyResult = await f.ledger.correctDraftRecordedAcquisition(
        f.userId,
        f.accountId,
        f.statementId,
        f.buyOperationId,
        acquisitionCorrection(f)
      )
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        saleCorrection(f, {
          expectedSourceFingerprint: report.source.acceptedFingerprint,
        })
      )
      const latest = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(latest.source).toMatchObject({
        changed: false,
        correctionCount: 2,
      })
      const liveBeforeRetry = await prisma.position.findUniqueOrThrow({
        where: { id: f.buy.positionId },
        include: { transactions: true },
      })
      expect(
        await f.ledger.correctDraftRecordedAcquisition(
          f.userId,
          f.accountId,
          f.statementId,
          f.buyOperationId,
          acquisitionCorrection(f)
        )
      ).toMatchObject({ created: false, revisionId: buyResult.revisionId })
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.buy.positionId },
          include: { transactions: true },
        })
      ).toEqual(liveBeforeRetry)
      await expect(
        f.ledger.correctDraftRecordedAcquisition(
          f.userId,
          f.accountId,
          f.statementId,
          f.buyOperationId,
          acquisitionCorrection(f, { quantity: '1.5' })
        )
      ).rejects.toMatchObject({ status: 409 })
    })
    it.each([
      [{ quantity: '0.49' }, 409],
      [{ effectiveDate: '2026-10-04' }, 409],
      [{ effectiveDate: '2026-10-03', sequence: 2 }, 409],
      [{ effectiveDate: '2026-10-01' }, 409],
      [{ effectiveDate: '2026-12-01' }, 409],
      [{ price: '100', quantity: '2' }, 422],
      [{ price: '0.001', quantity: '1' }, 400],
      [{ price: '9999999999', quantity: '2' }, 400],
      [{ price: '9999999999.99', quantity: '1', fees: '0.005' }, 400],
      [{ price: '60', fees: '1', quantity: '1' }, 400],
    ] as const)(
      'rejects invalid acquisition %j with status %s without partial writes',
      async (extra, status) => {
        const f = await correctedSaleFixture()
        const before = await prisma.position.findUniqueOrThrow({
          where: { id: f.buy.positionId },
          include: { transactions: { orderBy: { id: 'asc' } } },
        })
        await expect(
          f.ledger.correctDraftRecordedAcquisition(
            f.userId,
            f.accountId,
            f.statementId,
            f.buyOperationId,
            acquisitionCorrection(f, extra)
          )
        ).rejects.toMatchObject({ status })
        expect(
          await prisma.position.findUniqueOrThrow({
            where: { id: f.buy.positionId },
            include: { transactions: { orderBy: { id: 'asc' } } },
          })
        ).toEqual(before)
        expect(
          await prisma.draftCashRevision.count({
            where: { statementId: f.statementId },
          })
        ).toBe(0)
      }
    )
    it('uses explicit acquisition-before-sale ordering for same-day corrections, not inferred timestamps', async () => {
      const f = await correctedSaleFixture()
      await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        saleCorrection(f, { sequence: 3 })
      )
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      const corrected = await f.ledger.correctDraftRecordedAcquisition(
        f.userId,
        f.accountId,
        f.statementId,
        f.buyOperationId,
        acquisitionCorrection(f, {
          effectiveDate: '2026-10-03',
          sequence: 2,
          expectedSourceFingerprint: report.source.acceptedFingerprint,
        })
      )
      expect(
        (
          await prisma.transaction.findUniqueOrThrow({
            where: { id: f.buy.id },
          })
        ).date.toISOString()
      ).toBe('2026-10-03T01:00:00.000Z')
      const latest = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      const sale = latest.cashOperations.find(
        (row) => row.operationId === f.operationId
      )
      if (!sale) throw new Error('Missing fixture sale operation')
      await expect(
        f.ledger.correctDraftRecordedSale(
          f.userId,
          f.accountId,
          f.statementId,
          f.operationId,
          saleCorrection(f, {
            idempotencyKey: 'sale-before-buy',
            sequence: 1,
            expectedRevisionId: sale.currentRevisionId,
            expectedSourceFingerprint: latest.source.acceptedFingerprint,
          })
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(corrected.created).toBe(true)
    })
    it('rejects broker-linked sale allocations even on an otherwise manual acquisition', async () => {
      const f = await correctedSaleFixture()
      await prisma.transaction.update({
        where: { id: f.sale.id },
        data: { brokerRef: 'source-sale' },
      })
      await expect(
        f.ledger.correctDraftRecordedAcquisition(
          f.userId,
          f.accountId,
          f.statementId,
          f.buyOperationId,
          acquisitionCorrection(f)
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(
        await prisma.transaction.findUniqueOrThrow({
          where: { id: f.buy.id },
        })
      ).toEqual(f.buy)
    })
    it('serializes competing acquisition corrections and rejects external quantity drift after an audited correction', async () => {
      const f = await correctedSaleFixture()
      const results = await Promise.allSettled(
        ['first-buy', 'second-buy'].map((idempotencyKey) =>
          f.ledger.correctDraftRecordedAcquisition(
            f.userId,
            f.accountId,
            f.statementId,
            f.buyOperationId,
            acquisitionCorrection(f, { idempotencyKey })
          )
        )
      )
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === 'rejected')
      ).toHaveLength(1)
      await prisma.transaction.update({
        where: { id: f.buy.id },
        data: { quantity: 1.5 },
      })
      await expect(
        f.ledger.reconcileDraftOpening(f.userId, f.statementId, f.accountId)
      ).rejects.toMatchObject({ status: 409 })
    })
    it('rolls back acquisition, recomputed parcel and cash if final source audit preparation fails', async () => {
      const f = await correctedSaleFixture()
      const before = await prisma.position.findUniqueOrThrow({
        where: { id: f.buy.positionId },
        include: { transactions: { orderBy: { id: 'asc' } } },
      })
      const revisions = await import('./cash-revisions.js')
      const prepare = vi
        .spyOn(revisions, 'prepareCashRevision')
        .mockImplementationOnce(() => {
          throw new Error('Injected acquisition audit failure')
        })
      try {
        await expect(
          f.ledger.correctDraftRecordedAcquisition(
            f.userId,
            f.accountId,
            f.statementId,
            f.buyOperationId,
            acquisitionCorrection(f)
          )
        ).rejects.toThrow('Injected acquisition audit failure')
      } finally {
        prepare.mockRestore()
      }
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.buy.positionId },
          include: { transactions: { orderBy: { id: 'asc' } } },
        })
      ).toEqual(before)
      expect(
        await prisma.draftCashRevision.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
    })
    it('atomically corrects a live manual sale and draft cash with immutable snapshots and retry-safe source continuation', async () => {
      const f = await correctedSaleFixture()
      const statement = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: f.statementId },
      })
      const result = await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        saleCorrection(f)
      )
      expect(result.replay.balances[0].endingAmount).toBe('87.93654322')
      const sale = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.sale.id },
      })
      expect(sale.price.toFixed()).toBe('100.123456789012')
      expect(sale.totalValue.toFixed()).toBe('50.06')
      expect(sale.fees.toFixed()).toBe('1.12345678')
      expect(sale.date).toEqual(f.sale.date)
      expect(sale.quantity).toBe(0.5)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: f.sale.positionId },
          })
        ).quantity
      ).toBe(0.5)
      const revision = await prisma.draftCashRevision.findUniqueOrThrow({
        where: { id: result.revisionId },
        include: { postings: { orderBy: { legIndex: 'asc' } } },
      })
      const { prepareCashRevision } = await import('./cash-revisions.js')
      const audit = prepareCashRevision(revision.request).request.executionAudit
      expect(audit).toMatchObject({
        number: 1,
        previousFingerprint: f.sourceFingerprint,
        before: {
          price: '80',
          totalValue: '40',
          fees: '1',
          date: f.sale.date.toISOString(),
        },
        after: {
          price: '100.123456789012',
          totalValue: '50.06',
          fees: '1.12345678',
        },
      })
      expect(
        revision.postings.map((row) => [row.phase, row.amount.toFixed()])
      ).toEqual([
        ['REVERSAL', '-40'],
        ['REVERSAL', '1'],
        ['REPLACEMENT', '50.06'],
        ['REPLACEMENT', '-1.12345678'],
      ])
      expect(
        await prisma.accountOpeningStatement.findUniqueOrThrow({
          where: { id: f.statementId },
        })
      ).toEqual(statement)
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.source).toMatchObject({
        savedFingerprint: f.sourceFingerprint,
        acceptedFingerprint: audit?.nextFingerprint,
        changed: false,
        correctionCount: 1,
      })
      expect(report.accountingActive).toBe(false)
      const retry = await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        saleCorrection(f)
      )
      expect(retry).toMatchObject({
        created: false,
        revisionId: result.revisionId,
      })
      expect(
        (
          await prisma.transaction.findUniqueOrThrow({
            where: { id: f.sale.id },
          })
        ).updatedAt
      ).toEqual(sale.updatedAt)
      // Staging retry and subsequent capital appends use the audited continuation, not a rewritten opening fingerprint.
      expect(
        (
          await f.ledger.saveDraftManualExecutionCash(
            f.userId,
            f.accountId,
            f.statementId,
            f.sale.id,
            1
          )
        ).created
      ).toBe(false)
      await f.ledger.saveDraftCashOperation(
        f.userId,
        f.statementId,
        capital(f.accountId, { effectiveDate: '2026-10-04', sequence: 1 })
      )
      const oldStatement =
        await prisma.accountOpeningStatement.findFirstOrThrow({
          where: { accountId: f.accountId, id: { not: f.statementId } },
        })
      const other = await f.ledger.reconcileDraftOpening(
        f.userId,
        oldStatement.id,
        f.accountId
      )
      expect(other.source.changed).toBe(true)
    })
    it('rejects source/head/identity drift and concurrent corrections, but reuses an older retry after later revisions', async () => {
      const f = await correctedSaleFixture()
      await expect(
        f.ledger.correctDraftRecordedSale(
          f.userId,
          'foreign',
          f.statementId,
          f.operationId,
          saleCorrection(f)
        )
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        f.ledger.correctDraftRecordedSale(
          f.userId,
          f.accountId,
          f.statementId,
          f.operationId,
          saleCorrection(f, { expectedSourceFingerprint: 'a'.repeat(64) })
        )
      ).rejects.toMatchObject({ status: 409 })
      const results = await Promise.allSettled([
        f.ledger.correctDraftRecordedSale(
          f.userId,
          f.accountId,
          f.statementId,
          f.operationId,
          saleCorrection(f, { idempotencyKey: 'race-a' })
        ),
        f.ledger.correctDraftRecordedSale(
          f.userId,
          f.accountId,
          f.statementId,
          f.operationId,
          saleCorrection(f, { idempotencyKey: 'race-b', fees: '2' })
        ),
      ])
      const winner = results.find((row) => row.status === 'fulfilled')
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      if (!winner || winner.status !== 'fulfilled')
        throw new Error('Missing correction winner')
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      const second = await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        saleCorrection(f, {
          idempotencyKey: 'second',
          expectedRevisionId: winner.value.revisionId,
          expectedSourceFingerprint: report.source.acceptedFingerprint,
          effectiveDate: '2026-10-04',
          fees: '0',
          price: '90',
        })
      )
      const saved = await prisma.draftCashRevision.findUniqueOrThrow({
        where: { id: winner.value.revisionId },
      })
      const { prepareCashRevision } = await import('./cash-revisions.js')
      const originalInput = prepareCashRevision(saved.request).request
        .executionAudit?.input
      const retry = await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        originalInput
      )
      expect(retry).toMatchObject({
        created: false,
        revisionId: winner.value.revisionId,
      })
      expect(retry.replay).toEqual(second.replay)
      expect(
        (
          await f.ledger.reconcileDraftOpening(
            f.userId,
            f.statementId,
            f.accountId
          )
        ).source.correctionCount
      ).toBe(2)
    })
    it('rolls back both live sale and audit cash when a correction would cause downstream funding deficits or a write fails', async () => {
      const f = await correctedSaleFixture()
      await f.ledger.saveDraftCashOperation(
        f.userId,
        f.statementId,
        capital(f.accountId, {
          kind: 'WITHDRAWAL',
          effectiveDate: '2026-10-05',
          cash: { currency: 'AUD', amount: '70' },
        })
      )
      const before = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.sale.id },
      })
      await expect(
        f.ledger.correctDraftRecordedSale(
          f.userId,
          f.accountId,
          f.statementId,
          f.operationId,
          saleCorrection(f, { price: '40', fees: '1' })
        )
      ).rejects.toMatchObject({ status: 422 })
      const service = await import('./position-service.js')
      const recompute = vi
        .spyOn(service, 'recomputePositionFromTransactions')
        .mockRejectedValueOnce(new Error('Injected recompute failure'))
      try {
        await expect(
          f.ledger.correctDraftRecordedSale(
            f.userId,
            f.accountId,
            f.statementId,
            f.operationId,
            saleCorrection(f)
          )
        ).rejects.toThrow('Injected recompute failure')
      } finally {
        recompute.mockRestore()
      }
      expect(
        await prisma.transaction.findUniqueOrThrow({ where: { id: f.sale.id } })
      ).toEqual(before)
      expect(
        await prisma.draftCashRevision.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
      expect(
        await prisma.draftCashRevisionPosting.count({
          where: { revision: { statementId: f.statementId } },
        })
      ).toBe(0)
    })
    it('rejects pre-acquisition, opening-boundary, future and imported sale corrections without mutation', async () => {
      const f = await correctedSaleFixture()
      for (const effectiveDate of ['2026-09-30', '2026-10-01', '2099-01-01']) {
        await expect(
          f.ledger.correctDraftRecordedSale(
            f.userId,
            f.accountId,
            f.statementId,
            f.operationId,
            saleCorrection(f, { effectiveDate })
          )
        ).rejects.toMatchObject({ status: 409 })
      }
      await prisma.transaction.update({
        where: { id: f.sale.id },
        data: { brokerRef: 'KRAKEN:order:reserved' },
      })
      await expect(
        f.ledger.correctDraftRecordedSale(
          f.userId,
          f.accountId,
          f.statementId,
          f.operationId,
          saleCorrection(f)
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(
        await prisma.draftCashRevision.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
    })
    it('retains statement evidence and recomputes its variance against corrected cash', async () => {
      const f = await correctedSaleFixture()
      await f.ledger.recordDraftCashEvidence(
        f.userId,
        f.statementId,
        {
          idempotencyKey: 'statement-evidence',
          asOfDate: '2026-10-05',
          source: 'Broker statement',
          reference: 'Statement page 1',
          attested: true,
          cashBalances: [{ currency: 'AUD', amount: '78' }],
          decisions: [],
        },
        f.accountId
      )
      const evidence = await prisma.draftCashEvidence.findFirstOrThrow({
        where: { statementId: f.statementId },
        include: { balances: true, decisions: true },
      })
      await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        saleCorrection(f, { price: '100', fees: '1' })
      )
      expect(
        await prisma.draftCashEvidence.findUniqueOrThrow({
          where: { id: evidence.id },
          include: { balances: true, decisions: true },
        })
      ).toEqual(evidence)
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.cashEvidence[0].currentComparison.variances).toEqual([
        {
          currency: 'AUD',
          expectedAmount: '88',
          statementAmount: '78',
          difference: '-10',
        },
      ])
      expect(report.source.changed).toBe(false)
    })
    it('orders source continuation globally across different operations, including pure resequencing without rewriting the sale', async () => {
      const f = await correctedSaleFixture(true)
      if (!f.secondSale) throw new Error('Missing second fixture sale')
      const secondOperation = await f.ledger.saveDraftManualExecutionCash(
        f.userId,
        f.accountId,
        f.statementId,
        f.secondSale.id,
        1
      )
      const laterDateFirst = await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        secondOperation.operationId,
        saleCorrection(f, {
          idempotencyKey: 'other-sale',
          expectedRevisionId: secondOperation.operationId,
          effectiveDate: '2026-10-04',
          price: '64',
          fees: '0',
        })
      )
      const firstReport = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      const before = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.sale.id },
      })
      const resequence = await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        saleCorrection(f, {
          expectedSourceFingerprint: firstReport.source.acceptedFingerprint,
          price: '80',
          fees: '1',
          sequence: 2,
        })
      )
      expect(resequence.created).toBe(true)
      expect(laterDateFirst.created).toBe(true)
      expect(
        await prisma.transaction.findUniqueOrThrow({ where: { id: f.sale.id } })
      ).toEqual(before)
      const report = await f.ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.source).toMatchObject({
        correctionCount: 2,
        changed: false,
        acceptedFingerprint: firstReport.source.acceptedFingerprint,
      })
      expect(
        (
          await f.ledger.saveDraftManualExecutionCash(
            f.userId,
            f.accountId,
            f.statementId,
            f.sale.id,
            1
          )
        ).created
      ).toBe(false)
    })
    it('fails closed on a source-price edit or a recomputed but broken audit fingerprint chain', async () => {
      const f = await correctedSaleFixture()
      const result = await f.ledger.correctDraftRecordedSale(
        f.userId,
        f.accountId,
        f.statementId,
        f.operationId,
        saleCorrection(f)
      )
      await prisma.transaction.update({
        where: { id: f.sale.id },
        data: { price: '101' },
      })
      await expect(
        f.ledger.reconcileDraftOpening(f.userId, f.statementId, f.accountId)
      ).rejects.toMatchObject({ status: 409 })
      await prisma.transaction.update({
        where: { id: f.sale.id },
        data: { price: '100.123456789012' },
      })
      const row = await prisma.draftCashRevision.findUniqueOrThrow({
        where: { id: result.revisionId },
      })
      const { prepareCashRevision } = await import('./cash-revisions.js')
      const request = prepareCashRevision(row.request).request
      if (!request.executionAudit)
        throw new Error('Missing stored source audit')
      const corrupted = prepareCashRevision({
        ...request,
        executionAudit: { ...request.executionAudit, number: 2 },
      })
      await prisma.draftCashRevision.update({
        where: { id: row.id },
        data: {
          request: { ...corrupted.request },
          payloadHash: corrupted.payloadHash,
        },
      })
      await expect(
        f.ledger.reconcileDraftOpening(f.userId, f.statementId, f.accountId)
      ).rejects.toMatchObject({ status: 409 })
    })
    it('rolls back a live edit and recomputed parcel if persisting its final audit cannot complete', async () => {
      const f = await correctedSaleFixture()
      const before = await prisma.position.findUniqueOrThrow({
        where: { id: f.sale.positionId },
        include: { transactions: { orderBy: { id: 'asc' } } },
      })
      const revisions = await import('./cash-revisions.js')
      const prepare = vi
        .spyOn(revisions, 'prepareCashRevision')
        .mockImplementationOnce(() => {
          throw new Error('Injected audit persistence failure')
        })
      try {
        await expect(
          f.ledger.correctDraftRecordedSale(
            f.userId,
            f.accountId,
            f.statementId,
            f.operationId,
            saleCorrection(f)
          )
        ).rejects.toThrow('Injected audit persistence failure')
      } finally {
        prepare.mockRestore()
      }
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.sale.positionId },
          include: { transactions: { orderBy: { id: 'asc' } } },
        })
      ).toEqual(before)
      expect(
        await prisma.draftCashRevision.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
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
    function currentSydneyDate() {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Australia/Sydney',
      }).format(new Date())
    }
    async function confirmCashLedger(accountId: string, statementId: string) {
      const statement = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: statementId },
      })
      await prisma.accountOpeningStatement.update({
        where: { id: statementId },
        data: { state: 'CONFIRMED' },
      })
      await prisma.accountCashLedger.create({
        data: {
          accountId,
          openingStatementId: statementId,
          state: 'ACTIVE',
          openingSourceFingerprint: statement.sourceFingerprint,
          acceptedSourceFingerprint: statement.sourceFingerprint,
        },
      })
    }
    function liveTradeInput(
      overrides: Record<string, unknown> = {}
    ): Record<string, unknown> {
      return {
        kind: 'BUY',
        assetId: 'live-asset-placeholder',
        idempotencyKey: `live-${randomUUID()}`,
        effectiveDate: currentSydneyDate(),
        sequence: 1,
        quantity: '1',
        price: '20',
        fees: '1',
        ...overrides,
      }
    }
    async function liveAcquisitionFixture(
      soldQuantity = '4',
      saleSequence = 1
    ) {
      const { postAccountTrade } = await import('./draft-cash-ledger.js')
      const f = await fixture('1000')
      if (!exchangeId) throw new Error('Missing fixture exchange')
      const asset = await prisma.asset.create({
        data: {
          symbol: `LIVE-BUY-${randomUUID()}`,
          name: 'Live purchase fixture',
          exchangeId,
        },
      })
      await confirmCashLedger(f.accountId, f.statementId)
      const buy = await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: asset.id,
          effectiveDate: '2026-10-02',
          quantity: '10',
          price: '10',
          fees: '1',
        })
      )
      const transaction = await prisma.transaction.findUniqueOrThrow({
        where: { id: buy.transactionId },
      })
      const sale = await postAccountTrade(f.userId, f.accountId, {
        kind: 'SELL',
        positionId: transaction.positionId,
        idempotencyKey: randomUUID(),
        effectiveDate: '2026-10-03',
        sequence: saleSequence,
        quantity: soldQuantity,
        price: '20',
        fees: '1',
      })
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      return {
        ...f,
        buy,
        sale,
        positionId: transaction.positionId,
        assetId: asset.id,
        correction: {
          idempotencyKey: randomUUID(),
          expectedRevisionId: buy.operationId,
          expectedSourceFingerprint: ledger.acceptedSourceFingerprint,
          reason: 'Correct purchase from statement',
          effectiveDate: '2026-10-02',
          sequence: 1,
          quantity: '4',
          price: '12',
          fees: '2',
        },
      }
    }

    it('audits live acquisition corrections, closes/reopens sold parcels, preserves sales and replays a mixed BUY/SELL chain', async () => {
      const {
        correctLiveManualAcquisition,
        correctLiveManualSale,
        postAccountTrade,
      } = await import('./draft-cash-ledger.js')
      const f = await liveAcquisitionFixture()
      const original = await prisma.accountCashOperation.findUniqueOrThrow({
        where: { id: f.buy.operationId },
        include: { postings: { orderBy: { legIndex: 'asc' } } },
      })
      const saleBefore = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.sale.transactionId },
      })
      const parcelBefore = await prisma.position.findUniqueOrThrow({
        where: { id: f.positionId },
      })
      await prisma.position.update({
        where: { id: f.positionId },
        data: {
          maxDrawdownPercent: 12,
          maxRunUpPercent: 20,
          unrealizedPnL: '20',
          updatedAt: parcelBefore.updatedAt,
        },
      })
      const first = await correctLiveManualAcquisition(
        f.userId,
        f.accountId,
        f.buy.transactionId,
        f.correction
      )
      expect(first.replay.balances[0].endingAmount).toBe('1029')
      expect(
        await prisma.position.findUniqueOrThrow({ where: { id: f.positionId } })
      ).toMatchObject({
        quantity: 0,
        status: 'CLOSED',
        maxDrawdownPercent: null,
        maxRunUpPercent: null,
        unrealizedPnL: null,
      })
      expect(
        await prisma.transaction.findUniqueOrThrow({
          where: { id: f.sale.transactionId },
        })
      ).toEqual(saleBefore)
      const revision =
        await prisma.accountCashOperationRevision.findUniqueOrThrow({
          where: { id: first.revisionId },
          include: { postings: { orderBy: { legIndex: 'asc' } } },
        })
      expect(
        revision.postings.map((row) => [row.phase, row.amount.toFixed()])
      ).toEqual([
        ['REVERSAL', '100'],
        ['REVERSAL', '1'],
        ['REPLACEMENT', '-48'],
        ['REPLACEMENT', '-2'],
      ])
      expect(revision.request).toMatchObject({
        executionAudit: {
          kind: 'BUY',
          before: { quantity: '10' },
          after: { quantity: '4' },
        },
      })
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      const secondInput = {
        ...f.correction,
        idempotencyKey: randomUUID(),
        expectedRevisionId: first.revisionId,
        expectedSourceFingerprint: ledger.acceptedSourceFingerprint,
        quantity: '6',
      }
      const second = await correctLiveManualAcquisition(
        f.userId,
        f.accountId,
        f.buy.transactionId,
        secondInput
      )
      expect(second.replay.balances[0].endingAmount).toBe('1005')
      expect(
        await prisma.position.findUniqueOrThrow({ where: { id: f.positionId } })
      ).toMatchObject({ quantity: 2, status: 'PARTIAL', closeDate: null })
      const afterBuyLedger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      const correctedSale = await correctLiveManualSale(
        f.userId,
        f.accountId,
        f.sale.transactionId,
        {
          idempotencyKey: randomUUID(),
          expectedRevisionId: f.sale.operationId,
          expectedSourceFingerprint: afterBuyLedger.acceptedSourceFingerprint,
          reason: 'Correct sale fee',
          effectiveDate: '2026-10-03',
          sequence: 1,
          price: '20',
          fees: '0.5',
        }
      )
      expect(correctedSale.replay.balances[0].endingAmount).toBe('1005.5')
      const retry = await correctLiveManualAcquisition(
        f.userId,
        f.accountId,
        f.buy.transactionId,
        f.correction
      )
      expect(retry).toMatchObject({
        created: false,
        revisionId: first.revisionId,
      })
      expect(
        await prisma.accountCashOperation.findUniqueOrThrow({
          where: { id: f.buy.operationId },
          include: { postings: { orderBy: { legIndex: 'asc' } } },
        })
      ).toEqual(original)
      const next = await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: f.assetId,
          effectiveDate: '2026-10-04',
          quantity: '1',
          price: '10',
          fees: '0',
        })
      )
      expect(next.replay.balances[0].endingAmount).toBe('995.5')
      expect(
        await prisma.transaction.count({
          where: { positionId: f.positionId, type: 'BUY' },
        })
      ).toBe(1)
      const originalRetry = await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: f.assetId,
          idempotencyKey: original.idempotencyKey,
          effectiveDate: '2026-10-02',
          quantity: '10',
          price: '10',
          fees: '1',
        })
      )
      expect(originalRetry).toMatchObject({
        created: false,
        transactionId: f.buy.transactionId,
      })
    })

    it.each([
      [{ quantity: '3' }, 409],
      [{ effectiveDate: '2026-10-04' }, 409],
      [{ effectiveDate: '2026-10-01' }, 409],
      [{ effectiveDate: '2999-01-01' }, 409],
      [{ quantity: '4.0000000000001' }, 400],
      [{ quantity: '9007199254740992' }, 400],
      [{ price: '400' }, 422],
      [{ expectedRevisionId: 'stale' }, 409],
      [{ expectedSourceFingerprint: 'a'.repeat(64) }, 409],
      [{ quantity: '10', price: '10', fees: '1' }, 400],
    ])(
      'rejects invalid live acquisition %j without partial writes',
      async (extra, status) => {
        const { correctLiveManualAcquisition } =
          await import('./draft-cash-ledger.js')
        const f = await liveAcquisitionFixture()
        const before = await prisma.position.findUniqueOrThrow({
          where: { id: f.positionId },
          include: { transactions: true },
        })
        const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
          where: { accountId: f.accountId },
        })
        await expect(
          correctLiveManualAcquisition(
            f.userId,
            f.accountId,
            f.buy.transactionId,
            {
              ...f.correction,
              ...extra,
            }
          )
        ).rejects.toMatchObject({ status })
        expect(
          await prisma.position.findUniqueOrThrow({
            where: { id: f.positionId },
            include: { transactions: true },
          })
        ).toEqual(before)
        expect(
          await prisma.accountCashLedger.findUniqueOrThrow({
            where: { accountId: f.accountId },
          })
        ).toEqual(ledger)
        expect(
          await prisma.accountCashOperationRevision.count({
            where: { accountId: f.accountId },
          })
        ).toBe(0)
      }
    )

    it('enforces same-day acquisition ordering and reserves former sequence slots', async () => {
      const { correctLiveManualAcquisition, postAccountTrade } =
        await import('./draft-cash-ledger.js')
      const f = await liveAcquisitionFixture()
      await expect(
        correctLiveManualAcquisition(
          f.userId,
          f.accountId,
          f.buy.transactionId,
          {
            ...f.correction,
            effectiveDate: '2026-10-03',
            sequence: 2,
          }
        )
      ).rejects.toMatchObject({ status: 409, message: /same-day sales/i })
      const corrected = await correctLiveManualAcquisition(
        f.userId,
        f.accountId,
        f.buy.transactionId,
        {
          ...f.correction,
          effectiveDate: '2026-10-02',
          sequence: 2,
        }
      )
      expect(corrected.created).toBe(true)
      await expect(
        postAccountTrade(
          f.userId,
          f.accountId,
          liveTradeInput({
            assetId: f.assetId,
            effectiveDate: '2026-10-02',
            sequence: 1,
          })
        )
      ).rejects.toMatchObject({ status: 409 })
      const ordered = await liveAcquisitionFixture('4', 3)
      const sameDay = await correctLiveManualAcquisition(
        ordered.userId,
        ordered.accountId,
        ordered.buy.transactionId,
        {
          ...ordered.correction,
          effectiveDate: '2026-10-03',
          sequence: 2,
        }
      )
      expect(sameDay.created).toBe(true)
      expect(
        await prisma.transaction.findUniqueOrThrow({
          where: { id: ordered.buy.transactionId },
        })
      ).toMatchObject({ date: new Date('2026-10-03T01:00:00Z') })
    })

    it('does not enable demo, closed or legacy accounts and rejects ownership and imported-source drift', async () => {
      const { correctLiveManualAcquisition } =
        await import('./draft-cash-ledger.js')
      for (const accountChange of [
        { isDemo: true },
        { status: 'CLOSED' as const },
      ]) {
        const f = await liveAcquisitionFixture()
        await prisma.tradingAccount.update({
          where: { id: f.accountId },
          data: accountChange,
        })
        await expect(
          correctLiveManualAcquisition(
            f.userId,
            f.accountId,
            f.buy.transactionId,
            f.correction
          )
        ).rejects.toMatchObject({ status: 409 })
        expect(
          await prisma.accountCashOperationRevision.count({
            where: { accountId: f.accountId },
          })
        ).toBe(0)
      }
      const f = await liveAcquisitionFixture()
      await expect(
        correctLiveManualAcquisition(
          'unowned-user',
          f.accountId,
          f.buy.transactionId,
          f.correction
        )
      ).rejects.toMatchObject({ status: 401 })
      await expect(
        correctLiveManualAcquisition(
          f.userId,
          'unowned-account',
          f.buy.transactionId,
          f.correction
        )
      ).rejects.toMatchObject({ status: 404 })
      await prisma.transaction.update({
        where: { id: f.sale.transactionId },
        data: { brokerRef: 'imported-allocation' },
      })
      await expect(
        correctLiveManualAcquisition(
          f.userId,
          f.accountId,
          f.buy.transactionId,
          f.correction
        )
      ).rejects.toMatchObject({ status: 404 })
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
      const legacy = await fixture('1000', true)
      if (!legacy.transactionId) throw new Error('Missing legacy transaction')
      await expect(
        correctLiveManualAcquisition(
          legacy.userId,
          legacy.accountId,
          legacy.transactionId,
          f.correction
        )
      ).rejects.toMatchObject({ status: 409 })
    })

    it('serializes competing live acquisition corrections and rejects changed retry content', async () => {
      const { correctLiveManualAcquisition } =
        await import('./draft-cash-ledger.js')
      const f = await liveAcquisitionFixture()
      const results = await Promise.allSettled(
        ['left', 'right'].map((idempotencyKey) =>
          correctLiveManualAcquisition(
            f.userId,
            f.accountId,
            f.buy.transactionId,
            { ...f.correction, idempotencyKey }
          )
        )
      )
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { accountId: f.accountId },
        })
      ).toBe(1)
      const revision =
        await prisma.accountCashOperationRevision.findFirstOrThrow({
          where: { accountId: f.accountId },
        })
      await expect(
        correctLiveManualAcquisition(
          f.userId,
          f.accountId,
          f.buy.transactionId,
          {
            ...f.correction,
            idempotencyKey: revision.idempotencyKey,
            quantity: '5',
          }
        )
      ).rejects.toMatchObject({ status: 409 })
    })

    it('rolls back purchase, parcel, revision postings and fingerprint if a final live acquisition write fails', async () => {
      const { correctLiveManualAcquisition } =
        await import('./draft-cash-ledger.js')
      const f = await liveAcquisitionFixture()
      const before = await prisma.position.findUniqueOrThrow({
        where: { id: f.positionId },
        include: { transactions: true },
      })
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      const auditModule = await import('./accounting-preview-service.js')
      const read = auditModule.readAccountOpeningPreview
      let reads = 0
      const fail = vi
        .spyOn(auditModule, 'readAccountOpeningPreview')
        .mockImplementation(async (...args) => {
          reads += 1
          if (reads === 2)
            throw new Error('Injected live acquisition audit failure')
          return read(...args)
        })
      try {
        await expect(
          correctLiveManualAcquisition(
            f.userId,
            f.accountId,
            f.buy.transactionId,
            f.correction
          )
        ).rejects.toThrow('Injected live acquisition audit failure')
      } finally {
        fail.mockRestore()
      }
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.positionId },
          include: { transactions: true },
        })
      ).toEqual(before)
      expect(
        await prisma.accountCashLedger.findUniqueOrThrow({
          where: { accountId: f.accountId },
        })
      ).toEqual(ledger)
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
    })
    it('requires an explicitly confirmed live ledger and atomically posts a retry-safe BUY', async () => {
      const { postAccountTrade } = await import('./draft-cash-ledger.js')
      const f = await fixture('100')
      const asset = await prisma.asset.create({
        data: {
          symbol: `LIVE-${randomUUID()}`,
          name: 'Live posting fixture',
          exchangeId: exchangeId!,
        },
      })
      const input = liveTradeInput({ assetId: asset.id })
      await expect(
        postAccountTrade(f.userId, f.accountId, input)
      ).rejects.toMatchObject({
        status: 409,
        message: /no active confirmed cash ledger/,
      })
      const statement = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: f.statementId },
      })
      await prisma.accountCashLedger.create({
        data: {
          accountId: f.accountId,
          openingStatementId: f.statementId,
          state: 'ACTIVE',
          openingSourceFingerprint: statement.sourceFingerprint,
          acceptedSourceFingerprint: statement.sourceFingerprint,
        },
      })
      await expect(
        postAccountTrade(f.userId, f.accountId, input)
      ).rejects.toMatchObject({
        status: 409,
        message: /confirmed opening statement/i,
      })
      await prisma.accountCashLedger.delete({
        where: { accountId: f.accountId },
      })
      await confirmCashLedger(f.accountId, f.statementId)
      const result = await postAccountTrade(f.userId, f.accountId, input)
      expect(result).toMatchObject({ created: true, replay: { funded: true } })
      expect(result.replay.balances[0].endingAmount).toBe('79')
      const retry = await postAccountTrade(f.userId, f.accountId, input)
      expect(retry).toMatchObject({
        created: false,
        operationId: result.operationId,
        transactionId: result.transactionId,
      })
      const operation = await prisma.accountCashOperation.findUniqueOrThrow({
        where: { id: result.operationId },
        include: { postings: { orderBy: { legIndex: 'asc' } } },
      })
      expect(operation.postings.map((row) => row.amount.toFixed())).toEqual([
        '-20',
        '-1',
      ])
      expect(
        await prisma.transaction.count({
          where: { position: { accountId: f.accountId } },
        })
      ).toBe(1)
      await expect(
        postAccountTrade(
          f.userId,
          f.accountId,
          liveTradeInput({
            assetId: asset.id,
            idempotencyKey: `duplicate-slot-${randomUUID()}`,
          })
        )
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        postAccountTrade(f.userId, f.accountId, {
          ...input,
          price: '21',
        })
      ).rejects.toMatchObject({ status: 409 })
      await prisma.transaction.update({
        where: { id: result.transactionId },
        data: { price: '21' },
      })
      await expect(
        postAccountTrade(
          f.userId,
          f.accountId,
          liveTradeInput({ assetId: asset.id, sequence: 2 })
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(1)
    })
    it('posts a funded manual SELL against one owned parcel and rejects overselling without writes', async () => {
      const { correctLiveManualSale, postAccountTrade } =
        await import('./draft-cash-ledger.js')
      if (!userId || !exchangeId) throw new Error('Missing fixture owner')
      const account = await prisma.tradingAccount.create({
        data: { userId, name: `Live sale fixture ${randomUUID()}` },
      })
      const asset = await prisma.asset.create({
        data: {
          symbol: `LIVE-SELL-${randomUUID()}`,
          name: 'Live sale fixture',
          exchangeId,
        },
      })
      const position = await prisma.position.create({
        data: {
          userId,
          accountId: account.id,
          assetId: asset.id,
          openDate: new Date('2026-09-30T00:00:00Z'),
          entryPrice: '10',
          quantity: 10,
          totalBuyValue: '100',
          buyFees: '0',
          capitalAllocated: '100',
          transactions: {
            create: {
              type: 'BUY',
              date: new Date('2026-09-30T00:00:00Z'),
              quantity: 10,
              price: '10',
              totalValue: '100',
              fees: '0',
            },
          },
        },
      })
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const { saveOpeningStatement } = await import('./opening-statements.js')
      const opening = {
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '100' }],
      }
      const preview = await previewAccountOpening(userId, account.id, opening)
      const saved = await saveOpeningStatement(userId, account.id, {
        ...opening,
        sourceFingerprint: preview.sourceFingerprint,
      })
      await confirmCashLedger(account.id, saved.statement.id)
      const input = {
        kind: 'SELL',
        positionId: position.id,
        idempotencyKey: `live-sale-${randomUUID()}`,
        effectiveDate: currentSydneyDate(),
        sequence: 1,
        quantity: '2',
        price: '20',
        fees: '1',
      }
      const result = await postAccountTrade(userId, account.id, input)
      expect(result.replay.balances[0].endingAmount).toBe('139')
      expect(
        await prisma.position.findUniqueOrThrow({ where: { id: position.id } })
      ).toMatchObject({ quantity: 8, status: 'PARTIAL' })
      await expect(
        postAccountTrade(userId, account.id, {
          ...input,
          idempotencyKey: `oversell-${randomUUID()}`,
          sequence: 2,
          quantity: '9',
        })
      ).rejects.toMatchObject({ status: 409 })
      expect(
        await prisma.transaction.count({ where: { positionId: position.id } })
      ).toBe(2)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: account.id },
        })
      ).toBe(1)

      const operation = await prisma.accountCashOperation.findUniqueOrThrow({
        where: { transactionId: result.transactionId },
      })
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: account.id },
      })
      const correction = {
        idempotencyKey: `live-sale-correction-${randomUUID()}`,
        expectedRevisionId: operation.id,
        expectedSourceFingerprint: ledger.acceptedSourceFingerprint,
        reason: 'Corrected from the broker statement',
        effectiveDate: currentSydneyDate(),
        sequence: 2,
        price: '21',
        fees: '0.5',
      }
      const corrected = await correctLiveManualSale(
        userId,
        account.id,
        result.transactionId,
        correction
      )
      expect(corrected).toMatchObject({
        operationId: operation.id,
        created: true,
        replay: { funded: true },
      })
      expect(corrected.replay.balances[0].endingAmount).toBe('141.5')
      const currentLedger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: account.id },
      })
      const secondCorrection = {
        ...correction,
        idempotencyKey: `live-sale-correction-${randomUUID()}`,
        expectedRevisionId: corrected.revisionId,
        expectedSourceFingerprint: currentLedger.acceptedSourceFingerprint,
        sequence: 3,
        price: '22',
        fees: '0.25',
      }
      const correctedAgain = await correctLiveManualSale(
        userId,
        account.id,
        result.transactionId,
        secondCorrection
      )
      expect(correctedAgain.replay.balances[0].endingAmount).toBe('143.75')
      const revisedOperation =
        await prisma.accountCashOperation.findUniqueOrThrow({
          where: { id: operation.id },
          include: {
            revisions: {
              orderBy: { revisionNumber: 'asc' },
              include: {
                postings: { orderBy: { legIndex: 'asc' } },
              },
            },
          },
        })
      expect(revisedOperation.sequence).toBe(1n)
      expect(revisedOperation.revisions).toHaveLength(2)
      expect(revisedOperation.revisions[1]).toMatchObject({
        revisionNumber: 2,
        previousRevisionId: revisedOperation.revisions[0].id,
      })
      expect(
        revisedOperation.revisions[0].postings.map((row) => [
          row.phase,
          row.amount.toFixed(),
        ])
      ).toEqual([
        ['REVERSAL', '-40'],
        ['REVERSAL', '1'],
        ['REPLACEMENT', '42'],
        ['REPLACEMENT', '-0.5'],
      ])
      const correctedTransaction = await prisma.transaction.findUniqueOrThrow({
        where: { id: result.transactionId },
      })
      expect(correctedTransaction.quantity).toBe(2)
      expect(correctedTransaction.price.toFixed()).toBe('22')
      expect(correctedTransaction.totalValue.toFixed()).toBe('44')
      expect(correctedTransaction.fees.toFixed()).toBe('0.25')
      const retry = await correctLiveManualSale(
        userId,
        account.id,
        result.transactionId,
        correction
      )
      expect(retry).toMatchObject({
        revisionId: revisedOperation.revisions[0].id,
        created: false,
      })
      expect(retry.replay.balances[0].endingAmount).toBe('143.75')
      await expect(
        postAccountTrade(userId, account.id, {
          ...input,
          idempotencyKey: `reserved-revision-slot-${randomUUID()}`,
          sequence: 2,
          quantity: '1',
        })
      ).rejects.toMatchObject({ status: 409 })
      const replayed = await postAccountTrade(userId, account.id, {
        ...input,
        idempotencyKey: `after-sale-correction-${randomUUID()}`,
        sequence: 4,
        quantity: '1',
      })
      expect(replayed.replay.funded).toBe(true)
    })
    it('serializes competing live spending and rolls back an unaffordable BUY', async () => {
      const { postAccountTrade } = await import('./draft-cash-ledger.js')
      const f = await fixture('100')
      const asset = await prisma.asset.create({
        data: {
          symbol: `LIVE-RACE-${randomUUID()}`,
          name: 'Live race fixture',
          exchangeId: exchangeId!,
        },
      })
      await confirmCashLedger(f.accountId, f.statementId)
      const attempts = [1, 2].map((sequence) =>
        postAccountTrade(
          f.userId,
          f.accountId,
          liveTradeInput({
            assetId: asset.id,
            idempotencyKey: `live-race-${sequence}`,
            sequence,
            price: '60',
          })
        )
      )
      const results = await Promise.allSettled(attempts)
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1)
      expect(
        await prisma.position.count({ where: { accountId: f.accountId } })
      ).toBe(1)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(1)
    })
  }
)
