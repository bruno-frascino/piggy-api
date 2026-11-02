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
let assetId: string | undefined
let exchangeId: string | undefined
const statementIds: string[] = []

async function fixture(amount = '100', withOpeningHolding = false) {
  if (!userId || !assetId)
    throw new Error('Missing disposable proposed-trade fixtures')
  const account = await prisma.tradingAccount.create({
    data: { userId, name: `Proposed trade fixture ${randomUUID()}` },
  })
  const position = withOpeningHolding
    ? await prisma.position.create({
        data: {
          userId,
          accountId: account.id,
          assetId,
          openDate: new Date('2026-09-01T00:00:00Z'),
          entryPrice: '5',
          quantity: 5,
          totalBuyValue: '50',
          buyFees: '1',
          capitalAllocated: '51',
          transactions: {
            create: [
              {
                type: 'BUY',
                date: new Date('2026-09-01T00:00:00Z'),
                quantity: 10,
                price: '5',
                totalValue: '50',
                fees: '1',
              },
              {
                type: 'SELL',
                date: new Date('2026-09-20T00:00:00Z'),
                quantity: 3,
                price: '6',
                totalValue: '18',
                fees: '1',
              },
              {
                type: 'SELL',
                date: new Date('2026-10-02T00:00:00Z'),
                quantity: 2,
                price: '6',
                totalValue: '12',
                fees: '1',
              },
            ],
          },
        },
        include: { transactions: true },
      })
    : null
  const input = {
    openingDate: '2026-10-01',
    cashBalances: [{ currency: 'AUD', amount }],
  }
  const preview = await (
    await import('./accounting-preview-service.js')
  ).previewAccountOpening(userId, account.id, input)
  const saved = await (
    await import('./opening-statements.js')
  ).saveOpeningStatement(userId, account.id, {
    ...input,
    sourceFingerprint: preview.sourceFingerprint,
  })
  statementIds.push(saved.statement.id)
  const openingParcel = position
    ? await prisma.openingParcelBalance.findUniqueOrThrow({
        where: {
          statementId_positionId: {
            statementId: saved.statement.id,
            positionId: position.id,
          },
        },
      })
    : null
  const buy = {
    accountId: account.id,
    idempotencyKey: randomUUID(),
    effectiveDate: '2026-10-02',
    sequence: 1,
    kind: 'BUY',
    assetId,
    currency: 'AUD',
    quantity: '10',
    price: '5',
    fees: '1',
  }
  return {
    userId,
    accountId: account.id,
    statementId: saved.statement.id,
    buy,
    position,
    openingParcel,
  }
}
function sale(accountId: string, parcelKey: string, quantity = '4') {
  return {
    accountId,
    parcelKey,
    idempotencyKey: randomUUID(),
    effectiveDate: '2026-10-03',
    sequence: 1,
    kind: 'SELL',
    currency: 'AUD',
    quantity,
    price: '6',
    fees: '1',
  }
}

function correction(
  expectedRevisionId: string,
  replacement: Record<string, unknown> | null
) {
  const idempotencyKey = randomUUID()
  return {
    idempotencyKey,
    expectedRevisionId,
    reason: 'Correct disposable proposed trade',
    replacement: replacement ? { ...replacement, idempotencyKey } : null,
  }
}

describe.skipIf(!enabled)(
  'isolated atomic draft trades on disposable localhost fixtures',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Draft trade tests require a localhost database')
      prisma = (await import('./prisma.js')).prisma
      ledger = await import('./draft-cash-ledger.js')
      userId = (
        await prisma.user.create({
          data: {
            email: `proposed-trade-fixture-${randomUUID()}@example.invalid`,
            passwordHash: 'fixture-not-a-login',
          },
        })
      ).id
      exchangeId = (
        await prisma.exchange.create({
          data: {
            code: `FIXTURE-${randomUUID()}`,
            name: 'Disposable proposal exchange',
            currency: 'AUD',
            countryName: 'Australia',
            countryCode: 'AU',
          },
        })
      ).id
      assetId = (
        await prisma.asset.create({
          data: {
            exchangeId,
            symbol: `FIXTURE-${randomUUID()}`,
            name: 'Disposable proposal asset',
          },
        })
      ).id
    })
    afterEach(() => vi.restoreAllMocks())
    afterAll(async () => {
      vi.restoreAllMocks()
      try {
        const ids = (
          await prisma.draftManualTrade.findMany({
            where: { operation: { statementId: { in: statementIds } } },
            select: { id: true },
          })
        ).map((row) => row.id)
        if (userId) await prisma.user.delete({ where: { id: userId } })
        expect(
          await prisma.draftManualTrade.count({ where: { id: { in: ids } } })
        ).toBe(0)
        if (assetId) await prisma.asset.delete({ where: { id: assetId } })
        if (exchangeId)
          await prisma.exchange.delete({ where: { id: exchangeId } })
      } finally {
        if (prisma) await prisma.$disconnect()
      }
    })

    it('projects partial opening sales, corrections and reversal from boundary units, not live remaining units', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel || !f.position)
        throw new Error('Missing opening fixture')
      const parcelKey = `opening:${f.openingParcel.id}`
      expect(f.openingParcel.quantity.toFixed()).toBe('7')
      const sell = sale(f.accountId, parcelKey)
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sell
      )
      expect(sold.replay.balances[0].endingAmount).toBe('23')
      expect(sold.replay.balances[0].netExternalContribution).toBe('0')
      expect(sold.parcels).toEqual([
        {
          parcelKey,
          assetId: null,
          positionId: f.position.id,
          symbol: f.openingParcel.symbol,
          currency: 'AUD',
          acquired: '7',
          remaining: '3',
        },
      ])
      const amended = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        sold.operationId,
        correction(sold.operationId, { ...sell, quantity: '2' })
      )
      expect(amended.parcels[0].remaining).toBe('5')
      expect(amended.replay.balances[0].endingAmount).toBe('11')
      const reversed = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        sold.operationId,
        correction(amended.revisionId, null)
      )
      expect(reversed.parcels[0].remaining).toBe('7')
      expect(reversed.replay.balances[0].endingAmount).toBe('0')
      const retry = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sell
      )
      expect(retry.created).toBe(false)
      expect(retry.parcels[0].remaining).toBe('7')
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.position.id },
          include: { transactions: true },
        })
      ).toEqual(f.position)
      expect(
        await prisma.openingParcelBalance.findUniqueOrThrow({
          where: { id: f.openingParcel.id },
        })
      ).toEqual(f.openingParcel)
      const persisted = await prisma.draftCashOperation.findMany({
        where: { statementId: f.statementId },
        include: { proposedTrade: true, tradeLinks: true, revisions: true },
      })
      expect(persisted).toHaveLength(1)
      expect(persisted[0].kind).toBe('SELL')
      expect(persisted[0].revisions).toHaveLength(2)
      expect(persisted[0].tradeLinks.map((row) => row.transactionId)).toEqual([
        sold.tradeId,
      ])
    })

    it('serializes competing opening sales against shared boundary units', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel) throw new Error('Missing opening fixture')
      const parcelKey = `opening:${f.openingParcel.id}`
      const results = await Promise.allSettled([
        ledger.saveDraftManualTrade(
          f.userId,
          f.statementId,
          sale(f.accountId, parcelKey)
        ),
        ledger.saveDraftManualTrade(f.userId, f.statementId, {
          ...sale(f.accountId, parcelKey),
          sequence: 2,
        }),
      ])
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1)
      const failure = results.find((row) => row.status === 'rejected')
      expect(failure?.status === 'rejected' && failure.reason).toMatchObject({
        status: 422,
      })
      const success = results.find((row) => row.status === 'fulfilled')
      expect(
        success?.status === 'fulfilled' && success.value.parcels[0].remaining
      ).toBe('3')
      expect(
        await prisma.draftManualTrade.count({
          where: { operation: { statementId: f.statementId } },
        })
      ).toBe(1)
    })

    it('serializes opening sale corrections against a competing new disposal', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel) throw new Error('Missing opening fixture')
      const sell = sale(f.accountId, `opening:${f.openingParcel.id}`)
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sell
      )
      const corrected = correction(sold.operationId, { ...sell, quantity: '5' })
      const results = await Promise.allSettled([
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          sold.operationId,
          corrected
        ),
        ledger.saveDraftManualTrade(f.userId, f.statementId, {
          ...sell,
          idempotencyKey: randomUUID(),
          quantity: '3',
          sequence: 2,
        }),
      ])
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      const failed = results.find((row) => row.status === 'rejected')
      expect(failed?.status === 'rejected' && failed.reason).toMatchObject({
        status: 422,
      })
      const retry = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sell
      )
      expect(['0', '2']).toContain(retry.parcels[0].remaining)
    })

    it('rolls back opening sale correction audit and cash children together', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel) throw new Error('Missing opening fixture')
      const sell = sale(f.accountId, `opening:${f.openingParcel.id}`)
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sell
      )
      const transact = prisma.$transaction.bind(prisma)
      const failure = new Error('Injected opening correction rollback')
      vi.spyOn(prisma, '$transaction').mockImplementationOnce((callback) => {
        if (typeof callback !== 'function')
          throw new Error('Expected interactive transaction')
        return transact(async (db) => {
          await callback(db)
          throw failure
        })
      })
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          sold.operationId,
          correction(sold.operationId, { ...sell, quantity: '6' })
        )
      ).rejects.toBe(failure)
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: sold.operationId },
        })
      ).toBe(0)
      expect(
        await prisma.draftCashRevisionPosting.count({
          where: { revision: { operationId: sold.operationId } },
        })
      ).toBe(0)
      const retry = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sell
      )
      expect(retry.parcels[0].remaining).toBe('3')
      expect(retry.replay.balances[0].endingAmount).toBe('23')
    })

    it('funds proposed purchases once from opening sales and rejects corrections that remove dependent cash', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel) throw new Error('Missing opening fixture')
      const sell = sale(f.accountId, `opening:${f.openingParcel.id}`)
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sell
      )
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        {
          ...f.buy,
          effectiveDate: '2026-10-04',
          quantity: '4',
        }
      )
      expect(bought.replay.balances[0].endingAmount).toBe('2')
      expect(bought.parcels.map((row) => row.remaining)).toEqual(['3', '4'])
      for (const replacement of [null, { ...sell, quantity: '3' }]) {
        await expect(
          ledger.correctDraftManualTrade(
            f.userId,
            f.statementId,
            sold.operationId,
            correction(sold.operationId, replacement)
          )
        ).rejects.toMatchObject({ status: 422 })
      }
      await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        bought.operationId,
        correction(bought.operationId, null)
      )
      const reversed = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        sold.operationId,
        correction(sold.operationId, null)
      )
      expect(reversed.replay.balances[0].endingAmount).toBe('0')
      expect(reversed.parcels).toHaveLength(1)
      expect(reversed.parcels[0].remaining).toBe('7')
    })

    it('rejects conflicting corrected opening unit allocations and restores fully sold opening parcels', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel) throw new Error('Missing opening fixture')
      const parcelKey = `opening:${f.openingParcel.id}`
      const first = sale(f.accountId, parcelKey)
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        first
      )
      const final = await ledger.saveDraftManualTrade(f.userId, f.statementId, {
        ...sale(f.accountId, parcelKey, '3'),
        effectiveDate: '2026-10-04',
      })
      expect(final.parcels[0].remaining).toBe('0')
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          sold.operationId,
          correction(sold.operationId, { ...first, quantity: '5' })
        )
      ).rejects.toMatchObject({ status: 422 })
      const reversed = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        final.operationId,
        correction(final.operationId, null)
      )
      expect(reversed.parcels[0].remaining).toBe('3')
      expect(reversed.replay.balances[0].endingAmount).toBe('23')
    })

    it('rejects opening keys from other drafts, raw position keys, wrong currency, pre-boundary sales and oversales', async () => {
      const f = await fixture('0', true)
      const other = await fixture('0', true)
      if (!f.openingParcel || !f.position || !other.openingParcel)
        throw new Error('Missing opening fixture')
      const sell = sale(f.accountId, `opening:${f.openingParcel.id}`)
      for (const raw of [
        { ...sell, parcelKey: `opening:${other.openingParcel.id}` },
        { ...sell, parcelKey: f.position.id },
        { ...sell, currency: 'USD' },
        { ...sell, quantity: '8' },
        { ...sell, effectiveDate: '2026-10-01' },
      ])
        await expect(
          ledger.saveDraftManualTrade(f.userId, f.statementId, raw)
        ).rejects.toThrow()
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
    })

    it('replays retries after a source change but blocks new mutations until opening reconciliation', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel || !f.position)
        throw new Error('Missing opening fixture')
      const sell = sale(f.accountId, `opening:${f.openingParcel.id}`)
      await ledger.saveDraftManualTrade(f.userId, f.statementId, sell)
      await prisma.position.update({
        where: { id: f.position.id },
        data: { quantity: 4 },
      })
      const retry = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sell
      )
      expect(retry.created).toBe(false)
      expect(retry.parcels[0].remaining).toBe('3')
      await expect(
        ledger.saveDraftManualTrade(f.userId, f.statementId, {
          ...sell,
          idempotencyKey: randomUUID(),
          sequence: 2,
          quantity: '1',
        })
      ).rejects.toThrow('source records have changed')
      await prisma.openingParcelBalance.update({
        where: { id: f.openingParcel.id },
        data: { quantity: '8' },
      })
      await expect(
        ledger.saveDraftManualTrade(f.userId, f.statementId, sell)
      ).rejects.toThrow('reviewed snapshot')
    })

    it('prevents counting recorded live trade cash and opening proposals in the same draft', async () => {
      const f = await fixture('0', true)
      const g = await fixture('0', true)
      if (!f.openingParcel || !g.openingParcel || !f.position || !g.position)
        throw new Error('Missing opening fixture')
      function recordedSale(
        accountId: string,
        position: NonNullable<typeof f.position>
      ) {
        const transaction = position.transactions.find(
          (row) => row.date.toISOString().slice(0, 10) === '2026-10-02'
        )
        if (!transaction) throw new Error('Missing recorded SELL')
        return {
          accountId,
          kind: 'SELL',
          idempotencyKey: randomUUID(),
          source: { origin: 'MANUAL', reference: transaction.id },
          effectiveDate: '2026-10-02',
          sequence: 1,
          transactionIds: [transaction.id],
          consideration: { currency: 'AUD', amount: '12' },
          fees: [{ currency: 'AUD', amount: '1' }],
        }
      }
      await ledger.saveDraftCashOperation(
        f.userId,
        f.statementId,
        recordedSale(f.accountId, f.position)
      )
      await expect(
        ledger.saveDraftManualTrade(
          f.userId,
          f.statementId,
          sale(f.accountId, `opening:${f.openingParcel.id}`)
        )
      ).rejects.toThrow('cannot mix')
      await ledger.saveDraftManualTrade(
        g.userId,
        g.statementId,
        sale(g.accountId, `opening:${g.openingParcel.id}`)
      )
      await expect(
        ledger.saveDraftCashOperation(
          g.userId,
          g.statementId,
          recordedSale(g.accountId, g.position)
        )
      ).rejects.toThrow('cannot mix')
    })

    it('reconciles draft/live unit differences, unlinked executions and overlap without financial writes', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel || !f.position)
        throw new Error('Missing opening fixture')
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sale(f.accountId, `opening:${f.openingParcel.id}`)
      )
      const before = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: f.statementId },
        include: {
          parcels: true,
          cashBalances: true,
          cashOperations: {
            include: { proposedTrade: true, revisions: true, postings: true },
          },
        },
      })
      const report = await ledger.reconcileDraftOpening(f.userId, f.statementId)
      expect(report).toMatchObject({
        mode: 'RECONCILIATION_ONLY',
        accountingActive: false,
        activationReady: false,
        source: { changed: false },
        cash: { verification: 'UNVERIFIED', funded: true },
      })
      expect(report.cash.balances[0].endingAmount).toBe('23')
      expect(report.inventory[0]).toMatchObject({
        openingQuantity: '7',
        proposedRemaining: '3',
        liveExpectedRemaining: '5',
        liveRecordedRemaining: '5',
        scenarioDifference: '-2',
      })
      expect(report.tradeSources).toHaveLength(1)
      expect(report.tradeSources[0]).toMatchObject({
        linkage: 'UNLINKED',
        potentialOverlapOperationIds: [sold.operationId],
      })
      expect(report.reviewReasons).toContain('PROPOSED_RECORDED_TRADE_OVERLAP')
      expect(
        await prisma.accountOpeningStatement.findUniqueOrThrow({
          where: { id: f.statementId },
          include: {
            parcels: true,
            cashBalances: true,
            cashOperations: {
              include: { proposedTrade: true, revisions: true, postings: true },
            },
          },
        })
      ).toEqual(before)
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.position.id },
          include: { transactions: true },
        })
      ).toEqual(f.position)
      await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        sold.operationId,
        correction(sold.operationId, null)
      )
      const reversed = await ledger.reconcileDraftOpening(
        f.userId,
        f.statementId
      )
      expect(reversed.inventory[0].proposedRemaining).toBe('7')
      expect(reversed.cash.balances[0].endingAmount).toBe('0')
      expect(reversed.tradeSources[0].potentialOverlapOperationIds).toEqual([])
    })

    it('reports source changes and invalid live inventory while denying cross-user report access', async () => {
      const f = await fixture('0', true)
      if (!f.position) throw new Error('Missing opening fixture')
      await prisma.position.update({
        where: { id: f.position.id },
        data: { quantity: 4 },
      })
      const report = await ledger.reconcileDraftOpening(f.userId, f.statementId)
      expect(report.source.changed).toBe(true)
      expect(report.reviewReasons).toContain('OPENING_SOURCE_CHANGED')
      expect(report.reviewReasons).toContain('LIVE_PREVIEW_BLOCKING_ISSUES')
      expect(report.inventory[0]).toMatchObject({
        liveExpectedRemaining: '5',
        liveRecordedRemaining: '4',
      })
      await expect(
        ledger.reconcileDraftOpening('non-owner', f.statementId)
      ).rejects.toMatchObject({ status: 404 })
    })

    it('reconciliation and a competing sale share the account barrier without torn cash/unit projections', async () => {
      const f = await fixture('0', true)
      if (!f.openingParcel) throw new Error('Missing opening fixture')
      const [report] = await Promise.all([
        ledger.reconcileDraftOpening(f.userId, f.statementId),
        ledger.saveDraftManualTrade(
          f.userId,
          f.statementId,
          sale(f.accountId, `opening:${f.openingParcel.id}`)
        ),
      ])
      const pair = [
        report.inventory[0].proposedRemaining,
        report.cash.balances[0].endingAmount,
      ]
      expect([
        ['7', '0'],
        ['3', '23'],
      ]).toContainEqual(pair)
      const latest = await ledger.reconcileDraftOpening(f.userId, f.statementId)
      expect(latest.inventory[0].proposedRemaining).toBe('3')
      expect(latest.cash.balances[0].endingAmount).toBe('23')
    })

    it('records user-attested exact statement cash as immutable evidence while keeping external verification and activation disabled', async () => {
      const f = await fixture('100')
      const evidence = {
        idempotencyKey: randomUUID(),
        asOfDate: '2026-10-10',
        source: 'Example Bank',
        reference: 'Statement 001',
        attested: true,
        cashBalances: [{ currency: 'AUD', amount: '100' }],
        decisions: [],
      }
      const recorded = await ledger.recordDraftCashEvidence(
        f.userId,
        f.statementId,
        evidence,
        f.accountId
      )
      expect(recorded).toMatchObject({
        created: true,
        comparison: { matchesReplay: true, variances: [] },
      })
      const retry = await ledger.recordDraftCashEvidence(
        f.userId,
        f.statementId,
        evidence,
        f.accountId
      )
      expect(retry).toMatchObject({
        evidenceId: recorded.evidenceId,
        created: false,
      })
      const report = await ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.cashEvidence[0]).toMatchObject({
        source: 'Example Bank',
        reference: 'Statement 001',
        attested: true,
        currentComparison: { matchesReplay: true, variances: [] },
      })
      expect(report.cash.verification).toBe('UNVERIFIED')
      expect(report.activationReady).toBe(false)
      expect(report.reviewReasons).toContain('CASH_NOT_EXTERNALLY_VERIFIED')
      expect(report.reviewReasons).not.toContain('CASH_EVIDENCE_MISSING')
      expect(
        await prisma.draftCashEvidence.count({
          where: { statementId: f.statementId },
        })
      ).toBe(1)
      expect(
        await prisma.draftCashEvidenceBalance.count({
          where: { evidence: { statementId: f.statementId } },
        })
      ).toBe(1)
      expect(
        await prisma.position.count({ where: { accountId: f.accountId } })
      ).toBe(0)
    })

    it('persists discrepancy decisions but only a separate effective-dated source operation can make replay match', async () => {
      const f = await fixture('100')
      const evidence = {
        idempotencyKey: randomUUID(),
        asOfDate: '2026-10-10',
        source: 'Example Bank',
        reference: 'Statement 002',
        attested: true,
        cashBalances: [{ currency: 'AUD', amount: '125' }],
        decisions: [
          {
            currency: 'AUD',
            reason: 'UNRECORDED_OPERATION',
            note: 'Transfer from reserve account was not recorded',
          },
        ],
      }
      const recorded = await ledger.recordDraftCashEvidence(
        f.userId,
        f.statementId,
        evidence,
        f.accountId
      )
      expect(recorded.comparison).toMatchObject({
        matchesReplay: false,
        variances: [
          { currency: 'AUD', expectedAmount: '100', difference: '25' },
        ],
      })
      let report = await ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.reviewReasons).toContain('CASH_EVIDENCE_MISMATCH')
      expect(report.cashEvidence[0].decisions).toEqual(evidence.decisions)
      const operation = await ledger.saveDraftReconciliationCashOperation(
        f.userId,
        f.statementId,
        {
          idempotencyKey: randomUUID(),
          effectiveDate: '2026-10-05',
          sequence: 1,
          kind: 'DEPOSIT',
          currency: 'AUD',
          amount: '25',
          sourceReference: 'reserve-transfer-25',
        },
        f.accountId
      )
      expect(operation.replay.balances[0].endingAmount).toBe('125')
      report = await ledger.reconcileDraftOpening(
        f.userId,
        f.statementId,
        f.accountId
      )
      expect(report.cashEvidence[0].currentComparison).toMatchObject({
        matchesReplay: true,
        variances: [],
      })
      expect(report.reviewReasons).not.toContain('CASH_EVIDENCE_MISMATCH')
      expect(report.cash.verification).toBe('UNVERIFIED')
      expect(report.activationReady).toBe(false)
      const persisted = await prisma.draftCashEvidence.findUniqueOrThrow({
        where: { id: recorded.evidenceId },
        include: { balances: true, decisions: true },
      })
      expect(persisted.balances[0].amount.toFixed()).toBe('125')
      expect(persisted.decisions[0].note).toBe(evidence.decisions[0].note)
    })

    it('requires all explicit currency balances and exact variance decisions, and rejects account rebinding', async () => {
      const f = await fixture('100')
      const raw = {
        idempotencyKey: randomUUID(),
        asOfDate: '2026-10-10',
        source: 'Example Bank',
        reference: 'Statement 003',
        attested: true,
        cashBalances: [{ currency: 'AUD', amount: '99' }],
        decisions: [],
      }
      await expect(
        ledger.recordDraftCashEvidence(
          f.userId,
          f.statementId,
          raw,
          f.accountId
        )
      ).rejects.toThrow('one explicit decision')
      await expect(
        ledger.recordDraftCashEvidence(
          f.userId,
          f.statementId,
          {
            ...raw,
            cashBalances: [
              { currency: 'AUD', amount: '99' },
              { currency: 'USD', amount: '0' },
            ],
            decisions: [{ currency: 'AUD', reason: 'OTHER', note: 'Review' }],
          },
          f.accountId
        )
      ).rejects.toThrow('every explicitly tracked')
      await expect(
        ledger.reconcileDraftOpening(f.userId, f.statementId, randomUUID())
      ).rejects.toMatchObject({ status: 404 })
      expect(
        await prisma.draftCashEvidence.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
    })

    it('commits isolated BUY, partial/full SELL and exact cash while live holdings/transactions remain untouched', async () => {
      const f = await fixture()
      const before = await prisma.accountOpeningStatement.findUniqueOrThrow({
        where: { id: f.statementId },
      })
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      expect(bought.replay.balances[0].endingAmount).toBe('49')
      const partial = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sale(f.accountId, bought.parcelKey)
      )
      expect(partial.replay.balances[0].endingAmount).toBe('72')
      expect(partial.parcels[0].remaining).toBe('6')
      const full = await ledger.saveDraftManualTrade(f.userId, f.statementId, {
        ...sale(f.accountId, bought.parcelKey, '6'),
        effectiveDate: '2026-10-04',
      })
      expect(full.replay.balances[0].endingAmount).toBe('107')
      expect(full.replay.balances[0].netExternalContribution).toBe('0')
      expect(full.parcels[0]).toMatchObject({ acquired: '10', remaining: '0' })
      expect(
        await prisma.position.count({ where: { accountId: f.accountId } })
      ).toBe(0)
      expect(
        await prisma.transaction.count({
          where: { position: { accountId: f.accountId } },
        })
      ).toBe(0)
      expect(
        await prisma.accountOpeningStatement.findUniqueOrThrow({
          where: { id: f.statementId },
        })
      ).toEqual(before)
      expect(
        await prisma.draftManualTrade.count({
          where: { operation: { statementId: f.statementId } },
        })
      ).toBe(3)
    })
    it('corrects BUY quantity/cost and SELL quantity atomically while preserving original records and live tables', async () => {
      const f = await fixture('200')
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      const sellRequest = sale(f.accountId, bought.parcelKey)
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sellRequest
      )
      const before = await prisma.draftCashOperation.findUniqueOrThrow({
        where: { id: bought.operationId },
        include: { proposedTrade: true, postings: true },
      })
      const buyCorrection = correction(bought.operationId, {
        ...f.buy,
        quantity: '8',
        price: '6',
        fees: '2',
      })
      const corrected = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        bought.operationId,
        buyCorrection
      )
      expect(corrected.parcels[0]).toMatchObject({
        acquired: '8',
        remaining: '4',
      })
      expect(corrected.replay.balances[0].endingAmount).toBe('173')
      expect(
        await prisma.draftCashOperation.findUniqueOrThrow({
          where: { id: bought.operationId },
          include: { proposedTrade: true, postings: true },
        })
      ).toEqual(before)
      const sellCorrection = correction(sold.operationId, {
        ...sellRequest,
        quantity: '3',
        price: '7',
        fees: '2',
      })
      const next = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        sold.operationId,
        sellCorrection
      )
      expect(next.parcels[0].remaining).toBe('5')
      expect(next.replay.balances[0].endingAmount).toBe('169')
      const retry = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      expect(retry.created).toBe(false)
      expect(retry.parcels[0]).toMatchObject({ acquired: '8', remaining: '5' })
      expect(retry.replay.balances[0].endingAmount).toBe('169')
      expect(
        await prisma.position.count({ where: { accountId: f.accountId } })
      ).toBe(0)
      expect(
        await prisma.transaction.count({
          where: { position: { accountId: f.accountId } },
        })
      ).toBe(0)
    })

    it('rejects reducing or reversing a BUY beneath already proposed disposals', async () => {
      const f = await fixture()
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sale(f.accountId, bought.parcelKey, '7')
      )
      for (const replacement of [
        { ...f.buy, quantity: '6' },
        null,
        { ...f.buy, effectiveDate: '2026-10-04' },
      ]) {
        await expect(
          ledger.correctDraftManualTrade(
            f.userId,
            f.statementId,
            bought.operationId,
            correction(bought.operationId, replacement)
          )
        ).rejects.toMatchObject({
          status: 422,
          name: 'Insufficient Draft Units',
        })
      }
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: bought.operationId },
        })
      ).toBe(0)
    })

    it('checks cash at every affected date when increasing BUY costs or removing sale proceeds', async () => {
      const f = await fixture('51')
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      const sellRequest = sale(f.accountId, bought.parcelKey, '10')
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sellRequest
      )
      await ledger.saveDraftCashOperation(f.userId, f.statementId, {
        accountId: f.accountId,
        kind: 'WITHDRAWAL',
        idempotencyKey: randomUUID(),
        source: { origin: 'MANUAL', reference: randomUUID() },
        effectiveDate: '2026-10-04',
        sequence: 1,
        cash: { currency: 'AUD', amount: '59' },
      })
      await ledger.saveDraftCashOperation(f.userId, f.statementId, {
        accountId: f.accountId,
        kind: 'DEPOSIT',
        idempotencyKey: randomUUID(),
        source: { origin: 'MANUAL', reference: randomUUID() },
        effectiveDate: '2026-10-05',
        sequence: 1,
        cash: { currency: 'AUD', amount: '100' },
      })
      for (const replacement of [
        null,
        { ...sellRequest, price: '5' },
        { ...sellRequest, effectiveDate: '2026-10-05', sequence: 2 },
      ]) {
        await expect(
          ledger.correctDraftManualTrade(
            f.userId,
            f.statementId,
            sold.operationId,
            correction(sold.operationId, replacement)
          )
        ).rejects.toMatchObject({ status: 422, name: 'Insufficient Cash' })
      }
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          bought.operationId,
          correction(bought.operationId, { ...f.buy, fees: '2' })
        )
      ).rejects.toMatchObject({ status: 422, name: 'Insufficient Cash' })
    })

    it('reverses a SELL then BUY, restoring units/cash without erasing audit and makes reversal terminal', async () => {
      const f = await fixture()
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      const sold = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        sale(f.accountId, bought.parcelKey)
      )
      const voidSale = correction(sold.operationId, null)
      const reversedSale = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        sold.operationId,
        voidSale
      )
      expect(reversedSale.parcels[0].remaining).toBe('10')
      expect(reversedSale.replay.balances[0].endingAmount).toBe('49')
      const reversedBuy = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        bought.operationId,
        correction(bought.operationId, null)
      )
      expect(reversedBuy.parcels).toEqual([])
      expect(reversedBuy.replay.balances[0].endingAmount).toBe('100')
      expect(
        (
          await ledger.correctDraftManualTrade(
            f.userId,
            f.statementId,
            sold.operationId,
            voidSale
          )
        ).created
      ).toBe(false)
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          sold.operationId,
          correction(reversedSale.revisionId, null)
        )
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        ledger.saveDraftManualTrade(
          f.userId,
          f.statementId,
          sale(f.accountId, bought.parcelKey)
        )
      ).rejects.toMatchObject({ status: 409 })
    })

    it('competing corrections and sales cannot both consume the same remaining units', async () => {
      const f = await fixture('200')
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      const results = await Promise.allSettled([
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          bought.operationId,
          correction(bought.operationId, { ...f.buy, quantity: '6' })
        ),
        ledger.saveDraftManualTrade(
          f.userId,
          f.statementId,
          sale(f.accountId, bought.parcelKey, '7')
        ),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { status: 422 },
      })
    })

    it('serializes competing head corrections and hashes units/price even when cash consideration is equal', async () => {
      const f = await fixture()
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      const first = correction(bought.operationId, {
        ...f.buy,
        quantity: '5',
        price: '10',
      })
      const second = correction(bought.operationId, {
        ...f.buy,
        quantity: '2',
        price: '25',
      })
      const results = await Promise.allSettled([
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          bought.operationId,
          first
        ),
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          bought.operationId,
          second
        ),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { status: 409 },
      })
      const winner = results[0].status === 'fulfilled' ? first : second
      expect(
        (
          await ledger.correctDraftManualTrade(
            f.userId,
            f.statementId,
            bought.operationId,
            winner
          )
        ).created
      ).toBe(false)
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          bought.operationId,
          {
            ...winner,
            replacement: { ...f.buy, idempotencyKey: winner.idempotencyKey },
          }
        )
      ).rejects.toMatchObject({ status: 409 })
      const latest = await prisma.draftCashRevision.findFirstOrThrow({
        where: { operationId: bought.operationId },
      })
      await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        bought.operationId,
        correction(latest.id, { ...f.buy, quantity: '9' })
      )
      const oldRetry = await ledger.correctDraftManualTrade(
        f.userId,
        f.statementId,
        bought.operationId,
        winner
      )
      expect(oldRetry.created).toBe(false)
      expect(oldRetry.parcels[0].acquired).toBe('9')
    })

    it('rolls back correction request and reversal/replacement children together after a commit failure', async () => {
      const f = await fixture()
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      const transact = prisma.$transaction.bind(prisma)
      const failure = new Error('Injected correction rollback')
      vi.spyOn(prisma, '$transaction').mockImplementationOnce((callback) => {
        if (typeof callback !== 'function')
          throw new Error('Expected interactive transaction')
        return transact(async (db) => {
          await callback(db)
          throw failure
        })
      })
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          bought.operationId,
          correction(bought.operationId, { ...f.buy, quantity: '9' })
        )
      ).rejects.toBe(failure)
      expect(
        await prisma.draftCashRevision.count({
          where: { operationId: bought.operationId },
        })
      ).toBe(0)
      const retry = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      expect(retry.parcels[0].acquired).toBe('10')
      expect(retry.replay.balances[0].endingAmount).toBe('49')
    })

    it('rejects cross-statement correction, identity rebinding and cash-only bypasses', async () => {
      const f = await fixture()
      const other = await fixture()
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          other.statementId,
          bought.operationId,
          correction(bought.operationId, null)
        )
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          bought.operationId,
          correction(bought.operationId, { ...f.buy, assetId: 'other' })
        )
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        ledger.correctDraftManualTrade(
          f.userId,
          f.statementId,
          bought.operationId,
          correction(bought.operationId, { ...f.buy, currency: 'USD' })
        )
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          bought.operationId,
          correction(bought.operationId, null)
        )
      ).rejects.toMatchObject({ status: 409 })
    })

    it('competing BUYs cannot both spend the same dated cash', async () => {
      const f = await fixture('60')
      const results = await Promise.allSettled([
        ledger.saveDraftManualTrade(f.userId, f.statementId, f.buy),
        ledger.saveDraftManualTrade(f.userId, f.statementId, {
          ...f.buy,
          idempotencyKey: randomUUID(),
          sequence: 2,
        }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { status: 422 },
      })
      expect(
        await prisma.draftManualTrade.count({
          where: { operation: { statementId: f.statementId } },
        })
      ).toBe(1)
    })
    it('competing SELLs cannot dispose of the same draft units twice', async () => {
      const f = await fixture()
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      const results = await Promise.allSettled([
        ledger.saveDraftManualTrade(
          f.userId,
          f.statementId,
          sale(f.accountId, bought.parcelKey, '7')
        ),
        ledger.saveDraftManualTrade(f.userId, f.statementId, {
          ...sale(f.accountId, bought.parcelKey, '7'),
          sequence: 2,
        }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { status: 422, name: 'Insufficient Draft Units' },
      })
      expect(
        await prisma.draftManualTrade.count({
          where: {
            operation: { statementId: f.statementId },
            parcelKey: bought.parcelKey,
          },
        })
      ).toBe(2)
    })
    it('identical competing retries reuse one proposal and reject changed payloads', async () => {
      const f = await fixture()
      const results = await Promise.all([
        ledger.saveDraftManualTrade(f.userId, f.statementId, f.buy),
        ledger.saveDraftManualTrade(f.userId, f.statementId, {
          ...f.buy,
          quantity: '10.00',
        }),
      ])
      expect(new Set(results.map((r) => r.tradeId)).size).toBe(1)
      expect(results.filter((r) => r.created)).toHaveLength(1)
      await expect(
        ledger.saveDraftManualTrade(f.userId, f.statementId, {
          ...f.buy,
          fees: '2',
        })
      ).rejects.toMatchObject({ status: 409 })
    })
    it('cannot manufacture earlier funding with a later deposit or sell before the BUY date', async () => {
      const f = await fixture('0')
      await ledger.saveDraftCashOperation(f.userId, f.statementId, {
        accountId: f.accountId,
        idempotencyKey: randomUUID(),
        kind: 'DEPOSIT',
        source: { origin: 'MANUAL', reference: randomUUID() },
        effectiveDate: '2026-10-03',
        sequence: 1,
        cash: { currency: 'AUD', amount: '100' },
      })
      await expect(
        ledger.saveDraftManualTrade(f.userId, f.statementId, f.buy)
      ).rejects.toMatchObject({ status: 422, name: 'Insufficient Cash' })
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        {
          ...f.buy,
          effectiveDate: '2026-10-03',
          sequence: 2,
        }
      )
      await expect(
        ledger.saveDraftManualTrade(f.userId, f.statementId, {
          ...sale(f.accountId, bought.parcelKey),
          effectiveDate: '2026-10-02',
        })
      ).rejects.toMatchObject({ status: 422, name: 'Insufficient Draft Units' })
    })
    it('capital corrections cannot remove funding consumed by a proposed BUY', async () => {
      const f = await fixture('0')
      const deposit = await ledger.saveDraftCashOperation(
        f.userId,
        f.statementId,
        {
          accountId: f.accountId,
          idempotencyKey: randomUUID(),
          kind: 'DEPOSIT',
          source: { origin: 'MANUAL', reference: randomUUID() },
          effectiveDate: '2026-10-02',
          sequence: 1,
          cash: { currency: 'AUD', amount: '100' },
        }
      )
      await ledger.saveDraftManualTrade(f.userId, f.statementId, {
        ...f.buy,
        sequence: 2,
      })
      await expect(
        ledger.correctDraftCashOperation(
          f.userId,
          f.statementId,
          deposit.operationId,
          {
            idempotencyKey: randomUUID(),
            expectedRevisionId: deposit.operationId,
            reason: 'Remove fixture funding',
            replacement: null,
          }
        )
      ).rejects.toMatchObject({ status: 422 })
    })
    it('rolls back the trade snapshot, links and cash children together after a commit failure', async () => {
      const f = await fixture()
      const transact = prisma.$transaction.bind(prisma)
      const failure = new Error('Injected commit failure')
      vi.spyOn(prisma, '$transaction').mockImplementationOnce((callback) => {
        if (typeof callback !== 'function')
          throw new Error('Expected interactive transaction')
        return transact(async (db) => {
          await callback(db)
          throw failure
        })
      })
      await expect(
        ledger.saveDraftManualTrade(f.userId, f.statementId, f.buy)
      ).rejects.toBe(failure)
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(0)
      expect(
        await prisma.draftManualTrade.count({
          where: { operation: { statementId: f.statementId } },
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
    })
    it('rejects cross-statement parcel allocation and stale live sources without changing proposals', async () => {
      const f = await fixture()
      const other = await fixture()
      const bought = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      await expect(
        ledger.saveDraftManualTrade(
          other.userId,
          other.statementId,
          sale(other.accountId, bought.parcelKey)
        )
      ).rejects.toMatchObject({ status: 409 })
      await prisma.tradingAccount.update({
        where: { id: f.accountId },
        data: { name: randomUUID() },
      })
      const retry = await ledger.saveDraftManualTrade(
        f.userId,
        f.statementId,
        f.buy
      )
      expect(retry.created).toBe(false)
      await expect(
        ledger.saveDraftManualTrade(
          f.userId,
          f.statementId,
          sale(f.accountId, bought.parcelKey)
        )
      ).rejects.toMatchObject({ status: 409 })
    })
  }
)
