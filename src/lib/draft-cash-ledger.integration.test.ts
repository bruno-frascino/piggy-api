import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('./prisma.js').prisma
let userId: string | undefined
let exchangeId: string | undefined

async function fixture(amount = '100', withTrade = false) {
  if (!userId) throw new Error('Missing isolated cash fixture')
  const account = await prisma.tradingAccount.create({
    data: { userId, name: `Cash fixture ${randomUUID()}` },
  })
  let transactionId: string | undefined
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
