import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const tax = vi.hoisted(() => ({ userId: '', result: vi.fn(), pdf: vi.fn() }))
vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: tax.userId, email: 'fixture@example.invalid' }
    next()
  },
}))
vi.mock('../lib/cgt-engine.js', () => ({
  computeCapitalGainsReport: tax.result,
}))
vi.mock('../lib/pdf-report.js', () => ({ buildCapitalGainsPdf: tax.pdf }))

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('../lib/prisma.js').prisma
let lifecycle: typeof import('../lib/trading-account-mutations.js')
let mutations: typeof import('../lib/position-mutations.js')
let app: express.Express
let exchangeId: string | undefined
let userId: string | undefined

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(isDemo = false) {
  if (!userId || !exchangeId)
    throw new Error('Missing disposable lifecycle fixture')
  const account = await prisma.tradingAccount.create({
    data: { userId, name: `Lifecycle fixture ${randomUUID()}`, isDemo },
  })
  const asset = await prisma.asset.create({
    data: {
      exchangeId,
      symbol: `FIXTURE-${randomUUID()}`,
      name: 'Disposable lifecycle asset',
    },
  })
  const data = {
    assetId: asset.id,
    openDate: new Date('2026-01-01'),
    quantity: 10,
    entryPrice: '10',
    buyFees: '2',
    totalBuyValue: '100',
    capitalAllocated: '102',
    transactions: {
      create: {
        type: 'BUY' as const,
        date: new Date('2026-01-01'),
        quantity: 10,
        price: '10',
        totalValue: '100',
        fees: '2',
      },
    },
  }
  return { userId, account, asset, data }
}
function taxResult(accountId: string) {
  return {
    financialYearStartYear: 2025,
    financialYearLabel: 'FY2025-26',
    accountsKey: accountId,
    lineItems: [],
    totalProceedsAud: 0,
    totalCostBaseAud: 0,
    totalCapitalGainGrossAud: 0,
    totalCapitalLossAud: 0,
    carriedForwardLossOpeningAud: 0,
    discountAppliedAud: 0,
    netCapitalGainAud: 0,
    carriedForwardLossClosingAud: 0,
  }
}

describe.skipIf(!enabled)(
  'account lifecycle and trade races on disposable localhost fixtures',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error(
          'Lifecycle integration tests require a localhost database'
        )
      prisma = (await import('../lib/prisma.js')).prisma
      lifecycle = await import('../lib/trading-account-mutations.js')
      mutations = await import('../lib/position-mutations.js')
      userId = (
        await prisma.user.create({
          data: {
            email: `lifecycle-fixture-${randomUUID()}@example.invalid`,
            passwordHash: 'fixture-not-a-login',
          },
        })
      ).id
      tax.userId = userId
      exchangeId = (
        await prisma.exchange.create({
          data: {
            code: `FIXTURE-${randomUUID()}`,
            name: 'Disposable lifecycle fixture',
            currency: 'AUD',
            countryName: 'Australia',
            countryCode: 'AU',
          },
        })
      ).id
      app = express()
      app.use(express.json())
      app.use('/api/tax-reports', (await import('./tax-reports.js')).default)
      app.use(
        (
          error: Error & { status?: number },
          _req: Request,
          res: Response,
          _next: NextFunction
        ) => {
          res
            .status(error.status ?? 500)
            .json({ error: error.name, message: error.message })
        }
      )
    })
    afterEach(() => vi.restoreAllMocks())
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

    it('serializes close versus a new purchase without leaving archived open holdings', async () => {
      const f = await fixture()
      const results = await Promise.allSettled([
        lifecycle.closeTradingAccount(f.userId, f.account.id),
        mutations.createPosition(f.userId, { accountId: f.account.id }, f.data),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === 'rejected')
      ).toHaveLength(1)
      const account = await prisma.tradingAccount.findUniqueOrThrow({
        where: { id: f.account.id },
      })
      const count = await prisma.position.count({
        where: { accountId: account.id },
      })
      expect(account.status === 'CLOSED' ? count === 0 : count === 1).toBe(true)
    })

    it('serializes empty real-account deletion versus a purchase without cascading a successful trade', async () => {
      const f = await fixture()
      const results = await Promise.allSettled([
        lifecycle.deleteTradingAccount(f.userId, f.account.id),
        mutations.createPosition(f.userId, { accountId: f.account.id }, f.data),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      const account = await prisma.tradingAccount.findUnique({
        where: { id: f.account.id },
      })
      expect(
        await prisma.position.count({ where: { accountId: f.account.id } })
      ).toBe(account ? 1 : 0)
      expect(
        await prisma.transaction.count({
          where: { position: { accountId: f.account.id } },
        })
      ).toBe(account ? 1 : 0)
    })
    it('does not reroute a purchase whose explicit account was already deleted', async () => {
      const f = await fixture()
      await lifecycle.deleteTradingAccount(f.userId, f.account.id)
      const before = await prisma.position.count({
        where: { userId: f.userId },
      })
      await expect(
        mutations.createPosition(f.userId, { accountId: f.account.id }, f.data)
      ).rejects.toMatchObject({ status: 404 })
      expect(await prisma.position.count({ where: { userId: f.userId } })).toBe(
        before
      )
    })
    it('serializes moving open holdings into an account versus archiving its destination', async () => {
      const f = await fixture()
      const position = await mutations.createPosition(
        f.userId,
        { accountId: f.account.id },
        f.data
      )
      const target = await prisma.tradingAccount.create({
        data: {
          userId: f.userId,
          name: `Move destination ${randomUUID()}`,
        },
      })
      const results = await Promise.allSettled([
        lifecycle.closeTradingAccount(f.userId, target.id),
        mutations.updatePositionAcquisition(
          f.userId,
          position.id,
          {},
          {},
          target.id
        ),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      const account = await prisma.tradingAccount.findUniqueOrThrow({
        where: { id: target.id },
      })
      const parcel = await prisma.position.findUniqueOrThrow({
        where: { id: position.id },
      })
      expect(
        account.status === 'CLOSED'
          ? parcel.accountId === f.account.id
          : parcel.accountId === target.id
      ).toBe(true)
    })

    it('rejects acquisitions after closure, allows explicit reopen, and protects retained corrections', async () => {
      const f = await fixture()
      const position = await mutations.createPosition(
        f.userId,
        { accountId: f.account.id },
        f.data
      )
      await mutations.closePosition(f.userId, position.id, {
        closeDate: new Date('2026-02-01'),
        exitPrice: 12,
        fees: 1,
      })
      const closed = await lifecycle.closeTradingAccount(f.userId, f.account.id)
      await expect(
        mutations.createPosition(f.userId, { accountId: f.account.id }, f.data)
      ).rejects.toMatchObject({ status: 409 })
      const buy = await prisma.transaction.findFirstOrThrow({
        where: { positionId: position.id, type: 'BUY' },
      })
      await expect(
        mutations.updatePositionAcquisition(
          f.userId,
          position.id,
          { quantity: 12 },
          {}
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(
        (await prisma.transaction.findUniqueOrThrow({ where: { id: buy.id } }))
          .quantity
      ).toBe(10)
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: position.id },
          })
        ).quantity
      ).toBe(0)
      const corrected = await mutations.updatePositionAcquisition(
        f.userId,
        position.id,
        { entryPrice: 11 },
        { notes: 'corrected' }
      )
      expect(corrected.status).toBe('CLOSED')
      expect(corrected.realizedPnL?.toFixed()).toBe('7')
      expect(
        (await lifecycle.closeTradingAccount(f.userId, f.account.id)).closedAt
      ).toEqual(closed.closedAt)
      await lifecycle.reopenTradingAccount(f.userId, f.account.id)
      await expect(
        mutations.createPosition(f.userId, { accountId: f.account.id }, f.data)
      ).resolves.toMatchObject({ accountId: f.account.id })
    })

    it('serializes demo deletion and manual disposal with no orphan transactions', async () => {
      const f = await fixture(true)
      const position = await mutations.createPosition(
        f.userId,
        { accountId: f.account.id },
        f.data
      )
      const results = await Promise.allSettled([
        mutations.closePosition(f.userId, position.id, {
          closeDate: new Date('2026-02-01'),
          exitPrice: 12,
          quantity: 4,
        }),
        lifecycle.deleteTradingAccount(f.userId, f.account.id),
      ])
      expect(results[1].status).toBe('fulfilled')
      expect(
        await prisma.position.findUnique({ where: { id: position.id } })
      ).toBeNull()
      expect(
        await prisma.transaction.count({ where: { positionId: position.id } })
      ).toBe(0)
    })

    it('rejects report creation if its account was deleted during PDF preparation', async () => {
      const f = await fixture()
      tax.result.mockResolvedValue(taxResult(f.account.id))
      const ready = deferred()
      const released = deferred()
      tax.pdf.mockImplementationOnce(async () => {
        ready.resolve()
        await released.promise
        return Buffer.from('%PDF-fixture')
      })
      const pending = request(app)
        .post('/api/tax-reports/generate')
        .send({ financialYearStartYear: 2025, accountIds: [f.account.id] })
        .then((response) => response)
      await ready.promise
      try {
        await lifecycle.deleteTradingAccount(f.userId, f.account.id)
      } finally {
        released.resolve()
      }
      expect((await pending).status).toBe(404)
      expect(
        await prisma.taxReport.count({
          where: { userId: f.userId, accountsKey: f.account.id },
        })
      ).toBe(0)
    })

    it('serializes concurrent report revisions sharing the same account selection', async () => {
      const f = await fixture()
      tax.result.mockResolvedValue(taxResult(f.account.id))
      const ready = deferred()
      const released = deferred()
      let prepared = 0
      tax.pdf.mockImplementation(async () => {
        if (++prepared === 2) ready.resolve()
        await released.promise
        return Buffer.from('%PDF-fixture')
      })
      const generate = () =>
        request(app)
          .post('/api/tax-reports/generate')
          .send({ financialYearStartYear: 2025, accountIds: [f.account.id] })
          .then((response) => response)
      const pending = Promise.all([generate(), generate()])
      await ready.promise
      released.resolve()
      const responses = await pending
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ])
      expect(
        await prisma.taxReport.count({
          where: {
            userId: f.userId,
            accountsKey: f.account.id,
            supersededAt: null,
          },
        })
      ).toBe(1)
    })

    it('blocks account deletion after a report creates its account reference', async () => {
      const f = await fixture()
      tax.result.mockResolvedValue(taxResult(f.account.id))
      tax.pdf.mockResolvedValue(Buffer.from('%PDF-fixture'))
      const response = await request(app)
        .post('/api/tax-reports/generate')
        .send({ financialYearStartYear: 2025, accountIds: [f.account.id] })
      expect(response.status).toBe(200)
      await expect(
        lifecycle.deleteTradingAccount(f.userId, f.account.id)
      ).rejects.toMatchObject({ status: 409, message: /generated tax report/ })
      expect(
        await prisma.tradingAccount.findUnique({ where: { id: f.account.id } })
      ).not.toBeNull()
      expect(
        await prisma.taxReport.count({
          where: { userId: f.userId, accountsKey: f.account.id },
        })
      ).toBe(1)
    })
  }
)
