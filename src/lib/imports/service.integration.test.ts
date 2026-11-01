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

vi.mock('../fx-rates.js', () => ({
  getHistoricalFxRateToAud: vi
    .fn()
    .mockResolvedValue({ rate: 1, source: 'RBA' }),
}))
vi.mock('../historical-drawdown.js', () => ({
  fetchHistoricalMaxDrawdown: vi.fn().mockResolvedValue(null),
  fetchHistoricalMaxRunUp: vi.fn().mockResolvedValue(null),
}))

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('../prisma.js').prisma
let service: typeof import('./service.js')
let mutations: typeof import('../position-mutations.js')
let positions: typeof import('../position-service.js')
let userId: string | undefined
let exchangeId: string
const assetIds: string[] = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  if (!userId) throw new Error('Missing disposable import user')
  const account = await prisma.tradingAccount.create({
    data: { userId, name: `Import locking fixture ${randomUUID()}` },
  })
  const asset = await prisma.asset.create({
    data: {
      exchangeId,
      assetType: 'CRYPTO',
      symbol: `BTC-${randomUUID()}`,
      name: 'Disposable import fixture',
    },
  })
  assetIds.push(asset.id)
  vi.spyOn(positions, 'findOrCreateAsset').mockResolvedValue(asset)
  const position = await prisma.position.create({
    data: {
      userId,
      accountId: account.id,
      assetId: asset.id,
      openDate: new Date('2026-01-01'),
      quantity: 10,
      entryPrice: '10',
      totalBuyValue: '100',
      buyFees: '2',
      capitalAllocated: '102',
      transactions: {
        create: {
          type: 'BUY',
          date: new Date('2026-01-01'),
          quantity: 10,
          price: '10',
          totalValue: '100',
          fees: '2',
        },
      },
    },
  })
  async function batch() {
    const created = await prisma.importBatch.create({
      data: {
        userId: account.userId,
        accountId: account.id,
        source: 'KRAKEN',
        method: 'CSV',
        fileNames: [],
      },
    })
    const sell = await prisma.importedEvent.create({
      data: {
        batchId: created.id,
        userId: account.userId,
        source: 'KRAKEN',
        externalId: `KRAKEN:order:${randomUUID()}`,
        kind: 'SELL',
        occurredAt: new Date('2026-02-01T01:00:00Z'),
        baseAsset: 'BTC',
        quoteCurrency: 'AUD',
        exchangeCode: 'KRAKEN',
        quantity: '6',
        price: '12',
        grossValue: '72',
        fee: '1',
        feeCurrency: 'AUD',
        raw: {},
        resolution: {
          allocations: [{ positionRef: position.id, quantity: '6' }],
        },
      },
    })
    const buy = await prisma.importedEvent.create({
      data: {
        batchId: created.id,
        userId: account.userId,
        source: 'KRAKEN',
        externalId: `KRAKEN:order:${randomUUID()}`,
        kind: 'BUY',
        occurredAt: new Date('2026-03-01T01:00:00Z'),
        baseAsset: 'BTC',
        quoteCurrency: 'AUD',
        exchangeCode: 'KRAKEN',
        quantity: '1',
        price: '10',
        grossValue: '10',
        fee: '0',
        feeCurrency: 'AUD',
        raw: {},
      },
    })
    return { ...created, sell, buy }
  }
  function pausePreparation(arrivals = 1) {
    const ready = deferred()
    const released = deferred()
    let count = 0
    vi.spyOn(positions, 'findOrCreateAsset').mockImplementation(async () => {
      if (++count === arrivals) ready.resolve()
      await released.promise
      return asset
    })
    return { ready: ready.promise, release: released.resolve }
  }
  return { userId, account, asset, position, batch, pausePreparation }
}

describe.skipIf(!enabled)(
  'import financial locking on disposable localhost fixtures',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Import integration tests require a localhost database')
      prisma = (await import('../prisma.js')).prisma
      service = await import('./service.js')
      mutations = await import('../position-mutations.js')
      positions = await import('../position-service.js')
      exchangeId = (
        await prisma.exchange.findUniqueOrThrow({ where: { code: 'KRAKEN' } })
      ).id
      userId = (
        await prisma.user.create({
          data: {
            email: `import-lock-fixture-${randomUUID()}@example.invalid`,
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
        if (assetIds.length)
          await prisma.asset.deleteMany({ where: { id: { in: assetIds } } })
      } finally {
        if (prisma) await prisma.$disconnect()
      }
    })

    it('commits imported parcels, allocated sells, recomputation and event links together', async () => {
      const f = await fixture()
      const batch = await f.batch()
      const result = await service.commitBatch(batch.id, f.userId)
      expect(result.appliedEvents).toBe(2)
      expect(result.createdPositionIds).toHaveLength(1)
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
        include: { transactions: true },
      })
      expect(parcel.quantity).toBe(4)
      expect(parcel.status).toBe('PARTIAL')
      expect(parcel.realizedPnL?.toFixed()).toBe('9.8')
      const imported = await prisma.position.findUniqueOrThrow({
        where: { id: result.createdPositionIds[0] },
        include: { transactions: true },
      })
      expect(imported.transactions.map((row) => row.type)).toEqual(['BUY'])
      expect(
        (
          await prisma.importedEvent.findUniqueOrThrow({
            where: { id: batch.sell.id },
          })
        ).appliedPositionIds
      ).toEqual([parcel.id])
      expect(
        (
          await prisma.importBatch.findUniqueOrThrow({
            where: { id: batch.id },
          })
        ).status
      ).toBe('COMMITTED')
    })

    it.each(['same batch', 'different batches'])(
      'serializes competing imports: %s',
      async (mode) => {
        const f = await fixture()
        const first = await f.batch()
        const second = mode === 'same batch' ? first : await f.batch()
        const paused = f.pausePreparation(2)
        const pending = Promise.allSettled([
          service.commitBatch(first.id, f.userId),
          service.commitBatch(second.id, f.userId),
        ])
        await paused.ready
        paused.release()
        const results = await pending
        expect(
          results.filter((result) => result.status === 'fulfilled')
        ).toHaveLength(1)
        const failure = results.find((result) => result.status === 'rejected')
        expect(failure?.status === 'rejected' && failure.reason).toMatchObject({
          status: 409,
          message: /changed during preparation/,
        })
        const parcel = await prisma.position.findUniqueOrThrow({
          where: { id: f.position.id },
          include: { transactions: true },
        })
        expect(parcel.quantity).toBe(4)
        expect(
          parcel.transactions.filter((row) => row.type === 'SELL')
        ).toHaveLength(1)
        expect(
          await prisma.position.count({ where: { accountId: f.account.id } })
        ).toBe(2)
        if (mode === 'same batch') {
          const retry = await service.commitBatch(first.id, f.userId)
          expect(retry).toEqual({ createdPositionIds: [], appliedEvents: 0 })
        }
      }
    )

    it.each(['sale', 'quantity edit', 'move', 'deletion'])(
      'rejects a stale allocation after a manual %s',
      async (operation) => {
        const f = await fixture()
        const batch = await f.batch()
        const paused = f.pausePreparation()
        const pending = service.commitBatch(batch.id, f.userId)
        const outcome = expect(pending).rejects.toMatchObject({
          status: 409,
          message: /changed during preparation/,
        })
        await paused.ready
        try {
          if (operation === 'sale')
            await mutations.closePosition(f.userId, f.position.id, {
              closeDate: new Date('2026-01-15'),
              exitPrice: 11,
              quantity: 6,
              fees: 0,
            })
          if (operation === 'quantity edit')
            await mutations.updatePositionAcquisition(
              f.userId,
              f.position.id,
              { quantity: 5 },
              {}
            )
          if (operation === 'deletion')
            await mutations.deletePosition(f.userId, f.position.id)
          if (operation === 'move') {
            const target = await prisma.tradingAccount.create({
              data: {
                userId: f.userId,
                name: `Import move fixture ${randomUUID()}`,
              },
            })
            await mutations.updatePositionAcquisition(
              f.userId,
              f.position.id,
              {},
              {},
              target.id
            )
          }
        } finally {
          paused.release()
        }
        await outcome
        expect(
          await prisma.transaction.count({
            where: { brokerRef: batch.sell.externalId },
          })
        ).toBe(0)
        expect(
          (
            await prisma.importedEvent.findUniqueOrThrow({
              where: { id: batch.sell.id },
            })
          ).status
        ).toBe('PENDING')
      }
    )

    it.each(['resolution', 'discard'])(
      'rejects a stale plan after %s changes',
      async (operation) => {
        const f = await fixture()
        const batch = await f.batch()
        const paused = f.pausePreparation()
        const pending = service.commitBatch(batch.id, f.userId)
        const outcome = expect(pending).rejects.toMatchObject({ status: 409 })
        await paused.ready
        try {
          if (operation === 'resolution')
            await service.saveResolution(batch.id, batch.sell.id, f.userId, {
              closeReason: 'TARGET',
            })
          else await service.discardBatch(batch.id, f.userId)
        } finally {
          paused.release()
        }
        await outcome
        expect(
          await prisma.position.count({ where: { accountId: f.account.id } })
        ).toBe(1)
        expect(
          await prisma.transaction.count({
            where: { brokerRef: batch.sell.externalId },
          })
        ).toBe(0)
      }
    )

    it('rolls back all import writes if parcel recomputation fails', async () => {
      const f = await fixture()
      const batch = await f.batch()
      vi.spyOn(
        positions,
        'recomputePositionFromTransactions'
      ).mockRejectedValueOnce(new Error('Injected import recompute failure'))
      await expect(service.commitBatch(batch.id, f.userId)).rejects.toThrow(
        'Injected import'
      )
      expect(
        await prisma.position.count({ where: { accountId: f.account.id } })
      ).toBe(1)
      expect(
        await prisma.transaction.count({
          where: { positionId: f.position.id, type: 'SELL' },
        })
      ).toBe(0)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: f.position.id },
          })
        ).quantity
      ).toBe(10)
      expect(
        await prisma.importedEvent.count({
          where: { batchId: batch.id, status: 'PENDING' },
        })
      ).toBe(2)
      expect(
        (
          await prisma.importBatch.findUniqueOrThrow({
            where: { id: batch.id },
          })
        ).status
      ).toBe('PENDING_REVIEW')
    })

    it('does not let a manual close oversell after waiting for an import', async () => {
      const f = await fixture()
      const batch = await f.batch()
      const locked = deferred()
      const released = deferred()
      const recompute = positions.recomputePositionFromTransactions
      vi.spyOn(
        positions,
        'recomputePositionFromTransactions'
      ).mockImplementationOnce(async (...args) => {
        const result = await recompute(...args)
        locked.resolve()
        await released.promise
        return result
      })
      const pending = service.commitBatch(batch.id, f.userId)
      await locked.promise
      let closing: Promise<unknown>
      try {
        closing = mutations.closePosition(f.userId, f.position.id, {
          closeDate: new Date('2026-04-01'),
          quantity: 6,
          exitPrice: 12,
          fees: 0,
        })
      } finally {
        released.resolve()
      }
      await pending
      await expect(closing).rejects.toMatchObject({ status: 400 })
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: f.position.id },
        include: { transactions: true },
      })
      expect(parcel.quantity).toBe(4)
      expect(
        parcel.transactions.filter((row) => row.type === 'SELL')
      ).toHaveLength(1)
    })

    it('rechecks account eligibility at commit but still permits review and discard', async () => {
      const f = await fixture()
      const batch = await f.batch()
      const paused = f.pausePreparation()
      const pending = service.commitBatch(batch.id, f.userId)
      const outcome = expect(pending).rejects.toMatchObject({
        status: 400,
        message: /active, non-demo/,
      })
      await paused.ready
      try {
        await prisma.tradingAccount.update({
          where: { id: f.account.id },
          data: { status: 'CLOSED' },
        })
      } finally {
        paused.release()
      }
      await outcome
      await service.saveResolution(batch.id, batch.sell.id, f.userId, {
        skip: true,
      })
      await service.discardBatch(batch.id, f.userId)
      expect(
        (
          await prisma.importBatch.findUniqueOrThrow({
            where: { id: batch.id },
          })
        ).status
      ).toBe('DISCARDED')
      expect(
        await prisma.position.count({ where: { accountId: f.account.id } })
      ).toBe(1)
    })

    it('merges concurrent review changes without losing either field', async () => {
      const f = await fixture()
      const batch = await f.batch()
      await Promise.all([
        service.saveResolution(batch.id, batch.sell.id, f.userId, {
          closeReason: 'TARGET',
        }),
        service.saveResolution(batch.id, batch.sell.id, f.userId, {
          skip: true,
        }),
      ])
      expect(
        (
          await prisma.importedEvent.findUniqueOrThrow({
            where: { id: batch.sell.id },
          })
        ).resolution
      ).toMatchObject({ closeReason: 'TARGET', skip: true })
    })
  }
)
