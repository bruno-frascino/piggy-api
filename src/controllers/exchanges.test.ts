import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exchangeFindManyMock, authMock, searchMarkets } = vi.hoisted(() => ({
  searchMarkets: vi.fn(),
  exchangeFindManyMock: vi.fn(),
  authMock: vi.fn(),
}))
vi.mock('../lib/crypto/kraken-markets.js', () => ({
  searchKrakenMarkets: searchMarkets,
  KrakenMarketsUnavailable: class extends Error {},
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    authMock()
    if (req.headers.authorization !== 'test-authentication') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: { exchange: { findMany: exchangeFindManyMock } },
}))

import exchangesRouter from './exchanges.js'
import { KrakenMarketsUnavailable } from '../lib/crypto/kraken-markets.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/exchanges', exchangesRouter)
  return app
}

const rows = [
  { code: 'ASX', name: 'Australian Securities Exchange', currency: 'AUD' },
  { code: 'KRAKEN', name: 'Kraken (AUD)', currency: 'AUD' },
  { code: 'KRAKEN_USD', name: 'Kraken (USD)', currency: 'USD' },
]

describe('GET /api/exchanges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    exchangeFindManyMock.mockResolvedValue(rows)
  })

  it('requires authentication', async () => {
    const res = await request(createApp()).get('/api/exchanges')
    expect(res.status).toBe(401)
  })

  it('returns all exchanges with isCrypto flag', async () => {
    const res = await request(createApp())
      .get('/api/exchanges')
      .set('Authorization', 'test-authentication')

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([
      { ...rows[0], isCrypto: false },
      { ...rows[1], isCrypto: true },
      { ...rows[2], isCrypto: true },
    ])
  })

  it('filters crypto venues', async () => {
    const res = await request(createApp())
      .get('/api/exchanges?assetClass=crypto')
      .set('Authorization', 'test-authentication')

    expect(res.body.data.map((e: { code: string }) => e.code)).toEqual([
      'KRAKEN',
      'KRAKEN_USD',
    ])
  })

  it('filters equity exchanges', async () => {
    const res = await request(createApp())
      .get('/api/exchanges?assetClass=equity')
      .set('Authorization', 'test-authentication')

    expect(res.body.data.map((e: { code: string }) => e.code)).toEqual(['ASX'])
  })

  it('rejects an invalid assetClass', async () => {
    const res = await request(createApp())
      .get('/api/exchanges?assetClass=bonds')
      .set('Authorization', 'test-authentication')

    expect(res.status).toBe(400)
  })

  it('searches Kraken only for authenticated requests with a supported quote', async () => {
    const market = {
      base: 'BTC',
      name: 'Bitcoin',
      quote: 'AUD',
      symbol: 'BTC-AUD',
      exchangeCode: 'KRAKEN',
    }
    searchMarkets.mockResolvedValue([market])
    expect(
      (await request(createApp()).get('/api/exchanges/kraken/assets?quote=AUD'))
        .status
    ).toBe(401)
    const res = await request(createApp())
      .get('/api/exchanges/kraken/assets?quote=AUD&q=bitcoin')
      .set('Authorization', 'test-authentication')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([market])
    expect(searchMarkets).toHaveBeenCalledWith('AUD', 'bitcoin')
    expect(
      (
        await request(createApp())
          .get('/api/exchanges/kraken/assets?quote=EUR')
          .set('Authorization', 'test-authentication')
      ).status
    ).toBe(400)
  })

  it('returns 503 for a catalogue outage, not an empty success', async () => {
    searchMarkets.mockRejectedValue(new KrakenMarketsUnavailable('offline'))
    const res = await request(createApp())
      .get('/api/exchanges/kraken/assets?quote=AUD&q=BTC')
      .set('Authorization', 'test-authentication')
    expect(res.status).toBe(503)
    expect(res.body.message).toMatch(/temporarily unavailable/)
  })
})
