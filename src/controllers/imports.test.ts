import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  batchFindMany: vi.fn(),
  batchCount: vi.fn(),
  eventGroupBy: vi.fn(),
  createImportBatch: vi.fn(),
  planBatch: vi.fn(),
  saveResolution: vi.fn(),
  commitBatch: vi.fn(),
  discardBatch: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== 'Bearer ok') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    tradingAccount: { findFirst: m.accountFindFirst },
    importBatch: { findMany: m.batchFindMany, count: m.batchCount },
    importedEvent: { groupBy: m.eventGroupBy },
  },
}))

vi.mock('../lib/imports/service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../lib/imports/service.js')>()
  return {
    ...actual,
    createImportBatch: m.createImportBatch,
    planBatch: m.planBatch,
    saveResolution: m.saveResolution,
    commitBatch: m.commitBatch,
    discardBatch: m.discardBatch,
  }
})

import importsRouter from './imports.js'
import { ImportError } from '../lib/imports/service.js'

function createApp() {
  const app = express()
  // Mirrors src/index.ts: the upload route parses its own (larger) body.
  const defaultJson = express.json()
  app.use((req, res, next) =>
    req.method === 'POST' && /^\/api\/imports\/?$/.test(req.path)
      ? next()
      : defaultJson(req, res, next)
  )
  app.use('/api/imports', importsRouter)
  app.use(
    (
      err: Error & { status?: number },
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      res.status(err.status ?? 500).json({ error: err.name })
    }
  )
  return app
}

const auth = { Authorization: 'Bearer ok' }
const validBody = {
  source: 'KRAKEN',
  accountId: 'acc1',
  files: [
    { kind: 'trades', fileName: 't.csv', content: 'x' },
    { kind: 'ledgers', fileName: 'l.csv', content: 'y' },
  ],
}
const planned = {
  batch: { id: 'b1' },
  plan: { summary: { blockingIssues: 0 } },
  eventCounts: { PENDING: 3 },
}

beforeEach(() => {
  vi.resetAllMocks()
  m.accountFindFirst.mockResolvedValue({
    id: 'acc1',
    isDemo: false,
    status: 'ACTIVE',
  })
})

describe('POST /api/imports', () => {
  it('requires authentication', async () => {
    const res = await request(createApp()).post('/api/imports').send(validBody)
    expect(res.status).toBe(401)
  })

  it.each([
    ['an unsupported source', { ...validBody, source: 'BINANCE' }],
    ['no files', { ...validBody, files: [] }],
    [
      'an unknown file kind',
      {
        ...validBody,
        files: [{ kind: 'statement', fileName: 'a', content: 'x' }],
      },
    ],
    [
      'an empty file',
      { ...validBody, files: [{ kind: 'trades', fileName: 'a', content: '' }] },
    ],
    ['a missing account', { ...validBody, accountId: undefined }],
  ])('rejects %s', async (_label, body) => {
    const res = await request(createApp())
      .post('/api/imports')
      .set(auth)
      .send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Validation Error')
    expect(m.createImportBatch).not.toHaveBeenCalled()
  })

  it('404s for an account the user does not own', async () => {
    m.accountFindFirst.mockResolvedValue(null)
    const res = await request(createApp())
      .post('/api/imports')
      .set(auth)
      .send(validBody)
    expect(res.status).toBe(404)
    expect(m.accountFindFirst).toHaveBeenCalledWith({
      where: { id: 'acc1', userId: 'u_1' },
    })
  })

  it.each([
    ['demo', { isDemo: true, status: 'ACTIVE' }],
    ['closed', { isDemo: false, status: 'CLOSED' }],
  ])('rejects %s accounts', async (_label, account) => {
    m.accountFindFirst.mockResolvedValue({ id: 'acc1', ...account })
    const res = await request(createApp())
      .post('/api/imports')
      .set(auth)
      .send(validBody)
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/active, non-demo/)
    expect(m.createImportBatch).not.toHaveBeenCalled()
  })

  it('creates the batch and returns the plan', async () => {
    m.createImportBatch.mockResolvedValue({
      batchId: 'b1',
      duplicates: 4,
      existingBatches: [],
      warnings: ['w'],
    })
    m.planBatch.mockResolvedValue(planned)

    const res = await request(createApp())
      .post('/api/imports')
      .set(auth)
      .send(validBody)

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      batch: { id: 'b1' },
      duplicates: 4,
      existingBatches: [],
      warnings: ['w'],
    })
    expect(m.createImportBatch).toHaveBeenCalledWith({
      userId: 'u_1',
      accountId: 'acc1',
      source: 'KRAKEN',
      files: validBody.files,
    })
  })

  it('reports a re-upload of already imported files without creating a batch', async () => {
    const existingBatches = [
      {
        id: 'previous',
        accountId: 'acc1',
        accountName: 'Kraken account',
        status: 'PENDING_REVIEW',
        eventCount: 78,
      },
    ]
    m.createImportBatch.mockResolvedValue({
      batchId: null,
      duplicates: 78,
      existingBatches,
      warnings: [],
    })
    const res = await request(createApp())
      .post('/api/imports')
      .set(auth)
      .send(validBody)
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      batch: null,
      duplicates: 78,
      existingBatches,
    })
    expect(m.planBatch).not.toHaveBeenCalled()
  })

  it('passes parse errors (wrong headers, missing file) through as 400', async () => {
    m.createImportBatch.mockRejectedValue(
      new ImportError(400, 'Unrecognised trades export format')
    )
    const res = await request(createApp())
      .post('/api/imports')
      .set(auth)
      .send(validBody)
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('Unrecognised trades export format')
  })

  it('accepts bodies above the default 100 kb JSON limit', async () => {
    m.createImportBatch.mockResolvedValue({
      batchId: null,
      duplicates: 0,
      warnings: [],
    })
    const big = 'a'.repeat(300_000)
    const res = await request(createApp())
      .post('/api/imports')
      .set(auth)
      .send({
        ...validBody,
        files: [{ kind: 'trades', fileName: 't.csv', content: big }],
      })
    expect(res.status).toBe(201)
    expect(m.createImportBatch.mock.calls[0][0].files[0].content).toHaveLength(
      300_000
    )
  })

  it('rejects bodies above 10 MB', async () => {
    // The server may close the socket mid-upload, which surfaces client-side as EPIPE/ECONNRESET.
    const outcome = await request(createApp())
      .post('/api/imports')
      .set(auth)
      .send({
        ...validBody,
        files: [
          {
            kind: 'trades',
            fileName: 't.csv',
            content: 'a'.repeat(11_000_000),
          },
        ],
      })
      .then(
        (res) => res.status,
        (error: { code?: string; status?: number }) =>
          error.status ?? error.code
      )
    expect([413, 'EPIPE', 'ECONNRESET']).toContain(outcome)
    expect(m.createImportBatch).not.toHaveBeenCalled()
  })
})

describe('GET /api/imports', () => {
  it('lists batches with event counts', async () => {
    m.batchFindMany.mockResolvedValue([{ id: 'b1' }, { id: 'b2' }])
    m.batchCount.mockResolvedValue(2)
    m.eventGroupBy.mockResolvedValue([
      { batchId: 'b1', status: 'APPLIED', _count: { _all: 5 } },
      { batchId: 'b1', status: 'SKIPPED', _count: { _all: 2 } },
    ])

    const res = await request(createApp()).get('/api/imports').set(auth)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([
      { id: 'b1', eventCounts: { APPLIED: 5, SKIPPED: 2 } },
      { id: 'b2', eventCounts: {} },
    ])
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 2 })
    expect(m.batchFindMany.mock.calls[0][0].where).toEqual({ userId: 'u_1' })
  })

  it('rejects an out-of-range limit', async () => {
    const res = await request(createApp())
      .get('/api/imports?limit=1000')
      .set(auth)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/imports/:id', () => {
  it('returns the plan for the caller', async () => {
    m.planBatch.mockResolvedValue(planned)
    const res = await request(createApp()).get('/api/imports/b1').set(auth)
    expect(res.status).toBe(200)
    expect(m.planBatch).toHaveBeenCalledWith('b1', 'u_1')
    expect(res.body.data.plan).toEqual(planned.plan)
  })

  it('propagates 404 for foreign batches', async () => {
    m.planBatch.mockRejectedValue(
      Object.assign(new Error('Import batch not found'), { status: 404 })
    )
    const res = await request(createApp()).get('/api/imports/zzz').set(auth)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/imports/:id/events/:eventId', () => {
  it('saves a resolution and returns the updated plan', async () => {
    m.saveResolution.mockResolvedValue(planned)
    const body = {
      allocations: [{ positionRef: 'pos1', quantity: '0.5' }],
      closeReason: 'MANUAL',
    }
    const res = await request(createApp())
      .patch('/api/imports/b1/events/e1')
      .set(auth)
      .send(body)

    expect(res.status).toBe(200)
    expect(m.saveResolution).toHaveBeenCalledWith('b1', 'e1', 'u_1', body)
  })

  it('clears an allocation override with null', async () => {
    m.saveResolution.mockResolvedValue(planned)
    const res = await request(createApp())
      .patch('/api/imports/b1/events/e1')
      .set(auth)
      .send({ allocations: null })
    expect(res.status).toBe(200)
    expect(m.saveResolution.mock.calls[0][3]).toEqual({
      allocations: undefined,
    })
  })

  it('allows clearing the close reason with null', async () => {
    m.saveResolution.mockResolvedValue(planned)
    await request(createApp())
      .patch('/api/imports/b1/events/e1')
      .set(auth)
      .send({ closeReason: null })
    expect(m.saveResolution.mock.calls[0][3]).toEqual({ closeReason: null })
  })

  it.each([
    ['a bad close reason', { closeReason: 'WHATEVER' }],
    [
      'non-numeric quantities',
      { allocations: [{ positionRef: 'p', quantity: 'abc' }] },
    ],
    ['an empty allocation list', { allocations: [] }],
    ['a non-numeric fmv', { fmvAud: 'lots' }],
  ])('rejects %s', async (_label, body) => {
    const res = await request(createApp())
      .patch('/api/imports/b1/events/e1')
      .set(auth)
      .send(body)
    expect(res.status).toBe(400)
    expect(m.saveResolution).not.toHaveBeenCalled()
  })

  it('maps service conflicts to 409', async () => {
    m.saveResolution.mockRejectedValue(
      new ImportError(409, 'already processed')
    )
    const res = await request(createApp())
      .patch('/api/imports/b1/events/e1')
      .set(auth)
      .send({ skip: true })
    expect(res.status).toBe(409)
  })
})

describe('POST /api/imports/:id/commit', () => {
  it('surfaces stale-plan conflicts with the standard error shape', async () => {
    const message =
      'Import events or holdings changed during preparation. Review the refreshed plan and try again.'
    m.commitBatch.mockRejectedValue(new ImportError(409, message))
    const res = await request(createApp())
      .post('/api/imports/b1/commit')
      .set(auth)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'Conflict', message })
    expect(m.commitBatch).toHaveBeenCalledTimes(1)
  })

  it('commits everything by default', async () => {
    m.commitBatch.mockResolvedValue({
      createdPositionIds: ['p1'],
      appliedEvents: 2,
    })
    const res = await request(createApp())
      .post('/api/imports/b1/commit')
      .set(auth)
      .send({})
    expect(res.status).toBe(200)
    expect(m.commitBatch).toHaveBeenCalledWith('b1', 'u_1', undefined)
    expect(res.body.data.createdPositionIds).toEqual(['p1'])
  })

  it('commits selected events', async () => {
    m.commitBatch.mockResolvedValue({
      createdPositionIds: [],
      appliedEvents: 1,
    })
    await request(createApp())
      .post('/api/imports/b1/commit')
      .set(auth)
      .send({ eventIds: ['e1'] })
    expect(m.commitBatch).toHaveBeenCalledWith('b1', 'u_1', ['e1'])
  })

  it('returns blocking issues as 409 with details', async () => {
    m.commitBatch.mockRejectedValue(
      new ImportError(409, 'Resolve the blocking issues before committing', [
        { type: 'INSUFFICIENT_HOLDINGS' },
      ])
    )
    const res = await request(createApp())
      .post('/api/imports/b1/commit')
      .set(auth)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: 'Conflict',
      details: [{ type: 'INSUFFICIENT_HOLDINGS' }],
    })
  })

  it('rejects an empty eventIds list', async () => {
    const res = await request(createApp())
      .post('/api/imports/b1/commit')
      .set(auth)
      .send({ eventIds: [] })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/imports/:id', () => {
  it('discards the batch for the caller', async () => {
    const res = await request(createApp()).delete('/api/imports/b1').set(auth)
    expect(res.status).toBe(200)
    expect(m.discardBatch).toHaveBeenCalledWith('b1', 'u_1')
  })
})
