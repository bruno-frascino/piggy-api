import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { save, list } = vi.hoisted(() => ({ save: vi.fn(), list: vi.fn() }))
vi.mock('../lib/opening-statements.js', () => ({
  saveOpeningStatement: save,
  listOpeningStatements: list,
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
import router from './opening-statements.js'
import { errorHandler } from '../middleware/validation.js'

function app() {
  const instance = express()
  instance.use(express.json())
  instance.use('/api/accounts', router)
  instance.use(errorHandler)
  return instance
}
const input = {
  openingDate: '2026-10-01',
  cashBalances: [{ currency: 'AUD', amount: '0' }],
  sourceFingerprint: 'a'.repeat(64),
}
beforeEach(() => {
  vi.resetAllMocks()
  save.mockResolvedValue({
    statement: { id: 's1', state: 'DRAFT' },
    created: true,
  })
  list.mockResolvedValue({ statements: [], nextBeforeVersion: null })
})
describe('opening statement endpoints', () => {
  it('saves a reviewed draft for the authenticated account and disables caching', async () => {
    const response = await request(app())
      .post('/api/accounts/a1/opening-statements')
      .set('Authorization', 'Bearer test')
      .send(input)
    expect(response.status).toBe(200)
    expect(response.body.data.statement.state).toBe('DRAFT')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(save).toHaveBeenCalledWith('u1', 'a1', input)
  })
  it('validates fingerprints before invoking save', async () => {
    const response = await request(app())
      .post('/api/accounts/a1/opening-statements')
      .set('Authorization', 'Bearer test')
      .send({ ...input, sourceFingerprint: 'invalid' })
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Validation Error')
    expect(save).not.toHaveBeenCalled()
  })
  it('lists revisions using a bounded exclusive numeric cursor', async () => {
    const response = await request(app())
      .get('/api/accounts/a1/opening-statements?beforeVersion=12')
      .set('Authorization', 'Bearer test')
    expect(response.status).toBe(200)
    expect(list).toHaveBeenCalledWith('u1', 'a1', 12)
    expect(response.body.data).toEqual({
      statements: [],
      nextBeforeVersion: null,
    })
    expect(response.headers['cache-control']).toBe('no-store')
  })
  it('lists without a cursor and rejects invalid cursors', async () => {
    await request(app())
      .get('/api/accounts/a1/opening-statements')
      .set('Authorization', 'Bearer test')
    expect(list).toHaveBeenCalledWith('u1', 'a1', undefined)
    list.mockClear()
    expect(
      (
        await request(app())
          .get('/api/accounts/a1/opening-statements?beforeVersion=-1')
          .set('Authorization', 'Bearer test')
      ).status
    ).toBe(400)
    expect(list).not.toHaveBeenCalled()
  })
  it('requires authentication on both routes', async () => {
    expect(
      (
        await request(app())
          .post('/api/accounts/a1/opening-statements')
          .send(input)
      ).status
    ).toBe(401)
    expect(
      (await request(app()).get('/api/accounts/a1/opening-statements')).status
    ).toBe(401)
    expect(save).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })
  it('surfaces stale snapshots and non-owned account errors', async () => {
    save.mockRejectedValue(
      Object.assign(new Error('Preview changed'), {
        status: 409,
        name: 'Conflict',
      })
    )
    expect(
      (
        await request(app())
          .post('/api/accounts/a1/opening-statements')
          .set('Authorization', 'Bearer test')
          .send(input)
      ).status
    ).toBe(409)
    list.mockRejectedValue(
      Object.assign(new Error('Trading account not found'), {
        status: 404,
        name: 'Not Found',
      })
    )
    expect(
      (
        await request(app())
          .get('/api/accounts/a1/opening-statements')
          .set('Authorization', 'Bearer test')
      ).status
    ).toBe(404)
  })
})
