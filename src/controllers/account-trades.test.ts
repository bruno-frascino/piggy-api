import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { post, correct, correctBuy, correctImported, voidTrade, readVoids } =
  vi.hoisted(() => ({
    post: vi.fn(),
    correct: vi.fn(),
    correctBuy: vi.fn(),
    correctImported: vi.fn(),
    voidTrade: vi.fn(),
    readVoids: vi.fn(),
  }))
vi.mock('../lib/draft-cash-ledger.js', () => ({
  postAccountTrade: post,
  correctLiveManualSale: correct,
  correctLiveManualAcquisition: correctBuy,
  correctLiveImportedExecution: correctImported,
  voidLiveManualTrade: voidTrade,
  readLiveManualTradeVoids: readVoids,
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
  correctImported.mockResolvedValue({
    operationId: 'op1',
    revisionId: 'revision1',
    created: true,
  })
})

describe('account trade endpoint', () => {
  it('authenticates, validates and forwards manual voids, retries and errors', async () => {
    const input = {
      idempotencyKey: 'void-1',
      expectedRevisionId: 'op1',
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Duplicate trade',
    }
    const path = '/api/accounts/a1/trades/tx1/voids'
    await request(app()).post(path).send(input).expect(401)
    for (const invalid of [
      { ...input, reason: '' },
      { ...input, expectedRevisionId: '' },
      { ...input, expectedSourceFingerprint: 'bad' },
    ])
      await request(app())
        .post(path)
        .set('Authorization', '******')
        .send(invalid)
        .expect(400)
    expect(voidTrade).not.toHaveBeenCalled()
    voidTrade.mockResolvedValueOnce({
      operationId: 'op1',
      revisionId: 'rev1',
      created: true,
    })
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(201)
    expect(voidTrade).toHaveBeenCalledWith('u1', 'a1', 'tx1', input)
    voidTrade.mockResolvedValueOnce({
      operationId: 'op1',
      revisionId: 'rev1',
      created: false,
    })
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(200)
    voidTrade.mockRejectedValueOnce(
      Object.assign(new Error('Insufficient cash'), { status: 422 })
    )
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(422)
  })

  it('reads owned paginated retained void audits and rejects invalid pagination', async () => {
    const path = '/api/accounts/a1/trades/voids'
    await request(app()).get(path).expect(401)
    await request(app())
      .get(`${path}?limit=101`)
      .set('Authorization', '******')
      .expect(400)
    await request(app())
      .get(`${path}?offset=-1`)
      .set('Authorization', '******')
      .expect(400)
    expect(readVoids).not.toHaveBeenCalled()
    readVoids.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 2 })
    const result = await request(app())
      .get(`${path}?limit=10&offset=2`)
      .set('Authorization', '******')
      .expect(200)
    expect(result.body.data.items).toEqual([])
    expect(readVoids).toHaveBeenCalledWith('u1', 'a1', 10, 2)
    await request(app()).get(path).set('Authorization', '******').expect(200)
    expect(readVoids).toHaveBeenLastCalledWith('u1', 'a1', 100, 0)
  })

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

  it('authenticates, validates and forwards imported execution corrections', async () => {
    const correction = {
      idempotencyKey: 'import-fix',
      expectedRevisionId: 'op1',
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Corrected from broker statement',
      effectiveDate: '2026-10-03',
      sequence: 2,
      price: '12.345678901234',
      fees: '0.12345678',
    }
    const path = '/api/accounts/a1/imported-executions/event1/corrections'
    await request(app()).post(path).send(correction).expect(401)
    for (const invalid of [
      { ...correction, sequence: 0 },
      { ...correction, expectedSourceFingerprint: 'invalid' },
      { ...correction, fees: 1 },
    ]) {
      await request(app())
        .post(path)
        .set('Authorization', '******')
        .send(invalid)
        .expect(400)
    }
    expect(correctImported).not.toHaveBeenCalled()
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(correction)
      .expect(201)
    expect(correctImported).toHaveBeenCalledWith(
      'u1',
      'a1',
      'event1',
      correction
    )
    correctImported.mockResolvedValueOnce({
      operationId: 'op1',
      revisionId: 'revision1',
      created: false,
    })
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(correction)
      .expect(200)
  })
})
