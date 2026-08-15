import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  assetFindManyMock,
  watchlistItemFindManyMock,
  savedScreenFindManyMock,
  savedScreenCreateMock,
  savedScreenFindFirstMock,
  savedScreenDeleteMock,
} = vi.hoisted(() => ({
  assetFindManyMock: vi.fn(),
  watchlistItemFindManyMock: vi.fn(),
  savedScreenFindManyMock: vi.fn(),
  savedScreenCreateMock: vi.fn(),
  savedScreenFindFirstMock: vi.fn(),
  savedScreenDeleteMock: vi.fn(),
}))

const { screenStocksMock, searchSymbolMock, getDividendsCalendarMock } =
  vi.hoisted(() => ({
    screenStocksMock: vi.fn(),
    searchSymbolMock: vi.fn(),
    getDividendsCalendarMock: vi.fn(),
  }))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    asset: { findMany: assetFindManyMock },
    watchlistItem: { findMany: watchlistItemFindManyMock },
    savedScreen: {
      findMany: savedScreenFindManyMock,
      create: savedScreenCreateMock,
      findFirst: savedScreenFindFirstMock,
      delete: savedScreenDeleteMock,
    },
  },
}))

vi.mock('../lib/fmp-client.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/fmp-client.js')>(
    '../lib/fmp-client.js'
  )
  return {
    ...actual,
    screenStocks: screenStocksMock,
    searchSymbol: searchSymbolMock,
    getDividendsCalendar: getDividendsCalendarMock,
  }
})

import screenerRouter from './screener.js'
import { FmpUnavailableError } from '../lib/fmp-client.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/screener', screenerRouter)
  return app
}

describe('screener controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    assetFindManyMock.mockResolvedValue([])
    watchlistItemFindManyMock.mockResolvedValue([])
  })

  it('filters by fundamentals when no symbol is given', async () => {
    screenStocksMock.mockResolvedValue([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        marketCap: 1_000_000_000,
        price: 200,
        lastAnnualDividend: 1,
        isEtf: false,
        country: 'US',
      },
    ])

    const response = await request(createApp())
      .get('/api/screener')
      .query({ marketCapMin: 1000, sector: 'Technology' })

    expect(response.status).toBe(200)
    expect(response.body.mode).toBe('filter')
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      symbol: 'AAPL',
      alreadyTracked: false,
      inWatchlist: false,
    })
    expect(screenStocksMock).toHaveBeenCalledWith(
      expect.objectContaining({ marketCapMoreThan: 1000, sector: 'Technology' })
    )
  })

  it('uses symbol search mode when symbol is given, ignoring fundamental filters', async () => {
    searchSymbolMock.mockResolvedValue([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        currency: 'USD',
      },
    ])

    const response = await request(createApp())
      .get('/api/screener')
      .query({ symbol: 'AAPL' })

    expect(response.status).toBe(200)
    expect(response.body.mode).toBe('symbol')
    expect(response.body.data[0]).toMatchObject({
      symbol: 'AAPL',
      marketCap: null,
    })
    expect(screenStocksMock).not.toHaveBeenCalled()
  })

  it('flags alreadyTracked and inWatchlist from DB lookups', async () => {
    screenStocksMock.mockResolvedValue([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        sector: null,
        industry: null,
        marketCap: null,
        price: null,
        lastAnnualDividend: null,
        isEtf: false,
        country: null,
      },
    ])
    assetFindManyMock.mockResolvedValue([{ symbol: 'AAPL' }])
    watchlistItemFindManyMock.mockResolvedValue([{ asset: { symbol: 'AAPL' } }])

    const response = await request(createApp())
      .get('/api/screener')
      .query({ sector: 'Technology' })

    expect(response.body.data[0]).toMatchObject({
      alreadyTracked: true,
      inWatchlist: true,
    })
  })

  it('returns 503 when the provider is unavailable', async () => {
    screenStocksMock.mockRejectedValue(new FmpUnavailableError('down'))

    const response = await request(createApp())
      .get('/api/screener')
      .query({ sector: 'Technology' })

    expect(response.status).toBe(503)
    expect(response.body.error).toBe('Upstream Unavailable')
  })

  it('rejects an invalid limit', async () => {
    const response = await request(createApp())
      .get('/api/screener')
      .query({ limit: 0 })

    expect(response.status).toBe(400)
  })

  describe('upcoming dividends', () => {
    it('returns dividends filtered by symbols', async () => {
      getDividendsCalendarMock.mockResolvedValue([
        {
          symbol: 'AAPL',
          exDate: '2026-08-20',
          paymentDate: null,
          dividend: 0.26,
          yield: null,
          frequency: null,
        },
        {
          symbol: 'MSFT',
          exDate: '2026-08-21',
          paymentDate: null,
          dividend: 0.75,
          yield: null,
          frequency: null,
        },
      ])

      const response = await request(createApp())
        .get('/api/screener/upcoming-dividends')
        .query({ symbols: 'AAPL', from: '2026-08-01', to: '2026-08-30' })

      expect(response.status).toBe(200)
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0].symbol).toBe('AAPL')
    })

    it('rejects a date range over 90 days', async () => {
      const response = await request(createApp())
        .get('/api/screener/upcoming-dividends')
        .query({ from: '2026-01-01', to: '2026-08-01' })

      expect(response.status).toBe(400)
      expect(getDividendsCalendarMock).not.toHaveBeenCalled()
    })
  })

  describe('saved screens', () => {
    it('lists saved screens for the authenticated user', async () => {
      savedScreenFindManyMock.mockResolvedValue([
        { id: 's1', userId: 'u_1', name: 'High div tech', filters: {} },
      ])

      const response = await request(createApp()).get(
        '/api/screener/saved-screens'
      )

      expect(response.status).toBe(200)
      expect(response.body.data).toHaveLength(1)
    })

    it('creates a saved screen', async () => {
      savedScreenCreateMock.mockResolvedValue({
        id: 's1',
        userId: 'u_1',
        name: 'High div tech',
        filters: { sector: 'Technology' },
      })

      const response = await request(createApp())
        .post('/api/screener/saved-screens')
        .send({ name: 'High div tech', filters: { sector: 'Technology' } })

      expect(response.status).toBe(201)
      expect(savedScreenCreateMock).toHaveBeenCalledWith({
        data: {
          userId: 'u_1',
          name: 'High div tech',
          filters: { sector: 'Technology' },
        },
      })
    })

    it('returns 404 deleting a saved screen that does not belong to the user', async () => {
      savedScreenFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp()).delete(
        '/api/screener/saved-screens/s_missing'
      )

      expect(response.status).toBe(404)
      expect(savedScreenDeleteMock).not.toHaveBeenCalled()
    })

    it('deletes an owned saved screen', async () => {
      savedScreenFindFirstMock.mockResolvedValue({ id: 's1', userId: 'u_1' })

      const response = await request(createApp()).delete(
        '/api/screener/saved-screens/s1'
      )

      expect(response.status).toBe(200)
      expect(savedScreenDeleteMock).toHaveBeenCalledWith({
        where: { id: 's1' },
      })
    })
  })
})
