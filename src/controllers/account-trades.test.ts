import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { post, correct, correctBuy } = vi.hoisted(() => ({
  post: vi.fn(),
  correct: vi.fn(),
  correctBuy: vi.fn(),
}))
vi.mock('../lib/draft-cash-ledger.js', () => ({
  postAccountTrade: post,
  correctLiveManualSale: correct,
  correctLiveManualAcquisition: correctBuy,
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
  correct.mockResolvedValue({
    operationId: 'op1',
    revisionId: 'revision1',
    created: true,
  })
  correctBuy.mockResolvedValue({
    operationId: 'op1',
    revisionId: 'revision1',
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

  it('authenticates, validates and forwards an audited sale correction', async () => {
    const correction = {
      idempotencyKey: 'correction-1',
      expectedRevisionId: 'op1',
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Corrected from broker statement',
      effectiveDate: '2026-10-03',
      sequence: 2,
      price: '12.5',
      fees: '0.25',
    }
    const path = '/api/accounts/a1/trades/tx1/corrections'
    await request(app()).post(path).send(correction).expect(401)
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send({ ...correction, sequence: 0 })
      .expect(400)
    expect(correct).not.toHaveBeenCalled()
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(correction)
      .expect(201)
    expect(correct).toHaveBeenCalledWith('u1', 'a1', 'tx1', correction)
  })

  it('authenticates and forwards exact acquisition corrections, including retries and failures', async () => {
    const correction = {
      idempotencyKey: 'buy-fix',
      expectedRevisionId: 'op1',
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Correct broker purchase',
      effectiveDate: '2026-10-03',
      sequence: 1,
      quantity: '2.000000000001',
      price: '0.123456789012',
      fees: '0.12345678',
    }
    const path = '/api/accounts/a1/trades/tx1/acquisition-corrections'
    await request(app()).post(path).send(correction).expect(401)
    for (const invalid of [
      { ...correction, quantity: 2 },
      { ...correction, sequence: 0 },
      { ...correction, expectedSourceFingerprint: 'invalid' },
      { ...correction, reason: '' },
      { ...correction, effectiveDate: '2026-02-30' },
    ]) {
      await request(app())
        .post(path)
        .set('Authorization', 'Bearer test')
        .send(invalid)
        .expect(400)
    }
    expect(correctBuy).not.toHaveBeenCalled()
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(correction)
      .expect(201)
    expect(correctBuy).toHaveBeenCalledWith('u1', 'a1', 'tx1', correction)
    correctBuy.mockResolvedValueOnce({
      operationId: 'op1',
      revisionId: 'revision1',
      created: false,
    })
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(correction)
      .expect(200)
    correctBuy.mockRejectedValueOnce(
      Object.assign(new Error('Source drift'), { status: 409 })
    )
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(correction)
      .expect(409)
    expect(correct).not.toHaveBeenCalled()
  })
})
