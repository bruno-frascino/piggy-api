import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  watchlistFindManyMock,
  watchlistFindFirstMock,
  watchlistCreateMock,
  watchlistUpdateMock,
  watchlistDeleteMock,
  watchlistItemFindUniqueMock,
  watchlistItemFindFirstMock,
  watchlistItemCreateMock,
  watchlistItemDeleteMock,
  findOrCreateAssetMock,
} = vi.hoisted(() => ({
  watchlistFindManyMock: vi.fn(),
  watchlistFindFirstMock: vi.fn(),
  watchlistCreateMock: vi.fn(),
  watchlistUpdateMock: vi.fn(),
  watchlistDeleteMock: vi.fn(),
  watchlistItemFindUniqueMock: vi.fn(),
  watchlistItemFindFirstMock: vi.fn(),
  watchlistItemCreateMock: vi.fn(),
  watchlistItemDeleteMock: vi.fn(),
  findOrCreateAssetMock: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    watchlist: {
      findMany: watchlistFindManyMock,
      findFirst: watchlistFindFirstMock,
      create: watchlistCreateMock,
      update: watchlistUpdateMock,
      delete: watchlistDeleteMock,
    },
    watchlistItem: {
      findUnique: watchlistItemFindUniqueMock,
      findFirst: watchlistItemFindFirstMock,
      create: watchlistItemCreateMock,
      delete: watchlistItemDeleteMock,
    },
  },
}))

vi.mock('../lib/position-service.js', () => ({
  findOrCreateAsset: findOrCreateAssetMock,
}))

import watchlistsRouter from './watchlists.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/watchlists', watchlistsRouter)
  return app
}

describe('watchlists controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists watchlists for the authenticated user', async () => {
    watchlistFindManyMock.mockResolvedValue([
      { id: 'w1', userId: 'u_1', name: 'Tech', _count: { items: 2 } },
    ])

    const response = await request(createApp()).get('/api/watchlists')

    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(1)
    expect(watchlistFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u_1' } })
    )
  })

  it('creates a watchlist', async () => {
    watchlistCreateMock.mockResolvedValue({
      id: 'w1',
      userId: 'u_1',
      name: 'Tech',
    })

    const response = await request(createApp())
      .post('/api/watchlists')
      .send({ name: 'Tech' })

    expect(response.status).toBe(201)
    expect(watchlistCreateMock).toHaveBeenCalledWith({
      data: { userId: 'u_1', name: 'Tech' },
    })
  })

  it('rejects creating a watchlist with an empty name', async () => {
    const response = await request(createApp())
      .post('/api/watchlists')
      .send({ name: '' })

    expect(response.status).toBe(400)
    expect(watchlistCreateMock).not.toHaveBeenCalled()
  })

  it('returns watchlist detail with items', async () => {
    watchlistFindFirstMock.mockResolvedValue({
      id: 'w1',
      userId: 'u_1',
      name: 'Tech',
      items: [],
    })

    const response = await request(createApp()).get('/api/watchlists/w1')

    expect(response.status).toBe(200)
    expect(response.body.data.id).toBe('w1')
  })

  it('returns 404 for a watchlist not owned by the user', async () => {
    watchlistFindFirstMock.mockResolvedValue(null)

    const response = await request(createApp()).get('/api/watchlists/w_other')

    expect(response.status).toBe(404)
  })

  it('renames a watchlist', async () => {
    watchlistFindFirstMock.mockResolvedValue({
      id: 'w1',
      userId: 'u_1',
      name: 'Old',
    })
    watchlistUpdateMock.mockResolvedValue({
      id: 'w1',
      userId: 'u_1',
      name: 'New',
    })

    const response = await request(createApp())
      .patch('/api/watchlists/w1')
      .send({ name: 'New' })

    expect(response.status).toBe(200)
    expect(response.body.data.name).toBe('New')
  })

  it('deletes a watchlist', async () => {
    watchlistFindFirstMock.mockResolvedValue({ id: 'w1', userId: 'u_1' })

    const response = await request(createApp()).delete('/api/watchlists/w1')

    expect(response.status).toBe(200)
    expect(watchlistDeleteMock).toHaveBeenCalledWith({ where: { id: 'w1' } })
  })

  describe('items', () => {
    it('adds a new item, creating/reusing the underlying asset', async () => {
      watchlistFindFirstMock.mockResolvedValue({ id: 'w1', userId: 'u_1' })
      findOrCreateAssetMock.mockResolvedValue({ id: 'asset_1', symbol: 'AAPL' })
      watchlistItemFindUniqueMock.mockResolvedValue(null)
      watchlistItemCreateMock.mockResolvedValue({
        id: 'item_1',
        watchlistId: 'w1',
        assetId: 'asset_1',
      })

      const response = await request(createApp())
        .post('/api/watchlists/w1/items')
        .send({ symbol: 'AAPL', exchangeCode: 'NASDAQ' })

      expect(response.status).toBe(201)
      expect(findOrCreateAssetMock).toHaveBeenCalledWith(
        'AAPL',
        'NASDAQ',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
      expect(watchlistItemCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { watchlistId: 'w1', assetId: 'asset_1' },
        })
      )
    })

    it('returns 409 when the symbol is already in the watchlist', async () => {
      watchlistFindFirstMock.mockResolvedValue({ id: 'w1', userId: 'u_1' })
      findOrCreateAssetMock.mockResolvedValue({ id: 'asset_1', symbol: 'AAPL' })
      watchlistItemFindUniqueMock.mockResolvedValue({ id: 'item_1' })

      const response = await request(createApp())
        .post('/api/watchlists/w1/items')
        .send({ symbol: 'AAPL', exchangeCode: 'NASDAQ' })

      expect(response.status).toBe(409)
      expect(watchlistItemCreateMock).not.toHaveBeenCalled()
    })

    it('returns 404 adding an item to a watchlist not owned by the user', async () => {
      watchlistFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp())
        .post('/api/watchlists/w_other/items')
        .send({ symbol: 'AAPL', exchangeCode: 'NASDAQ' })

      expect(response.status).toBe(404)
      expect(findOrCreateAssetMock).not.toHaveBeenCalled()
    })

    it('removes an item', async () => {
      watchlistFindFirstMock.mockResolvedValue({ id: 'w1', userId: 'u_1' })
      watchlistItemFindFirstMock.mockResolvedValue({
        id: 'item_1',
        watchlistId: 'w1',
      })

      const response = await request(createApp()).delete(
        '/api/watchlists/w1/items/item_1'
      )

      expect(response.status).toBe(200)
      expect(watchlistItemDeleteMock).toHaveBeenCalledWith({
        where: { id: 'item_1' },
      })
    })

    it('returns 404 removing an item that does not exist in the watchlist', async () => {
      watchlistFindFirstMock.mockResolvedValue({ id: 'w1', userId: 'u_1' })
      watchlistItemFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp()).delete(
        '/api/watchlists/w1/items/item_missing'
      )

      expect(response.status).toBe(404)
      expect(watchlistItemDeleteMock).not.toHaveBeenCalled()
    })
  })
})
