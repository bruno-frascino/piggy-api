import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../lib/draft-cash-ledger.js', () => ({ postAccountTrade: post }))
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

import router from './account-trades.js'
import { errorHandler } from '../middleware/validation.js'

function app() {
  const instance = express()
  instance.use(express.json())
  instance.use('/api/accounts', router)
  instance.use(errorHandler)
  return instance
}

const buy = {
  kind: 'BUY',
  assetId: 'asset-1',
  idempotencyKey: 'buy-1',
  effectiveDate: '2026-10-02',
  sequence: 1,
  quantity: '1.25',
  price: '12.50',
  fees: '1',
}

beforeEach(() => {
  vi.resetAllMocks()
  post.mockResolvedValue({
    operationId: 'op1',
    transactionId: 'tx1',
    created: true,
  })
})

describe('account trade endpoint', () => {
  it('authenticates, validates and forwards the exact account command', async () => {
    const path = '/api/accounts/a1/trades'
    await request(app()).post(path).send(buy).expect(401)
    for (const invalid of [
      { ...buy, quantity: 1.25 },
      { ...buy, sequence: 0 },
      { ...buy, effectiveDate: '2026-02-30' },
    ]) {
      await request(app())
        .post(path)
        .set('Authorization', '******')
        .send(invalid)
        .expect(400)
    }
    expect(post).not.toHaveBeenCalled()
    const response = await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(buy)
      .expect(201)
    expect(response.body.data).toMatchObject({ transactionId: 'tx1' })
    expect(post).toHaveBeenCalledWith('u1', 'a1', buy)
  })

  it('returns 200 for an idempotent retry', async () => {
    post.mockResolvedValue({ operationId: 'op1', created: false })
    await request(app())
      .post('/api/accounts/a1/trades')
      .set('Authorization', '******')
      .send(buy)
      .expect(200)
  })
})
