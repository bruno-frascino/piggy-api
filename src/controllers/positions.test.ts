import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  positionFindManyMock,
  positionCountMock,
  positionFindFirstMock,
  positionFindUniqueMock,
  positionCreateMock,
  positionUpdateMock,
  positionDeleteMock,
  transactionFindManyMock,
  transactionFindFirstMock,
  transactionCreateMock,
  transactionUpdateMock,
  exchangeFindUniqueMock,
  assetFindUniqueMock,
  assetCreateMock,
  accountFindFirstMock,
  accountUpsertMock,
  fetchHistoricalMaxDrawdownMock,
} = vi.hoisted(() => ({
  positionFindManyMock: vi.fn(),
  positionCountMock: vi.fn(),
  positionFindFirstMock: vi.fn(),
  positionFindUniqueMock: vi.fn(),
  positionCreateMock: vi.fn(),
  positionUpdateMock: vi.fn(),
  positionDeleteMock: vi.fn(),
  transactionFindManyMock: vi.fn(),
  transactionFindFirstMock: vi.fn(),
  transactionCreateMock: vi.fn(),
  transactionUpdateMock: vi.fn(),
  exchangeFindUniqueMock: vi.fn(),
  assetFindUniqueMock: vi.fn(),
  assetCreateMock: vi.fn(),
  accountFindFirstMock: vi.fn(),
  accountUpsertMock: vi.fn(),
  fetchHistoricalMaxDrawdownMock: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/historical-drawdown.js', () => ({
  fetchHistoricalMaxDrawdown: fetchHistoricalMaxDrawdownMock,
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    position: {
      findMany: positionFindManyMock,
      count: positionCountMock,
      findFirst: positionFindFirstMock,
      findUnique: positionFindUniqueMock,
      create: positionCreateMock,
      update: positionUpdateMock,
      delete: positionDeleteMock,
    },
    transaction: {
      findMany: transactionFindManyMock,
      findFirst: transactionFindFirstMock,
      create: transactionCreateMock,
      update: transactionUpdateMock,
    },
    exchange: { findUnique: exchangeFindUniqueMock },
    asset: { findUnique: assetFindUniqueMock, create: assetCreateMock },
    tradingAccount: {
      findFirst: accountFindFirstMock,
      upsert: accountUpsertMock,
    },
  },
}))

import positionsRouter from './positions.js'
import { errorHandler } from '../middleware/validation.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/positions', positionsRouter)
  app.use(errorHandler)
  return app
}

describe('positions controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchHistoricalMaxDrawdownMock.mockResolvedValue(null)
  })

  describe('GET /api/positions', () => {
    it('lists positions for the authenticated user', async () => {
      positionFindManyMock.mockResolvedValue([{ id: 'p_1' }])
      positionCountMock.mockResolvedValue(1)

      const response = await request(createApp()).get('/api/positions')

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data).toHaveLength(1)
      expect(response.body.meta).toEqual({ total: 1, limit: 50, offset: 0 })
      expect(positionFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u_1' },
        })
      )
    })

    it('filters by status and accountId', async () => {
      positionFindManyMock.mockResolvedValue([])
      positionCountMock.mockResolvedValue(0)

      await request(createApp()).get(
        '/api/positions?status=OPEN,PARTIAL&accountId=acc_1'
      )

      expect(positionFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'u_1',
            status: { in: ['OPEN', 'PARTIAL'] },
            accountId: 'acc_1',
          },
        })
      )
    })
  })

  describe('POST /api/positions', () => {
    const validBody = {
      symbol: 'AAPL',
      exchangeCode: 'NASDAQ',
      openDate: '2026-01-01T00:00:00.000Z',
      entryPrice: 10,
      quantity: 5,
      capitalAllocated: 50,
    }

    it('opens a new position', async () => {
      exchangeFindUniqueMock.mockResolvedValue({ id: 'ex_1', code: 'NASDAQ' })
      assetFindUniqueMock.mockResolvedValue(null)
      assetCreateMock.mockResolvedValue({ id: 'a_1', symbol: 'AAPL' })
      accountFindFirstMock.mockResolvedValue({ id: 'acc_1' })
      positionCreateMock.mockResolvedValue({ id: 'p_1' })

      const response = await request(createApp())
        .post('/api/positions')
        .send({ ...validBody, accountId: 'acc_1' })

      expect(response.status).toBe(201)
      expect(response.body.success).toBe(true)
      expect(response.body.data).toEqual({ id: 'p_1' })
    })

    it('returns 400 when required fields are missing', async () => {
      const response = await request(createApp())
        .post('/api/positions')
        .send({ symbol: 'AAPL' })

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Validation Error')
    })

    it('propagates a 404 when the exchange does not exist', async () => {
      exchangeFindUniqueMock.mockResolvedValue(null)

      const response = await request(createApp())
        .post('/api/positions')
        .send(validBody)

      expect(response.status).toBe(404)
      expect(response.body.message).toBe("Exchange 'NASDAQ' not found")
    })
  })

  describe('GET /api/positions/close-events', () => {
    it('lists SELL transactions for the authenticated user', async () => {
      transactionFindManyMock.mockResolvedValue([{ id: 'tx_1', type: 'SELL' }])

      const response = await request(createApp()).get(
        '/api/positions/close-events'
      )

      expect(response.status).toBe(200)
      expect(response.body.data).toHaveLength(1)
      expect(transactionFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { type: 'SELL', position: { userId: 'u_1' } },
        })
      )
    })
  })

  describe('PATCH /api/positions/close-events/:id', () => {
    it('returns 404 when the SELL transaction is not owned by the user', async () => {
      transactionFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp())
        .patch('/api/positions/close-events/missing')
        .send({ exitPrice: 12 })

      expect(response.status).toBe(404)
      expect(transactionFindFirstMock).toHaveBeenCalledWith({
        where: {
          id: 'missing',
          type: 'SELL',
          position: { userId: 'u_1' },
        },
        select: { positionId: true, quantity: true },
      })
    })

    it('updates the SELL transaction and recomputes its position', async () => {
      transactionFindFirstMock.mockResolvedValue({
        positionId: 'p_1',
        quantity: 5,
      })
      transactionUpdateMock.mockResolvedValue({ id: 'tx_1', price: 12 })
      positionFindUniqueMock.mockResolvedValue({
        id: 'p_1',
        entryPrice: 10,
        buyFees: 0,
        transactions: [
          {
            type: 'BUY',
            quantity: 5,
            price: 10,
            totalValue: 50,
            fees: 0,
            date: new Date('2026-01-01'),
          },
          {
            type: 'SELL',
            quantity: 5,
            price: 12,
            totalValue: 60,
            fees: 1,
            date: new Date('2026-02-01'),
          },
        ],
      })
      positionUpdateMock.mockResolvedValue({ id: 'p_1', status: 'CLOSED' })

      const response = await request(createApp())
        .patch('/api/positions/close-events/tx_1')
        .send({
          closeDate: '2026-02-01T00:00:00.000Z',
          exitPrice: 12,
          sellFees: 1,
          notes: ' reviewed ',
        })

      expect(response.status).toBe(200)
      expect(transactionUpdateMock).toHaveBeenCalledWith({
        where: { id: 'tx_1' },
        data: {
          date: '2026-02-01T00:00:00.000Z',
          price: 12,
          totalValue: 60,
          fees: 1,
          notes: 'reviewed',
        },
      })
      expect(positionUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'p_1' } })
      )
    })

    it('validates editable close-event fields', async () => {
      const response = await request(createApp())
        .patch('/api/positions/close-events/tx_1')
        .send({ exitPrice: 0, sellFees: -1 })

      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Validation Error')
      expect(transactionFindFirstMock).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/positions/:id/recalculate-drawdown', () => {
    it('returns 404 when the position does not exist', async () => {
      positionFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp()).post(
        '/api/positions/missing/recalculate-drawdown'
      )

      expect(response.status).toBe(404)
    })

    it('recalculates and persists the drawdown', async () => {
      positionFindFirstMock.mockResolvedValue({
        id: 'p_1',
        entryPrice: 10,
        openDate: '2026-01-01T00:00:00.000Z',
        asset: { symbol: 'AAPL' },
      })
      fetchHistoricalMaxDrawdownMock.mockResolvedValue(12.5)
      positionUpdateMock.mockResolvedValue({
        id: 'p_1',
        maxDrawdownPercent: 12.5,
      })

      const response = await request(createApp()).post(
        '/api/positions/p_1/recalculate-drawdown'
      )

      expect(response.status).toBe(200)
      expect(response.body.maxDrawdownPercent).toBe(12.5)
      expect(positionUpdateMock).toHaveBeenCalledWith({
        where: { id: 'p_1' },
        data: { maxDrawdownPercent: 12.5 },
      })
    })
  })

  describe('PATCH /api/positions/:id', () => {
    it('returns 404 when the position does not exist', async () => {
      positionFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp())
        .patch('/api/positions/missing')
        .send({ notes: 'hello' })

      expect(response.status).toBe(404)
    })

    it('updates simple metadata fields', async () => {
      positionFindFirstMock.mockResolvedValue({
        id: 'p_1',
        assetId: 'a_1',
        quantity: 5,
        entryPrice: 10,
        buyFees: 0,
        openDate: '2026-01-01T00:00:00.000Z',
        asset: { symbol: 'AAPL', exchange: { code: 'NASDAQ' } },
        transactions: [],
      })
      positionUpdateMock.mockResolvedValue({ id: 'p_1', notes: 'hello' })

      const response = await request(createApp())
        .patch('/api/positions/p_1')
        .send({ notes: 'hello' })

      expect(response.status).toBe(200)
      expect(positionUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p_1' },
          data: expect.objectContaining({ notes: 'hello' }),
        })
      )
    })

    it('updates and clears the opening reason', async () => {
      positionFindFirstMock.mockResolvedValue({
        id: 'p_1',
        assetId: 'a_1',
        quantity: 5,
        entryPrice: 10,
        buyFees: 0,
        openDate: '2026-01-01T00:00:00.000Z',
        asset: { symbol: 'AAPL', exchange: { code: 'NASDAQ' } },
        transactions: [],
      })
      positionUpdateMock.mockResolvedValue({ id: 'p_1' })

      const updatedResponse = await request(createApp())
        .patch('/api/positions/p_1')
        .send({ openReason: 'New rationale' })
      const clearedResponse = await request(createApp())
        .patch('/api/positions/p_1')
        .send({ openReason: null })

      expect(updatedResponse.status).toBe(200)
      expect(clearedResponse.status).toBe(200)
      expect(positionUpdateMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ openReason: 'New rationale' }),
        })
      )
      expect(positionUpdateMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ openReason: null }),
        })
      )
    })
  })

  describe('POST /api/positions/:id/close', () => {
    it('returns 404 when the position does not exist', async () => {
      positionFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp())
        .post('/api/positions/missing/close')
        .send({ closeDate: '2026-02-01T00:00:00.000Z', exitPrice: 12 })

      expect(response.status).toBe(404)
    })

    it('returns 400 when the position is already closed', async () => {
      positionFindFirstMock.mockResolvedValue({ id: 'p_1', status: 'CLOSED' })

      const response = await request(createApp())
        .post('/api/positions/p_1/close')
        .send({ closeDate: '2026-02-01T00:00:00.000Z', exitPrice: 12 })

      expect(response.status).toBe(400)
    })

    it('closes an open position and records a SELL transaction', async () => {
      positionFindFirstMock
        .mockResolvedValueOnce({
          id: 'p_1',
          status: 'OPEN',
          transactions: [
            {
              type: 'BUY',
              quantity: 5,
              price: 10,
              totalValue: 50,
              fees: 0,
              date: new Date('2026-01-01'),
            },
          ],
        })
        .mockResolvedValueOnce({ id: 'p_1', status: 'CLOSED' })
      transactionCreateMock.mockResolvedValue({ id: 'tx_1' })
      positionFindUniqueMock.mockResolvedValue({
        id: 'p_1',
        entryPrice: 10,
        buyFees: 0,
        transactions: [
          {
            type: 'BUY',
            quantity: 5,
            price: 10,
            totalValue: 50,
            fees: 0,
            date: new Date('2026-01-01'),
          },
          {
            type: 'SELL',
            quantity: 5,
            price: 12,
            totalValue: 60,
            fees: 0,
            date: new Date('2026-02-01'),
          },
        ],
      })
      positionUpdateMock.mockResolvedValue({ id: 'p_1', status: 'CLOSED' })

      const response = await request(createApp())
        .post('/api/positions/p_1/close')
        .send({ closeDate: '2026-02-01T00:00:00.000Z', exitPrice: 12 })

      expect(response.status).toBe(200)
      expect(transactionCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'SELL', price: 12 }),
        })
      )
    })
  })

  describe('DELETE /api/positions/:id', () => {
    it('returns 404 when the position does not exist', async () => {
      positionFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp()).delete(
        '/api/positions/missing'
      )

      expect(response.status).toBe(404)
    })

    it('deletes an existing position', async () => {
      positionFindFirstMock.mockResolvedValue({ id: 'p_1' })
      positionDeleteMock.mockResolvedValue({ id: 'p_1' })

      const response = await request(createApp()).delete('/api/positions/p_1')

      expect(response.status).toBe(200)
      expect(positionDeleteMock).toHaveBeenCalledWith({ where: { id: 'p_1' } })
    })
  })
})
