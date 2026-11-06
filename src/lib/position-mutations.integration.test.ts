import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('./prisma.js').prisma
let userId: string | undefined
let exchangeId: string | undefined
let positionService: typeof import('./position-service.js')
let closePosition: typeof import('./position-mutations.js').closePosition
let updateCloseEvent: typeof import('./position-mutations.js').updateCloseEvent
let deletePosition: typeof import('./position-mutations.js').deletePosition
let createPosition: typeof import('./position-mutations.js').createPosition
let updatePositionAcquisition: typeof import('./position-mutations.js').updatePositionAcquisition

async function fixture() {
  if (!userId || !exchangeId)
    throw new Error('Missing disposable financial-write fixture')
  const account = await prisma.tradingAccount.create({
    data: { userId, name: `Atomic parcel fixture ${randomUUID()}` },
  })
  const asset = await prisma.asset.create({
    data: {
      exchangeId,
      symbol: `FIXTURE-${randomUUID()}`,
      name: 'Disposable parcel test asset',
    },
  })
  const position = await prisma.position.create({
    data: {
      userId,
      accountId: account.id,
      assetId: asset.id,
      openDate: new Date('2026-10-02T00:00:00Z'),
      entryPrice: '10',
      quantity: 10,
      totalBuyValue: '100',
      buyFees: '2',
      capitalAllocated: '102',
      transactions: {
        create: {
          type: 'BUY',
          date: new Date('2026-10-02T00:00:00Z'),
          quantity: 10,
          price: '10',
          totalValue: '100',
          fees: '2',
        },
      },
    },
    include: { transactions: true },
  })
  return { userId, account, position }
}
const input = {
  closeDate: new Date('2026-10-03T00:00:00Z'),
  exitPrice: 12,
  quantity: 6,
  fees: 1,
}

describe.skipIf(!enabled)(
  'atomic manual disposals on disposable localhost fixtures',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error(
          'Financial-write integration tests require a localhost database'
        )
      prisma = (await import('./prisma.js')).prisma
      positionService = await import('./position-service.js')
      const mutations = await import('./position-mutations.js')
      closePosition = mutations.closePosition
      updateCloseEvent = mutations.updateCloseEvent
      deletePosition = mutations.deletePosition
      createPosition = mutations.createPosition
      updatePositionAcquisition = mutations.updatePositionAcquisition
      userId = (
        await prisma.user.create({
          data: {
            email: `parcel-write-fixture-${randomUUID()}@example.invalid`,
            passwordHash: 'fixture-not-a-login',
          },
        })
      ).id
      exchangeId = (
        await prisma.exchange.create({
          data: {
            code: `FIXTURE-${randomUUID()}`,
            name: 'Disposable parcel fixture',
            currency: 'AUD',
            countryName: 'Australia',
            countryCode: 'AU',
          },
        })
      ).id
    })
    afterAll(async () => {
      vi.restoreAllMocks()
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
    it('serializes competing partial sells: one succeeds, one sees the new remaining inventory', async () => {
      const f = await fixture()
      const results = await Promise.allSettled([
        closePosition(f.userId, f.position.id, input),
        closePosition(f.userId, f.position.id, input),
      ])
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      const rejected = results.find((row) => row.status === 'rejected')
      if (!rejected || rejected.status !== 'rejected')
        throw new Error('Expected one rejected oversell')
      expect(rejected.reason).toMatchObject({ status: 400 })
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
        include: { transactions: true },
      })
      expect(
        parcel.transactions.filter((row) => row.type === 'SELL')
      ).toHaveLength(1)
      expect(parcel.quantity).toBe(4)
      expect(parcel.status).toBe('PARTIAL')
      expect(parcel.realizedPnL?.toFixed()).toBe('9.8')
    })
    async function stagedFixture() {
      const f = await fixture()
      const closed = await closePosition(f.userId, f.position.id, input)
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const { saveOpeningStatement } = await import('./opening-statements.js')
      const opening = {
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '1000' }],
      }
      const preview = await previewAccountOpening(
        f.userId,
        f.account.id,
        opening
      )
      const saved = await saveOpeningStatement(f.userId, f.account.id, {
        ...opening,
        sourceFingerprint: preview.sourceFingerprint,
      })
      const sell = closed.transactions.find((row) => row.type === 'SELL')
      if (!sell) throw new Error('Missing fixture disposal')
      return { ...f, sell, statementId: saved.statement.id }
    }
    it('protects linked manual trades from financial edits, moves and deletion, even after cash reversal', async () => {
      const f = await stagedFixture()
      const { saveDraftManualExecutionCash } =
        await import('./draft-cash-ledger.js')
      const staged = await saveDraftManualExecutionCash(
        f.userId,
        f.account.id,
        f.statementId,
        f.sell.id,
        1
      )
      const before = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
        include: { transactions: { orderBy: { id: 'asc' } } },
      })
      const destination = await prisma.tradingAccount.create({
        data: { userId: f.userId, name: `Destination ${randomUUID()}` },
      })
      for (const edit of [
        () => updateCloseEvent(f.userId, f.sell.id, { exitPrice: 13 }),
        () =>
          updatePositionAcquisition(
            f.userId,
            f.position.id,
            { buyFees: 3 },
            {}
          ),
        () =>
          updatePositionAcquisition(
            f.userId,
            f.position.id,
            {},
            {},
            destination.id
          ),
        () => deletePosition(f.userId, f.position.id),
      ])
        await expect(edit()).rejects.toMatchObject({
          status: 409,
          message: /coordinated trade\/cash correction/,
        })
      // Reversed cash still reserves the source identity; legacy editors must not bypass it.
      const { prepareCashRevision, prepareRevisionLegs } =
        await import('./cash-revisions.js')
      const { prepareCashCommand } = await import('./cash-ledger.js')
      const operation = await prisma.draftCashOperation.findUniqueOrThrow({
        where: { id: staged.operationId },
      })
      const revision = prepareCashRevision({
        idempotencyKey: 'fixture-reversal',
        expectedRevisionId: staged.operationId,
        reason: 'Existing reversed audit fixture',
        replacement: null,
      })
      const legs = prepareRevisionLegs(
        prepareCashCommand(operation.command).command,
        null
      )
      await prisma.draftCashRevision.create({
        data: {
          statementId: f.statementId,
          operationId: staged.operationId,
          revisionNumber: 1,
          idempotencyKey: revision.request.idempotencyKey,
          payloadHash: revision.payloadHash,
          reason: revision.request.reason,
          request: { ...revision.request },
          postings: {
            create: legs.map((leg, legIndex) => ({ ...leg, legIndex })),
          },
        },
      })
      await expect(
        updateCloseEvent(f.userId, f.sell.id, { sellFees: 2 })
      ).rejects.toMatchObject({ status: 409 })
      expect(
        await prisma.position.findUniqueOrThrow({
          where: { id: f.position.id },
          include: { transactions: { orderBy: { id: 'asc' } } },
        })
      ).toEqual(before)
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
      ).toBe(1)
    })
    it.each(['edit', 'delete', 'move'] as const)(
      'serializes cash staging against a legacy %s without allowing both changes',
      async (action) => {
        const f = await stagedFixture()
        const { saveDraftManualExecutionCash } =
          await import('./draft-cash-ledger.js')
        const destination = await prisma.tradingAccount.create({
          data: { userId: f.userId, name: `Race destination ${randomUUID()}` },
        })
        const mutate =
          action === 'edit'
            ? () => updateCloseEvent(f.userId, f.sell.id, { exitPrice: 13 })
            : action === 'delete'
              ? () => deletePosition(f.userId, f.position.id)
              : () =>
                  updatePositionAcquisition(
                    f.userId,
                    f.position.id,
                    {},
                    {},
                    destination.id
                  )
        const results = await Promise.allSettled([
          saveDraftManualExecutionCash(
            f.userId,
            f.account.id,
            f.statementId,
            f.sell.id,
            1
          ),
          mutate(),
        ])
        expect(
          results.filter((row) => row.status === 'fulfilled')
        ).toHaveLength(1)
        const operationCount = await prisma.draftCashOperation.count({
          where: { statementId: f.statementId },
        })
        if (results[0].status === 'fulfilled') {
          expect(operationCount).toBe(1)
          const sell = await prisma.transaction.findUniqueOrThrow({
            where: { id: f.sell.id },
            include: { position: true },
          })
          expect(sell.price.toFixed()).toBe('12')
          expect(sell.position.accountId).toBe(f.account.id)
        } else {
          expect(operationCount).toBe(0)
          expect(
            await prisma.draftOperationTradeLink.count({
              where: { statementId: f.statementId },
            })
          ).toBe(0)
        }
      }
    )
    it('preserves imported BUY/SELL values while allowing notes and unchanged financial fields', async () => {
      const f = await stagedFixture()
      const buy = f.position.transactions[0]
      await prisma.position.update({
        where: { id: f.position.id },
        data: { origin: 'IMPORT_TRADE' },
      })
      await prisma.transaction.update({
        where: { id: buy.id },
        data: { brokerRef: 'KRAKEN:order:buy-fixture' },
      })
      await prisma.transaction.update({
        where: { id: f.sell.id },
        data: { brokerRef: 'KRAKEN:order:sell-fixture' },
      })
      await expect(
        updatePositionAcquisition(
          f.userId,
          f.position.id,
          { entryPrice: 11 },
          {}
        )
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        updateCloseEvent(f.userId, f.sell.id, { sellFees: 2 })
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        deletePosition(f.userId, f.position.id)
      ).rejects.toMatchObject({ status: 409 })
      await updatePositionAcquisition(
        f.userId,
        f.position.id,
        {
          openDate: f.position.openDate,
          entryPrice: 10,
          quantity: 10,
          buyFees: 2,
        },
        { notes: 'Reviewed import' },
        f.account.id
      )
      await updateCloseEvent(f.userId, f.sell.id, {
        closeDate: f.sell.date,
        exitPrice: 12,
        sellFees: 1,
        notes: 'Reviewed allocation',
      })
      const rows = await prisma.transaction.findMany({
        where: { positionId: f.position.id },
        orderBy: { type: 'asc' },
      })
      expect(rows.find((row) => row.id === buy.id)).toMatchObject({
        price: buy.price,
        totalValue: buy.totalValue,
        fees: buy.fees,
        date: buy.date,
      })
      expect(rows.find((row) => row.id === f.sell.id)).toMatchObject({
        price: f.sell.price,
        totalValue: f.sell.totalValue,
        fees: f.sell.fees,
        date: f.sell.date,
        notes: 'Reviewed allocation',
      })
    })
    it('creates a parcel with exactly one nested BUY and rolls back account creation if the parcel write fails', async () => {
      const f = await fixture()
      const created = await createPosition(
        f.userId,
        { accountId: f.account.id },
        {
          assetId: f.position.assetId,
          openDate: input.closeDate,
          entryPrice: 5,
          quantity: 2,
          totalBuyValue: 10,
          capitalAllocated: 11,
          buyFees: 1,
          transactions: {
            create: {
              type: 'BUY',
              date: input.closeDate,
              price: 5,
              quantity: 2,
              totalValue: 10,
              fees: 1,
            },
          },
        }
      )
      expect(created.transactions).toHaveLength(1)
      expect(created.transactions[0].type).toBe('BUY')
      expect(created.accountId).toBe(f.account.id)
      const accountName = `Failed creation ${randomUUID()}`
      await expect(
        createPosition(
          f.userId,
          { accountName },
          {
            assetId: 'missing-asset',
            openDate: input.closeDate,
            entryPrice: 5,
            quantity: 2,
            totalBuyValue: 10,
            capitalAllocated: 10,
          }
        )
      ).rejects.toMatchObject({ code: 'P2003' })
      expect(
        await prisma.tradingAccount.count({
          where: { userId: f.userId, name: accountName },
        })
      ).toBe(0)
    })
    it('recomputes realised gains after an acquisition cost change and rejects reducing units below sold inventory', async () => {
      const f = await fixture()
      await closePosition(f.userId, f.position.id, input)
      await updatePositionAcquisition(
        f.userId,
        f.position.id,
        { entryPrice: 11, buyFees: 3 },
        {}
      )
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
        include: { transactions: true },
      })
      expect(parcel.realizedPnL?.toFixed()).toBe('3.2')
      expect(parcel.quantity).toBe(4)
      expect(parcel.totalBuyValue.toFixed()).toBe('110')
      const buy = parcel.transactions.find((row) => row.type === 'BUY')
      expect(buy?.totalValue.toFixed()).toBe('110')
      await expect(
        updatePositionAcquisition(f.userId, f.position.id, { quantity: 5 }, {})
      ).rejects.toThrow('already sold')
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: f.position.id },
          })
        ).quantity
      ).toBe(4)
    })
    it('rolls back BUY and parcel changes together when acquisition recompute fails', async () => {
      const f = await fixture()
      const recompute = vi
        .spyOn(positionService, 'recomputePositionFromTransactions')
        .mockRejectedValueOnce(new Error('Injected acquisition failure'))
      try {
        await expect(
          updatePositionAcquisition(
            f.userId,
            f.position.id,
            { entryPrice: 11, quantity: 12 },
            {}
          )
        ).rejects.toThrow('Injected acquisition failure')
      } finally {
        recompute.mockRestore()
      }
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
        include: { transactions: true },
      })
      expect(parcel.entryPrice.toFixed()).toBe('10')
      expect(parcel.quantity).toBe(10)
      expect(parcel.transactions[0].quantity).toBe(10)
      expect(parcel.transactions[0].price.toFixed()).toBe('10')
    })
    it('serializes a bought-quantity reduction with a competing close and never leaves oversold inventory', async () => {
      const f = await fixture()
      const results = await Promise.allSettled([
        updatePositionAcquisition(f.userId, f.position.id, { quantity: 5 }, {}),
        closePosition(f.userId, f.position.id, input),
      ])
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
        include: { transactions: true },
      })
      const bought = parcel.transactions
        .filter((row) => row.type === 'BUY')
        .reduce((sum, row) => sum + row.quantity, 0)
      const sold = parcel.transactions
        .filter((row) => row.type === 'SELL')
        .reduce((sum, row) => sum + row.quantity, 0)
      expect(sold).toBeLessThanOrEqual(bought)
      expect(parcel.quantity).toBe(bought - sold)
    })
    it('moves parcels in opposite directions without deadlocks and rechecks demo boundaries', async () => {
      const a = await fixture()
      const b = await fixture()
      const results = await Promise.allSettled([
        updatePositionAcquisition(
          a.userId,
          a.position.id,
          {},
          {},
          b.account.id
        ),
        updatePositionAcquisition(
          b.userId,
          b.position.id,
          {},
          {},
          a.account.id
        ),
      ])
      expect(results.every((row) => row.status === 'fulfilled')).toBe(true)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: a.position.id },
          })
        ).accountId
      ).toBe(b.account.id)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: b.position.id },
          })
        ).accountId
      ).toBe(a.account.id)
      const demo = await prisma.tradingAccount.create({
        data: {
          userId: a.userId,
          name: `Demo ${randomUUID()}`,
          isDemo: true,
        },
      })
      await expect(
        updatePositionAcquisition(a.userId, a.position.id, {}, {}, demo.id)
      ).rejects.toThrow('demo and real')
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: a.position.id },
          })
        ).accountId
      ).toBe(b.account.id)
    })
    it('concurrent full closes create only one disposal and keep exactly zero remaining units', async () => {
      const f = await fixture()
      const { quantity: _quantity, ...full } = input
      const results = await Promise.allSettled([
        closePosition(f.userId, f.position.id, full),
        closePosition(f.userId, f.position.id, full),
      ])
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1
      )
      expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1)
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
      })
      expect(parcel.quantity).toBe(0)
      expect(parcel.status).toBe('CLOSED')
      expect(
        await prisma.transaction.count({
          where: { positionId: f.position.id, type: 'SELL' },
        })
      ).toBe(1)
    })
    it('rolls back a new SELL when recomputing the parcel fails after creating the transaction', async () => {
      const f = await fixture()
      const recompute = vi
        .spyOn(positionService, 'recomputePositionFromTransactions')
        .mockRejectedValueOnce(new Error('Injected parcel recompute failure'))
      try {
        await expect(
          closePosition(f.userId, f.position.id, input)
        ).rejects.toThrow('Injected parcel recompute failure')
      } finally {
        recompute.mockRestore()
      }
      expect(
        await prisma.transaction.count({
          where: { positionId: f.position.id, type: 'SELL' },
        })
      ).toBe(0)
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
      })
      expect(parcel.quantity).toBe(10)
      expect(parcel.status).toBe('OPEN')
      expect(parcel.totalSellValue).toBeNull()
    })
    it('rolls back a sale correction on recompute failure, then updates cash-independent parcel P&L atomically', async () => {
      const f = await fixture()
      const closed = await closePosition(f.userId, f.position.id, input)
      const sell = closed.transactions.find((row) => row.type === 'SELL')
      if (!sell) throw new Error('Missing fixture disposal')
      const recompute = vi
        .spyOn(positionService, 'recomputePositionFromTransactions')
        .mockRejectedValueOnce(new Error('Injected correction failure'))
      try {
        await expect(
          updateCloseEvent(f.userId, sell.id, { exitPrice: 13, sellFees: 2 })
        ).rejects.toThrow('Injected correction failure')
      } finally {
        recompute.mockRestore()
      }
      const original = await prisma.transaction.findUniqueOrThrow({
        where: { id: sell.id },
      })
      expect(original.price.toFixed()).toBe('12')
      expect(original.fees.toFixed()).toBe('1')
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: f.position.id },
          })
        ).realizedPnL?.toFixed()
      ).toBe('9.8')
      await updateCloseEvent(f.userId, sell.id, { exitPrice: 13, sellFees: 2 })
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
      })
      expect(parcel.realizedPnL?.toFixed()).toBe('14.8')
      expect(parcel.quantity).toBe(4)
      expect(parcel.totalSellValue?.toFixed()).toBe('78')
    })
    it('serializes deletion and sale without leaving a detached transaction or partially closed parcel', async () => {
      const f = await fixture()
      const results = await Promise.allSettled([
        deletePosition(f.userId, f.position.id),
        closePosition(f.userId, f.position.id, input),
      ])
      expect(results[0].status).toBe('fulfilled')
      expect(
        await prisma.position.count({ where: { id: f.position.id } })
      ).toBe(0)
      expect(
        await prisma.transaction.count({ where: { positionId: f.position.id } })
      ).toBe(0)
    })
    it('retains inactive statement and cash source snapshots when a legacy parcel is deleted', async () => {
      const f = await fixture()
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const { saveOpeningStatement } = await import('./opening-statements.js')
      const { saveDraftCashOperation } = await import('./draft-cash-ledger.js')
      const opening = {
        openingDate: '2026-10-02',
        cashBalances: [{ currency: 'AUD', amount: '100' }],
      }
      const preview = await previewAccountOpening(
        f.userId,
        f.account.id,
        opening
      )
      const saved = await saveOpeningStatement(f.userId, f.account.id, {
        ...opening,
        sourceFingerprint: preview.sourceFingerprint,
      })
      const closed = await closePosition(f.userId, f.position.id, input)
      // Source changed: staging on the old opening revision is refused, never silently updated.
      await expect(
        saveDraftCashOperation(f.userId, saved.statement.id, {
          accountId: f.account.id,
          kind: 'DEPOSIT',
          idempotencyKey: 'funding',
          source: { origin: 'MANUAL', reference: 'funding' },
          effectiveDate: '2026-10-04',
          sequence: 1,
          cash: { currency: 'AUD', amount: '10' },
        })
      ).rejects.toThrow('source records have changed')
      expect(closed.quantity).toBe(4)
      await deletePosition(f.userId, f.position.id)
      expect(
        await prisma.openingParcelBalance.count({
          where: { statementId: saved.statement.id, positionId: f.position.id },
        })
      ).toBe(1)
      expect(
        await prisma.accountOpeningStatement.count({
          where: { id: saved.statement.id, state: 'DRAFT' },
        })
      ).toBe(1)
      expect(
        await prisma.draftCashOperation.count({
          where: { statementId: saved.statement.id },
        })
      ).toBe(0)
    })
    it('ownership-checks close, sale edits and deletion without changing another user’s parcel', async () => {
      const f = await fixture()
      await expect(
        closePosition('not-owner', f.position.id, input)
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        deletePosition('not-owner', f.position.id)
      ).rejects.toMatchObject({ status: 404 })
      const closed = await closePosition(f.userId, f.position.id, input)
      const sell = closed.transactions.find((row) => row.type === 'SELL')
      if (!sell) throw new Error('Missing fixture sale')
      await expect(
        updateCloseEvent('not-owner', sell.id, { exitPrice: 99 })
      ).rejects.toMatchObject({ status: 404 })
      expect(
        (
          await prisma.transaction.findUniqueOrThrow({ where: { id: sell.id } })
        ).price.toFixed()
      ).toBe('12')
    })
  }
)
