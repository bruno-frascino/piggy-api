import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  transactionFindManyMock,
  transactionCountMock,
  positionFindManyMock,
  snapshotFindManyMock,
} = vi.hoisted(() => ({
  transactionFindManyMock: vi.fn(),
  transactionCountMock: vi.fn(),
  positionFindManyMock: vi.fn(),
  snapshotFindManyMock: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: transactionFindManyMock,
      count: transactionCountMock,
    },
    position: {
      findMany: positionFindManyMock,
    },
    portfolioSnapshot: {
      findMany: snapshotFindManyMock,
    },
  },
}))

import statisticsRouter from './statistics.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/statistics', statisticsRouter)
  return app
}

describe('statistics controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transactionCountMock.mockResolvedValue(0)
    positionFindManyMock.mockResolvedValue([])
    transactionFindManyMock.mockResolvedValue([])
    snapshotFindManyMock.mockResolvedValue([])
  })

  describe('GET /api/statistics/summary', () => {
    it('returns summary metrics for the selected scope', async () => {
      transactionFindManyMock.mockResolvedValue([
        {
          id: 'tx_1',
          quantity: 2,
          price: 120,
          fees: 2,
          date: new Date('2026-02-01T00:00:00.000Z'),
          position: {
            id: 'p_1',
            accountId: 'acc_1',
            quantity: 5,
            entryPrice: 100,
            buyFees: 5,
            openDate: new Date('2026-01-01T00:00:00.000Z'),
            asset: {
              symbol: 'AAPL',
              exchange: { code: 'NASDAQ', currency: 'USD' },
            },
          },
        },
      ])
      positionFindManyMock.mockResolvedValue([{ unrealizedPnL: 10.5 }])

      const response = await request(createApp()).get(
        '/api/statistics/summary?accountIds=acc_1&exchangeCodes=NASDAQ'
      )

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data.totalTrades).toBe(1)
      expect(response.body.data.realizedPnL).toBeGreaterThan(0)
      expect(response.body.data.unrealizedPnL).toBe(10.5)
      expect(response.body.data.metricDefinitionVersion).toBe('stats-v1')
      expect(transactionFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'SELL',
          }),
        })
      )
    })

    it('returns validation errors for invalid asset types', async () => {
      const response = await request(createApp()).get(
        '/api/statistics/summary?assetTypes=INVALID'
      )

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Validation Error')
    })
  })

  describe('GET /api/statistics/timeseries', () => {
    it('returns bucketed points for equity metric', async () => {
      snapshotFindManyMock.mockResolvedValue([
        {
          date: new Date('2026-01-01T00:00:00.000Z'),
          totalValue: 1000,
          totalPnL: 100,
        },
        {
          date: new Date('2026-01-15T00:00:00.000Z'),
          totalValue: 1050,
          totalPnL: 120,
        },
      ])

      const response = await request(createApp()).get(
        '/api/statistics/timeseries?metric=equity&granularity=month'
      )

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data.points).toHaveLength(1)
      expect(response.body.data.points[0].value).toBe(1050)
    })

    it('returns validation error for missing metric', async () => {
      const response = await request(createApp()).get(
        '/api/statistics/timeseries'
      )

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Validation Error')
    })
  })

  describe('GET /api/statistics/closed-trades', () => {
    it('returns paginated rows and meta', async () => {
      transactionFindManyMock.mockResolvedValue([
        {
          id: 'tx_1',
          quantity: 1,
          price: 110,
          fees: 1,
          date: new Date('2026-02-01T00:00:00.000Z'),
          position: {
            id: 'p_1',
            accountId: 'acc_1',
            quantity: 1,
            entryPrice: 100,
            buyFees: 0,
            openDate: new Date('2026-01-01T00:00:00.000Z'),
            asset: {
              symbol: 'BHP.AX',
              exchange: { code: 'ASX', currency: 'AUD' },
            },
          },
        },
      ])
      transactionCountMock.mockResolvedValue(1)

      const response = await request(createApp()).get(
        '/api/statistics/closed-trades?limit=10&offset=0'
      )

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0]).toMatchObject({
        symbol: 'BHP.AX',
        exchangeCode: 'ASX',
        currency: 'AUD',
      })
      expect(response.body.meta).toEqual({ total: 1, limit: 10, offset: 0 })
    })

    it('sorts by pnl ascending when requested', async () => {
      transactionFindManyMock.mockResolvedValue([
        {
          id: 'tx_1',
          quantity: 1,
          price: 95,
          fees: 0,
          date: new Date('2026-02-02T00:00:00.000Z'),
          position: {
            id: 'p_1',
            accountId: 'acc_1',
            quantity: 1,
            entryPrice: 100,
            buyFees: 0,
            openDate: new Date('2026-01-01T00:00:00.000Z'),
            asset: {
              symbol: 'AAPL',
              exchange: { code: 'NASDAQ', currency: 'USD' },
            },
          },
        },
        {
          id: 'tx_2',
          quantity: 1,
          price: 110,
          fees: 0,
          date: new Date('2026-02-01T00:00:00.000Z'),
          position: {
            id: 'p_2',
            accountId: 'acc_1',
            quantity: 1,
            entryPrice: 100,
            buyFees: 0,
            openDate: new Date('2026-01-01T00:00:00.000Z'),
            asset: {
              symbol: 'MSFT',
              exchange: { code: 'NASDAQ', currency: 'USD' },
            },
          },
        },
      ])

      const response = await request(createApp()).get(
        '/api/statistics/closed-trades?sortBy=pnl&sortDir=asc'
      )

      expect(response.status).toBe(200)
      expect(response.body.data).toHaveLength(2)
      expect(response.body.data[0].symbol).toBe('AAPL')
      expect(response.body.data[1].symbol).toBe('MSFT')
      expect(transactionCountMock).not.toHaveBeenCalled()
    })

    it('returns validation error for date range over cap', async () => {
      const response = await request(createApp()).get(
        '/api/statistics/closed-trades?dateFrom=2010-01-01&dateTo=2026-01-01'
      )

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Validation Error')
    })
  })

  describe('GET /api/statistics/distributions', () => {
    it('returns histogram payload and sample size', async () => {
      transactionFindManyMock.mockResolvedValue([
        {
          id: 'tx_1',
          quantity: 1,
          price: 120,
          fees: 1,
          date: new Date('2026-03-01T00:00:00.000Z'),
          position: {
            id: 'p_1',
            accountId: 'acc_1',
            quantity: 1,
            entryPrice: 100,
            buyFees: 0,
            openDate: new Date('2026-01-01T00:00:00.000Z'),
            asset: { symbol: 'AAPL', exchange: { code: 'NASDAQ' } },
          },
        },
      ])

      const response = await request(createApp()).get(
        '/api/statistics/distributions'
      )

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data.sampleSize).toBe(1)
      expect(Array.isArray(response.body.data.pnlHistogram)).toBe(true)
    })
  })

  describe('GET /api/statistics/risk', () => {
    it('returns computed risk metrics from snapshots', async () => {
      snapshotFindManyMock.mockResolvedValue([
        {
          date: new Date('2026-01-01T00:00:00.000Z'),
          totalValue: 1000,
        },
        {
          date: new Date('2026-01-02T00:00:00.000Z'),
          totalValue: 1100,
        },
        {
          date: new Date('2026-01-03T00:00:00.000Z'),
          totalValue: 1000,
        },
      ])

      const response = await request(createApp()).get('/api/statistics/risk')

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data.methodology).toBe('SNAPSHOT_RETURNS_V1')
      expect(response.body.data.maxDrawdownPct).not.toBeNull()
    })
  })

  describe('GET /api/statistics/breakdowns', () => {
    it('returns grouped rows by requested dimension and metric', async () => {
      positionFindManyMock.mockResolvedValue([
        {
          accountId: 'acc_1',
          realizedPnL: 100,
          unrealizedPnL: 20,
          capitalAllocated: 1000,
          asset: {
            industry: 'Technology',
            assetType: 'EQUITY',
            exchange: { code: 'NASDAQ' },
          },
        },
        {
          accountId: 'acc_1',
          realizedPnL: -50,
          unrealizedPnL: 10,
          capitalAllocated: 500,
          asset: {
            industry: 'Technology',
            assetType: 'EQUITY',
            exchange: { code: 'NASDAQ' },
          },
        },
      ])

      const response = await request(createApp()).get(
        '/api/statistics/breakdowns?by=industry&metric=totalPnL'
      )

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data.rows).toHaveLength(1)
      expect(response.body.data.rows[0].key).toBe('Technology')
      expect(response.body.data.total).toBe(80)
    })

    it('validates by/metric enums', async () => {
      const response = await request(createApp()).get(
        '/api/statistics/breakdowns?by=bad&metric=bad'
      )

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Validation Error')
    })
  })
})
