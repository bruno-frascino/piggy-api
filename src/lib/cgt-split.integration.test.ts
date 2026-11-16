import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('./prisma.js').prisma
let userId: string | undefined
let exchangeId: string | undefined

describe.skipIf(!enabled)(
  'split-aware CGT on disposable localhost fixtures',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('CGT integration tests require a localhost database')
      prisma = (await import('./prisma.js')).prisma
      userId = (
        await prisma.user.create({
          data: {
            email: `cgt-split-${randomUUID()}@example.invalid`,
            passwordHash: 'test-fixture-not-a-login',
          },
        })
      ).id
      exchangeId = (
        await prisma.exchange.create({
          data: {
            code: `CGT-${randomUUID()}`.toUpperCase(),
            name: 'Disposable CGT fixture',
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

    it('uses retained split history for each disposal and removes fixture records on user purge', async () => {
      if (!userId || !exchangeId)
        throw new Error('Missing isolated CGT fixture')
      const { prepareAccountSplit } = await import('./account-split-command.js')
      const { computeCapitalGainsReport } = await import('./cgt-engine.js')
      const account = await prisma.tradingAccount.create({
        data: { userId, name: `CGT fixture ${randomUUID()}` },
      })
      const asset = await prisma.asset.create({
        data: {
          exchangeId,
          symbol: `CGT-${randomUUID()}`,
          name: 'Disposable CGT split asset',
          assetType: 'EQUITY',
        },
      })
      const position = await prisma.position.create({
        data: {
          userId,
          accountId: account.id,
          assetId: asset.id,
          openDate: new Date('2024-01-01T00:00:00Z'),
          entryPrice: '100',
          quantity: 12,
          totalBuyValue: '1000',
          buyFees: '10',
          capitalAllocated: '1010',
          transactions: {
            create: [
              {
                type: 'BUY',
                date: new Date('2024-01-01T00:00:00Z'),
                quantity: 10,
                price: '100',
                totalValue: '1000',
                fees: '10',
              },
              {
                type: 'SELL',
                date: new Date('2025-07-01T00:00:00Z'),
                quantity: 2,
                price: '110',
                totalValue: '220',
                fees: '0',
              },
              {
                type: 'SELL',
                date: new Date('2025-10-01T00:00:00Z'),
                quantity: 4,
                price: '60',
                totalValue: '240',
                fees: '0',
              },
            ],
          },
        },
      })
      const request = {
        idempotencyKey: randomUUID(),
        assetId: asset.id,
        effectiveDate: '2025-08-01',
        newUnits: '2',
        oldUnits: '1',
        sourceReference: 'fixture-statement',
        statementConfirmed: true,
      }
      const prepared = prepareAccountSplit(request, account.id)
      const action = await prisma.accountSplitAction.create({
        data: {
          accountId: account.id,
          assetId: asset.id,
          effectiveDate: new Date('2025-08-01T00:00:00Z'),
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
              beforeQuantity: '8',
              afterQuantity: '16',
            },
          },
        },
      })

      const report = await computeCapitalGainsReport(userId, 2025, [account.id])
      expect(report.lineItems.map((item) => item.costBaseForeign)).toEqual([
        202, 202,
      ])
      expect(report.lineItems.map((item) => item.acquireDate)).toEqual([
        '2024-01-01',
        '2024-01-01',
      ])
      expect(report.totalCapitalGainGrossAud).toBe(56)
      const { recomputePositionFromTransactions } =
        await import('./position-service.js')
      const recomputed = await recomputePositionFromTransactions(position.id)
      expect(recomputed?.quantity).toBe(12)
      expect(recomputed?.status).toBe('PARTIAL')
      expect(Number(recomputed?.realizedPnL)).toBe(56)
      expect(Number(recomputed?.returnPercentage)).toBeCloseTo((56 / 404) * 100)
      expect(recomputed?.openDate.toISOString()).toBe(
        '2024-01-01T00:00:00.000Z'
      )
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      for (const [openingDate, openingQuantity] of [
        ['2025-07-31', '8'],
        ['2025-08-01', '16'],
      ]) {
        const preview = await previewAccountOpening(userId, account.id, {
          openingDate,
          cashBalances: [{ currency: 'AUD', amount: '100' }],
        })
        expect(preview.parcels).toEqual([
          expect.objectContaining({
            positionId: position.id,
            openingQuantity,
            expectedCurrentQuantity: '12',
          }),
        ])
        expect(preview.cashBalances[0].tradeOnlyEndingAmount).toBe('340')
        expect(
          preview.issues
            .filter((issue) => issue.severity === 'BLOCKING')
            .map((issue) => issue.code)
        ).toEqual(['SPLIT_REPLAY_UNSUPPORTED'])
      }
      const { closePosition, deletePosition, updatePositionAcquisition } =
        await import('./position-mutations.js')
      const transactionsBefore = await prisma.transaction.findMany({
        where: { positionId: position.id },
        orderBy: { id: 'asc' },
      })
      await expect(
        closePosition(userId, position.id, {
          closeDate: new Date('2025-11-01'),
          exitPrice: 70,
          quantity: 1,
        })
      ).rejects.toMatchObject({ status: 409, message: /split history/ })
      await expect(deletePosition(userId, position.id)).rejects.toMatchObject({
        status: 409,
        message: /split history/,
      })
      await expect(
        updatePositionAcquisition(userId, position.id, { quantity: 11 }, {})
      ).rejects.toMatchObject({ status: 409, message: /split history/ })
      expect(
        await prisma.position.findUniqueOrThrow({ where: { id: position.id } })
      ).toEqual(recomputed)
      expect(
        await prisma.transaction.findMany({
          where: { positionId: position.id },
          orderBy: { id: 'asc' },
        })
      ).toEqual(transactionsBefore)
      await updatePositionAcquisition(
        userId,
        position.id,
        {},
        { notes: 'Retained statement evidence' }
      )
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: position.id },
          })
        ).notes
      ).toBe('Retained statement evidence')
      await expect(
        prisma.position.delete({ where: { id: position.id } })
      ).rejects.toThrow()
      await prisma.accountSplitParcelEffect.delete({
        where: {
          actionId_positionId: { actionId: action.id, positionId: position.id },
        },
      })
      await expect(
        computeCapitalGainsReport(userId, 2025, [account.id])
      ).rejects.toThrow('Split action is missing its parcel effect')
      await expect(
        recomputePositionFromTransactions(position.id)
      ).rejects.toThrow('Split action is missing its parcel effect')
      await expect(
        previewAccountOpening(userId, account.id, {
          openingDate: '2025-07-31',
          cashBalances: [{ currency: 'AUD', amount: '100' }],
        })
      ).rejects.toThrow('Split action is missing its parcel effect')
      await prisma.accountSplitParcelEffect.create({
        data: {
          actionId: action.id,
          positionId: position.id,
          beforeQuantity: '8',
          afterQuantity: '16',
        },
      })
    })
  }
)
