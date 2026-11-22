import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('../lib/prisma.js').prisma
let userId: string
let exchangeId: string

describe.skipIf(!enabled)(
  'tax report concurrency on disposable localhost',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error(
          'Tax report integration tests require a localhost database'
        )
      prisma = (await import('../lib/prisma.js')).prisma
      userId = (
        await prisma.user.create({
          data: {
            email: `tax-report-${randomUUID()}@example.invalid`,
            passwordHash: 'test-fixture-not-a-login',
          },
        })
      ).id
      exchangeId = (
        await prisma.exchange.create({
          data: {
            code: `REPORT-${randomUUID()}`.toUpperCase(),
            name: 'Disposable tax report fixture',
            currency: 'AUD',
            countryName: 'Australia',
            countryCode: 'AU',
          },
        })
      ).id
    })

    afterAll(async () => {
      try {
        if (userId) await prisma.user.delete({ where: { id: userId } })
        if (exchangeId) {
          await prisma.asset.deleteMany({ where: { exchangeId } })
          await prisma.exchange.delete({ where: { id: exchangeId } })
        }
      } finally {
        if (prisma) await prisma.$disconnect()
      }
    })

    it('rejects a split-aware correction racing PDF preparation and retains the prior report', async () => {
      const express = (await import('express')).default
      const request = (await import('supertest')).default
      const { errorHandler } = await import('../middleware/validation.js')
      const { signAccessToken } = await import('../lib/jwt.js')
      const { previewAccountOpening } =
        await import('../lib/accounting-preview-service.js')
      const { saveOpeningStatement } =
        await import('../lib/opening-statements.js')
      const pdf = await import('../lib/pdf-report.js')
      const {
        postAccountSplit,
        reverseAccountSplit,
        postAccountTrade,
        correctLiveManualAcquisition,
        readLiveCapitalOperations,
      } = await import('../lib/draft-cash-ledger.js')
      const account = await prisma.tradingAccount.create({
        data: { userId, name: `Report fixture ${randomUUID()}` },
      })
      const asset = await prisma.asset.create({
        data: {
          exchangeId,
          symbol: `R${randomUUID().slice(0, 8).toUpperCase()}`,
          name: 'Disposable report asset',
          assetType: 'EQUITY',
        },
      })
      const opening = {
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '1000' }],
      }
      const preview = await previewAccountOpening(userId, account.id, opening)
      const saved = await saveOpeningStatement(userId, account.id, {
        ...opening,
        sourceFingerprint: preview.sourceFingerprint,
      })
      await prisma.accountOpeningStatement.update({
        where: { id: saved.statement.id },
        data: { state: 'CONFIRMED' },
      })
      await prisma.accountCashLedger.create({
        data: {
          accountId: account.id,
          openingStatementId: saved.statement.id,
          state: 'ACTIVE',
          openingSourceFingerprint: saved.statement.sourceFingerprint,
          acceptedSourceFingerprint: saved.statement.sourceFingerprint,
        },
      })
      const buy = await postAccountTrade(userId, account.id, {
        kind: 'BUY',
        symbol: asset.symbol,
        exchangeCode: (
          await prisma.exchange.findUniqueOrThrow({ where: { id: exchangeId } })
        ).code,
        assetType: 'EQUITY',
        idempotencyKey: randomUUID(),
        effectiveDate: '2026-10-02',
        sequence: 1,
        quantity: '10',
        price: '10',
        fees: '1',
        stopLossPrice: '9',
      })
      if (!buy.transactionId) throw new Error('Missing fixture acquisition')
      const acquisition = await prisma.transaction.findUniqueOrThrow({
        where: { id: buy.transactionId },
      })
      const sale = await postAccountTrade(userId, account.id, {
        kind: 'SELL',
        positionId: acquisition.positionId,
        idempotencyKey: randomUUID(),
        effectiveDate: '2026-10-03',
        sequence: 1,
        quantity: '4',
        price: '20',
        fees: '1',
      })
      vi.stubEnv('JWT_SECRET', 'isolated-tax-report-test-secret')
      const originalPdf = pdf.buildCapitalGainsPdf
      const spy = vi.spyOn(pdf, 'buildCapitalGainsPdf')
      try {
        const router = (await import('./tax-reports.js')).default
        const positionsRouter = (await import('./positions.js')).default
        const statisticsRouter = (await import('./statistics.js')).default
        const portfolioRouter = (await import('./portfolio.js')).default
        const app = express()
        app.use(express.json())
        app.use('/api/tax-reports', router)
        app.use('/api/positions', positionsRouter)
        app.use('/api/statistics', statisticsRouter)
        app.use('/api/portfolio', portfolioRouter)
        app.use(errorHandler)
        const token = signAccessToken({
          userId,
          email: 'isolated@example.invalid',
        })
        const generate = () =>
          request(app)
            .post('/api/tax-reports/generate')
            .set('Authorization', `Bearer ${token}`)
            .send({ financialYearStartYear: 2026, accountIds: [account.id] })

        const first = await generate().expect(200)
        const previous = await prisma.taxReport.findUniqueOrThrow({
          where: { id: first.body.data.id },
        })
        const fixturePosition = await prisma.position.findUniqueOrThrow({
          where: { id: acquisition.positionId },
        })
        const {
          requireSupportedStopLossHistory,
          savePositionStopLossHit,
          savePositionHistory,
        } = await import('../lib/position-derived-values.js')
        const headBeforeMetadata = await readLiveCapitalOperations(
          userId,
          account.id
        )
        await savePositionHistory(fixturePosition, {
          maxDrawdownPercent: 45,
          maxRunUpPercent: 60,
        })
        const hitAt = new Date('2026-10-03T02:00:00Z')
        await savePositionStopLossHit(fixturePosition, hitAt)
        await request(app)
          .patch(`/api/positions/${acquisition.positionId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            notes: 'Reviewed position',
            stopLossPrice: 9,
            unrealizedPnL: 0,
            currentPrice: 8,
          })
          .expect(200)
        if (!sale.transactionId) throw new Error('Missing fixture sale')
        await request(app)
          .patch(`/api/positions/close-events/${sale.transactionId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ notes: 'Reviewed sale' })
          .expect(200)
        const preSplitPosition = await prisma.position.findUniqueOrThrow({
          where: { id: acquisition.positionId },
        })
        expect(preSplitPosition.updatedAt).toEqual(fixturePosition.updatedAt)
        expect(preSplitPosition.notes).toBe('Reviewed position')
        const headAfterMetadata = await readLiveCapitalOperations(
          userId,
          account.id
        )
        expect(headAfterMetadata.sourceFreshness.status).toBe('CURRENT')
        expect(headAfterMetadata.sourceFingerprint).toBe(
          headBeforeMetadata.sourceFingerprint
        )
        expect(headAfterMetadata.auditNumber).toBe(
          headBeforeMetadata.auditNumber
        )
        await expect(
          requireSupportedStopLossHistory(prisma, preSplitPosition)
        ).resolves.toBeUndefined()
        const exchangeCode = (
          await prisma.exchange.findUniqueOrThrow({ where: { id: exchangeId } })
        ).code
        const saveSnapshot = () =>
          request(app)
            .post('/api/portfolio/snapshot')
            .set('Authorization', `Bearer ${token}`)
            .send({ accountId: account.id, exchangeCode })
        const legacySnapshot = await saveSnapshot().expect(200)
        expect(Number(legacySnapshot.body.data.totalInvested)).toBe(101)
        const splitRequest = {
          idempotencyKey: randomUUID(),
          assetId: asset.id,
          effectiveDate: '2026-10-04',
          newUnits: '2',
          oldUnits: '1',
          sourceReference: `split-${randomUUID()}`,
          statementConfirmed: true,
        }
        try {
          await prisma.position.update({
            where: { id: acquisition.positionId },
            data: {
              updatedAt: new Date(preSplitPosition.updatedAt.getTime() + 1000),
            },
          })
          await request(app)
            .patch(`/api/positions/${acquisition.positionId}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ notes: 'Metadata on an already stale source' })
            .expect(200)
          const stale = await readLiveCapitalOperations(userId, account.id)
          expect(stale.sourceFreshness.status).toBe('STALE')
          expect(stale.sourceFingerprint).toBe(
            headBeforeMetadata.sourceFingerprint
          )
          await expect(
            postAccountSplit(userId, account.id, splitRequest)
          ).rejects.toMatchObject({ status: 409 })
        } finally {
          await prisma.position.update({
            where: { id: acquisition.positionId },
            data: { updatedAt: preSplitPosition.updatedAt },
          })
        }
        const [split] = await Promise.all([
          postAccountSplit(userId, account.id, splitRequest),
          request(app)
            .patch(`/api/positions/${acquisition.positionId}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ notes: 'Concurrent metadata edit' })
            .expect(200),
        ])
        const splitPositions = await request(app)
          .get('/api/positions')
          .set('Authorization', `Bearer ${token}`)
          .query({ accountId: account.id })
          .expect(200)
        expect(splitPositions.body.data[0].stopLossReviewRequired).toBe(true)
        expect(splitPositions.body.data[0].priceHistoryReviewRequired).toBe(
          true
        )
        expect(splitPositions.body.data[0].maxDrawdownPercent).toBeNull()
        expect(splitPositions.body.data[0].maxRunUpPercent).toBeNull()
        await request(app)
          .post(`/api/positions/${acquisition.positionId}/recalculate-drawdown`)
          .set('Authorization', `Bearer ${token}`)
          .expect(409)
        for (const payload of [
          { currentPrice: 1 },
          { maxRunUpPercent: null },
        ]) {
          await request(app)
            .patch(`/api/positions/${acquisition.positionId}`)
            .set('Authorization', `Bearer ${token}`)
            .send(payload)
            .expect(409)
        }
        await expect(
          savePositionHistory(preSplitPosition, { maxDrawdownPercent: 99 })
        ).rejects.toMatchObject({ status: 409 })
        const persistedHistory = await prisma.position.findUniqueOrThrow({
          where: { id: acquisition.positionId },
        })
        expect(Number(persistedHistory.maxDrawdownPercent)).toBe(45)
        expect(Number(persistedHistory.maxRunUpPercent)).toBe(60)
        await request(app)
          .patch(`/api/positions/${acquisition.positionId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ notes: 'Reviewed after split' })
          .expect(200)
        await request(app)
          .patch(`/api/positions/close-events/${sale.transactionId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ notes: 'Reviewed after split' })
          .expect(200)
        expect(
          (await readLiveCapitalOperations(userId, account.id)).sourceFreshness
            .status
        ).toBe('CURRENT')
        const stopCheck = await request(app)
          .post(`/api/positions/${acquisition.positionId}/check-stop-loss`)
          .set('Authorization', `Bearer ${token}`)
          .send({ currentPrice: 1 })
          .expect(409)
        expect(stopCheck.body.message).toMatch(/monitoring is unavailable/i)
        await expect(
          savePositionStopLossHit(preSplitPosition, new Date())
        ).rejects.toMatchObject({ status: 409 })
        expect(
          (
            await prisma.position.findUniqueOrThrow({
              where: { id: acquisition.positionId },
            })
          ).stopLossHitAt
        ).toEqual(hitAt)
        await request(app)
          .patch(`/api/positions/${acquisition.positionId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ stopLossPrice: 8 })
          .expect(409)
        const headBeforeStopReview = await readLiveCapitalOperations(
          userId,
          account.id
        )
        const reviewedStop = await request(app)
          .post(`/api/positions/${acquisition.positionId}/stop-loss-review`)
          .set('Authorization', `Bearer ${token}`)
          .send({ stopLossPrice: 4.5, reviewConfirmed: true })
          .expect(200)
        expect(reviewedStop.body.data.stopLossPrice).toBe(4.5)
        const reviewedPosition = await prisma.position.findUniqueOrThrow({
          where: { id: acquisition.positionId },
        })
        expect(Number(reviewedPosition.stopLossPrice)).toBe(4.5)
        expect(reviewedPosition.stopLossReviewedAt).toBeInstanceOf(Date)
        expect(reviewedPosition.stopLossHitAt).toBeNull()
        expect(
          (await readLiveCapitalOperations(userId, account.id)).sourceFreshness
            .status
        ).toBe('CURRENT')
        expect(
          (await readLiveCapitalOperations(userId, account.id))
            .sourceFingerprint
        ).toBe(headBeforeStopReview.sourceFingerprint)
        await request(app)
          .post(`/api/positions/${acquisition.positionId}/check-stop-loss`)
          .set('Authorization', `Bearer ${token}`)
          .send({ currentPrice: 1 })
          .expect(200)
        const reviewedPositions = await request(app)
          .get('/api/positions')
          .set('Authorization', `Bearer ${token}`)
          .query({ accountId: account.id })
          .expect(200)
        expect(reviewedPositions.body.data[0].stopLossReviewRequired).toBe(
          false
        )
        const splitHead = await readLiveCapitalOperations(userId, account.id)
        await reverseAccountSplit(userId, account.id, {
          idempotencyKey: randomUUID(),
          actionId: split.actionId,
          expectedAuditNumber: splitHead.auditNumber,
          expectedSourceFingerprint: splitHead.sourceFingerprint,
          reason: 'Correct the recorded split',
          reversalConfirmed: true,
        })
        const reversedPositions = await request(app)
          .get('/api/positions')
          .set('Authorization', `Bearer ${token}`)
          .query({ accountId: account.id })
          .expect(200)
        expect(reversedPositions.body.data[0].stopLossReviewRequired).toBe(true)
        expect(reversedPositions.body.data[0].priceHistoryReviewRequired).toBe(
          true
        )
        expect(reversedPositions.body.data[0].maxDrawdownPercent).toBeNull()
        expect(reversedPositions.body.data[0]).not.toHaveProperty(
          'splitAdjustedInventory'
        )
        await request(app)
          .post(`/api/positions/${acquisition.positionId}/check-stop-loss`)
          .set('Authorization', `Bearer ${token}`)
          .send({ currentPrice: 1 })
          .expect(409)
        await postAccountSplit(userId, account.id, {
          ...splitRequest,
          idempotencyKey: randomUUID(),
        })
        await postAccountTrade(userId, account.id, {
          kind: 'SELL',
          positionId: acquisition.positionId,
          idempotencyKey: randomUUID(),
          effectiveDate: '2026-10-05',
          sequence: 1,
          quantity: '4',
          price: '10',
          fees: '1',
        })
        const head = await readLiveCapitalOperations(userId, account.id)
        const transactionId = buy.transactionId
        spy.mockImplementationOnce(async (...args) => {
          await correctLiveManualAcquisition(
            userId,
            account.id,
            transactionId,
            {
              idempotencyKey: randomUUID(),
              expectedRevisionId: buy.operationId,
              expectedSourceFingerprint: head.sourceFingerprint,
              reason: 'Correct purchase from statement',
              effectiveDate: '2026-10-02',
              sequence: 1,
              quantity: '10',
              price: '11',
              fees: '1',
            }
          )
          return originalPdf(...args)
        })
        const raced = await generate().expect(409)
        expect(raced.body.message).toMatch(/inputs changed during generation/i)
        expect(
          await prisma.taxReport.findUniqueOrThrow({
            where: { id: previous.id },
          })
        ).toEqual(previous)
        expect(
          await prisma.taxReport.count({
            where: { userId, financialYearStartYear: 2026 },
          })
        ).toBe(1)

        const refreshed = await generate().expect(200)
        expect(refreshed.body.data.version).toBe(2)
        const next = await prisma.taxReport.findUniqueOrThrow({
          where: { id: refreshed.body.data.id },
        })
        expect(next.lineItems).toEqual([
          expect.objectContaining({ quantity: 4, costBaseForeign: 44.4 }),
          expect.objectContaining({ quantity: 4, costBaseForeign: 22.2 }),
        ])
        const history = await request(app)
          .get('/api/positions/close-events')
          .set('Authorization', `Bearer ${token}`)
          .query({ accountId: account.id, dateFrom: '2026-10-05', limit: 1 })
          .expect(200)
        expect(history.body.data).toHaveLength(1)
        expect(history.body.data[0].splitAdjustedSale).toEqual({
          costBasis: '22.200000000000',
          buyFees: '0.200000000000',
        })
        expect(history.body.data[0].position.entryPrice).toBe('11')
        expect(history.body.data[0].position.priceHistoryReviewRequired).toBe(
          true
        )
        expect(history.body.data[0].position.maxDrawdownPercent).toBeNull()
        expect(history.body.data[0].position.transactions).toEqual([
          expect.objectContaining({
            id: buy.transactionId,
            type: 'BUY',
            quantity: 10,
          }),
        ])
        expect(history.body.data[0].position).not.toHaveProperty('splitEffects')
        expect(history.body.data[0].position.asset).not.toHaveProperty(
          'splitActions'
        )
        const breakdown = await request(app)
          .get('/api/statistics/breakdowns')
          .set('Authorization', `Bearer ${token}`)
          .query({
            by: 'assetType',
            metric: 'marketValue',
            accountIds: account.id,
          })
          .expect(200)
        expect(breakdown.body.data.total).toBe(44.4)
        expect(breakdown.body.data.rows).toEqual([
          expect.objectContaining({ key: 'EQUITY', value: 44.4 }),
        ])
        const snapshot = await saveSnapshot().expect(200)
        expect(Number(snapshot.body.data.totalInvested)).toBe(44.4)
        expect(Number(snapshot.body.data.totalValue)).toBe(44.4)
        const savedSnapshot = await prisma.portfolioSnapshot.findUniqueOrThrow({
          where: { id: snapshot.body.data.id },
        })
        const currentPosition = await prisma.position.findUniqueOrThrow({
          where: { id: acquisition.positionId },
        })
        try {
          await prisma.position.update({
            where: { id: currentPosition.id },
            data: { quantity: currentPosition.quantity + 1 },
          })
          await saveSnapshot().expect(500)
          expect(
            await prisma.portfolioSnapshot.findUniqueOrThrow({
              where: { id: savedSnapshot.id },
            })
          ).toEqual(savedSnapshot)
        } finally {
          await prisma.position.update({
            where: { id: currentPosition.id },
            data: { quantity: currentPosition.quantity },
          })
        }
        const retained = await prisma.taxReport.findUniqueOrThrow({
          where: { id: previous.id },
        })
        expect(retained.supersededAt).not.toBeNull()
        expect(retained.lineItems).toEqual(previous.lineItems)
        expect(retained.pdfData).toEqual(previous.pdfData)
        expect((await generate().expect(200)).body.data.id).toBe(next.id)
      } finally {
        spy.mockRestore()
        vi.unstubAllEnvs()
      }
    })
  }
)
