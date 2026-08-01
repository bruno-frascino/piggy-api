import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock, quoteMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  quoteMock: vi.fn(),
}))

vi.mock('yahoo-finance2', () => ({
  default: class YahooFinanceMock {
    quote = quoteMock
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

import stocksRouter from './stocks.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/stocks', stocksRouter)
  return app
}

describe('stocks controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('maps search results from yahoo payload', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        quotes: [
          {
            symbol: 'aapl',
            longname: 'Apple Inc.',
            exchDisp: 'NasdaqGS',
            typeDisp: 'Equity',
            region: 'US',
          },
        ],
      }),
    })

    const response = await request(createApp()).get('/api/stocks/search?q=aapl')

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.data).toEqual([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        type: 'Equity',
        countryCode: 'US',
      },
    ])
  })

  it('falls back to second yahoo host when first is rate limited', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: vi.fn().mockResolvedValue('rate limited'),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ quotes: [] }),
      })

    const response = await request(createApp()).get('/api/stocks/search?q=msft')

    expect(response.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(response.body.data).toEqual([])
  })

  it('returns 502 when both yahoo hosts fail', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: vi.fn().mockResolvedValue('upstream error'),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: vi.fn().mockResolvedValue('still down'),
      })

    const response = await request(createApp()).get('/api/stocks/search?q=tsla')

    expect(response.status).toBe(502)
    expect(response.body.success).toBe(false)
  })

  it('returns empty data when quotes input resolves to no symbols', async () => {
    const response = await request(createApp()).get(
      '/api/stocks/quotes?symbols= , '
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, data: [] })
  })

  it('returns quotes from resolved yahoo responses and filters failures', async () => {
    quoteMock
      .mockResolvedValueOnce({
        regularMarketPrice: 100,
        regularMarketChange: 2,
        regularMarketChangePercent: 2,
        currency: 'USD',
      })
      .mockRejectedValueOnce(new Error('missing'))

    const response = await request(createApp()).get(
      '/api/stocks/quotes?symbols=AAPL,UNKNOWN'
    )

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual([
      {
        symbol: 'AAPL',
        price: 100,
        change: 2,
        changePercent: 2,
        currency: 'USD',
      },
    ])
  })
})
