import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  positions: vi.fn(),
  batches: vi.fn(),
  transaction: vi.fn(),
  trades: vi.fn(),
  events: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({
  prisma: { $transaction: mocks.transaction },
}))
vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization)
      return res
        .status(401)
        .json({ error: 'Unauthorized', message: 'Authentication required' })
    req.user = { userId: 'u1', email: 'test@example.com' }
    next()
  },
}))
import accountsRouter from './accounts.js'
import { errorHandler } from '../middleware/validation.js'

const db = {
  tradingAccount: { findFirst: mocks.account },
  position: { findMany: mocks.positions },
  importBatch: { findMany: mocks.batches },
  transaction: { findMany: mocks.trades },
  importedEvent: { findMany: mocks.events },
}
const input = {
  openingDate: '2026-10-01',
  cashBalances: [{ currency: 'AUD', amount: '1000' }],
}
function app() {
  const instance = express()
  instance.use(express.json())
  instance.use('/api/accounts', accountsRouter)
  instance.use(errorHandler)
  return instance
}
function send(body: object = input) {
  return request(app())
    .post('/api/accounts/a1/opening-preview')
    .set('Authorization', 'Bearer test')
    .send(body)
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.transaction.mockImplementation(
    (callback: (client: typeof db) => unknown) => callback(db)
  )
  mocks.account.mockResolvedValue({
    id: 'a1',
    status: 'ACTIVE',
    isDemo: false,
    updatedAt: new Date(),
  })
  mocks.positions.mockResolvedValue([])
  mocks.batches.mockResolvedValue([])
  mocks.trades.mockResolvedValue([])
  mocks.events.mockResolvedValue([])
})
describe('opening preview endpoint and read-only service', () => {
  it('returns complete preview shape and reads an ownership-scoped consistent snapshot only', async () => {
    const response = await send()
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.data).toMatchObject({
      accountId: 'a1',
      openingDate: '2026-10-01',
      boundary: 'END_OF_DAY',
      timezone: 'Australia/Sydney',
      mode: 'PREVIEW_ONLY',
      parcels: [],
      counts: { parcels: 0, postBoundaryTrades: 0, blockingIssues: 0 },
    })
    expect(mocks.account.mock.calls[0][0].where).toEqual({
      id: 'a1',
      userId: 'u1',
    })
    expect(mocks.positions.mock.calls[0][0].where).toEqual({
      accountId: 'a1',
      userId: 'u1',
      voidedAt: null,
    })
    expect(mocks.trades.mock.calls[0][0].where).toEqual({
      voidedAt: null,
      position: { accountId: 'a1', userId: 'u1', voidedAt: null },
    })
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'RepeatableRead',
      timeout: 15000,
    })
  })
  it('requires authentication before reading any account', async () => {
    const response = await request(app())
      .post('/api/accounts/a1/opening-preview')
      .send(input)
    expect(response.status).toBe(401)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('hides other users accounts and does not load their parcels', async () => {
    mocks.account.mockResolvedValue(null)
    expect((await send()).status).toBe(404)
    expect(mocks.positions).not.toHaveBeenCalled()
  })
  it.each([
    { openingDate: 'bad', cashBalances: [] },
    { ...input, cashBalances: [{ currency: 'AUD', amount: 1 }] },
    { ...input, openingDate: '2026-02-30' },
  ])('rejects malformed input before DB reads %#', async (body) => {
    expect((await send(body)).status).toBe(400)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('maps decimal sources and flags unresolved imports', async () => {
    mocks.positions.mockResolvedValue([
      {
        id: 'p',
        quantity: 1,
        positionType: 'LONG',
        origin: 'MANUAL',
        updatedAt: new Date(),
        asset: { symbol: 'ABC.AX', exchange: { currency: 'AUD' } },
      },
    ])
    mocks.trades.mockResolvedValue([
      {
        positionId: 'p',
        id: 'b',
        type: 'BUY',
        date: new Date('2026-09-01'),
        quantity: 1,
        totalValue: '10',
        fees: '1',
      },
    ])
    mocks.batches.mockResolvedValue([
      {
        id: 'i',
        status: 'PENDING_REVIEW',
      },
    ])
    mocks.events.mockResolvedValue([
      { id: 'event', kind: 'WITHDRAWAL', status: 'PENDING' },
    ])
    const response = await send()
    expect(response.status).toBe(200)
    expect(response.body.data.parcels[0].openingQuantity).toBe('1')
    expect(response.body.data.counts.blockingIssues).toBe(2)
  })
  it('refuses oversized accounts instead of returning incomplete success', async () => {
    mocks.positions.mockResolvedValue(Array(5001).fill({}))
    expect((await send()).status).toBe(422)
  })
  it('refuses oversized transaction histories before constructing a partial preview', async () => {
    mocks.trades.mockResolvedValue(Array(50001).fill({}))
    expect((await send()).status).toBe(422)
  })
  it('surfaces database failures without successful fallback', async () => {
    mocks.transaction.mockRejectedValue(new Error('Database unavailable'))
    const response = await send()
    expect(response.status).toBe(500)
    expect(response.body.success).toBeUndefined()
    expect(response.body.message).not.toContain('Database unavailable')
  })
})
