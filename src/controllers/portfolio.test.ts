import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findExchangeUniqueMock,
  findSnapshotManyMock,
  findTradingAccountFirstMock,
  findPositionManyMock,
  upsertSnapshotMock,
  computeSnapshotValuesMock,
} = vi.hoisted(() => ({
  findExchangeUniqueMock: vi.fn(),
  findSnapshotManyMock: vi.fn(),
  findTradingAccountFirstMock: vi.fn(),
  findPositionManyMock: vi.fn(),
  upsertSnapshotMock: vi.fn(),
  computeSnapshotValuesMock: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/portfolio-calc.js', () => ({
  computeSnapshotValues: computeSnapshotValuesMock,
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    exchange: {
      findUnique: findExchangeUniqueMock,
    },
    portfolioSnapshot: {
      findMany: findSnapshotManyMock,
      upsert: upsertSnapshotMock,
    },
    tradingAccount: {
      findFirst: findTradingAccountFirstMock,
    },
    position: {
      findMany: findPositionManyMock,
    },
  },
}))

import portfolioRouter from './portfolio.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/portfolio', portfolioRouter)
  return app
}

describe('portfolio controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    computeSnapshotValuesMock.mockReturnValue({
      totalInvested: 1000,
      totalPnL: 150,
      totalValue: 1150,
      totalReturnPct: 15,
    })
  })

  it('returns empty history when exchange is unknown', async () => {
    findExchangeUniqueMock.mockResolvedValue(null)

    const response = await request(createApp()).get(
      '/api/portfolio/history?accountId=acc1&exchangeCode=UNKNOWN'
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, data: [] })
  })

  it('returns ordered history snapshots when exchange exists', async () => {
    findExchangeUniqueMock.mockResolvedValue({ id: 'ex1' })
    findSnapshotManyMock.mockResolvedValue([
      { date: '2026-05-01', totalValue: 1000 },
      { date: '2026-05-02', totalValue: 1200 },
    ])

    const response = await request(createApp()).get(
      '/api/portfolio/history?accountId=acc1&exchangeCode=ASX'
    )

    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(2)
    expect(findSnapshotManyMock).toHaveBeenCalledWith({
      where: {
        userId: 'u_1',
        accountId: 'acc1',
        exchangeId: 'ex1',
      },
      orderBy: { date: 'asc' },
    })
  })

  it('returns 404 when account does not exist for snapshot', async () => {
    findTradingAccountFirstMock.mockResolvedValue(null)
    findExchangeUniqueMock.mockResolvedValue({ id: 'ex1' })

    const response = await request(createApp())
      .post('/api/portfolio/snapshot')
      .send({ accountId: 'acc1', exchangeCode: 'ASX' })

    expect(response.status).toBe(404)
    expect(response.body.message).toContain('Trading account not found')
  })

  it('returns 404 when exchange does not exist for snapshot', async () => {
    findTradingAccountFirstMock.mockResolvedValue({ id: 'acc1' })
    findExchangeUniqueMock.mockResolvedValue(null)

    const response = await request(createApp())
      .post('/api/portfolio/snapshot')
      .send({ accountId: 'acc1', exchangeCode: 'MISSING' })

    expect(response.status).toBe(404)
    expect(response.body.message).toContain("Exchange 'MISSING' not found")
  })

  it('upserts snapshot from computed totals', async () => {
    findTradingAccountFirstMock.mockResolvedValue({ id: 'acc1' })
    findExchangeUniqueMock.mockResolvedValue({ id: 'ex1' })
    findPositionManyMock
      .mockResolvedValueOnce([
        { capitalAllocated: 1000, unrealizedPnL: 100 },
        { capitalAllocated: 500, unrealizedPnL: 50 },
      ])
      .mockResolvedValueOnce([{ realizedPnL: 25 }])
    upsertSnapshotMock.mockResolvedValue({
      id: 'snap1',
      totalValue: 1150,
    })

    const response = await request(createApp())
      .post('/api/portfolio/snapshot')
      .send({ accountId: 'acc1', exchangeCode: 'ASX' })

    expect(response.status).toBe(200)
    expect(computeSnapshotValuesMock).toHaveBeenCalledWith(
      [
        { capitalAllocated: 1000, unrealizedPnL: 100 },
        { capitalAllocated: 500, unrealizedPnL: 50 },
      ],
      [{ realizedPnL: 25 }]
    )
    expect(upsertSnapshotMock).toHaveBeenCalledTimes(1)
    expect(response.body.success).toBe(true)
  })
})
