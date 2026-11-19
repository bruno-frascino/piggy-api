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
  withImportedTrade = false,
  withIncomeHolding = false,
  extraCashBalances: { currency: string; amount: string }[] = [],
  withSecondIncomeHolding = false
) {
  if (!userId) throw new Error('Missing isolated cash fixture')
  const account = await prisma.tradingAccount.create({
    data: { userId, name: `Cash fixture ${randomUUID()}` },
  })
  let transactionId: string | undefined
  let eventId: string | undefined
  let incomeAssetId: string | undefined
  if (withIncomeHolding) {
    if (!exchangeId) throw new Error('Missing fixture exchange')
    const asset = await prisma.asset.create({
      data: {
        symbol: `INCOME-${randomUUID()}`,
        name: 'Disposable income receipt test asset',
        exchangeId,
        assetType: 'EQUITY',
      },
    })
    incomeAssetId = asset.id
    await prisma.position.create({
      data: {
        userId,
        accountId: account.id,
        assetId: asset.id,
        openDate: new Date('2026-09-30T00:00:00Z'),
        entryPrice: '60',
        quantity: 1,
        totalBuyValue: '60',
        buyFees: '1',
        capitalAllocated: '61',
        transactions: {
          create: {
            type: 'BUY',
            date: new Date('2026-09-30T00:00:00Z'),
            quantity: 1,
            price: '60',
            totalValue: '60',
            fees: '1',
          },
        },
      },
    })
    if (withSecondIncomeHolding) {
      await prisma.position.create({
        data: {
          userId,
          accountId: account.id,
          assetId: asset.id,
          openDate: new Date('2026-09-29T00:00:00Z'),
          entryPrice: '40',
          quantity: 3,
          totalBuyValue: '120',
          buyFees: '2',
          capitalAllocated: '122',
          transactions: {
            create: {
              type: 'BUY',
              date: new Date('2026-09-29T00:00:00Z'),
              quantity: 3,
              price: '40',
              totalValue: '120',
              fees: '2',
            },
          },
        },
      })
    }
  }
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
    cashBalances: [{ currency: 'AUD', amount }, ...extraCashBalances],
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
    incomeAssetId,
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
            code: `FIXTURE-${randomUUID()}`.toUpperCase(),
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
    it('corrects and terminally reverses paired transfers with immutable audit, safe retries and both dated funding checks', async () => {
      const {
        postAccountCashTransfer,
        readLiveCashTransferReview,
        correctLiveCashTransfer,
        readLiveCapitalOperations,
        postAccountCapitalFlow,
        correctLiveCapitalOperation,
      } = await import('./draft-cash-ledger.js')
      const source = await fixture('100')
      const destination = await fixture('0')
      await confirmCashLedger(source.accountId, source.statementId)
      await confirmCashLedger(destination.accountId, destination.statementId)
      const transferInput = {
        toAccountId: destination.accountId,
        idempotencyKey: `transfer-${randomUUID()}`,
        effectiveDate: '2026-10-03',
        sourceSequence: 1,
        destinationSequence: 1,
        currency: 'AUD',
        amount: '40',
        fee: '1',
        sourceReference: `statement-${randomUUID()}`,
      }
      const posted = await postAccountCashTransfer(
        source.userId,
        source.accountId,
        transferInput
      )
      const review = await readLiveCashTransferReview(
        source.userId,
        source.accountId,
        posted.sourceOperationId
      )
      const correction = {
        idempotencyKey: `fix-${randomUUID()}`,
        reason: 'Correct statement amount and fee',
        sourceHead: review.sourceHead,
        destinationHead: review.destinationHead,
        replacement: {
          effectiveDate: '2026-10-03',
          sourceSequence: 1,
          destinationSequence: 1,
          amount: '30',
          fee: '2',
        },
      }
      const corrected = await correctLiveCashTransfer(
        source.userId,
        source.accountId,
        posted.sourceOperationId,
        correction
      )
      expect(corrected.sourceReplay.balances[0]).toMatchObject({
        endingAmount: '68',
        netExternalContribution: '-30',
      })
      expect(corrected.destinationReplay.balances[0]).toMatchObject({
        endingAmount: '30',
        netExternalContribution: '30',
      })
      expect(
        await correctLiveCashTransfer(
          source.userId,
          source.accountId,
          posted.sourceOperationId,
          correction
        )
      ).toMatchObject({
        created: false,
        sourceRevisionId: corrected.sourceRevisionId,
        destinationRevisionId: corrected.destinationRevisionId,
      })
      await expect(
        correctLiveCashTransfer(
          source.userId,
          source.accountId,
          posted.sourceOperationId,
          {
            ...correction,
            replacement: { ...correction.replacement, fee: '3' },
          }
        )
      ).rejects.toThrow(/Idempotency/)
      const after = await readLiveCapitalOperations(
        source.userId,
        source.accountId
      )
      expect(
        after.auditOperations[0].revisions[0].postings.map((row) => row.amount)
      ).toEqual(['40', '1', '-30', '-2'])
      expect(
        (
          await postAccountCashTransfer(
            source.userId,
            source.accountId,
            transferInput
          )
        ).sourceReplay.balances[0].endingAmount
      ).toBe('68')
      const withdrawal = await postAccountCapitalFlow(
        destination.userId,
        destination.accountId,
        {
          kind: 'WITHDRAWAL',
          idempotencyKey: `spend-${randomUUID()}`,
          effectiveDate: '2026-10-04',
          sequence: 1,
          currency: 'AUD',
          amount: '25',
          sourceReference: `spend-${randomUUID()}`,
        }
      )
      const latest = await readLiveCashTransferReview(
        source.userId,
        source.accountId,
        posted.sourceOperationId
      )
      const next = {
        ...correction,
        idempotencyKey: `next-${randomUUID()}`,
        sourceHead: latest.sourceHead,
        destinationHead: latest.destinationHead,
      }
      await expect(
        correctLiveCashTransfer(
          source.userId,
          source.accountId,
          posted.sourceOperationId,
          {
            ...next,
            replacement: { ...next.replacement, amount: '20' },
          }
        )
      ).rejects.toThrow(/Insufficient/)
      await expect(
        correctLiveCashTransfer(
          source.userId,
          source.accountId,
          posted.sourceOperationId,
          {
            ...next,
            replacement: null,
          }
        )
      ).rejects.toThrow(/Insufficient/)
      await expect(
        correctLiveCashTransfer(
          source.userId,
          source.accountId,
          posted.sourceOperationId,
          {
            ...next,
            replacement: {
              ...next.replacement,
              effectiveDate: '2026-10-04',
              sourceSequence: 2,
              destinationSequence: 2,
            },
          }
        )
      ).rejects.toThrow(/Insufficient/)
      expect(
        await prisma.accountCashOperationRevision.count({
          where: {
            operationId: {
              in: [posted.sourceOperationId, posted.destinationOperationId],
            },
          },
        })
      ).toBe(2)
      const moved = await correctLiveCashTransfer(
        source.userId,
        source.accountId,
        posted.sourceOperationId,
        {
          ...next,
          replacement: {
            ...next.replacement,
            effectiveDate: '2026-10-02',
            sourceSequence: 2,
            destinationSequence: 2,
          },
        }
      )
      expect(moved.destinationReplay.balances[0].endingAmount).toBe('5')
      const fundingReview = await readLiveCapitalOperations(
        destination.userId,
        destination.accountId
      )
      await correctLiveCapitalOperation(
        destination.userId,
        destination.accountId,
        withdrawal.operationId,
        {
          idempotencyKey: `unspend-${randomUUID()}`,
          expectedRevisionId: withdrawal.operationId,
          expectedAuditNumber: fundingReview.auditNumber,
          expectedSourceFingerprint: fundingReview.sourceFingerprint,
          reason: 'Duplicate statement withdrawal',
          replacement: null,
        }
      )
      const reversalReview = await readLiveCashTransferReview(
        source.userId,
        source.accountId,
        posted.sourceOperationId
      )
      const reversal = {
        idempotencyKey: `reverse-${randomUUID()}`,
        reason: 'Statement confirms duplicate transfer',
        sourceHead: reversalReview.sourceHead,
        destinationHead: reversalReview.destinationHead,
        replacement: null,
      }
      const reversed = await correctLiveCashTransfer(
        source.userId,
        source.accountId,
        posted.sourceOperationId,
        reversal
      )
      expect(reversed.sourceReplay.balances[0].endingAmount).toBe('100')
      expect(reversed.destinationReplay.balances[0].endingAmount).toBe('0')
      expect(
        (
          await correctLiveCashTransfer(
            source.userId,
            source.accountId,
            posted.sourceOperationId,
            reversal
          )
        ).created
      ).toBe(false)
      const terminal = await readLiveCashTransferReview(
        source.userId,
        source.accountId,
        posted.sourceOperationId
      )
      expect(terminal.current).toBeNull()
      await expect(
        correctLiveCashTransfer(
          source.userId,
          source.accountId,
          posted.sourceOperationId,
          {
            ...reversal,
            idempotencyKey: `after-terminal-${randomUUID()}`,
            sourceHead: terminal.sourceHead,
            destinationHead: terminal.destinationHead,
          }
        )
      ).rejects.toThrow(/reversed transfer/)
    })

    it('rejects stale paired review, reserves historic slots and serializes competing transfer corrections', async () => {
      const {
        postAccountCashTransfer,
        readLiveCashTransferReview,
        correctLiveCashTransfer,
        postAccountCapitalFlow,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const a = await fixture('100')
      const b = await fixture('0')
      await confirmCashLedger(a.accountId, a.statementId)
      await confirmCashLedger(b.accountId, b.statementId)
      const posted = await postAccountCashTransfer(a.userId, a.accountId, {
        toAccountId: b.accountId,
        idempotencyKey: `transfer-${randomUUID()}`,
        effectiveDate: '2026-10-03',
        sourceSequence: 1,
        destinationSequence: 1,
        currency: 'AUD',
        amount: '40',
        fee: '1',
        sourceReference: `statement-${randomUUID()}`,
      })
      let review = await readLiveCashTransferReview(
        a.userId,
        a.accountId,
        posted.sourceOperationId
      )
      const originalHead = review.destinationHead
      await postAccountCapitalFlow(b.userId, b.accountId, {
        kind: 'DEPOSIT',
        idempotencyKey: `deposit-${randomUUID()}`,
        effectiveDate: '2026-10-04',
        sequence: 1,
        currency: 'AUD',
        amount: '1',
        sourceReference: `deposit-${randomUUID()}`,
      })
      const correction = {
        idempotencyKey: `fix-${randomUUID()}`,
        reason: 'Broker date correction',
        sourceHead: review.sourceHead,
        destinationHead: originalHead,
        replacement: {
          effectiveDate: '2026-10-02',
          sourceSequence: 1,
          destinationSequence: 1,
          amount: '35',
          fee: '2',
        },
      }
      await expect(
        correctLiveCashTransfer(
          a.userId,
          a.accountId,
          posted.sourceOperationId,
          correction
        )
      ).rejects.toThrow(/Cash history changed/)
      review = await readLiveCashTransferReview(
        a.userId,
        a.accountId,
        posted.sourceOperationId
      )
      const fixed = {
        ...correction,
        sourceHead: review.sourceHead,
        destinationHead: review.destinationHead,
      }
      const results = await Promise.allSettled([
        correctLiveCashTransfer(
          a.userId,
          a.accountId,
          posted.sourceOperationId,
          fixed
        ),
        correctLiveCashTransfer(
          a.userId,
          a.accountId,
          posted.sourceOperationId,
          { ...fixed, idempotencyKey: `race-${randomUUID()}` }
        ),
      ])
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      const next = await readLiveCashTransferReview(
        a.userId,
        a.accountId,
        posted.sourceOperationId
      )
      await expect(
        correctLiveCashTransfer(
          a.userId,
          a.accountId,
          posted.sourceOperationId,
          {
            ...fixed,
            idempotencyKey: `reserved-${randomUUID()}`,
            sourceHead: next.sourceHead,
            destinationHead: next.destinationHead,
            replacement: { ...fixed.replacement, effectiveDate: '2026-10-03' },
          }
        )
      ).rejects.toThrow(/slots remain reserved/)
      const rows = await prisma.accountCashOperationRevision.findMany({
        where: { operationId: posted.destinationOperationId },
      })
      await prisma.accountCashRevisionPosting.updateMany({
        where: { revisionId: rows[0].id, phase: 'REPLACEMENT' },
        data: { amount: '34' },
      })
      await expect(
        readLiveCapitalOperations(a.userId, a.accountId)
      ).rejects.toThrow(/Paired transfer revision/)
    })

    it('posts paired same-currency transfers once, retains cross-account audit and rejects one-sided changes', async () => {
      const {
        postAccountCashTransfer,
        readLiveCapitalOperations,
        correctLiveCapitalOperation,
        saveDraftCashOperation,
      } = await import('./draft-cash-ledger.js')
      const source = await fixture('100')
      const destination = await fixture('0')
      await confirmCashLedger(source.accountId, source.statementId)
      await confirmCashLedger(destination.accountId, destination.statementId)
      const input = {
        toAccountId: destination.accountId,
        idempotencyKey: `transfer-${randomUUID()}`,
        effectiveDate: '2026-10-03',
        sourceSequence: 1,
        destinationSequence: 1,
        currency: 'AUD',
        amount: '40.000000000001',
        fee: '0.5',
        sourceReference: `statement-${randomUUID()}`,
      }
      const result = await postAccountCashTransfer(
        source.userId,
        source.accountId,
        input
      )
      expect(result.created).toBe(true)
      expect(result.sourceReplay.balances[0]).toMatchObject({
        endingAmount: '59.499999999999',
        netExternalContribution: '-40.000000000001',
      })
      expect(result.destinationReplay.balances[0]).toMatchObject({
        endingAmount: '40.000000000001',
        netExternalContribution: '40.000000000001',
      })
      const retry = await postAccountCashTransfer(
        source.userId,
        source.accountId,
        input
      )
      expect(retry).toMatchObject({
        created: false,
        sourceOperationId: result.sourceOperationId,
        destinationOperationId: result.destinationOperationId,
      })
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, {
          ...input,
          fee: '1',
        })
      ).rejects.toThrow(/Idempotency/)
      const review = await readLiveCapitalOperations(
        source.userId,
        source.accountId
      )
      expect(review.replay.balances[0].endingAmount).toBe('59.499999999999')
      expect(review.auditOperations[0].current).toMatchObject({
        kind: 'TRANSFER_OUT',
        fee: '0.5',
        transfer: {
          fromAccountId: source.accountId,
          toAccountId: destination.accountId,
        },
      })
      await expect(
        correctLiveCapitalOperation(
          source.userId,
          source.accountId,
          result.sourceOperationId,
          {
            idempotencyKey: `reverse-${randomUUID()}`,
            expectedRevisionId: result.sourceOperationId,
            expectedAuditNumber: review.auditNumber,
            expectedSourceFingerprint: review.sourceFingerprint,
            reason: 'One-sided reversal is forbidden',
            replacement: null,
          }
        )
      ).rejects.toThrow()
      await prisma.tradingAccount.update({
        where: { id: source.accountId },
        data: { status: 'CLOSED' },
      })
      expect(
        (await readLiveCapitalOperations(source.userId, source.accountId))
          .replay.balances[0].endingAmount
      ).toBe('59.499999999999')
      expect(
        (await readLiveCapitalOperations(source.userId, destination.accountId))
          .replay.balances[0].endingAmount
      ).toBe('40.000000000001')
      const operation = await prisma.accountCashOperation.findUniqueOrThrow({
        where: { id: result.sourceOperationId },
      })
      if (
        !operation.command ||
        typeof operation.command !== 'object' ||
        !('cashCommand' in operation.command)
      )
        throw new Error('Missing fixture command')
      const draft = await fixture()
      await expect(
        saveDraftCashOperation(
          source.userId,
          draft.statementId,
          operation.command.cashCommand
        )
      ).rejects.toThrow(/paired live/)
      await prisma.accountCashPosting.updateMany({
        where: { operationId: result.destinationOperationId },
        data: { amount: '39' },
      })
      await expect(
        readLiveCapitalOperations(source.userId, source.accountId)
      ).rejects.toThrow(/Paired cash transfer/)
      await prisma.accountCashOperation.delete({
        where: { id: result.destinationOperationId },
      })
      await expect(
        readLiveCapitalOperations(source.userId, source.accountId)
      ).rejects.toThrow(/missing its paired/)
    })

    it('rolls back both transfer legs for invalid endpoints, dates, source drift, slots or funding gaps', async () => {
      const { postAccountCashTransfer, postAccountCapitalFlow } =
        await import('./draft-cash-ledger.js')
      const source = await fixture('100')
      const destination = await fixture('0')
      await confirmCashLedger(source.accountId, source.statementId)
      const input = {
        toAccountId: destination.accountId,
        idempotencyKey: `transfer-${randomUUID()}`,
        effectiveDate: '2026-10-03',
        sourceSequence: 1,
        destinationSequence: 1,
        currency: 'AUD',
        amount: '100',
        fee: '1',
        sourceReference: `statement-${randomUUID()}`,
      }
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, input)
      ).rejects.toThrow(/ledger/)
      await confirmCashLedger(destination.accountId, destination.statementId)
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, input)
      ).rejects.toThrow(/Insufficient/)
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, {
          ...input,
          amount: '1',
          currency: 'USD',
        })
      ).rejects.toThrow(/opening cash/)
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, {
          ...input,
          amount: '1',
          effectiveDate: '2026-10-01',
        })
      ).rejects.toThrow(/opening boundary/)
      await expect(
        postAccountCashTransfer('another-user', source.accountId, input)
      ).rejects.toThrow()
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, {
          ...input,
          toAccountId: 'unowned-account',
        })
      ).rejects.toThrow(/not found/)
      const originalAccount = await prisma.tradingAccount.findUniqueOrThrow({
        where: { id: destination.accountId },
      })
      await prisma.tradingAccount.update({
        where: { id: destination.accountId },
        data: { status: 'CLOSED', updatedAt: originalAccount.updatedAt },
      })
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, input)
      ).rejects.toThrow(/active real/)
      await prisma.tradingAccount.update({
        where: { id: destination.accountId },
        data: {
          status: 'ACTIVE',
          isDemo: true,
          updatedAt: originalAccount.updatedAt,
        },
      })
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, input)
      ).rejects.toThrow(/active real/)
      await prisma.tradingAccount.update({
        where: { id: destination.accountId },
        data: { isDemo: false, updatedAt: originalAccount.updatedAt },
      })
      expect(
        await prisma.accountCashOperation.count({
          where: {
            accountId: { in: [source.accountId, destination.accountId] },
          },
        })
      ).toBe(0)
      await postAccountCapitalFlow(source.userId, source.accountId, {
        kind: 'DEPOSIT',
        idempotencyKey: `late-${randomUUID()}`,
        effectiveDate: '2026-10-04',
        sequence: 1,
        currency: 'AUD',
        amount: '100',
        sourceReference: `late-ref-${randomUUID()}`,
      })
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, {
          ...input,
          amount: '150',
          fee: '0',
        })
      ).rejects.toThrow(/Insufficient/)
      await postAccountCapitalFlow(source.userId, destination.accountId, {
        kind: 'DEPOSIT',
        idempotencyKey: `occupied-${randomUUID()}`,
        effectiveDate: '2026-10-03',
        sequence: 1,
        currency: 'AUD',
        amount: '1',
        sourceReference: `occupied-ref-${randomUUID()}`,
      })
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, {
          ...input,
          amount: '1',
        })
      ).rejects.toThrow(/slots remain reserved/)
      await prisma.tradingAccount.update({
        where: { id: destination.accountId },
        data: {
          updatedAt: new Date(originalAccount.updatedAt.getTime() + 1000),
        },
      })
      await expect(
        postAccountCashTransfer(source.userId, source.accountId, {
          ...input,
          amount: '1',
          destinationSequence: 2,
        })
      ).rejects.toThrow(/source|fingerprint/i)
      expect(
        await prisma.accountCashOperation.count({
          where: { idempotencyKey: input.idempotencyKey },
        })
      ).toBe(0)
    })

    it('serializes competing transfers and opposite-direction retries without overdrawing either ledger', async () => {
      const { postAccountCashTransfer, readLiveCapitalOperations } =
        await import('./draft-cash-ledger.js')
      const a = await fixture('100')
      const b = await fixture('0')
      await confirmCashLedger(a.accountId, a.statementId)
      await confirmCashLedger(b.accountId, b.statementId)
      const input = {
        toAccountId: b.accountId,
        idempotencyKey: `transfer-${randomUUID()}`,
        effectiveDate: '2026-10-03',
        sourceSequence: 1,
        destinationSequence: 1,
        currency: 'AUD',
        amount: '60',
        fee: '1',
        sourceReference: `statement-${randomUUID()}`,
      }
      const results = await Promise.allSettled([
        postAccountCashTransfer(a.userId, a.accountId, input),
        postAccountCashTransfer(a.userId, a.accountId, {
          ...input,
          idempotencyKey: `competing-${randomUUID()}`,
          sourceReference: `competing-${randomUUID()}`,
          sourceSequence: 2,
          destinationSequence: 2,
        }),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        (await readLiveCapitalOperations(a.userId, a.accountId)).replay
          .balances[0].endingAmount
      ).toBe('39')
      expect(
        (await readLiveCapitalOperations(b.userId, b.accountId)).replay
          .balances[0].endingAmount
      ).toBe('60')
      const roundTrip = {
        ...input,
        toAccountId: a.accountId,
        idempotencyKey: `return-${randomUUID()}`,
        amount: '10',
        fee: '0',
        sourceSequence: 3,
        destinationSequence: 3,
        sourceReference: `return-${randomUUID()}`,
      }
      const opposite = {
        ...input,
        idempotencyKey: `opposite-${randomUUID()}`,
        amount: '5',
        fee: '0',
        sourceSequence: 4,
        destinationSequence: 4,
        sourceReference: `opposite-${randomUUID()}`,
      }
      const paired = await Promise.all([
        postAccountCashTransfer(a.userId, b.accountId, roundTrip),
        postAccountCashTransfer(a.userId, a.accountId, opposite),
      ])
      expect(paired.every((result) => result.created)).toBe(true)
      const retries = await Promise.all([
        postAccountCashTransfer(a.userId, b.accountId, roundTrip),
        postAccountCashTransfer(a.userId, b.accountId, roundTrip),
      ])
      expect(retries.every((result) => !result.created)).toBe(true)
      const concurrent = {
        ...opposite,
        amount: '1',
        sourceSequence: 5,
        destinationSequence: 5,
        idempotencyKey: `concurrent-${randomUUID()}`,
        sourceReference: `concurrent-${randomUUID()}`,
      }
      const deduplicated = await Promise.all([
        postAccountCashTransfer(a.userId, a.accountId, concurrent),
        postAccountCashTransfer(a.userId, a.accountId, concurrent),
      ])
      expect(deduplicated.filter((result) => result.created)).toHaveLength(1)
      expect(deduplicated[0].sourceOperationId).toBe(
        deduplicated[1].sourceOperationId
      )
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
    it('rejects cash writes when retained split history is unaudited', async () => {
      const {
        postAccountCapitalFlow,
        readLiveCapitalOperations,
        readAccountTradeCapability,
      } = await import('./draft-cash-ledger.js')
      const { prepareAccountSplit } = await import('./account-split-command.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(f.accountId, f.statementId)
      const position = await prisma.position.findFirstOrThrow({
        where: { accountId: f.accountId, assetId: f.incomeAssetId },
      })
      const request = {
        idempotencyKey: randomUUID(),
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: 'fixture-split-statement',
        statementConfirmed: true,
      }
      const prepared = prepareAccountSplit(request, f.accountId)
      const split = await prisma.accountSplitAction.create({
        data: {
          accountId: f.accountId,
          assetId: f.incomeAssetId,
          effectiveDate: new Date('2026-10-02'),
          newUnits: '2',
          oldUnits: '1',
          sourceReference: request.sourceReference,
          idempotencyKey: request.idempotencyKey,
          payloadHash: prepared.payloadHash,
          sourceFingerprint: 'fixture-source',
          methodology: 'account-split-v1',
          request,
          effects: {
            create: {
              positionId: position.id,
              beforeQuantity: '1',
              afterQuantity: '2',
            },
          },
        },
      })
      await prisma.position.update({
        where: { id: position.id },
        data: { quantity: 2 },
      })
      const ledgerBefore = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      await expect(
        postAccountCapitalFlow(
          f.userId,
          f.accountId,
          liveCapitalFlowInput({ amount: '10' })
        )
      ).rejects.toMatchObject({
        status: 409,
        message: /source changed outside its audited live cash history/,
      })
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
      expect(
        await prisma.accountCashLedger.findUniqueOrThrow({
          where: { accountId: f.accountId },
        })
      ).toEqual(ledgerBefore)
      const history = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(history.cashCompleteness).toBe('INCOMPLETE')
      expect(history.sourceFreshness.status).toBe('STALE')
      expect(
        history.sourceReviewIssues.map((issue) => issue.code)
      ).not.toContain('INVENTORY_MISMATCH')
      expect(history.sourceReviewIssues).toContainEqual(
        expect.objectContaining({
          code: 'SPLIT_REPLAY_UNSUPPORTED',
          sourceId: split.id,
        })
      )
      expect(
        await readAccountTradeCapability(
          f.userId,
          f.accountId,
          currentSydneyDate()
        )
      ).toMatchObject({
        mode: 'BLOCKED',
        reason: expect.stringMatching(/source history has changed/),
      })
    })
    it('posts an exact split atomically, advances the accepted head and resolves concurrent retries', async () => {
      const {
        postAccountSplit,
        postAccountCapitalFlow,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, true, [], true)
      if (!f.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(f.accountId, f.statementId)
      const parcels = await prisma.position.findMany({
        where: { accountId: f.accountId, assetId: f.incomeAssetId },
        include: { transactions: true },
        orderBy: { id: 'asc' },
      })
      expect(parcels).toHaveLength(2)
      const before = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({
          effectiveDate: '2026-10-02',
          amount: '10',
        })
      )
      const cashBeforeSplit = await readLiveCapitalOperations(
        f.userId,
        f.accountId
      )
      const request = {
        idempotencyKey: randomUUID(),
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '3',
        oldUnits: '2',
        sourceReference: `split-statement-${randomUUID()}`,
        statementConfirmed: true,
      }
      const [left, right] = await Promise.all([
        postAccountSplit(f.userId, f.accountId, request),
        postAccountSplit(f.userId, f.accountId, request),
      ])
      expect([left, right].filter((result) => result.created)).toHaveLength(1)
      expect([left, right].filter((result) => !result.created)).toHaveLength(1)
      const actionId = left.actionId
      expect(right.actionId).toBe(actionId)
      await expect(
        postAccountSplit(f.userId, f.accountId, {
          ...request,
          newUnits: '2',
          oldUnits: '1',
        })
      ).rejects.toThrow(
        'Split idempotency key was reused with a different request'
      )
      const action = await prisma.accountSplitAction.findUniqueOrThrow({
        where: { id: actionId },
        include: { effects: { orderBy: { positionId: 'asc' } } },
      })
      expect(action).toMatchObject({
        auditNumber: 2,
        previousFingerprint: cashBeforeSplit.sourceFingerprint,
        sourceFingerprint: cashBeforeSplit.sourceFingerprint,
        nextFingerprint: left.sourceFingerprint,
      })
      expect(
        action.effects.map((effect) => [
          effect.positionId,
          effect.beforeQuantity.toFixed(),
          effect.afterQuantity.toFixed(),
        ])
      ).toEqual(
        parcels.map((parcel) => [
          parcel.id,
          String(parcel.quantity),
          String(parcel.quantity * 1.5),
        ])
      )
      for (const parcel of parcels) {
        const updated = await prisma.position.findUniqueOrThrow({
          where: { id: parcel.id },
          include: { transactions: true },
        })
        expect(updated.quantity).toBe(parcel.quantity * 1.5)
        expect(updated.transactions).toEqual(parcel.transactions)
      }
      const after = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      expect(after.acceptedSourceFingerprint).toBe(left.sourceFingerprint)
      expect(after.openingSourceFingerprint).toBe(
        before.openingSourceFingerprint
      )
      const secondRequest = {
        idempotencyKey: randomUUID(),
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-03',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `split-statement-${randomUUID()}`,
        statementConfirmed: true,
      }
      const secondSplit = await postAccountSplit(
        f.userId,
        f.accountId,
        secondRequest
      )
      expect(secondSplit).toMatchObject({
        created: true,
        auditNumber: 3,
      })
      const afterSecondSplit = await prisma.accountCashLedger.findUniqueOrThrow(
        {
          where: { accountId: f.accountId },
        }
      )
      expect(afterSecondSplit.acceptedSourceFingerprint).toBe(
        secondSplit.sourceFingerprint
      )
      expect(
        await postAccountSplit(f.userId, f.accountId, request)
      ).toMatchObject({
        created: false,
        actionId,
        auditNumber: 2,
        sourceFingerprint: left.sourceFingerprint,
      })
      const postSplitFlow = liveCapitalFlowInput({ amount: '10' })
      const postedFlow = await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        postSplitFlow
      )
      expect(postedFlow.created).toBe(true)
      expect(
        await postAccountCapitalFlow(f.userId, f.accountId, postSplitFlow)
      ).toMatchObject({
        created: false,
        operationId: postedFlow.operationId,
      })
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(2)
      const history = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(history).toMatchObject({
        auditNumber: 4,
        auditTotal: 2,
        sourceFreshness: { status: 'CURRENT' },
        cashCompleteness: 'INCOMPLETE',
      })
      expect(history.replay.balances[0]?.endingAmount).toBe('120')
      expect(cashBeforeSplit.replay.balances[0]?.endingAmount).toBe('110')
    })
    it('posts and corrects statement income using split-adjusted entitlement history', async () => {
      const {
        postAccountSplit,
        postAccountIncomeReceipt,
        correctLiveIncomeReceipt,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture income asset')
      await confirmCashLedger(f.accountId, f.statementId)
      await postAccountSplit(f.userId, f.accountId, {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `split-statement-${randomUUID()}`,
        statementConfirmed: true,
      })

      const incomeInput = {
        idempotencyKey: `income-${randomUUID()}`,
        assetId: f.incomeAssetId,
        entitlementDate: '2026-10-01',
        paymentDate: '2026-10-15',
        sequence: 1,
        currency: 'AUD',
        grossAmount: '100',
        withholdingAmount: '15',
        frankedAmount: '60',
        unfrankedAmount: '40',
        frankingCreditAud: '25.714285714286',
        sourceReference: `income-statement-${randomUUID()}`,
      }
      await expect(
        postAccountIncomeReceipt(f.userId, f.accountId, {
          ...incomeInput,
          idempotencyKey: `ineligible-${randomUUID()}`,
          entitlementDate: '2026-09-29',
        })
      ).rejects.toMatchObject({
        status: 422,
        message: /eligible historical holdings/,
      })

      const posted = await postAccountIncomeReceipt(
        f.userId,
        f.accountId,
        incomeInput
      )
      expect(posted.created).toBe(true)
      const review = await readLiveCapitalOperations(f.userId, f.accountId)
      const audit = review.auditOperations[0]
      if (!audit) throw new Error('Missing income audit record')
      const correction = {
        idempotencyKey: `income-correction-${randomUUID()}`,
        expectedRevisionId: audit.expectedRevisionId,
        expectedAuditNumber: review.auditNumber,
        expectedSourceFingerprint: review.sourceFingerprint,
        reason: 'Correct issuer-statement withholding',
        replacement: {
          entitlementDate: '2026-10-01',
          paymentDate: '2026-10-16',
          sequence: 2,
          grossAmount: '100',
          withholdingAmount: '20',
          frankedAmount: '60',
          unfrankedAmount: '40',
          frankingCreditAud: '25.714285714286',
        },
      }
      await expect(
        correctLiveIncomeReceipt(f.userId, f.accountId, posted.operationId, {
          ...correction,
          idempotencyKey: `ineligible-correction-${randomUUID()}`,
          replacement: {
            ...correction.replacement,
            entitlementDate: '2026-09-29',
          },
        })
      ).rejects.toMatchObject({
        status: 422,
        message: /eligible historical holdings/,
      })
      const corrected = await correctLiveIncomeReceipt(
        f.userId,
        f.accountId,
        posted.operationId,
        correction
      )
      expect(corrected.created).toBe(true)
      expect(
        await correctLiveIncomeReceipt(
          f.userId,
          f.accountId,
          posted.operationId,
          correction
        )
      ).toMatchObject({ created: false, revisionId: corrected.revisionId })
      const after = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(after).toMatchObject({
        sourceFreshness: { status: 'CURRENT' },
        cashCompleteness: 'INCOMPLETE',
        auditNumber: review.auditNumber + 1,
      })
      expect(after.auditOperations[0]?.currentIncomeReceipt).toMatchObject({
        entitlementDate: '2026-10-01',
        paymentDate: '2026-10-16',
        withholdingAmount: '20',
        netAmount: '80',
      })
    })
    it('posts and corrects paired cash transfers on audited split history', async () => {
      const {
        postAccountSplit,
        postAccountCashTransfer,
        readLiveCashTransferReview,
        correctLiveCashTransfer,
      } = await import('./draft-cash-ledger.js')
      const source = await fixture('100', false, false, true)
      const destination = await fixture('0')
      if (!source.incomeAssetId) throw new Error('Missing fixture income asset')
      await confirmCashLedger(source.accountId, source.statementId)
      await confirmCashLedger(destination.accountId, destination.statementId)
      await postAccountSplit(source.userId, source.accountId, {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: source.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `split-statement-${randomUUID()}`,
        statementConfirmed: true,
      })
      const input = {
        toAccountId: destination.accountId,
        idempotencyKey: `transfer-${randomUUID()}`,
        effectiveDate: currentSydneyDate(),
        sourceSequence: 1,
        destinationSequence: 1,
        currency: 'AUD',
        amount: '10',
        fee: '1',
        sourceReference: `transfer-statement-${randomUUID()}`,
      }
      const posted = await postAccountCashTransfer(
        source.userId,
        source.accountId,
        input
      )
      expect(posted.created).toBe(true)
      expect(
        await postAccountCashTransfer(source.userId, source.accountId, input)
      ).toMatchObject({
        created: false,
        sourceOperationId: posted.sourceOperationId,
        destinationOperationId: posted.destinationOperationId,
      })
      const review = await readLiveCashTransferReview(
        source.userId,
        source.accountId,
        posted.sourceOperationId
      )
      const correction = {
        idempotencyKey: `transfer-correction-${randomUUID()}`,
        reason: 'Correct transfer from statement',
        sourceHead: review.sourceHead,
        destinationHead: review.destinationHead,
        replacement: {
          effectiveDate: input.effectiveDate,
          sourceSequence: 2,
          destinationSequence: 2,
          amount: '9',
          fee: '2',
        },
      }
      const corrected = await correctLiveCashTransfer(
        source.userId,
        source.accountId,
        posted.sourceOperationId,
        correction
      )
      expect(corrected.created).toBe(true)
      expect(corrected.sourceReplay.balances[0]?.endingAmount).toBe('89')
      expect(corrected.destinationReplay.balances[0]?.endingAmount).toBe('9')
    })
    it('reverses a terminal split retroactively, preserves audit evidence and permits corrected source/date reuse', async () => {
      const {
        postAccountSplit,
        reverseAccountSplit,
        postAccountIncomeReceipt,
        readLiveCapitalOperations,
        postAccountCapitalFlow,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(f.accountId, f.statementId)
      const position = await prisma.position.findFirstOrThrow({
        where: { accountId: f.accountId, assetId: f.incomeAssetId },
        include: { transactions: true },
      })
      const acquisitionSnapshot = position.transactions
      const sourceReference = `split-statement-${randomUUID()}`
      const originalRequest = {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference,
        statementConfirmed: true,
      }
      const income = await postAccountIncomeReceipt(f.userId, f.accountId, {
        idempotencyKey: `income-${randomUUID()}`,
        assetId: f.incomeAssetId,
        entitlementDate: '2026-10-03',
        paymentDate: '2026-10-15',
        sequence: 1,
        currency: 'AUD',
        grossAmount: '100',
        withholdingAmount: '15',
        frankedAmount: '60',
        unfrankedAmount: '40',
        frankingCreditAud: '25.714285714286',
        sourceReference: `income-statement-${randomUUID()}`,
      })
      const incomeBeforeReversal =
        await prisma.accountCashOperation.findUniqueOrThrow({
          where: { id: income.operationId },
          include: { postings: true, incomeReceipt: true },
        })
      const original = await postAccountSplit(
        f.userId,
        f.accountId,
        originalRequest
      )
      const beforeReversal = await readLiveCapitalOperations(
        f.userId,
        f.accountId
      )
      const reversalRequest = {
        idempotencyKey: `reverse-${randomUUID()}`,
        actionId: original.actionId,
        expectedAuditNumber: beforeReversal.auditNumber,
        expectedSourceFingerprint: beforeReversal.sourceFingerprint,
        reason: 'Corrected statement evidence',
        reversalConfirmed: true,
      }
      const reversed = await reverseAccountSplit(
        f.userId,
        f.accountId,
        reversalRequest
      )
      expect(reversed).toMatchObject({
        created: true,
        actionId: original.actionId,
        auditNumber: beforeReversal.auditNumber + 1,
        affectedParcels: 1,
      })
      const retry = await reverseAccountSplit(
        f.userId,
        f.accountId,
        reversalRequest
      )
      expect(retry).toMatchObject({
        created: false,
        reversalId: reversed.reversalId,
        actionId: original.actionId,
        auditNumber: reversed.auditNumber,
        sourceFingerprint: reversed.sourceFingerprint,
      })
      const action = await prisma.accountSplitAction.findUniqueOrThrow({
        where: { id: original.actionId },
        include: { effects: true, reversal: true },
      })
      expect(action.reversal).toMatchObject({
        auditNumber: reversed.auditNumber,
        previousFingerprint: beforeReversal.sourceFingerprint,
        nextFingerprint: reversed.sourceFingerprint,
      })
      expect(action.effects).toHaveLength(1)
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: position.id },
          include: { transactions: true },
        })
      ).toMatchObject({
        quantity: 1,
        transactions: acquisitionSnapshot,
      })
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(1)
      const incomeAfterReversal =
        await prisma.accountCashOperation.findUniqueOrThrow({
          where: { id: income.operationId },
          include: { postings: true, incomeReceipt: true },
        })
      expect(incomeAfterReversal.incomeReceipt).toEqual(
        incomeBeforeReversal.incomeReceipt
      )
      expect(incomeAfterReversal.postings).toEqual(
        incomeBeforeReversal.postings
      )
      const afterReversal = await readLiveCapitalOperations(
        f.userId,
        f.accountId
      )
      expect(afterReversal).toMatchObject({
        auditNumber: reversed.auditNumber,
        sourceFingerprint: reversed.sourceFingerprint,
        sourceFreshness: { status: 'CURRENT' },
        cashCompleteness: 'INCOMPLETE',
      })
      const fundingAfterReversal = await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({ amount: '10' })
      )
      expect(fundingAfterReversal.created).toBe(true)

      const corrected = await postAccountSplit(f.userId, f.accountId, {
        ...originalRequest,
        idempotencyKey: `corrected-${randomUUID()}`,
        newUnits: '3',
        oldUnits: '2',
      })
      expect(corrected).toMatchObject({
        created: true,
        auditNumber: reversed.auditNumber + 2,
      })
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: position.id },
        })
      ).toMatchObject({ quantity: 1.5 })
      expect(
        await prisma.accountSplitAction.count({
          where: {
            accountId: f.accountId,
            assetId: f.incomeAssetId,
            sourceReference,
            effectiveDate: new Date(originalRequest.effectiveDate),
          },
        })
      ).toBe(2)
    })
    it('blocks split reversal while an active reinvestment depends on split-adjusted entitlement', async () => {
      const {
        postAccountSplit,
        reverseAccountSplit,
        readLiveCapitalOperations,
        postAccountReinvestment,
        readLiveReinvestmentReview,
        correctLiveReinvestment,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(f.accountId, f.statementId)
      const split = await postAccountSplit(f.userId, f.accountId, {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `statement-${randomUUID()}`,
        statementConfirmed: true,
      })
      const reinvestment = {
        idempotencyKey: randomUUID(),
        income: {
          assetId: f.incomeAssetId,
          entitlementDate: '2026-10-03',
          paymentDate: '2026-10-15',
          sequence: 1,
          currency: 'AUD',
          grossAmount: '100',
          withholdingAmount: '15',
          frankedAmount: '60',
          unfrankedAmount: '40',
          frankingCreditAud: '25',
          sourceReference: `drp-statement-${randomUUID()}`,
        },
        acquisition: {
          effectiveDate: '2026-10-17',
          sequence: 2,
          quantity: '4',
          price: '20',
          fees: '1',
        },
        residualAmount: '4',
        residualDisposition: 'ACCOUNT_CASH' as const,
        statementConfirmed: true as const,
      }
      const posted = await postAccountReinvestment(
        f.userId,
        f.accountId,
        reinvestment
      )
      const head = await readLiveCapitalOperations(f.userId, f.accountId)
      const reversal = {
        idempotencyKey: `reverse-${randomUUID()}`,
        actionId: split.actionId,
        expectedAuditNumber: head.auditNumber,
        expectedSourceFingerprint: head.sourceFingerprint,
        reason: 'Protect split-adjusted reinvestment entitlement',
        reversalConfirmed: true,
      }
      await expect(
        reverseAccountSplit(f.userId, f.accountId, reversal)
      ).rejects.toThrow(/dependent reinvestments/)
      expect(
        await prisma.accountSplitReversal.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)

      const review = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.incomeOperationId
      )
      await correctLiveReinvestment(
        f.userId,
        f.accountId,
        posted.incomeOperationId,
        {
          idempotencyKey: randomUUID(),
          expectedIncomeRevisionId: review.expectedIncomeRevisionId,
          expectedAcquisitionRevisionId: review.expectedAcquisitionRevisionId,
          expectedAuditNumber: review.expectedAuditNumber,
          expectedSourceFingerprint: review.expectedSourceFingerprint,
          reason: 'Reverse dependent reinvestment before split correction',
          replacement: null,
        }
      )
      const refreshed = await readLiveCapitalOperations(f.userId, f.accountId)
      await expect(
        reverseAccountSplit(f.userId, f.accountId, {
          ...reversal,
          idempotencyKey: `reverse-after-drp-${randomUUID()}`,
          expectedAuditNumber: refreshed.auditNumber,
          expectedSourceFingerprint: refreshed.sourceFingerprint,
        })
      ).resolves.toMatchObject({ created: true, actionId: split.actionId })
    })

    it('rejects reversal while a later active split depends on the target action', async () => {
      const {
        postAccountSplit,
        reverseAccountSplit,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(f.accountId, f.statementId)
      const first = await postAccountSplit(f.userId, f.accountId, {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `statement-${randomUUID()}`,
        statementConfirmed: true,
      })
      await postAccountSplit(f.userId, f.accountId, {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-03',
        newUnits: '3',
        oldUnits: '2',
        sourceReference: `statement-${randomUUID()}`,
        statementConfirmed: true,
      })
      const head = await readLiveCapitalOperations(f.userId, f.accountId)
      await expect(
        reverseAccountSplit(f.userId, f.accountId, {
          idempotencyKey: `reverse-${randomUUID()}`,
          actionId: first.actionId,
          expectedAuditNumber: head.auditNumber,
          expectedSourceFingerprint: head.sourceFingerprint,
          reason: 'Test dependency guard',
          reversalConfirmed: true,
        })
      ).rejects.toThrow(/later active splits first/)
      expect(
        await prisma.accountSplitReversal.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
      expect(
        await prisma.position.findFirstOrThrow({
          where: { accountId: f.accountId, assetId: f.incomeAssetId },
        })
      ).toMatchObject({ quantity: 3 })
    })
    it('rejects split reversal when retained history contains a later parcel sale', async () => {
      const {
        postAccountSplit,
        reverseAccountSplit,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(f.accountId, f.statementId)
      const split = await postAccountSplit(f.userId, f.accountId, {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `statement-${randomUUID()}`,
        statementConfirmed: true,
      })
      const position = await prisma.position.findFirstOrThrow({
        where: { accountId: f.accountId, assetId: f.incomeAssetId },
      })
      await prisma.transaction.create({
        data: {
          positionId: position.id,
          type: 'SELL',
          date: new Date('2026-10-03T00:00:00Z'),
          quantity: 0.5,
          price: '80',
          totalValue: '40',
          fees: '1',
        },
      })
      await prisma.position.update({
        where: { id: position.id },
        data: { quantity: 1.5 },
      })
      const preview = await previewAccountOpening(f.userId, f.accountId, {
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '100' }],
      })
      await prisma.accountSplitAction.update({
        where: { id: split.actionId },
        data: { nextFingerprint: preview.sourceFingerprint },
      })
      await prisma.accountCashLedger.update({
        where: { accountId: f.accountId },
        data: { acceptedSourceFingerprint: preview.sourceFingerprint },
      })
      const head = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(head.sourceFreshness).toMatchObject({ status: 'CURRENT' })
      await expect(
        reverseAccountSplit(f.userId, f.accountId, {
          idempotencyKey: `reverse-${randomUUID()}`,
          actionId: split.actionId,
          expectedAuditNumber: head.auditNumber,
          expectedSourceFingerprint: head.sourceFingerprint,
          reason: 'Protect a retained later sale',
          reversalConfirmed: true,
        })
      ).rejects.toThrow(/same-day or later sale/)
      expect(
        await prisma.accountSplitReversal.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: position.id },
        })
      ).toMatchObject({ quantity: 1.5 })
    })
    it('rejects source drift before creating a split action or changing inventory', async () => {
      const { postAccountSplit } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(f.accountId, f.statementId)
      const position = await prisma.position.findFirstOrThrow({
        where: { accountId: f.accountId, assetId: f.incomeAssetId },
      })
      await prisma.position.update({
        where: { id: position.id },
        data: { quantity: 2 },
      })
      const request = {
        idempotencyKey: randomUUID(),
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `stale-split-${randomUUID()}`,
        statementConfirmed: true,
      }
      await expect(
        postAccountSplit(f.userId, f.accountId, request)
      ).rejects.toThrow(/source changed outside its audited history/)
      expect(
        await prisma.accountSplitAction.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: position.id },
          })
        ).quantity
      ).toBe(2)
    })
    it('rejects closed accounts and unsupported unlinked trades before split mutation', async () => {
      const { postAccountSplit } = await import('./draft-cash-ledger.js')
      const closed = await fixture('100', false, false, true)
      if (!closed.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(closed.accountId, closed.statementId)
      await prisma.tradingAccount.update({
        where: { id: closed.accountId },
        data: { status: 'CLOSED' },
      })
      const closedRequest = {
        idempotencyKey: randomUUID(),
        assetId: closed.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `closed-split-${randomUUID()}`,
        statementConfirmed: true,
      }
      await expect(
        postAccountSplit(closed.userId, closed.accountId, closedRequest)
      ).rejects.toThrow('Stock splits require an active real account')
      expect(
        await prisma.accountSplitAction.count({
          where: { accountId: closed.accountId },
        })
      ).toBe(0)

      const unsupported = await fixture('100', true, false, true)
      if (!unsupported.incomeAssetId)
        throw new Error('Missing unsupported fixture holding')
      await confirmCashLedger(unsupported.accountId, unsupported.statementId)
      const unsupportedRequest = {
        idempotencyKey: randomUUID(),
        assetId: unsupported.incomeAssetId,
        effectiveDate: '2026-10-02',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `unsupported-split-${randomUUID()}`,
        statementConfirmed: true,
      }
      await expect(
        postAccountSplit(
          unsupported.userId,
          unsupported.accountId,
          unsupportedRequest
        )
      ).rejects.toThrow('Resolve unsupported account activity')
      expect(
        await prisma.accountSplitAction.count({
          where: { accountId: unsupported.accountId },
        })
      ).toBe(0)
    })
    it('continues the shared audit chain for split-aware trades and cash', async () => {
      const {
        postAccountTrade,
        postAccountCapitalFlow,
        correctLiveCapitalOperation,
        readLiveCapitalOperations,
        readAccountTradeCapability,
      } = await import('./draft-cash-ledger.js')
      const { prepareAccountSplit } = await import('./account-split-command.js')
      const { prepareCashRevision } = await import('./cash-revisions.js')
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture holding')
      await confirmCashLedger(f.accountId, f.statementId)
      await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({
          effectiveDate: '2026-10-02',
          amount: '10',
        })
      )
      const later = await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({
          effectiveDate: '2026-10-04',
          sequence: 2,
          amount: '5',
        })
      )
      const initial = await readLiveCapitalOperations(f.userId, f.accountId)
      const corrected = await correctLiveCapitalOperation(
        f.userId,
        f.accountId,
        later.operationId,
        {
          idempotencyKey: randomUUID(),
          expectedRevisionId: later.operationId,
          expectedAuditNumber: initial.auditNumber,
          expectedSourceFingerprint: initial.sourceFingerprint,
          reason: 'Fixture statement correction',
          replacement: {
            effectiveDate: '2026-10-04',
            sequence: 3,
            amount: '7',
          },
        }
      )
      const revision =
        await prisma.accountCashOperationRevision.findUniqueOrThrow({
          where: { id: corrected.revisionId },
        })
      const before = await readLiveCapitalOperations(f.userId, f.accountId)
      const position = await prisma.position.findFirstOrThrow({
        where: { accountId: f.accountId, assetId: f.incomeAssetId },
        include: { transactions: true },
      })
      const request = {
        idempotencyKey: randomUUID(),
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-03',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: 'audited-fixture-split',
        statementConfirmed: true,
      }
      const prepared = prepareAccountSplit(request, f.accountId)
      // This fixture seeds a mismatched source head to exercise replay validation.
      const split = await prisma.$transaction(async (db) => {
        const action = await db.accountSplitAction.create({
          data: {
            accountId: f.accountId,
            assetId: request.assetId,
            effectiveDate: new Date(request.effectiveDate),
            newUnits: request.newUnits,
            oldUnits: request.oldUnits,
            sourceReference: request.sourceReference,
            idempotencyKey: request.idempotencyKey,
            payloadHash: prepared.payloadHash,
            sourceFingerprint: before.sourceFingerprint,
            methodology: 'account-split-v1',
            request,
            auditNumber: 2,
            previousFingerprint: before.sourceFingerprint,
            nextFingerprint: 'f'.repeat(64),
            effects: {
              create: {
                positionId: position.id,
                beforeQuantity: '1',
                afterQuantity: '2',
              },
            },
          },
        })
        await db.position.update({
          where: { id: position.id },
          data: { quantity: 2 },
        })
        return action
      })
      const preview = await previewAccountOpening(f.userId, f.accountId, {
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '100' }],
      })
      const next = preview.sourceFingerprint
      const storedRevision = revision.request
      if (
        !storedRevision ||
        typeof storedRevision !== 'object' ||
        Array.isArray(storedRevision) ||
        !storedRevision.capitalAudit ||
        typeof storedRevision.capitalAudit !== 'object' ||
        Array.isArray(storedRevision.capitalAudit)
      )
        throw new Error('Missing fixture capital revision audit')
      const continuedRequest = {
        ...storedRevision,
        expectedAuditNumber: 3,
        expectedSourceFingerprint: next,
        capitalAudit: {
          ...storedRevision.capitalAudit,
          number: 4,
          previousFingerprint: next,
          nextFingerprint: next,
        },
      }
      await prisma.$transaction([
        prisma.accountSplitAction.update({
          where: { id: split.id },
          data: { nextFingerprint: next },
        }),
        prisma.accountCashOperation.update({
          where: { id: later.operationId },
          data: {
            auditNumber: 3,
            previousFingerprint: next,
            nextFingerprint: next,
          },
        }),
        prisma.accountCashOperationRevision.update({
          where: { id: revision.id },
          data: {
            auditNumber: 4,
            previousFingerprint: next,
            nextFingerprint: next,
            request: continuedRequest,
            payloadHash: prepareCashRevision(continuedRequest).payloadHash,
          },
        }),
        prisma.accountCashLedger.update({
          where: { accountId: f.accountId },
          data: { acceptedSourceFingerprint: next },
        }),
      ])
      const history = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(history.replay).toEqual(before.replay)
      expect(history).toMatchObject({
        auditNumber: 4,
        auditTotal: 2,
        cashCompleteness: 'INCOMPLETE',
        sourceFreshness: { status: 'CURRENT' },
        sourceFingerprint: next,
      })
      expect(history.auditOperations.map((op) => op.auditNumber)).toEqual([
        3, 1,
      ])
      expect(history.auditOperations[0].revisions[0].auditNumber).toBe(4)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: position.id },
            include: { transactions: true },
          })
        ).transactions
      ).toEqual(position.transactions)
      await expect(
        postAccountCapitalFlow(
          f.userId,
          f.accountId,
          liveCapitalFlowInput({ sequence: 2 })
        )
      ).resolves.toMatchObject({ created: true })
      expect(
        await readAccountTradeCapability(f.userId, f.accountId, '2026-10-05')
      ).toMatchObject({ mode: 'LIVE_LEDGER', nextSequence: 1 })

      for (const auditNumber of [1, 4]) {
        await prisma.accountSplitAction.update({
          where: { id: split.id },
          data: { auditNumber },
        })
        await expect(
          readLiveCapitalOperations(f.userId, f.accountId)
        ).rejects.toThrow(/audit sequence/)
      }
      await prisma.accountSplitAction.update({
        where: { id: split.id },
        data: {
          auditNumber: 2,
          previousFingerprint: 'c'.repeat(64),
          sourceFingerprint: 'c'.repeat(64),
        },
      })
      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).rejects.toThrow(/fingerprint chain/)
      await prisma.accountSplitAction.update({
        where: { id: split.id },
        data: {
          previousFingerprint: split.previousFingerprint,
          sourceFingerprint: split.sourceFingerprint,
        },
      })
      await expect(
        prisma.accountSplitAction.update({
          where: { id: split.id },
          data: { nextFingerprint: null },
        })
      ).rejects.toThrow(/account_split_actions_audit_continuation_check/)
      await expect(
        prisma.accountSplitAction.update({
          where: { id: split.id },
          data: { nextFingerprint: 'invalid' },
        })
      ).rejects.toThrow(/account_split_actions_audit_continuation_check/)
      await prisma.accountCashLedger.update({
        where: { accountId: f.accountId },
        data: { acceptedSourceFingerprint: before.sourceFingerprint },
      })
      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).rejects.toThrow('Live cash source audit head is inconsistent')
      await prisma.accountCashLedger.update({
        where: { accountId: f.accountId },
        data: { acceptedSourceFingerprint: next },
      })
      await prisma.accountSplitAction.update({
        where: { id: split.id },
        data: { recordedAt: new Date('2026-10-05') },
      })
      expect(
        (await readLiveCapitalOperations(f.userId, f.accountId)).sourceFreshness
          .status
      ).toBe('STALE')
      await prisma.accountSplitAction.update({
        where: { id: split.id },
        data: { recordedAt: split.recordedAt },
      })
      for (const [effectiveDate, sequence] of [
        ['2026-10-02', 2],
        ['2026-10-03', 1],
      ] as const)
        await expect(
          postAccountTrade(f.userId, f.accountId, {
            kind: 'BUY',
            assetId: f.incomeAssetId,
            idempotencyKey: randomUUID(),
            effectiveDate,
            sequence,
            quantity: '1',
            price: '10',
            fees: '0',
          })
        ).rejects.toThrow(/on or before a retained stock split date/)
      const sale = await postAccountTrade(f.userId, f.accountId, {
        kind: 'SELL',
        positionId: position.id,
        idempotencyKey: randomUUID(),
        effectiveDate: '2026-10-05',
        sequence: 1,
        quantity: '1',
        price: '80',
        fees: '1',
      })
      expect(sale.created).toBe(true)
      const laterAcquisition = await postAccountTrade(f.userId, f.accountId, {
        kind: 'BUY',
        assetId: f.incomeAssetId,
        idempotencyKey: randomUUID(),
        effectiveDate: '2026-10-06',
        sequence: 1,
        quantity: '1',
        price: '10',
        fees: '0',
      })
      expect(laterAcquisition.created).toBe(true)
      const afterSale = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(afterSale).toMatchObject({
        auditNumber: 7,
        cashCompleteness: 'INCOMPLETE',
        sourceFreshness: { status: 'CURRENT' },
        replay: {
          funded: true,
          balances: [{ currency: 'AUD', endingAmount: '286' }],
        },
      })
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: position.id },
        })
      ).toMatchObject({ quantity: 1 })
      await prisma.accountSplitParcelEffect.deleteMany({
        where: { actionId: split.id },
      })
      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).rejects.toThrow('Split action is missing its parcel effect')
    })
    it('posts atomic FX with both fee currencies, concurrent exact retries and retained cash-only history', async () => {
      const {
        postAccountFxConversion,
        readLiveCapitalOperations,
        correctLiveCapitalOperation,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('2000', false, false, false, [
        { currency: 'USD', amount: '0' },
      ])
      const input = {
        idempotencyKey: `fx-${randomUUID()}`,
        effectiveDate: currentSydneyDate(),
        sequence: 1,
        from: { currency: 'AUD', amount: '1500.000000000001' },
        to: { currency: 'USD', amount: '975' },
        fees: [
          { currency: 'USD', amount: '2' },
          { currency: 'AUD', amount: '5' },
        ],
        sourceReference: `fx-statement-${randomUUID()}`,
      }
      await expect(
        postAccountFxConversion(f.userId, f.accountId, input)
      ).rejects.toThrow(/confirmed/)
      await confirmCashLedger(f.accountId, f.statementId)
      const results = await Promise.all([
        postAccountFxConversion(f.userId, f.accountId, input),
        postAccountFxConversion(f.userId, f.accountId, {
          ...input,
          fees: input.fees.slice().reverse(),
        }),
      ])
      expect(results.map((result) => result.created).sort()).toEqual([
        false,
        true,
      ])
      expect(results[0].operationId).toBe(results[1].operationId)
      expect(results[0].replay.balances).toMatchObject([
        {
          currency: 'AUD',
          endingAmount: '494.999999999999',
          netExternalContribution: '0',
        },
        { currency: 'USD', endingAmount: '973', netExternalContribution: '0' },
      ])
      await expect(
        postAccountFxConversion(f.userId, f.accountId, {
          ...input,
          to: { currency: 'USD', amount: '976' },
        })
      ).rejects.toThrow(/different/)
      const operation = await prisma.accountCashOperation.findUniqueOrThrow({
        where: { id: results[0].operationId },
        include: { postings: { orderBy: { legIndex: 'asc' } } },
      })
      expect(
        operation.postings.map((posting) => [
          posting.role,
          posting.amount.toFixed(),
        ])
      ).toEqual([
        ['FX_PRINCIPAL', '-1500.000000000001'],
        ['FX_PRINCIPAL', '975'],
        ['CASH_FEE', '-5'],
        ['CASH_FEE', '-2'],
      ])
      expect(operation.previousFingerprint).toBe(operation.nextFingerprint)
      expect(
        await prisma.transaction.count({
          where: { position: { accountId: f.accountId } },
        })
      ).toBe(0)
      const review = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(review.auditOperations[0].original).toMatchObject({
        kind: 'FX_CONVERSION',
        from: input.from,
        to: input.to,
      })
      await expect(
        correctLiveCapitalOperation(f.userId, f.accountId, operation.id, {
          idempotencyKey: `fx-reverse-${randomUUID()}`,
          expectedRevisionId: operation.id,
          expectedAuditNumber: review.auditNumber,
          expectedSourceFingerprint: review.sourceFingerprint,
          reason: 'Unsupported one-sided reversal',
          replacement: null,
        })
      ).rejects.toThrow(/capital|funding|deposit|withdrawal/i)
      await prisma.tradingAccount.update({
        where: { id: f.accountId },
        data: { status: 'CLOSED' },
      })
      expect(
        (await readLiveCapitalOperations(f.userId, f.accountId))
          .auditOperations[0].original.kind
      ).toBe('FX_CONVERSION')
      await expect(
        postAccountFxConversion(f.userId, f.accountId, input)
      ).rejects.toThrow(/active|closed|archived/i)
    })

    it('rolls back FX when either currency is missing or a backdated timeline cannot fund it', async () => {
      const { postAccountFxConversion, postAccountCapitalFlow } =
        await import('./draft-cash-ledger.js')
      const input = {
        idempotencyKey: `fx-${randomUUID()}`,
        effectiveDate: '2026-10-12',
        sequence: 1,
        from: { currency: 'AUD', amount: '1500' },
        to: { currency: 'USD', amount: '975' },
        fees: [],
        sourceReference: `fx-statement-${randomUUID()}`,
      }
      const missing = await fixture('2000')
      await confirmCashLedger(missing.accountId, missing.statementId)
      await expect(
        postAccountFxConversion(missing.userId, missing.accountId, input)
      ).rejects.toThrow(/Missing explicit opening/)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: missing.accountId },
        })
      ).toBe(0)
      const f = await fixture('1000', false, false, false, [
        { currency: 'USD', amount: '0' },
      ])
      await confirmCashLedger(f.accountId, f.statementId)
      await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({
          effectiveDate: '2026-10-13',
          amount: '1000',
        })
      )
      await expect(
        postAccountFxConversion(f.userId, f.accountId, input)
      ).rejects.toThrow(/Insufficient recorded cash/i)
      await expect(
        postAccountFxConversion(f.userId, f.accountId, {
          ...input,
          effectiveDate: '2026-10-13',
        })
      ).rejects.toThrow(/sequence|slot/i)
      await expect(
        postAccountFxConversion(f.userId, f.accountId, {
          ...input,
          effectiveDate: '2026-10-01',
        })
      ).rejects.toThrow(/opening/i)
      await expect(
        postAccountFxConversion(f.userId, f.accountId, {
          ...input,
          effectiveDate: '2026-10-14',
          fees: [{ currency: 'USD', amount: '976' }],
        })
      ).rejects.toThrow(/Insufficient recorded cash/i)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(1)
    })

    it('serializes competing FX writes so the same source cash cannot be spent twice', async () => {
      const { postAccountFxConversion, readLiveCapitalOperations } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, false, [
        { currency: 'USD', amount: '0' },
      ])
      await confirmCashLedger(f.accountId, f.statementId)
      const input = {
        effectiveDate: currentSydneyDate(),
        from: { currency: 'AUD', amount: '60' },
        to: { currency: 'USD', amount: '39' },
        fees: [],
      }
      await expect(
        postAccountFxConversion('unowned-fixture-user', f.accountId, {
          ...input,
          sequence: 1,
          idempotencyKey: randomUUID(),
          sourceReference: randomUUID(),
        })
      ).rejects.toMatchObject({ status: 401 })
      const outcomes = await Promise.allSettled(
        [1, 2].map((sequence) =>
          postAccountFxConversion(f.userId, f.accountId, {
            ...input,
            sequence,
            idempotencyKey: randomUUID(),
            sourceReference: randomUUID(),
          })
        )
      )
      expect(
        outcomes.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      const failure = outcomes.find((result) => result.status === 'rejected')
      expect(
        failure?.status === 'rejected' ? failure.reason : null
      ).toMatchObject({ status: 422 })
      const review = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(review.replay.balances).toMatchObject([
        { currency: 'AUD', endingAmount: '40' },
        { currency: 'USD', endingAmount: '39' },
      ])
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(1)
    })

    it('fails closed on tampered signed FX postings', async () => {
      const { postAccountFxConversion, readLiveCapitalOperations } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, false, [
        { currency: 'USD', amount: '0' },
      ])
      await confirmCashLedger(f.accountId, f.statementId)
      const input = {
        idempotencyKey: `fx-${randomUUID()}`,
        effectiveDate: currentSydneyDate(),
        sequence: 1,
        from: { currency: 'AUD', amount: '50' },
        to: { currency: 'USD', amount: '30' },
        fees: [],
        sourceReference: `fx-statement-${randomUUID()}`,
      }
      const result = await postAccountFxConversion(f.userId, f.accountId, input)
      const posting = await prisma.accountCashPosting.findFirstOrThrow({
        where: { operationId: result.operationId },
      })
      await prisma.accountCashPosting.update({
        where: { id: posting.id },
        data: { amount: '999' },
      })
      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).rejects.toThrow(/FX|postings|inconsistent/i)
      await expect(
        postAccountFxConversion(f.userId, f.accountId, input)
      ).rejects.toThrow(/FX|postings|inconsistent/i)
    })

    it('audits exact FX correction/reversal legs, preserves retries and blocks unfunded terminal removal', async () => {
      const {
        postAccountFxConversion,
        correctLiveFxConversion,
        readLiveFxConversionReview,
        postAccountCapitalFlow,
        correctLiveCapitalOperation,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, false, [
        { currency: 'USD', amount: '0' },
      ])
      await confirmCashLedger(f.accountId, f.statementId)
      const postedInput = {
        idempotencyKey: randomUUID(),
        effectiveDate: currentSydneyDate(),
        sequence: 1,
        from: { currency: 'AUD', amount: '50' },
        to: { currency: 'USD', amount: '30' },
        fees: [
          { currency: 'AUD', amount: '1' },
          { currency: 'USD', amount: '2' },
        ],
        sourceReference: randomUUID(),
      }
      const posted = await postAccountFxConversion(
        f.userId,
        f.accountId,
        postedInput
      )
      const head = await readLiveFxConversionReview(
        f.userId,
        f.accountId,
        posted.operationId
      )
      const correction = {
        idempotencyKey: randomUUID(),
        expectedRevisionId: head.expectedRevisionId,
        expectedAuditNumber: head.auditNumber,
        expectedSourceFingerprint: head.sourceFingerprint,
        reason: 'Correct statement amounts and fees',
        replacement: {
          effectiveDate: currentSydneyDate(),
          sequence: 2,
          fromAmount: '40',
          toAmount: '25',
          fees: [
            { currency: 'USD', amount: '1' },
            { currency: 'AUD', amount: '2' },
          ],
        },
      }
      const corrected = await correctLiveFxConversion(
        f.userId,
        f.accountId,
        posted.operationId,
        correction
      )
      expect(corrected.replay.balances).toMatchObject([
        { currency: 'AUD', endingAmount: '58', netExternalContribution: '0' },
        { currency: 'USD', endingAmount: '24', netExternalContribution: '0' },
      ])
      const revision =
        await prisma.accountCashOperationRevision.findUniqueOrThrow({
          where: { id: corrected.revisionId },
          include: { postings: { orderBy: { legIndex: 'asc' } } },
        })
      expect(
        revision.postings.map((row) => [
          row.phase,
          row.currency,
          row.amount.toFixed(),
        ])
      ).toEqual([
        ['REVERSAL', 'AUD', '50'],
        ['REVERSAL', 'USD', '-30'],
        ['REVERSAL', 'AUD', '1'],
        ['REVERSAL', 'USD', '2'],
        ['REPLACEMENT', 'AUD', '-40'],
        ['REPLACEMENT', 'USD', '25'],
        ['REPLACEMENT', 'AUD', '-2'],
        ['REPLACEMENT', 'USD', '-1'],
      ])
      expect(revision.previousFingerprint).toBe(revision.nextFingerprint)
      const withdrawal = await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({
          kind: 'WITHDRAWAL',
          currency: 'USD',
          amount: '24',
          sequence: 3,
        })
      )
      const latest = await readLiveFxConversionReview(
        f.userId,
        f.accountId,
        posted.operationId
      )
      const reverse = {
        idempotencyKey: randomUUID(),
        expectedRevisionId: latest.expectedRevisionId,
        expectedAuditNumber: latest.auditNumber,
        expectedSourceFingerprint: latest.sourceFingerprint,
        reason: 'Erroneous conversion',
        replacement: null,
      }
      await expect(
        correctLiveFxConversion(
          f.userId,
          f.accountId,
          posted.operationId,
          reverse
        )
      ).rejects.toMatchObject({ status: 422 })
      await expect(
        correctLiveFxConversion(f.userId, f.accountId, posted.operationId, {
          ...reverse,
          idempotencyKey: randomUUID(),
          replacement: { ...correction.replacement, toAmount: '23' },
        })
      ).rejects.toMatchObject({ status: 422 })
      await correctLiveCapitalOperation(
        f.userId,
        f.accountId,
        withdrawal.operationId,
        {
          idempotencyKey: randomUUID(),
          expectedRevisionId: withdrawal.operationId,
          expectedAuditNumber: latest.auditNumber,
          expectedSourceFingerprint: latest.sourceFingerprint,
          reason: 'Erroneous withdrawal',
          replacement: null,
        }
      )
      const refreshed = await readLiveFxConversionReview(
        f.userId,
        f.accountId,
        posted.operationId
      )
      const reversed = await correctLiveFxConversion(
        f.userId,
        f.accountId,
        posted.operationId,
        { ...reverse, expectedAuditNumber: refreshed.auditNumber }
      )
      expect(reversed.replay.balances).toMatchObject([
        { currency: 'AUD', endingAmount: '100' },
        { currency: 'USD', endingAmount: '0' },
      ])
      expect(
        (
          await readLiveFxConversionReview(
            f.userId,
            f.accountId,
            posted.operationId
          )
        ).current
      ).toBeNull()
      expect(
        await correctLiveFxConversion(
          f.userId,
          f.accountId,
          posted.operationId,
          correction
        )
      ).toMatchObject({ created: false, revisionId: corrected.revisionId })
      expect(
        await postAccountFxConversion(f.userId, f.accountId, postedInput)
      ).toMatchObject({ created: false, operationId: posted.operationId })
      await expect(
        correctLiveFxConversion(f.userId, f.accountId, posted.operationId, {
          ...correction,
          idempotencyKey: randomUUID(),
        })
      ).rejects.toThrow(/reversed/)
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { operationId: posted.operationId },
        })
      ).toBe(2)
      await prisma.tradingAccount.update({
        where: { id: f.accountId },
        data: { status: 'CLOSED' },
      })
      const archived = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(
        archived.auditOperations.find(
          (row) => row.operationId === posted.operationId
        )
      ).toMatchObject({ current: null, revisions: [{}, {}] })
      await expect(
        readLiveFxConversionReview(f.userId, f.accountId, posted.operationId)
      ).rejects.toThrow(/active|closed|archived/i)
    })

    it('protects FX current heads, reserved slots and complete revision audit replay under competing corrections', async () => {
      const {
        postAccountFxConversion,
        correctLiveFxConversion,
        readLiveFxConversionReview,
        postAccountCapitalFlow,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, false, [
        { currency: 'USD', amount: '0' },
      ])
      await confirmCashLedger(f.accountId, f.statementId)
      const posted = await postAccountFxConversion(f.userId, f.accountId, {
        idempotencyKey: randomUUID(),
        effectiveDate: currentSydneyDate(),
        sequence: 1,
        from: { currency: 'AUD', amount: '50' },
        to: { currency: 'USD', amount: '30' },
        fees: [],
        sourceReference: randomUUID(),
      })
      const head = await readLiveFxConversionReview(
        f.userId,
        f.accountId,
        posted.operationId
      )
      const request = {
        idempotencyKey: randomUUID(),
        expectedRevisionId: head.expectedRevisionId,
        expectedAuditNumber: head.auditNumber,
        expectedSourceFingerprint: head.sourceFingerprint,
        reason: 'Statement correction',
        replacement: {
          effectiveDate: currentSydneyDate(),
          sequence: 2,
          fromAmount: '50',
          toAmount: '30',
          fees: [],
        },
      }
      await expect(
        correctLiveFxConversion(f.userId, f.accountId, posted.operationId, {
          ...request,
          replacement: { ...request.replacement, sequence: 1 },
        })
      ).rejects.toMatchObject({ status: 400 })
      await expect(
        correctLiveFxConversion(f.userId, f.accountId, posted.operationId, {
          ...request,
          replacement: { ...request.replacement, fromAmount: '101' },
        })
      ).rejects.toMatchObject({ status: 422 })
      await expect(
        correctLiveFxConversion(f.userId, f.accountId, posted.operationId, {
          ...request,
          replacement: { ...request.replacement, effectiveDate: '2026-10-01' },
        })
      ).rejects.toThrow(/opening/)
      const outcomes = await Promise.allSettled([
        correctLiveFxConversion(
          f.userId,
          f.accountId,
          posted.operationId,
          request
        ),
        correctLiveFxConversion(f.userId, f.accountId, posted.operationId, {
          ...request,
          idempotencyKey: randomUUID(),
          replacement: { ...request.replacement, sequence: 3, toAmount: '31' },
        }),
      ])
      const successful = outcomes.find(
        (result) => result.status === 'fulfilled'
      )
      expect(
        outcomes.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        outcomes.filter((result) => result.status === 'rejected')
      ).toHaveLength(1)
      if (!successful || successful.status !== 'fulfilled')
        throw new Error('Missing isolated FX correction')
      await expect(
        postAccountCapitalFlow(
          f.userId,
          f.accountId,
          liveCapitalFlowInput({ sequence: 1 })
        )
      ).rejects.toThrow(/slot|sequence/i)
      const refreshed = await readLiveFxConversionReview(
        f.userId,
        f.accountId,
        posted.operationId
      )
      await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({ sequence: 4 })
      )
      await expect(
        correctLiveFxConversion(f.userId, f.accountId, posted.operationId, {
          ...request,
          idempotencyKey: randomUUID(),
          expectedRevisionId: refreshed.expectedRevisionId,
          expectedAuditNumber: refreshed.auditNumber,
          replacement: null,
        })
      ).rejects.toThrow(/history changed/i)
      const leg = await prisma.accountCashRevisionPosting.findFirstOrThrow({
        where: { revisionId: successful.value.revisionId },
      })
      await prisma.accountCashRevisionPosting.update({
        where: { id: leg.id },
        data: { amount: '999' },
      })
      await expect(
        readLiveFxConversionReview(f.userId, f.accountId, posted.operationId)
      ).rejects.toThrow(/revision|postings|inconsistent/i)
    })
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
    function liveCapitalFlowInput(
      overrides: Record<string, unknown> = {}
    ): Record<string, unknown> {
      return {
        kind: 'DEPOSIT',
        idempotencyKey: `live-capital-${randomUUID()}`,
        effectiveDate: currentSydneyDate(),
        sequence: 1,
        currency: 'AUD',
        amount: '100',
        sourceReference: `bank-ref-${randomUUID()}`,
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

    async function liveImportedExecutionFixture(openingCash = '100') {
      if (!exchangeId) throw new Error('Missing fixture exchange')
      const { beginLiveImportPosting } = await import('./draft-cash-ledger.js')
      const f = await fixture(openingCash)
      await confirmCashLedger(f.accountId, f.statementId)
      const asset = await prisma.asset.create({
        data: {
          symbol: `LIVE-IMPORT-${randomUUID()}`,
          name: 'Live imported execution fixture',
          exchangeId,
        },
      })
      const externalId = `KRAKEN:order:${randomUUID()}`
      const occurredAt = new Date('2026-10-02T00:00:00.000Z')
      const batch = await prisma.importBatch.create({
        data: {
          userId: f.userId,
          accountId: f.accountId,
          source: 'KRAKEN',
          method: 'CSV',
          status: 'PENDING_REVIEW',
          fileNames: ['live-cash-fixture.csv'],
        },
      })
      const event = await prisma.importedEvent.create({
        data: {
          batchId: batch.id,
          userId: f.userId,
          source: 'KRAKEN',
          externalId,
          kind: 'BUY',
          status: 'PENDING',
          occurredAt,
          baseAsset: 'FIXTURE',
          quoteCurrency: 'AUD',
          exchangeCode: 'KRAKEN:AUD',
          quantity: '1',
          price: '60',
          grossValue: '60',
          fee: '1',
          feeCurrency: 'AUD',
          appliedPositionIds: [],
          raw: {},
        },
      })
      let positionId = ''
      let transactionId = ''
      await prisma.$transaction(async (db) => {
        const complete = await beginLiveImportPosting(
          db,
          f.userId,
          f.accountId,
          batch.id,
          [{ id: event.id, occurredAt }]
        )
        if (!complete) throw new Error('Missing live import posting callback')
        const position = await db.position.create({
          data: {
            userId: f.userId,
            accountId: f.accountId,
            assetId: asset.id,
            openDate: occurredAt,
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
                date: occurredAt,
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
        positionId = position.id
        transactionId = position.transactions[0].id
        await db.importedEvent.update({
          where: { id: event.id },
          data: { status: 'APPLIED', appliedPositionIds: [position.id] },
        })
        await db.importBatch.update({
          where: { id: batch.id },
          data: { status: 'COMMITTED', committedAt: new Date() },
        })
        await complete([event.id])
      })
      const operation = await prisma.accountCashOperation.findFirstOrThrow({
        where: { accountId: f.accountId, importedEventId: event.id },
      })
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      return {
        ...f,
        eventId: event.id,
        externalId,
        occurredAt,
        positionId,
        transactionId,
        operationId: operation.id,
        expectedSourceFingerprint: ledger.acceptedSourceFingerprint,
      }
    }

    it('audits imported execution corrections atomically and replays immutable retries', async () => {
      const { correctLiveImportedExecution, readLiveCapitalOperations } =
        await import('./draft-cash-ledger.js')
      const f = await liveImportedExecutionFixture()
      const originalEvent = await prisma.importedEvent.findUniqueOrThrow({
        where: { id: f.eventId },
      })
      const correctionInput = {
        idempotencyKey: randomUUID(),
        expectedRevisionId: f.operationId,
        expectedSourceFingerprint: f.expectedSourceFingerprint,
        reason: 'Corrected from the Kraken statement',
        effectiveDate: '2026-10-03',
        sequence: 2,
        price: '50',
        fees: '2',
      }
      const first = await correctLiveImportedExecution(
        f.userId,
        f.accountId,
        f.eventId,
        correctionInput
      )
      expect(first.replay.balances[0].endingAmount).toBe('48')
      const liveReview = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(liveReview.replay.balances[0]?.endingAmount).toBe('48')
      expect(liveReview.activity[0]).toMatchObject({
        kind: 'BUY',
        sourceOrigin: 'IMPORT',
        sourceReference: f.externalId,
      })
      expect(liveReview.auditOperations[0]?.revisions).toHaveLength(1)
      const firstTransaction = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.transactionId },
      })
      expect(firstTransaction.price.toFixed()).toBe('50')
      expect(firstTransaction.totalValue.toFixed()).toBe('50')
      expect(firstTransaction.fees.toFixed()).toBe('2')
      expect(firstTransaction.quantity).toBe(1)
      expect(firstTransaction.date.toISOString()).toBe(
        '2026-10-03T01:00:00.000Z'
      )
      const firstPosition = await prisma.position.findUniqueOrThrow({
        where: { id: f.positionId },
      })
      expect(firstPosition.quantity).toBe(1)
      expect(firstPosition.buyFees.toFixed()).toBe('2')
      expect(firstPosition.openDate.toISOString()).toBe(
        '2026-10-03T01:00:00.000Z'
      )
      const firstRevision =
        await prisma.accountCashOperationRevision.findUniqueOrThrow({
          where: { id: first.revisionId },
        })
      expect(firstRevision.request).toMatchObject({
        importedExecutionAudit: {
          eventId: f.eventId,
          number: expect.any(Number),
          before: [{ transactionId: f.transactionId, price: '60' }],
          after: [{ transactionId: f.transactionId, price: '50' }],
        },
      })
      expect(
        await prisma.importedEvent.findUniqueOrThrow({
          where: { id: f.eventId },
        })
      ).toEqual(originalEvent)

      const retry = await correctLiveImportedExecution(
        f.userId,
        f.accountId,
        f.eventId,
        correctionInput
      )
      expect(retry).toMatchObject({
        created: false,
        revisionId: first.revisionId,
      })

      const ledgerAfterFirst = await prisma.accountCashLedger.findUniqueOrThrow(
        {
          where: { accountId: f.accountId },
        }
      )
      await expect(
        correctLiveImportedExecution(f.userId, f.accountId, f.eventId, {
          ...correctionInput,
          idempotencyKey: randomUUID(),
          expectedRevisionId: first.revisionId,
          expectedSourceFingerprint: ledgerAfterFirst.acceptedSourceFingerprint,
          price: '120',
        })
      ).rejects.toMatchObject({ status: 422 })
      const afterRejectedCorrection =
        await prisma.transaction.findUniqueOrThrow({
          where: { id: f.transactionId },
        })
      expect(afterRejectedCorrection.price.toFixed()).toBe('50')
      expect(afterRejectedCorrection.fees.toFixed()).toBe('2')
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { operationId: f.operationId },
        })
      ).toBe(1)

      const secondInput = {
        ...correctionInput,
        idempotencyKey: randomUUID(),
        expectedRevisionId: first.revisionId,
        expectedSourceFingerprint: ledgerAfterFirst.acceptedSourceFingerprint,
        price: '55',
        fees: '1',
      }
      const second = await correctLiveImportedExecution(
        f.userId,
        f.accountId,
        f.eventId,
        secondInput
      )
      expect(second.replay.balances[0].endingAmount).toBe('44')
      const oldRetry = await correctLiveImportedExecution(
        f.userId,
        f.accountId,
        f.eventId,
        correctionInput
      )
      expect(oldRetry).toMatchObject({
        created: false,
        revisionId: first.revisionId,
      })
      expect(oldRetry.replay.balances[0].endingAmount).toBe('44')
      expect(
        await prisma.importedEvent.findUniqueOrThrow({
          where: { id: f.eventId },
        })
      ).toEqual(originalEvent)

      const ledgerAfterSecond =
        await prisma.accountCashLedger.findUniqueOrThrow({
          where: { accountId: f.accountId },
        })
      const competing = await Promise.allSettled([
        correctLiveImportedExecution(f.userId, f.accountId, f.eventId, {
          ...secondInput,
          idempotencyKey: randomUUID(),
          expectedRevisionId: second.revisionId,
          expectedSourceFingerprint:
            ledgerAfterSecond.acceptedSourceFingerprint,
          price: '56',
        }),
        correctLiveImportedExecution(f.userId, f.accountId, f.eventId, {
          ...secondInput,
          idempotencyKey: randomUUID(),
          expectedRevisionId: second.revisionId,
          expectedSourceFingerprint:
            ledgerAfterSecond.acceptedSourceFingerprint,
          price: '57',
        }),
      ])
      expect(
        competing.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        competing.filter((result) => result.status === 'rejected')
      ).toHaveLength(1)
    })

    it('reprices an imported multi-parcel sale without changing allocations', async () => {
      const { beginLiveImportPosting, correctLiveImportedExecution } =
        await import('./draft-cash-ledger.js')
      const { readLiveImportedExecutionCorrections } =
        await import('./live-import-corrections.js')
      const { recomputePositionFromTransactions } =
        await import('./position-service.js')
      const f = await liveImportedExecutionFixture('1000')
      if (!exchangeId) throw new Error('Missing fixture exchange')
      const secondAsset = await prisma.asset.create({
        data: {
          symbol: `LIVE-IMPORT-SECOND-${randomUUID()}`,
          name: 'Second live imported execution fixture',
          exchangeId,
        },
      })
      const batch = await prisma.importBatch.create({
        data: {
          userId: f.userId,
          accountId: f.accountId,
          source: 'KRAKEN',
          method: 'CSV',
          status: 'PENDING_REVIEW',
          fileNames: ['live-multiparcel-fixture.csv'],
        },
      })
      const buyOccurredAt = new Date('2026-10-03T00:00:00.000Z')
      const sellOccurredAt = new Date('2026-10-04T00:00:00.000Z')
      const buyExternalId = `KRAKEN:order:${randomUUID()}`
      const sellExternalId = `KRAKEN:order:${randomUUID()}`
      const buyEvent = await prisma.importedEvent.create({
        data: {
          batchId: batch.id,
          userId: f.userId,
          source: 'KRAKEN',
          externalId: buyExternalId,
          kind: 'BUY',
          status: 'PENDING',
          occurredAt: buyOccurredAt,
          baseAsset: 'FIXTURE2',
          quoteCurrency: 'AUD',
          exchangeCode: 'KRAKEN:AUD',
          quantity: '1',
          price: '40',
          grossValue: '40',
          fee: '1',
          feeCurrency: 'AUD',
          appliedPositionIds: [],
          raw: {},
        },
      })
      const sellEvent = await prisma.importedEvent.create({
        data: {
          batchId: batch.id,
          userId: f.userId,
          source: 'KRAKEN',
          externalId: sellExternalId,
          kind: 'SELL',
          status: 'PENDING',
          occurredAt: sellOccurredAt,
          baseAsset: 'FIXTURE',
          quoteCurrency: 'AUD',
          exchangeCode: 'KRAKEN:AUD',
          quantity: '1.5',
          price: '100',
          grossValue: '150',
          fee: '1',
          feeCurrency: 'AUD',
          appliedPositionIds: [],
          raw: {},
        },
      })
      let secondPositionId = ''
      await prisma.$transaction(async (db) => {
        const complete = await beginLiveImportPosting(
          db,
          f.userId,
          f.accountId,
          batch.id,
          [
            { id: buyEvent.id, occurredAt: buyOccurredAt },
            { id: sellEvent.id, occurredAt: sellOccurredAt },
          ]
        )
        if (!complete) throw new Error('Missing live import posting callback')
        const secondPosition = await db.position.create({
          data: {
            userId: f.userId,
            accountId: f.accountId,
            assetId: secondAsset.id,
            openDate: buyOccurredAt,
            entryPrice: '40',
            quantity: 1,
            totalBuyValue: '40',
            buyFees: '1',
            capitalAllocated: '41',
            origin: 'IMPORT_TRADE',
            externalRef: buyExternalId,
            transactions: {
              create: {
                type: 'BUY',
                date: buyOccurredAt,
                quantity: 1,
                price: '40',
                totalValue: '40',
                fees: '1',
                brokerRef: buyExternalId,
              },
            },
          },
          include: { transactions: true },
        })
        secondPositionId = secondPosition.id
        const allocations = [
          { positionId: f.positionId, quantity: 0.75 },
          { positionId: secondPosition.id, quantity: 0.75 },
        ]
        for (const allocation of allocations) {
          await db.transaction.create({
            data: {
              positionId: allocation.positionId,
              type: 'SELL',
              date: sellOccurredAt,
              quantity: allocation.quantity,
              price: '100',
              totalValue: '75',
              fees: '0.5',
              brokerRef: sellExternalId,
            },
          })
          if (
            !(await recomputePositionFromTransactions(
              allocation.positionId,
              db
            ))
          )
            throw new Error('Missing imported sell allocation parcel')
        }
        await db.importedEvent.update({
          where: { id: buyEvent.id },
          data: {
            status: 'APPLIED',
            appliedPositionIds: [secondPosition.id],
          },
        })
        await db.importedEvent.update({
          where: { id: sellEvent.id },
          data: {
            status: 'APPLIED',
            appliedPositionIds: allocations.map(
              (allocation) => allocation.positionId
            ),
          },
        })
        await db.importBatch.update({
          where: { id: batch.id },
          data: { status: 'COMMITTED', committedAt: new Date() },
        })
        await complete([buyEvent.id, sellEvent.id])
      })
      const operation = await prisma.accountCashOperation.findFirstOrThrow({
        where: { accountId: f.accountId, importedEventId: sellEvent.id },
      })
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      const originalEvent = await prisma.importedEvent.findUniqueOrThrow({
        where: { id: sellEvent.id },
      })
      const correction = await correctLiveImportedExecution(
        f.userId,
        f.accountId,
        sellEvent.id,
        {
          idempotencyKey: randomUUID(),
          expectedRevisionId: operation.id,
          expectedSourceFingerprint: ledger.acceptedSourceFingerprint,
          reason: 'Corrected multi-parcel sale from the Kraken statement',
          effectiveDate: '2026-10-04',
          sequence: 1,
          price: '90',
          fees: '2',
        }
      )

      expect(correction.replay.balances[0].endingAmount).toBe('1031')
      const sales = await prisma.transaction.findMany({
        where: { brokerRef: sellExternalId },
        orderBy: { id: 'asc' },
      })
      expect(sales).toHaveLength(2)
      expect(sales.map((sale) => sale.quantity)).toEqual([0.75, 0.75])
      expect(sales.map((sale) => sale.totalValue.toFixed())).toEqual([
        '67.5',
        '67.5',
      ])
      expect(sales.map((sale) => sale.fees.toFixed())).toEqual(['1', '1'])
      const correctionMetadata = await readLiveImportedExecutionCorrections(
        f.userId,
        sales.map((sale) => sale.id)
      )
      expect(
        sales.map((sale) => correctionMetadata.get(sale.id)?.fees)
      ).toEqual(['2', '2'])
      for (const positionId of [f.positionId, secondPositionId]) {
        expect(
          await prisma.position.findUniqueOrThrow({ where: { id: positionId } })
        ).toMatchObject({ quantity: 0.25, status: 'PARTIAL' })
      }
      expect(
        await prisma.importedEvent.findUniqueOrThrow({
          where: { id: sellEvent.id },
        })
      ).toEqual(originalEvent)
    })

    async function voidInput(accountId: string, expectedRevisionId: string) {
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId },
      })
      return {
        idempotencyKey: randomUUID(),
        expectedRevisionId,
        expectedSourceFingerprint: ledger.acceptedSourceFingerprint,
        reason: 'Duplicate manual trade entered in error',
      }
    }

    it.each(['4', '10'])(
      'voids a %s-unit sale, restores inventory and retains immutable trades and postings',
      async (quantity) => {
        const {
          voidLiveManualTrade,
          readLiveManualTradeVoids,
          postAccountTrade,
        } = await import('./draft-cash-ledger.js')
        const f = await liveAcquisitionFixture(quantity)
        const original = await prisma.accountCashOperation.findUniqueOrThrow({
          where: { id: f.sale.operationId },
          include: { postings: true },
        })
        const trade = await prisma.transaction.findUniqueOrThrow({
          where: { id: f.sale.transactionId },
        })
        const input = await voidInput(f.accountId, f.sale.operationId)
        const { computeCapitalGainsReport } = await import('./cgt-engine.js')
        expect(
          (await computeCapitalGainsReport(f.userId, 2026, [f.accountId]))
            .lineItems
        ).toHaveLength(1)
        const result = await voidLiveManualTrade(
          f.userId,
          f.accountId,
          f.sale.transactionId,
          input
        )
        expect(
          (await computeCapitalGainsReport(f.userId, 2026, [f.accountId]))
            .lineItems
        ).toHaveLength(0)
        expect(result.replay.balances[0].endingAmount).toBe('899')
        expect(
          await prisma.position.findUniqueOrThrow({
            where: { id: f.positionId },
          })
        ).toMatchObject({
          quantity: 10,
          status: 'OPEN',
          voidedAt: null,
          closeDate: null,
          realizedPnL: null,
        })
        const retained = await prisma.transaction.findUniqueOrThrow({
          where: { id: f.sale.transactionId },
        })
        expect(retained).toMatchObject({
          id: trade.id,
          date: trade.date,
          type: 'SELL',
          price: trade.price,
          quantity: trade.quantity,
          totalValue: trade.totalValue,
          fees: trade.fees,
          voidedAt: expect.any(Date),
        })
        expect(
          await prisma.accountCashOperation.findUniqueOrThrow({
            where: { id: f.sale.operationId },
            include: { postings: true },
          })
        ).toEqual(original)
        const revision =
          await prisma.accountCashOperationRevision.findUniqueOrThrow({
            where: { id: result.revisionId },
            include: { postings: { orderBy: { legIndex: 'asc' } } },
          })
        expect(revision.request).toMatchObject({
          replacement: null,
          voidAudit: { kind: 'SELL' },
        })
        expect(
          revision.postings.map((row) => [row.phase, row.amount.toFixed()])
        ).toEqual([
          ['REVERSAL', `-${Number(quantity) * 20}`],
          ['REVERSAL', '1'],
        ])
        expect(
          await voidLiveManualTrade(
            f.userId,
            f.accountId,
            f.sale.transactionId,
            input
          )
        ).toMatchObject({ created: false, revisionId: result.revisionId })
        const audits = await readLiveManualTradeVoids(f.userId, f.accountId)
        expect(audits.items[0]).toMatchObject({
          kind: 'SELL',
          reason: input.reason,
          transactionId: trade.id,
        })
        await expect(
          postAccountTrade(
            f.userId,
            f.accountId,
            liveTradeInput({
              assetId: f.assetId,
              effectiveDate: '2026-10-03',
              sequence: 1,
            })
          )
        ).rejects.toMatchObject({ status: 409 })
        const next = await postAccountTrade(f.userId, f.accountId, {
          kind: 'SELL',
          positionId: f.positionId,
          idempotencyKey: randomUUID(),
          effectiveDate: '2026-10-04',
          sequence: 1,
          quantity: '1',
          price: '20',
          fees: '0',
        })
        expect(next.replay.balances[0].endingAmount).toBe('919')
        expect(
          await prisma.position.findUniqueOrThrow({
            where: { id: f.positionId },
          })
        ).toMatchObject({ quantity: 9, status: 'PARTIAL' })
      }
    )

    it('voids an acquisition only after all sales are voided and preserves terminal audit retries', async () => {
      const {
        voidLiveManualTrade,
        readLiveManualTradeVoids,
        correctLiveManualAcquisition,
        postAccountTrade,
      } = await import('./draft-cash-ledger.js')
      const f = await liveAcquisitionFixture()
      await expect(
        voidLiveManualTrade(
          f.userId,
          f.accountId,
          f.buy.transactionId,
          await voidInput(f.accountId, f.buy.operationId)
        )
      ).rejects.toThrow('effective sales')
      const corrected = await correctLiveManualAcquisition(
        f.userId,
        f.accountId,
        f.buy.transactionId,
        f.correction
      )
      const saleInput = await voidInput(f.accountId, f.sale.operationId)
      await voidLiveManualTrade(
        f.userId,
        f.accountId,
        f.sale.transactionId,
        saleInput
      )
      const input = await voidInput(f.accountId, corrected.revisionId)
      const beforeVoid = await prisma.position.findUniqueOrThrow({
        where: { id: f.positionId },
      })
      const result = await voidLiveManualTrade(
        f.userId,
        f.accountId,
        f.buy.transactionId,
        input
      )
      expect(result.replay.balances[0].endingAmount).toBe('1000')
      expect(
        await prisma.position.findUniqueOrThrow({ where: { id: f.positionId } })
      ).toMatchObject({
        quantity: 0,
        status: 'OPEN',
        voidedAt: expect.any(Date),
        closeDate: null,
      })
      expect(
        await prisma.transaction.count({
          where: { positionId: f.positionId, type: 'BUY' },
        })
      ).toBe(1)
      expect(
        await voidLiveManualTrade(
          f.userId,
          f.accountId,
          f.buy.transactionId,
          input
        )
      ).toMatchObject({ created: false, revisionId: result.revisionId })
      expect(
        await voidLiveManualTrade(
          f.userId,
          f.accountId,
          f.sale.transactionId,
          saleInput
        )
      ).toMatchObject({ created: false })
      expect(
        await correctLiveManualAcquisition(
          f.userId,
          f.accountId,
          f.buy.transactionId,
          f.correction
        )
      ).toMatchObject({ created: false, revisionId: corrected.revisionId })
      await expect(
        voidLiveManualTrade(f.userId, f.accountId, f.buy.transactionId, {
          ...input,
          reason: 'changed retry',
        })
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        voidLiveManualTrade(
          f.userId,
          f.accountId,
          f.buy.transactionId,
          await voidInput(f.accountId, result.revisionId)
        )
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        postAccountTrade(f.userId, f.accountId, {
          kind: 'SELL',
          positionId: f.positionId,
          idempotencyKey: randomUUID(),
          effectiveDate: '2026-10-04',
          sequence: 1,
          quantity: '1',
          price: '20',
          fees: '0',
        })
      ).rejects.toMatchObject({ status: 409 })
      const { updatePositionAcquisition, deletePosition } =
        await import('./position-mutations.js')
      await expect(
        updatePositionAcquisition(f.userId, f.positionId, { notes: 'edit' })
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        deletePosition(f.userId, f.positionId)
      ).rejects.toMatchObject({ status: 409 })
      const { savePositionHistory, savePositionStopLossHit } =
        await import('./position-derived-values.js')
      await expect(
        savePositionHistory(beforeVoid, { maxRunUpPercent: 1 })
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        savePositionStopLossHit(beforeVoid, new Date())
      ).rejects.toMatchObject({ status: 409 })
      const audits = await readLiveManualTradeVoids(f.userId, f.accountId, 1, 0)
      expect(audits.total).toBe(2)
      expect(audits.items).toHaveLength(1)
      expect(
        (await readLiveManualTradeVoids(f.userId, f.accountId, 1, 1)).items
      ).toHaveLength(1)
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const preview = await previewAccountOpening(f.userId, f.accountId, {
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '1000' }],
      })
      expect(preview.parcels).toHaveLength(0)
      expect(preview.counts.postBoundaryTrades).toBe(0)
      const { closeTradingAccount, reopenTradingAccount } =
        await import('./trading-account-mutations.js')
      const accountBeforeClose = await prisma.tradingAccount.findUniqueOrThrow({
        where: { id: f.accountId },
      })
      await closeTradingAccount(f.userId, f.accountId)
      const archivedAccount = await prisma.tradingAccount.findUniqueOrThrow({
        where: { id: f.accountId },
      })
      expect(archivedAccount.status).toBe('CLOSED')
      expect(archivedAccount.updatedAt).toEqual(accountBeforeClose.updatedAt)
      expect(
        (await readLiveManualTradeVoids(f.userId, f.accountId)).total
      ).toBe(2)
      await expect(
        voidLiveManualTrade(f.userId, f.accountId, f.buy.transactionId, input)
      ).rejects.toMatchObject({ status: 409 })
      await reopenTradingAccount(f.userId, f.accountId)
      const reopenedTrade = await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: f.assetId,
          price: '10',
          fees: '0',
        })
      )
      expect(reopenedTrade).toMatchObject({
        created: true,
        transactionId: expect.any(String),
      })
    })

    it('rejects a sale void that would unfund a later purchase without changing any stored state', async () => {
      const { voidLiveManualTrade, postAccountTrade } =
        await import('./draft-cash-ledger.js')
      const f = await liveAcquisitionFixture('10')
      await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: f.assetId,
          effectiveDate: '2026-10-04',
          price: '1000',
          fees: '0',
        })
      )
      const trade = await prisma.transaction.findUniqueOrThrow({
        where: { id: f.sale.transactionId },
      })
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.positionId },
      })
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      await expect(
        voidLiveManualTrade(
          f.userId,
          f.accountId,
          trade.id,
          await voidInput(f.accountId, f.sale.operationId)
        )
      ).rejects.toMatchObject({ status: 422 })
      expect(
        await prisma.transaction.findUniqueOrThrow({ where: { id: trade.id } })
      ).toEqual(trade)
      expect(
        await prisma.position.findUniqueOrThrow({ where: { id: parcel.id } })
      ).toEqual(parcel)
      expect(
        await prisma.accountCashLedger.findUniqueOrThrow({
          where: { accountId: f.accountId },
        })
      ).toEqual(ledger)
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { operationId: f.sale.operationId },
        })
      ).toBe(0)
    })

    it('serializes competing voids and rejects unaudited marker tampering', async () => {
      const { voidLiveManualTrade, readLiveManualTradeVoids } =
        await import('./draft-cash-ledger.js')
      const f = await liveAcquisitionFixture()
      const input = await voidInput(f.accountId, f.sale.operationId)
      const results = await Promise.allSettled([
        voidLiveManualTrade(f.userId, f.accountId, f.sale.transactionId, input),
        voidLiveManualTrade(f.userId, f.accountId, f.sale.transactionId, {
          ...input,
          idempotencyKey: randomUUID(),
        }),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === 'rejected')
      ).toHaveLength(1)
      await prisma.transaction.update({
        where: { id: f.sale.transactionId },
        data: { voidedAt: null },
      })
      await expect(
        readLiveManualTradeVoids(f.userId, f.accountId)
      ).rejects.toThrow('void marker')
    })

    it('rolls back a void on audit write failure and rejects stale, foreign and imported requests', async () => {
      const { voidLiveManualTrade } = await import('./draft-cash-ledger.js')
      const f = await liveAcquisitionFixture()
      const input = await voidInput(f.accountId, f.sale.operationId)
      await expect(
        voidLiveManualTrade(f.userId, f.accountId, f.sale.transactionId, {
          ...input,
          expectedSourceFingerprint: 'a'.repeat(64),
        })
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        voidLiveManualTrade(
          randomUUID(),
          f.accountId,
          f.sale.transactionId,
          input
        )
      ).rejects.toMatchObject({ status: 401 })
      const other = await liveAcquisitionFixture()
      await expect(
        voidLiveManualTrade(
          f.userId,
          other.accountId,
          f.sale.transactionId,
          input
        )
      ).rejects.toMatchObject({ status: 404 })
      const imported = await liveImportedExecutionFixture()
      await expect(
        voidLiveManualTrade(
          imported.userId,
          imported.accountId,
          imported.transactionId,
          await voidInput(imported.accountId, imported.operationId)
        )
      ).rejects.toMatchObject({ status: 404 })
      const originalTransaction = prisma.$transaction.bind(prisma)
      const injected = vi
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(async (callback) =>
          originalTransaction(async (db) => {
            vi.spyOn(
              db.accountCashOperationRevision,
              'create'
            ).mockRejectedValueOnce(new Error('Injected void audit failure'))
            if (typeof callback !== 'function')
              throw new Error('Expected transaction callback')
            return callback(db)
          })
        )
      try {
        await expect(
          voidLiveManualTrade(
            f.userId,
            f.accountId,
            f.sale.transactionId,
            input
          )
        ).rejects.toThrow('Injected void audit failure')
      } finally {
        injected.mockRestore()
      }
      expect(
        await prisma.transaction.findUniqueOrThrow({
          where: { id: f.sale.transactionId },
        })
      ).toMatchObject({ voidedAt: null })
      expect(
        await prisma.position.findUniqueOrThrow({ where: { id: f.positionId } })
      ).toMatchObject({ quantity: 6 })
    })

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
    it('posts cash-only deposits that fund later trades and validates the retained audit on retry', async () => {
      const { postAccountCapitalFlow, postAccountTrade } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('0')
      const asset = await prisma.asset.create({
        data: {
          symbol: `LIVE-FUNDING-${randomUUID()}`,
          name: 'Live funding fixture',
          exchangeId: exchangeId!,
        },
      })
      const input = liveCapitalFlowInput({ amount: '100.000000000001' })
      await expect(
        postAccountCapitalFlow(f.userId, f.accountId, input)
      ).rejects.toMatchObject({
        status: 409,
        message: /no active confirmed cash ledger/,
      })
      await confirmCashLedger(f.accountId, f.statementId)
      const result = await postAccountCapitalFlow(f.userId, f.accountId, input)
      expect(result).toMatchObject({
        created: true,
        replay: { funded: true },
      })
      expect(result.replay.balances[0].endingAmount).toBe('100.000000000001')
      const retry = await postAccountCapitalFlow(f.userId, f.accountId, input)
      expect(retry).toMatchObject({
        created: false,
        operationId: result.operationId,
      })
      await expect(
        postAccountCapitalFlow(f.userId, f.accountId, {
          ...input,
          amount: '101',
        })
      ).rejects.toMatchObject({ status: 409 })

      const operation = await prisma.accountCashOperation.findUniqueOrThrow({
        where: { id: result.operationId },
        include: { postings: true },
      })
      expect(operation).toMatchObject({
        transactionId: null,
        importedEventId: null,
        kind: 'DEPOSIT',
        transactionSnapshot: {},
      })
      expect(operation.postings.map((row) => row.amount.toFixed())).toEqual([
        '100.000000000001',
      ])
      expect(
        await prisma.transaction.count({
          where: { position: { accountId: f.accountId } },
        })
      ).toBe(0)

      const trade = await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: asset.id,
          sequence: 2,
          price: '99',
          fees: '1',
        })
      )
      expect(trade.replay.funded).toBe(true)
      expect(trade.replay.balances[0].endingAmount).toBe('0.000000000001')
    })

    function reinvestmentInput(assetId: string) {
      return {
        idempotencyKey: randomUUID(),
        income: {
          assetId,
          entitlementDate: '2026-10-01',
          paymentDate: '2026-10-15',
          sequence: 1,
          currency: 'AUD',
          grossAmount: '100',
          withholdingAmount: '15',
          frankedAmount: '60',
          unfrankedAmount: '40',
          frankingCreditAud: '25',
          sourceReference: `drp-statement-${randomUUID()}`,
        },
        acquisition: {
          effectiveDate: '2026-10-15',
          sequence: 2,
          quantity: '4',
          price: '20',
          fees: '1',
        },
        residualAmount: '4',
        residualDisposition: 'ACCOUNT_CASH',
        statementConfirmed: true,
      }
    }

    it('posts one linked reinvestment parcel with exact retained income and concurrent retries, then permits sales', async () => {
      const {
        postAccountSplit,
        postAccountReinvestment,
        readLiveCapitalOperations,
        postAccountTrade,
        correctLiveIncomeReceipt,
        correctLiveManualAcquisition,
        voidLiveManualTrade,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture asset')
      const base = reinvestmentInput(f.incomeAssetId)
      const input = {
        ...base,
        acquisition: {
          ...base.acquisition,
          effectiveDate: '2026-10-17',
        },
      }
      await expect(
        postAccountReinvestment(f.userId, f.accountId, input)
      ).rejects.toThrow(/confirmed|ledger/)
      await confirmCashLedger(f.accountId, f.statementId)
      await postAccountSplit(f.userId, f.accountId, {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-16',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `split-statement-${randomUUID()}`,
        statementConfirmed: true,
      })
      await expect(
        postAccountReinvestment(f.userId, f.accountId, {
          ...input,
          idempotencyKey: `before-split-${randomUUID()}`,
          acquisition: {
            ...input.acquisition,
            effectiveDate: '2026-10-16',
          },
        })
      ).rejects.toThrow(/on or before a retained stock split date/)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
      const posted = await Promise.all([
        postAccountReinvestment(f.userId, f.accountId, input),
        postAccountReinvestment(f.userId, f.accountId, input),
      ])
      expect(posted.map((row) => row.created).sort()).toEqual([false, true])
      expect(posted[0].positionId).toBe(posted[1].positionId)
      expect(posted[0].replay.balances[0]).toMatchObject({
        endingAmount: '4',
        netExternalContribution: '0',
      })
      const review = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(review.auditOperations).toHaveLength(2)
      expect(
        review.auditOperations.every((row) => row.reinvestment !== null)
      ).toBe(true)
      expect(
        review.auditOperations.find((row) => row.incomeReceipt)?.incomeReceipt
      ).toMatchObject({
        grossAmount: '100',
        withholdingAmount: '15',
        netAmount: '85',
        frankingCreditAud: '25',
      })
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: posted[0].positionId },
        include: { transactions: true },
      })
      expect(parcel.transactions).toHaveLength(1)
      expect(parcel.quantity).toBe(4)
      expect(parcel.totalBuyValue.toFixed()).toBe('80')
      expect(parcel.buyFees.toFixed()).toBe('1')
      const head = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      const correction = {
        idempotencyKey: randomUUID(),
        expectedRevisionId: posted[0].acquisitionOperationId,
        expectedSourceFingerprint: head.acceptedSourceFingerprint,
        effectiveDate: '2026-10-17',
        sequence: 2,
        quantity: '4',
        price: '19',
        fees: '1',
        reason: 'Unsupported independent change',
      }
      await expect(
        correctLiveManualAcquisition(
          f.userId,
          f.accountId,
          parcel.transactions[0].id,
          correction
        )
      ).rejects.toThrow(/retained stock split history/)
      await expect(
        voidLiveManualTrade(f.userId, f.accountId, parcel.transactions[0].id, {
          idempotencyKey: randomUUID(),
          expectedRevisionId: posted[0].acquisitionOperationId,
          expectedSourceFingerprint: head.acceptedSourceFingerprint,
          reason: 'Unsupported independent void',
        })
      ).rejects.toThrow(/retained stock split history/)
      await expect(
        correctLiveIncomeReceipt(
          f.userId,
          f.accountId,
          posted[0].incomeOperationId,
          {}
        )
      ).rejects.toThrow(/paired audited/)
      await expect(
        postAccountReinvestment(f.userId, f.accountId, {
          ...input,
          residualAmount: '5',
          acquisition: { ...input.acquisition, fees: '0' },
        })
      ).rejects.toThrow(/Idempotency/)
      await expect(
        postAccountTrade(f.userId, f.accountId, {
          kind: 'SELL',
          positionId: parcel.id,
          idempotencyKey: randomUUID(),
          effectiveDate: '2026-10-17',
          sequence: 3,
          quantity: '1',
          price: '21',
          fees: '0',
        })
      ).resolves.toMatchObject({ replay: { funded: true } })
      await expect(
        postAccountReinvestment(f.userId, f.accountId, input)
      ).resolves.toMatchObject({ created: false, positionId: parcel.id })
    })

    it('rolls back occupied-slot posting, rejects invalid entitlement/currency/ownership and reserves cash for later allotment', async () => {
      const { postAccountReinvestment, postAccountCapitalFlow } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture asset')
      await confirmCashLedger(f.accountId, f.statementId)
      const input = reinvestmentInput(f.incomeAssetId)
      await postAccountCapitalFlow(f.userId, f.accountId, {
        idempotencyKey: randomUUID(),
        kind: 'DEPOSIT',
        effectiveDate: '2026-10-15',
        sequence: 3,
        currency: 'AUD',
        amount: '5',
        sourceReference: 'existing-funding',
      })
      const positionsBefore = await prisma.position.count({
        where: { accountId: f.accountId },
      })
      const changed = {
        ...input,
        acquisition: { ...input.acquisition, effectiveDate: '2026-10-16' },
      }
      await expect(
        postAccountReinvestment(f.userId, f.accountId, {
          ...input,
          acquisition: { ...input.acquisition, sequence: 3 },
        })
      ).rejects.toThrow(/reserved/)
      expect(
        await prisma.position.count({ where: { accountId: f.accountId } })
      ).toBe(positionsBefore)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId, kind: 'INCOME' },
        })
      ).toBe(0)
      await expect(
        postAccountReinvestment(f.userId, f.accountId, {
          ...changed,
          income: { ...input.income, entitlementDate: '2026-09-01' },
        })
      ).rejects.toThrow(/historical holdings/)
      await expect(
        postAccountReinvestment(f.userId, f.accountId, {
          ...input,
          income: {
            ...input.income,
            currency: 'USD',
            frankedAmount: '0',
            unfrankedAmount: '100',
            frankingCreditAud: '0',
          },
        })
      ).rejects.toThrow(/same payment/)
      await expect(
        postAccountReinvestment('not-the-owner', f.accountId, input)
      ).rejects.toMatchObject({ status: 401 })
      await expect(
        postAccountReinvestment(f.userId, f.accountId, changed)
      ).resolves.toMatchObject({
        replay: { balances: [{ endingAmount: '9' }] },
      })
      await expect(
        postAccountCapitalFlow(f.userId, f.accountId, {
          idempotencyKey: randomUUID(),
          kind: 'WITHDRAWAL',
          effectiveDate: '2026-10-15',
          sequence: 4,
          currency: 'AUD',
          amount: '10',
          sourceReference: 'would-spend-allotment-cash',
        })
      ).rejects.toThrow(/Insufficient/)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId, kind: 'WITHDRAWAL' },
        })
      ).toBe(0)
    })

    it('fails closed on a tampered reinvestment link or removed envelope and retains archived history', async () => {
      const { postAccountReinvestment, readLiveCapitalOperations } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture asset')
      await confirmCashLedger(f.accountId, f.statementId)
      const posted = await postAccountReinvestment(
        f.userId,
        f.accountId,
        reinvestmentInput(f.incomeAssetId)
      )
      const operation = await prisma.accountCashOperation.findUniqueOrThrow({
        where: { id: posted.acquisitionOperationId },
      })
      if (
        !operation.command ||
        typeof operation.command !== 'object' ||
        Array.isArray(operation.command)
      )
        throw new Error('Missing command')
      const stored = operation.command
      await prisma.accountCashOperation.update({
        where: { id: operation.id },
        data: {
          command: { request: stored.request, cashCommand: stored.cashCommand },
        },
      })
      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).rejects.toThrow(/inconsistent/)
      await prisma.accountCashOperation.update({
        where: { id: operation.id },
        data: { command: stored },
      })
      await prisma.tradingAccount.update({
        where: { id: f.accountId },
        data: { status: 'CLOSED' },
      })
      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).resolves.toMatchObject({ replay: { funded: true } })
      await expect(
        postAccountReinvestment(
          f.userId,
          f.accountId,
          reinvestmentInput(f.incomeAssetId)
        )
      ).rejects.toThrow(/active real/)
    })

    it('uses historical entitlement holdings after their disposal, not a later current parcel, and prevents duplicate statements', async () => {
      const { postAccountReinvestment, postAccountTrade } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture asset')
      await confirmCashLedger(f.accountId, f.statementId)
      const holding = await prisma.position.findFirstOrThrow({
        where: { accountId: f.accountId, assetId: f.incomeAssetId },
      })
      await postAccountTrade(f.userId, f.accountId, {
        kind: 'SELL',
        positionId: holding.id,
        idempotencyKey: randomUUID(),
        effectiveDate: '2026-10-02',
        sequence: 1,
        quantity: '1',
        price: '10',
        fees: '0',
      })
      const input = reinvestmentInput(f.incomeAssetId)
      await expect(
        postAccountReinvestment(f.userId, f.accountId, input)
      ).resolves.toMatchObject({
        replay: {
          balances: [{ endingAmount: '14', netExternalContribution: '0' }],
        },
      })
      await expect(
        postAccountReinvestment(f.userId, f.accountId, {
          ...reinvestmentInput(f.incomeAssetId),
          income: {
            ...input.income,
            entitlementDate: '2026-10-03',
            sourceReference: 'ineligible-entitlement',
          },
        })
      ).rejects.toThrow(/historical holdings/)
      await expect(
        postAccountReinvestment(f.userId, f.accountId, {
          ...input,
          idempotencyKey: randomUUID(),
          income: { ...input.income, sequence: 3 },
          acquisition: { ...input.acquisition, sequence: 4 },
        })
      ).rejects.toThrow(/Duplicate command key or execution source/)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId, kind: 'INCOME' },
        })
      ).toBe(1)
      expect(
        await prisma.position.count({ where: { accountId: f.accountId } })
      ).toBe(2)
    })

    it('audits paired reinvestment corrections and terminal reversal with exact retained retries', async () => {
      const {
        postAccountSplit,
        postAccountReinvestment,
        readLiveReinvestmentReview,
        correctLiveReinvestment,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture asset')
      await confirmCashLedger(f.accountId, f.statementId)
      await postAccountSplit(f.userId, f.accountId, {
        idempotencyKey: `split-${randomUUID()}`,
        assetId: f.incomeAssetId,
        effectiveDate: '2026-10-16',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: `split-statement-${randomUUID()}`,
        statementConfirmed: true,
      })
      const original = reinvestmentInput(f.incomeAssetId)
      original.acquisition.effectiveDate = '2026-10-17'
      const posted = await postAccountReinvestment(
        f.userId,
        f.accountId,
        original
      )
      const head = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.acquisitionOperationId
      )
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          {
            idempotencyKey: randomUUID(),
            expectedIncomeRevisionId: head.expectedIncomeRevisionId,
            expectedAcquisitionRevisionId: head.expectedAcquisitionRevisionId,
            expectedAuditNumber: head.expectedAuditNumber,
            expectedSourceFingerprint: head.expectedSourceFingerprint,
            reason: 'Unsupported split-date acquisition correction',
            replacement: {
              ...head.current!,
              acquisition: {
                ...head.current!.acquisition,
                effectiveDate: '2026-10-16',
              },
            },
          }
        )
      ).rejects.toThrow(/on or before a retained stock split date/)
      const request = {
        idempotencyKey: randomUUID(),
        expectedIncomeRevisionId: head.expectedIncomeRevisionId,
        expectedAcquisitionRevisionId: head.expectedAcquisitionRevisionId,
        expectedAuditNumber: head.expectedAuditNumber,
        expectedSourceFingerprint: head.expectedSourceFingerprint,
        reason: 'Correct issuer allotment statement',
        replacement: {
          ...head.current!,
          acquisition: {
            ...original.acquisition,
            quantity: '3',
            price: '25',
            fees: '2',
          },
          residualAmount: '8',
        },
      }
      const results = await Promise.all([
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          request
        ),
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          request
        ),
      ])
      expect(results.map((row) => row.created).sort()).toEqual([false, true])
      expect(results[0].replay.balances[0].endingAmount).toBe('8')
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: posted.positionId },
        })
      ).toMatchObject({ quantity: 3 })
      const changed = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.incomeOperationId
      )
      expect(changed.current?.acquisition.quantity).toBe('3')
      const reversal = {
        idempotencyKey: randomUUID(),
        expectedIncomeRevisionId: changed.expectedIncomeRevisionId,
        expectedAcquisitionRevisionId: changed.expectedAcquisitionRevisionId,
        expectedAuditNumber: changed.expectedAuditNumber,
        expectedSourceFingerprint: changed.expectedSourceFingerprint,
        reason: 'Issuer cancelled distribution and allotment',
        replacement: null,
      }
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          reversal
        )
      ).resolves.toMatchObject({
        replay: { balances: [{ endingAmount: '0' }] },
      })
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          request
        )
      ).resolves.toMatchObject({ created: false })
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          reversal
        )
      ).resolves.toMatchObject({ created: false })
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          { ...reversal, idempotencyKey: randomUUID() }
        )
      ).rejects.toThrow(/terminal/)
      await expect(
        postAccountReinvestment(f.userId, f.accountId, original)
      ).resolves.toMatchObject({ created: false })
      const review = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(review.auditOperations.every((row) => row.current === null)).toBe(
        true
      )
      expect(
        review.auditOperations.every((row) => row.revisions.length === 2)
      ).toBe(true)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: posted.positionId },
          })
        ).voidedAt
      ).not.toBeNull()
    })

    it('rejects no-op, changed identity, stale heads and unfunded paired revisions without partial writes', async () => {
      const {
        postAccountReinvestment,
        readLiveReinvestmentReview,
        correctLiveReinvestment,
        postAccountCapitalFlow,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture asset')
      await confirmCashLedger(f.accountId, f.statementId)
      const posted = await postAccountReinvestment(
        f.userId,
        f.accountId,
        reinvestmentInput(f.incomeAssetId)
      )
      const head = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.incomeOperationId
      )
      if (!head.current) throw new Error('Missing review')
      const input = {
        idempotencyKey: randomUUID(),
        expectedIncomeRevisionId: head.expectedIncomeRevisionId,
        expectedAcquisitionRevisionId: head.expectedAcquisitionRevisionId,
        expectedAuditNumber: head.expectedAuditNumber,
        expectedSourceFingerprint: head.expectedSourceFingerprint,
        reason: 'Correct statement',
        replacement: head.current,
      }
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          input
        )
      ).rejects.toThrow(/must change/)
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          {
            ...input,
            replacement: {
              ...head.current,
              income: {
                ...head.current.income,
                sourceReference: 'other-statement',
              },
            },
          }
        )
      ).rejects.toThrow(/fixed/)
      const taxOnly = {
        ...input,
        replacement: {
          ...head.current,
          income: {
            ...head.current.income,
            grossAmount: '110',
            withholdingAmount: '25',
            unfrankedAmount: '50',
          },
        },
      }
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          taxOnly
        )
      ).resolves.toMatchObject({
        replay: { balances: [{ endingAmount: '4' }] },
      })
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          { ...taxOnly, idempotencyKey: randomUUID() }
        )
      ).rejects.toThrow(/changed/)
      await postAccountCapitalFlow(f.userId, f.accountId, {
        idempotencyKey: randomUUID(),
        kind: 'WITHDRAWAL',
        effectiveDate: '2026-10-16',
        sequence: 1,
        currency: 'AUD',
        amount: '4',
        sourceReference: 'spend-residual',
      })
      const latest = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.incomeOperationId
      )
      if (!latest.current) throw new Error('Missing current review')
      const failed = {
        ...input,
        idempotencyKey: randomUUID(),
        expectedIncomeRevisionId: latest.expectedIncomeRevisionId,
        expectedAcquisitionRevisionId: latest.expectedAcquisitionRevisionId,
        expectedAuditNumber: latest.expectedAuditNumber,
        expectedSourceFingerprint: latest.expectedSourceFingerprint,
        replacement: {
          ...latest.current,
          acquisition: { ...latest.current.acquisition, fees: '2' },
          residualAmount: '3',
        },
      }
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          failed
        )
      ).rejects.toThrow(/Insufficient/)
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          { ...failed, replacement: null }
        )
      ).rejects.toThrow(/Insufficient/)
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { accountId: f.accountId },
        })
      ).toBe(2)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: posted.positionId },
          })
        ).buyFees.toFixed()
      ).toBe('1')
    })

    it('blocks paired changes after sales, allows reversal after sale void, and rejects one-sided audit tampering', async () => {
      const {
        postAccountReinvestment,
        postAccountTrade,
        readLiveReinvestmentReview,
        correctLiveReinvestment,
        voidLiveManualTrade,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture asset')
      await confirmCashLedger(f.accountId, f.statementId)
      const posted = await postAccountReinvestment(
        f.userId,
        f.accountId,
        reinvestmentInput(f.incomeAssetId)
      )
      const sale = await postAccountTrade(f.userId, f.accountId, {
        kind: 'SELL',
        positionId: posted.positionId,
        idempotencyKey: randomUUID(),
        effectiveDate: '2026-10-16',
        sequence: 1,
        quantity: '1',
        price: '20',
        fees: '0',
      })
      const head = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.incomeOperationId
      )
      expect(head.hasEffectiveSales).toBe(true)
      const input = {
        idempotencyKey: randomUUID(),
        expectedIncomeRevisionId: head.expectedIncomeRevisionId,
        expectedAcquisitionRevisionId: head.expectedAcquisitionRevisionId,
        expectedAuditNumber: head.expectedAuditNumber,
        expectedSourceFingerprint: head.expectedSourceFingerprint,
        reason: 'Cancelled statement',
        replacement: null,
      }
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          input
        )
      ).rejects.toThrow(/effective sales/)
      if (!sale.transactionId) throw new Error('Missing sale')
      await voidLiveManualTrade(f.userId, f.accountId, sale.transactionId, {
        idempotencyKey: randomUUID(),
        expectedRevisionId: sale.operationId,
        expectedSourceFingerprint: head.expectedSourceFingerprint,
        reason: 'Void sale before cancelling allotment',
      })
      const refreshed = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.incomeOperationId
      )
      const result = await correctLiveReinvestment(
        f.userId,
        f.accountId,
        posted.incomeOperationId,
        {
          ...input,
          expectedAuditNumber: refreshed.expectedAuditNumber,
          expectedSourceFingerprint: refreshed.expectedSourceFingerprint,
        }
      )
      expect(result.replay.balances[0].endingAmount).toBe('0')
      await prisma.accountCashRevisionPosting.updateMany({
        where: { revisionId: result.incomeRevisionId },
        data: { amount: '0' },
      })
      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).rejects.toThrow(/inconsistent/)
    })

    it('serializes competing paired heads, retains both historical slots and permits archived review only', async () => {
      const {
        postAccountReinvestment,
        readLiveReinvestmentReview,
        correctLiveReinvestment,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture asset')
      await confirmCashLedger(f.accountId, f.statementId)
      const posted = await postAccountReinvestment(
        f.userId,
        f.accountId,
        reinvestmentInput(f.incomeAssetId)
      )
      const head = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.incomeOperationId
      )
      if (!head.current) throw new Error('Missing review')
      const base = {
        idempotencyKey: randomUUID(),
        expectedIncomeRevisionId: head.expectedIncomeRevisionId,
        expectedAcquisitionRevisionId: head.expectedAcquisitionRevisionId,
        expectedAuditNumber: head.expectedAuditNumber,
        expectedSourceFingerprint: head.expectedSourceFingerprint,
        reason: 'Correct dates',
        replacement: {
          ...head.current,
          income: { ...head.current.income, paymentDate: '2026-10-16' },
          acquisition: {
            ...head.current.acquisition,
            effectiveDate: '2026-10-16',
          },
        },
      }
      const racing = await Promise.allSettled([
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          base
        ),
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          { ...base, idempotencyKey: randomUUID() }
        ),
      ])
      expect(
        racing.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        racing.filter((result) => result.status === 'rejected')
      ).toHaveLength(1)
      const changed = await readLiveReinvestmentReview(
        f.userId,
        f.accountId,
        posted.incomeOperationId
      )
      await expect(
        correctLiveReinvestment(
          f.userId,
          f.accountId,
          posted.incomeOperationId,
          {
            ...base,
            idempotencyKey: randomUUID(),
            expectedIncomeRevisionId: changed.expectedIncomeRevisionId,
            expectedAcquisitionRevisionId:
              changed.expectedAcquisitionRevisionId,
            expectedAuditNumber: changed.expectedAuditNumber,
            expectedSourceFingerprint: changed.expectedSourceFingerprint,
            replacement: head.current,
          }
        )
      ).rejects.toThrow(/reserved/)
      await prisma.tradingAccount.update({
        where: { id: f.accountId },
        data: { status: 'CLOSED' },
      })
      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).resolves.toMatchObject({ accountStatus: 'CLOSED' })
      await expect(
        readLiveReinvestmentReview(
          f.userId,
          f.accountId,
          posted.incomeOperationId
        )
      ).rejects.toThrow(/active real/)
    })

    it('does not post income before explicit account confirmation', async () => {
      const { postAccountIncomeReceipt } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture income asset')
      await expect(
        postAccountIncomeReceipt(f.userId, f.accountId, {
          idempotencyKey: `income-unconfirmed-${randomUUID()}`,
          assetId: f.incomeAssetId,
          entitlementDate: '2026-10-01',
          paymentDate: '2026-10-15',
          sequence: 1,
          currency: 'AUD',
          grossAmount: '100',
          withholdingAmount: '15',
          frankedAmount: '60',
          unfrankedAmount: '40',
          frankingCreditAud: '25',
          sourceReference: 'broker-income-statement',
        })
      ).rejects.toThrow(/confirmed|ledger/i)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
    })

    it('posts statement-supported income as net cash and retains its tax attributes', async () => {
      const {
        postAccountIncomeReceipt,
        correctLiveIncomeReceipt,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('100', false, false, true)
      if (!f.incomeAssetId) throw new Error('Missing fixture income asset')
      await confirmCashLedger(f.accountId, f.statementId)
      const input = {
        idempotencyKey: `income-${randomUUID()}`,
        assetId: f.incomeAssetId,
        entitlementDate: '2026-10-01',
        paymentDate: '2026-10-15',
        sequence: 1,
        currency: 'AUD',
        grossAmount: '100',
        withholdingAmount: '15',
        frankedAmount: '60',
        unfrankedAmount: '40',
        frankingCreditAud: '25.714285714286',
        sourceReference: 'broker-income-statement',
      }

      const posted = await postAccountIncomeReceipt(
        f.userId,
        f.accountId,
        input
      )
      expect(posted).toMatchObject({
        created: true,
        replay: {
          funded: true,
          balances: [
            {
              currency: 'AUD',
              endingAmount: '185',
              netExternalContribution: '0',
            },
          ],
        },
      })
      const retry = await postAccountIncomeReceipt(f.userId, f.accountId, input)
      expect(retry).toMatchObject({
        created: false,
        operationId: posted.operationId,
      })
      const operation = await prisma.accountCashOperation.findUniqueOrThrow({
        where: { id: posted.operationId },
        include: { postings: true, incomeReceipt: true },
      })
      expect(operation).toMatchObject({
        kind: 'INCOME',
        transactionId: null,
        importedEventId: null,
        incomeReceipt: {
          accountId: f.accountId,
          assetId: f.incomeAssetId,
          currency: 'AUD',
        },
      })
      expect(operation.incomeReceipt?.grossAmount.toFixed()).toBe('100')
      expect(operation.incomeReceipt?.withholdingAmount.toFixed()).toBe('15')
      expect(operation.incomeReceipt?.frankedAmount.toFixed()).toBe('60')
      expect(operation.incomeReceipt?.unfrankedAmount.toFixed()).toBe('40')
      expect(operation.postings.map((row) => row.amount.toFixed())).toEqual([
        '85',
      ])
      const review = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(review.activity[0]).toMatchObject({
        kind: 'INCOME',
        changes: [{ currency: 'AUD', amount: '85', balanceAfter: '185' }],
      })
      expect(review.auditOperations[0]?.incomeReceipt).toMatchObject({
        assetId: f.incomeAssetId,
        assetSymbol: expect.stringMatching(/^INCOME-/),
        grossAmount: '100',
        withholdingAmount: '15',
        netAmount: '85',
        frankedAmount: '60',
        unfrankedAmount: '40',
      })
      const recorded = review.auditOperations[0]
      if (!recorded) throw new Error('Missing income audit record')
      const correction = {
        idempotencyKey: `income-fix-${randomUUID()}`,
        expectedRevisionId: recorded.expectedRevisionId,
        expectedAuditNumber: review.auditNumber,
        expectedSourceFingerprint: review.sourceFingerprint,
        reason: 'Correct withholding from issuer statement',
        replacement: {
          entitlementDate: '2026-10-01',
          paymentDate: '2026-10-16',
          sequence: 2,
          grossAmount: '100',
          withholdingAmount: '20',
          frankedAmount: '60',
          unfrankedAmount: '40',
          frankingCreditAud: '25.714285714286',
        },
      }
      const corrected = await correctLiveIncomeReceipt(
        f.userId,
        f.accountId,
        posted.operationId,
        correction
      )
      expect(corrected).toMatchObject({
        created: true,
        replay: {
          funded: true,
          balances: [
            {
              currency: 'AUD',
              endingAmount: '180',
              netExternalContribution: '0',
            },
          ],
        },
      })
      const correctionRetry = await correctLiveIncomeReceipt(
        f.userId,
        f.accountId,
        posted.operationId,
        correction
      )
      expect(correctionRetry).toMatchObject({
        created: false,
        revisionId: corrected.revisionId,
      })
      const correctedReview = await readLiveCapitalOperations(
        f.userId,
        f.accountId
      )
      expect(
        correctedReview.auditOperations[0]?.currentIncomeReceipt
      ).toMatchObject({
        paymentDate: '2026-10-16',
        withholdingAmount: '20',
        netAmount: '80',
      })
      expect(correctedReview.auditOperations[0]?.revisions[0]).toMatchObject({
        reason: correction.reason,
        incomeBefore: { cash: { amount: '85' } },
        incomeReplacement: { cash: { amount: '80' } },
      })
      const terminalReversal = await correctLiveIncomeReceipt(
        f.userId,
        f.accountId,
        posted.operationId,
        {
          idempotencyKey: `income-reversal-${randomUUID()}`,
          expectedRevisionId:
            correctedReview.auditOperations[0]?.expectedRevisionId,
          expectedAuditNumber: correctedReview.auditNumber,
          expectedSourceFingerprint: correctedReview.sourceFingerprint,
          reason: 'Issuer confirmed duplicate payment',
          replacement: null,
        }
      )
      expect(terminalReversal.replay.balances[0]?.endingAmount).toBe('100')
      const reversedReview = await readLiveCapitalOperations(
        f.userId,
        f.accountId
      )
      expect(reversedReview.auditOperations[0]?.currentIncomeReceipt).toBeNull()
      const oldRevisionRetry = await correctLiveIncomeReceipt(
        f.userId,
        f.accountId,
        posted.operationId,
        correction
      )
      expect(oldRevisionRetry).toMatchObject({
        created: false,
        revisionId: corrected.revisionId,
      })
      await expect(
        correctLiveIncomeReceipt(f.userId, f.accountId, posted.operationId, {
          ...correction,
          idempotencyKey: `income-after-reversal-${randomUUID()}`,
          expectedRevisionId:
            reversedReview.auditOperations[0]?.expectedRevisionId,
          expectedAuditNumber: reversedReview.auditNumber,
        })
      ).rejects.toThrow('reversed income receipt')
    })

    it('revises and terminally reverses live funding with retained legs and safe retries', async () => {
      const {
        postAccountCapitalFlow,
        correctLiveCapitalOperation,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0')
      await confirmCashLedger(f.accountId, f.statementId)
      const original = liveCapitalFlowInput({ amount: '100' })
      const posted = await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        original
      )
      const initial = await readLiveCapitalOperations(f.userId, f.accountId)
      const operation = initial.items[0]
      if (!operation) throw new Error('Missing posted live funding operation')
      const correction = {
        idempotencyKey: `capital-fix-${randomUUID()}`,
        expectedRevisionId: operation.expectedRevisionId,
        expectedAuditNumber: initial.auditNumber,
        expectedSourceFingerprint: initial.sourceFingerprint,
        reason: 'Corrected from the bank statement',
        replacement: {
          effectiveDate: original.effectiveDate,
          sequence: 2,
          amount: '90',
        },
      }
      const corrected = await correctLiveCapitalOperation(
        f.userId,
        f.accountId,
        posted.operationId,
        correction
      )
      expect(corrected).toMatchObject({
        operationId: posted.operationId,
        created: true,
        replay: { funded: true, balances: [{ endingAmount: '90' }] },
      })
      const revision =
        await prisma.accountCashOperationRevision.findUniqueOrThrow({
          where: { id: corrected.revisionId },
          include: { postings: { orderBy: { legIndex: 'asc' } } },
        })
      expect(
        revision.postings.map((row) => [row.phase, row.amount.toFixed()])
      ).toEqual([
        ['REVERSAL', '-100'],
        ['REPLACEMENT', '90'],
      ])
      expect(revision.previousFingerprint).toBe(initial.sourceFingerprint)
      expect(revision.nextFingerprint).toBe(initial.sourceFingerprint)

      const secondView = await readLiveCapitalOperations(f.userId, f.accountId)
      const current = secondView.items[0]
      if (!current) throw new Error('Missing corrected live funding operation')
      const secondCorrection = {
        ...correction,
        idempotencyKey: `capital-fix-again-${randomUUID()}`,
        expectedRevisionId: current.expectedRevisionId,
        expectedAuditNumber: secondView.auditNumber,
        replacement: { ...correction.replacement, amount: '80' },
      }
      const correctedAgain = await correctLiveCapitalOperation(
        f.userId,
        f.accountId,
        posted.operationId,
        secondCorrection
      )
      const retryOld = await correctLiveCapitalOperation(
        f.userId,
        f.accountId,
        posted.operationId,
        correction
      )
      expect(retryOld).toMatchObject({
        created: false,
        revisionId: corrected.revisionId,
        replay: { balances: [{ endingAmount: '80' }] },
      })

      const beforeReversal = await readLiveCapitalOperations(
        f.userId,
        f.accountId
      )
      const reversal = await correctLiveCapitalOperation(
        f.userId,
        f.accountId,
        posted.operationId,
        {
          idempotencyKey: `capital-reversal-${randomUUID()}`,
          expectedRevisionId: correctedAgain.revisionId,
          expectedAuditNumber: beforeReversal.auditNumber,
          expectedSourceFingerprint: beforeReversal.sourceFingerprint,
          reason: 'Bank confirmed the original entry was duplicated',
          replacement: null,
        }
      )
      expect(reversal).toMatchObject({
        created: true,
        replay: { funded: true, balances: [{ endingAmount: '0' }] },
      })
      const finalView = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(finalView.items[0]).toMatchObject({
        operationId: posted.operationId,
        original: { amount: '100' },
        current: null,
        revisions: [
          {},
          {},
          {
            replacement: null,
            postings: [{ phase: 'REVERSAL', amount: '-80' }],
          },
        ],
      })
      await expect(
        correctLiveCapitalOperation(f.userId, f.accountId, posted.operationId, {
          idempotencyKey: `capital-after-reversal-${randomUUID()}`,
          expectedRevisionId: reversal.revisionId,
          expectedAuditNumber: finalView.auditNumber,
          expectedSourceFingerprint: finalView.sourceFingerprint,
          reason: 'Attempt to revive a reversed deposit',
          replacement: {
            effectiveDate: original.effectiveDate,
            sequence: 3,
            amount: '80',
          },
        })
      ).rejects.toMatchObject({ status: 409 })
      expect(finalView.sourceFingerprint).toBe(initial.sourceFingerprint)
    })

    it('reviews exact balances, effective activity, retained audits, evidence variances and archived access', async () => {
      const {
        postAccountCapitalFlow,
        readLiveCapitalOperations,
        recordDraftCashEvidence,
      } = await import('./draft-cash-ledger.js')
      const { closeTradingAccount } =
        await import('./trading-account-mutations.js')
      const f = await fixture('100')
      const asOfDate = currentSydneyDate()
      await recordDraftCashEvidence(
        f.userId,
        f.statementId,
        {
          idempotencyKey: `review-evidence-${randomUUID()}`,
          asOfDate,
          source: 'Broker statement',
          reference: 'Cash page',
          attested: true,
          cashBalances: [{ currency: 'AUD', amount: '100' }],
          decisions: [],
        },
        f.accountId
      )
      await confirmCashLedger(f.accountId, f.statementId)
      await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({
          effectiveDate: asOfDate,
          amount: '25',
          sequence: 1,
        })
      )

      const active = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(active).toMatchObject({
        accountStatus: 'ACTIVE',
        openingBoundary: {
          date: '2026-10-01',
          timezone: 'Australia/Sydney',
          type: 'END_OF_DAY',
        },
        sourceFreshness: { status: 'CURRENT' },
        cashCompleteness: 'COMPLETE',
        evidenceStatus: 'VARIANCE',
        replay: { balances: [{ currency: 'AUD', endingAmount: '125' }] },
        activity: [
          {
            kind: 'DEPOSIT',
            sourceOrigin: 'MANUAL',
            changes: [{ currency: 'AUD', amount: '25', balanceAfter: '125' }],
          },
        ],
        evidence: [
          {
            attested: true,
            currentComparison: {
              variances: [
                {
                  currency: 'AUD',
                  expectedAmount: '125',
                  statementAmount: '100',
                  difference: '-25',
                },
              ],
            },
          },
        ],
        auditOperations: [
          {
            original: { kind: 'DEPOSIT' },
            current: { kind: 'DEPOSIT' },
          },
        ],
      })

      await closeTradingAccount(f.userId, f.accountId)
      const archived = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(archived.accountStatus).toBe('CLOSED')
      expect(archived.sourceFreshness).toMatchObject({
        status: 'NOT_REVALIDATED',
        currentFingerprint: null,
      })
      expect(archived.replay.balances[0]?.endingAmount).toBe('125')
    })

    it('replays manual trades once and excludes a terminally voided sale from reviewed cash', async () => {
      const {
        postAccountTrade,
        readLiveCapitalOperations,
        voidLiveManualTrade,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('1000')
      const asset = await prisma.asset.create({
        data: {
          symbol: `REVIEW-${randomUUID()}`,
          name: 'Cash review fixture',
          exchangeId: exchangeId!,
        },
      })
      await confirmCashLedger(f.accountId, f.statementId)
      const buy = await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: asset.id,
          quantity: '1',
          price: '20',
          fees: '1',
          sequence: 1,
        })
      )
      const bought = await prisma.transaction.findUniqueOrThrow({
        where: { id: buy.transactionId },
      })
      const sale = await postAccountTrade(f.userId, f.accountId, {
        kind: 'SELL',
        positionId: bought.positionId,
        idempotencyKey: `review-sale-${randomUUID()}`,
        effectiveDate: currentSydneyDate(),
        sequence: 2,
        quantity: '1',
        price: '30',
        fees: '1',
      })
      const beforeVoid = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(beforeVoid.replay.balances[0]?.endingAmount).toBe('1008')
      expect(beforeVoid.activity).toHaveLength(2)

      await voidLiveManualTrade(f.userId, f.accountId, sale.transactionId, {
        idempotencyKey: `review-void-${randomUUID()}`,
        expectedRevisionId: sale.operationId,
        expectedSourceFingerprint: beforeVoid.sourceFingerprint,
        reason: 'Corrected duplicate sale',
      })
      const afterVoid = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(afterVoid.replay.balances[0]?.endingAmount).toBe('979')
      expect(afterVoid.activity).toHaveLength(1)
      expect(afterVoid.activity[0]?.kind).toBe('BUY')
      expect(
        afterVoid.auditOperations.find(
          (operation) => operation.operationId === sale.operationId
        )
      ).toMatchObject({ current: null, revisions: [{ replacement: null }] })
    })

    it('flags stale source history and unlinked post-opening trades without claiming complete cash', async () => {
      const { readLiveCapitalOperations } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100', true)
      if (!f.transactionId)
        throw new Error('Missing fixture trade for source review')
      await confirmCashLedger(f.accountId, f.statementId)
      await prisma.transaction.update({
        where: { id: f.transactionId },
        data: { totalValue: '59' },
      })

      const review = await readLiveCapitalOperations(f.userId, f.accountId)
      expect(review.sourceFreshness.status).toBe('STALE')
      expect(review.cashCompleteness).toBe('INCOMPLETE')
      expect(review.unsupportedEvents).toContainEqual({
        code: 'UNLINKED_POST_OPENING_TRADE',
        sourceId: f.transactionId,
        effectiveDate: '2026-10-02',
      })
    })

    it('fails visibly rather than returning balances from a tampered live posting audit', async () => {
      const { postAccountCapitalFlow, readLiveCapitalOperations } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('0')
      await confirmCashLedger(f.accountId, f.statementId)
      const posted = await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({ amount: '25' })
      )
      await prisma.accountCashPosting.update({
        where: {
          operationId_legIndex: {
            operationId: posted.operationId,
            legIndex: 0,
          },
        },
        data: { amount: '24' },
      })

      await expect(
        readLiveCapitalOperations(f.userId, f.accountId)
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('inconsistent'),
      })
    })

    it('rejects stale capital revisions and corrections that would unfund a later purchase', async () => {
      const {
        postAccountCapitalFlow,
        correctLiveCapitalOperation,
        readLiveCapitalOperations,
        postAccountTrade,
      } = await import('./draft-cash-ledger.js')
      const stale = await fixture('0')
      await confirmCashLedger(stale.accountId, stale.statementId)
      const first = await postAccountCapitalFlow(
        stale.userId,
        stale.accountId,
        liveCapitalFlowInput({ amount: '100', sequence: 1 })
      )
      const view = await readLiveCapitalOperations(
        stale.userId,
        stale.accountId
      )
      await postAccountCapitalFlow(
        stale.userId,
        stale.accountId,
        liveCapitalFlowInput({ amount: '50', sequence: 2 })
      )
      await expect(
        correctLiveCapitalOperation(
          stale.userId,
          stale.accountId,
          first.operationId,
          {
            idempotencyKey: `stale-capital-${randomUUID()}`,
            expectedRevisionId: first.operationId,
            expectedAuditNumber: view.auditNumber,
            expectedSourceFingerprint: view.sourceFingerprint,
            reason: 'Correct stale funding information',
            replacement: {
              effectiveDate: view.items[0]!.original.effectiveDate,
              sequence: 3,
              amount: '90',
            },
          }
        )
      ).rejects.toMatchObject({ status: 409 })

      const f = await fixture('0')
      await confirmCashLedger(f.accountId, f.statementId)
      const depositInput = liveCapitalFlowInput({ amount: '100', sequence: 1 })
      const deposit = await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        depositInput
      )
      const asset = await prisma.asset.create({
        data: {
          symbol: `LIVE-CAPITAL-CORRECTION-${randomUUID()}`,
          name: 'Capital correction funding fixture',
          exchangeId: exchangeId!,
        },
      })
      await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: asset.id,
          effectiveDate: depositInput.effectiveDate,
          sequence: 2,
          price: '90',
          fees: '0',
        })
      )
      const current = await readLiveCapitalOperations(f.userId, f.accountId)
      const operation = current.items.find(
        (row) => row.operationId === deposit.operationId
      )
      if (!operation)
        throw new Error('Missing funding operation for correction')
      await expect(
        correctLiveCapitalOperation(
          f.userId,
          f.accountId,
          deposit.operationId,
          {
            idempotencyKey: `unfunded-capital-fix-${randomUUID()}`,
            expectedRevisionId: operation.expectedRevisionId,
            expectedAuditNumber: current.auditNumber,
            expectedSourceFingerprint: current.sourceFingerprint,
            reason: 'Incorrect deposit amount',
            replacement: {
              effectiveDate: depositInput.effectiveDate,
              sequence: 1,
              amount: '80',
            },
          }
        )
      ).rejects.toMatchObject({ status: 422 })
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
    })

    it('rolls back a live capital correction when revision persistence fails', async () => {
      const {
        postAccountCapitalFlow,
        correctLiveCapitalOperation,
        readLiveCapitalOperations,
      } = await import('./draft-cash-ledger.js')
      const f = await fixture('0')
      await confirmCashLedger(f.accountId, f.statementId)
      const posted = await postAccountCapitalFlow(
        f.userId,
        f.accountId,
        liveCapitalFlowInput({ amount: '100' })
      )
      const current = await readLiveCapitalOperations(f.userId, f.accountId)
      const operation = current.items[0]
      if (!operation) throw new Error('Missing funding operation')
      const input = {
        idempotencyKey: `capital-rollback-${randomUUID()}`,
        expectedRevisionId: operation.expectedRevisionId,
        expectedAuditNumber: current.auditNumber,
        expectedSourceFingerprint: current.sourceFingerprint,
        reason: 'Correct the recorded statement',
        replacement: {
          effectiveDate: operation.original.effectiveDate,
          sequence: 2,
          amount: '90',
        },
      }
      const originalTransaction = prisma.$transaction.bind(prisma)
      const injected = vi
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(async (callback) =>
          originalTransaction(async (db) => {
            vi.spyOn(
              db.accountCashOperationRevision,
              'create'
            ).mockRejectedValueOnce(
              new Error('Injected live capital revision failure')
            )
            if (typeof callback !== 'function')
              throw new Error('Expected transaction callback')
            return callback(db)
          })
        )
      try {
        await expect(
          correctLiveCapitalOperation(
            f.userId,
            f.accountId,
            posted.operationId,
            input
          )
        ).rejects.toThrow('Injected live capital revision failure')
      } finally {
        injected.mockRestore()
      }
      expect(
        await prisma.accountCashOperationRevision.count({
          where: { operationId: posted.operationId },
        })
      ).toBe(0)
      expect(
        (await readLiveCapitalOperations(f.userId, f.accountId)).items[0]
          ?.current?.amount
      ).toBe('100')
    })

    it('rejects withdrawals that cause a dated funding gap, including backdated flows', async () => {
      const { postAccountCapitalFlow, postAccountTrade } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('1000')
      const asset = await prisma.asset.create({
        data: {
          symbol: `LIVE-WITHDRAW-${randomUUID()}`,
          name: 'Live withdrawal fixture',
          exchangeId: exchangeId!,
        },
      })
      await confirmCashLedger(f.accountId, f.statementId)
      await postAccountTrade(
        f.userId,
        f.accountId,
        liveTradeInput({
          assetId: asset.id,
          effectiveDate: '2026-10-02',
          price: '400',
          fees: '0',
        })
      )
      const unaffordable = liveCapitalFlowInput({
        kind: 'WITHDRAWAL',
        effectiveDate: '2026-10-03',
        amount: '601',
      })
      await expect(
        postAccountCapitalFlow(f.userId, f.accountId, unaffordable)
      ).rejects.toMatchObject({ status: 422 })
      const withdrawal = await postAccountCapitalFlow(f.userId, f.accountId, {
        ...unaffordable,
        amount: '600',
      })
      expect(withdrawal.replay.funded).toBe(true)
      expect(withdrawal.replay.balances[0].endingAmount).toBe('0')
      await expect(
        postAccountCapitalFlow(f.userId, f.accountId, {
          ...liveCapitalFlowInput({
            kind: 'WITHDRAWAL',
            effectiveDate: '2026-10-02',
            sequence: 2,
            amount: '1',
          }),
        })
      ).rejects.toMatchObject({ status: 422 })
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(2)
    })

    it('serializes competing withdrawals so their combined value cannot overdraw cash', async () => {
      const { postAccountCapitalFlow } = await import('./draft-cash-ledger.js')
      const f = await fixture('100')
      await confirmCashLedger(f.accountId, f.statementId)
      const attempts = [1, 2].map((sequence) =>
        postAccountCapitalFlow(
          f.userId,
          f.accountId,
          liveCapitalFlowInput({
            kind: 'WITHDRAWAL',
            idempotencyKey: `live-withdraw-race-${sequence}`,
            sequence,
            amount: '70',
          })
        )
      )
      const results = await Promise.allSettled(attempts)
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1)
      const successful = results.find((row) => row.status === 'fulfilled')
      if (!successful || successful.status !== 'fulfilled')
        throw new Error('Expected one successful withdrawal')
      expect(successful.value.replay.balances[0].endingAmount).toBe('30')
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(1)
      const state = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      expect(state.acceptedSourceFingerprint).toBe(
        (
          await prisma.accountOpeningStatement.findUniqueOrThrow({
            where: { id: f.statementId },
          })
        ).sourceFingerprint
      )
    })

    it('rejects foreign, archived and source-drifted capital writes without persisting an operation', async () => {
      const { postAccountCapitalFlow } = await import('./draft-cash-ledger.js')
      const { closeTradingAccount } =
        await import('./trading-account-mutations.js')
      const archived = await fixture('100')
      await confirmCashLedger(archived.accountId, archived.statementId)
      const archivedInput = liveCapitalFlowInput()
      await closeTradingAccount(archived.userId, archived.accountId)
      await expect(
        postAccountCapitalFlow(
          archived.userId,
          archived.accountId,
          archivedInput
        )
      ).rejects.toMatchObject({ status: 409 })

      const changed = await fixture('100', true)
      if (!changed.transactionId)
        throw new Error('Missing fixture trade for source-drift test')
      await confirmCashLedger(changed.accountId, changed.statementId)
      const input = liveCapitalFlowInput()
      const foreignUser = await prisma.user.create({
        data: {
          email: `cash-foreign-${randomUUID()}@example.invalid`,
          passwordHash: 'test-fixture-not-a-login',
        },
      })
      const foreignAccount = await prisma.tradingAccount.create({
        data: {
          userId: foreignUser.id,
          name: `Foreign cash fixture ${randomUUID()}`,
        },
      })
      try {
        await expect(
          postAccountCapitalFlow(changed.userId, foreignAccount.id, input)
        ).rejects.toMatchObject({ status: 404 })
      } finally {
        await prisma.user.delete({ where: { id: foreignUser.id } })
      }
      await prisma.transaction.update({
        where: { id: changed.transactionId },
        data: { price: '99' },
      })
      await expect(
        postAccountCapitalFlow(changed.userId, changed.accountId, input)
      ).rejects.toMatchObject({
        status: 409,
        message: /source changed outside its audited live cash history/,
      })
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: archived.accountId },
        })
      ).toBe(0)
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: changed.accountId },
        })
      ).toBe(0)
    })

    it('rolls back the operation and postings when the final live capital write fails', async () => {
      const { postAccountCapitalFlow } = await import('./draft-cash-ledger.js')
      const f = await fixture('100')
      await confirmCashLedger(f.accountId, f.statementId)
      const ledger = await prisma.accountCashLedger.findUniqueOrThrow({
        where: { accountId: f.accountId },
      })
      const input = liveCapitalFlowInput({ amount: '10' })
      const originalTransaction = prisma.$transaction.bind(prisma)
      const injected = vi
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(async (callback) =>
          originalTransaction(async (db) => {
            vi.spyOn(db.accountCashOperation, 'create').mockRejectedValueOnce(
              new Error('Injected live capital write failure')
            )
            if (typeof callback !== 'function')
              throw new Error('Expected transaction callback')
            return callback(db)
          })
        )
      try {
        await expect(
          postAccountCapitalFlow(f.userId, f.accountId, input)
        ).rejects.toThrow('Injected live capital write failure')
      } finally {
        injected.mockRestore()
      }
      expect(
        await prisma.accountCashOperation.count({
          where: { accountId: f.accountId },
        })
      ).toBe(0)
      expect(
        await prisma.accountCashPosting.count({
          where: { operation: { accountId: f.accountId } },
        })
      ).toBe(0)
      expect(
        await prisma.accountCashLedger.findUniqueOrThrow({
          where: { accountId: f.accountId },
        })
      ).toEqual(ledger)
      expect(
        await postAccountCapitalFlow(f.userId, f.accountId, input)
      ).toMatchObject({ created: true })
    })

    it('confirms a reviewed opening statement atomically and deduplicates competing retries', async () => {
      const { confirmOpeningStatement, recordDraftCashEvidence } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100')
      const statement = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: f.statementId },
      })
      await recordDraftCashEvidence(
        f.userId,
        f.statementId,
        {
          idempotencyKey: randomUUID(),
          asOfDate: currentSydneyDate(),
          source: 'Disposable confirmation statement',
          reference: randomUUID(),
          attested: true,
          cashBalances: [{ currency: 'AUD', amount: '100' }],
          decisions: [],
        },
        f.accountId
      )
      const input = {
        idempotencyKey: randomUUID(),
        expectedSourceFingerprint: statement.sourceFingerprint,
        acknowledgements: {
          openingBalancesReviewed: true,
          cashEvidenceUserAttested: true,
          priorDraftActivityExcluded: true,
          returnsUnavailableWithoutValuations: true,
        },
      }

      const results = await Promise.all([
        confirmOpeningStatement(f.userId, f.accountId, f.statementId, input),
        confirmOpeningStatement(f.userId, f.accountId, f.statementId, input),
      ])
      expect(results.map((result) => result.created).sort()).toEqual([
        false,
        true,
      ])
      expect(results[0].statementId).toBe(results[1].statementId)
      expect(
        await prisma.accountOpeningStatement.findUniqueOrThrow({
          where: { id: f.statementId },
        })
      ).toMatchObject({ state: 'CONFIRMED' })
      expect(
        await prisma.accountCashLedger.findUniqueOrThrow({
          where: { accountId: f.accountId },
        })
      ).toMatchObject({
        openingStatementId: f.statementId,
        state: 'ACTIVE',
        confirmedByUserId: f.userId,
        confirmationIdempotencyKey: input.idempotencyKey,
      })
    })

    it('blocks confirmation when the selected draft contains staged activity', async () => {
      const { confirmOpeningStatement, saveDraftCashOperation } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100')
      const statement = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: f.statementId },
      })
      await saveDraftCashOperation(f.userId, f.statementId, {
        ...capital(f.accountId),
        idempotencyKey: randomUUID(),
      })

      await expect(
        confirmOpeningStatement(f.userId, f.accountId, f.statementId, {
          idempotencyKey: randomUUID(),
          expectedSourceFingerprint: statement.sourceFingerprint,
          acknowledgements: {
            openingBalancesReviewed: true,
            cashEvidenceUserAttested: true,
            priorDraftActivityExcluded: true,
            returnsUnavailableWithoutValuations: true,
          },
        })
      ).rejects.toMatchObject({
        status: 409,
        message: /contains saved activity/,
      })
      expect(
        await prisma.accountCashLedger.findUnique({
          where: { accountId: f.accountId },
        })
      ).toBeNull()
      expect(
        await prisma.accountOpeningStatement.findUniqueOrThrow({
          where: { id: f.statementId },
        })
      ).toMatchObject({ state: 'DRAFT' })
    })

    it('serializes confirmation against account closure and user deletion without partial activation', async () => {
      const { confirmOpeningStatement, recordDraftCashEvidence } =
        await import('./draft-cash-ledger.js')
      const { closeTradingAccount } =
        await import('./trading-account-mutations.js')
      const { scheduleUserDeletion } = await import('./account-deletion.js')
      const f = await fixture('100')
      const statement = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: f.statementId },
      })
      await recordDraftCashEvidence(
        f.userId,
        f.statementId,
        {
          idempotencyKey: randomUUID(),
          asOfDate: currentSydneyDate(),
          source: 'Disposable lifecycle statement',
          reference: randomUUID(),
          attested: true,
          cashBalances: [{ currency: 'AUD', amount: '100' }],
          decisions: [],
        },
        f.accountId
      )
      const input = {
        idempotencyKey: randomUUID(),
        expectedSourceFingerprint: statement.sourceFingerprint,
        acknowledgements: {
          openingBalancesReviewed: true,
          cashEvidenceUserAttested: true,
          priorDraftActivityExcluded: true,
          returnsUnavailableWithoutValuations: true,
        },
      }
      const closeRace = await Promise.allSettled([
        confirmOpeningStatement(f.userId, f.accountId, f.statementId, input),
        closeTradingAccount(f.userId, f.accountId),
      ])
      expect(closeRace[1].status).toBe('fulfilled')
      const afterCloseStatement =
        await prisma.accountOpeningStatement.findUniqueOrThrow({
          where: { id: f.statementId },
        })
      const afterCloseLedger = await prisma.accountCashLedger.findUnique({
        where: { accountId: f.accountId },
      })
      expect(afterCloseStatement.state === 'CONFIRMED').toBe(
        afterCloseLedger !== null
      )

      await prisma.user.update({
        where: { id: f.userId },
        data: { deletedAt: null, purgeAfter: null },
      })
      const userDeleteRace = await Promise.allSettled([
        confirmOpeningStatement(f.userId, f.accountId, f.statementId, {
          ...input,
          idempotencyKey: randomUUID(),
        }),
        scheduleUserDeletion(f.userId, 'test-fixture-not-a-login', new Date()),
      ])
      expect(userDeleteRace[1].status).toBe('fulfilled')
      const afterDeleteStatement =
        await prisma.accountOpeningStatement.findUniqueOrThrow({
          where: { id: f.statementId },
        })
      const afterDeleteLedger = await prisma.accountCashLedger.findUnique({
        where: { accountId: f.accountId },
      })
      expect(afterDeleteStatement.state === 'CONFIRMED').toBe(
        afterDeleteLedger !== null
      )
      await prisma.user.update({
        where: { id: f.userId },
        data: { deletedAt: null, purgeAfter: null },
      })
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
    it('reports explicit trade capability and preserves ordinary trade metadata', async () => {
      const { postAccountTrade, readAccountTradeCapability } =
        await import('./draft-cash-ledger.js')
      const f = await fixture('100')
      const effectiveDate = currentSydneyDate()
      if (!exchangeId) throw new Error('Missing fixture exchange')
      const fixtureExchange = await prisma.exchange.findUniqueOrThrow({
        where: { id: exchangeId },
      })

      expect(
        await readAccountTradeCapability(f.userId, f.accountId, effectiveDate)
      ).toMatchObject({ mode: 'LEGACY', nextSequence: null })
      await confirmCashLedger(f.accountId, f.statementId)
      expect(
        await readAccountTradeCapability(f.userId, f.accountId, effectiveDate)
      ).toMatchObject({
        mode: 'LIVE_LEDGER',
        openingDate: '2026-10-01',
        nextSequence: 1,
      })

      const buy = await postAccountTrade(f.userId, f.accountId, {
        kind: 'BUY',
        symbol: `META${randomUUID().slice(0, 8)}`,
        exchangeCode: fixtureExchange.code,
        assetName: 'Trade metadata fixture',
        assetType: 'EQUITY',
        industry: 'Technology',
        openReason: 'Long-term investment',
        stopLossPrice: '15',
        idempotencyKey: randomUUID(),
        effectiveDate,
        sequence: 1,
        quantity: '1',
        price: '20',
        fees: '1',
      })
      const position = await prisma.position.findFirstOrThrow({
        where: { accountId: f.accountId },
        include: { asset: { include: { exchange: true } } },
      })
      expect(position).toMatchObject({
        openReason: 'Long-term investment',
        asset: {
          name: 'Trade metadata fixture',
          industry: 'Technology',
        },
      })
      expect(Number(position.stopLossPrice)).toBe(15)
      const capability = await readAccountTradeCapability(
        f.userId,
        f.accountId,
        effectiveDate
      )
      if (capability.nextSequence === null)
        throw new Error('Missing next trade sequence')
      expect(capability).toMatchObject({
        mode: 'LIVE_LEDGER',
        nextSequence: 2,
      })

      const sale = await postAccountTrade(f.userId, f.accountId, {
        kind: 'SELL',
        positionId: position.id,
        idempotencyKey: randomUUID(),
        effectiveDate,
        sequence: capability.nextSequence,
        quantity: '1',
        price: '25',
        fees: '0.5',
        closeReason: 'TARGET',
        notes: 'Target reached',
      })
      const transaction = await prisma.transaction.findUniqueOrThrow({
        where: { id: sale.transactionId },
      })
      expect(transaction).toMatchObject({
        closeReason: 'TARGET',
        notes: 'Target reached',
      })
      await expect(
        readAccountTradeCapability(f.userId, f.accountId, effectiveDate)
      ).resolves.toMatchObject({ mode: 'LIVE_LEDGER', nextSequence: 3 })
      expect(buy.created).toBe(true)
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
