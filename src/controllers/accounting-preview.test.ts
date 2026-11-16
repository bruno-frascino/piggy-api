import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountingDecimal } from '../lib/accounting-values.js'
import { prepareAccountSplit } from '../lib/account-split-command.js'

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  positions: vi.fn(),
  batches: vi.fn(),
  transaction: vi.fn(),
  trades: vi.fn(),
  events: vi.fn(),
  split: vi.fn(),
  effects: vi.fn(),
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
  accountSplitAction: { findMany: mocks.split },
  accountSplitParcelEffect: { findMany: mocks.effects },
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
  mocks.split.mockResolvedValue([])
  mocks.effects.mockResolvedValue([])
})

function splitFixture(effectiveDate = '2026-09-20') {
  const raw = {
    idempotencyKey: 'split-key',
    assetId: 'asset1',
    effectiveDate,
    newUnits: '2',
    oldUnits: '1',
    sourceReference: 'statement-1',
    statementConfirmed: true,
  }
  const prepared = prepareAccountSplit(raw, 'a1')
  const action = {
    id: 'split1',
    accountId: 'a1',
    assetId: 'asset1',
    effectiveDate: new Date(effectiveDate),
    newUnits: new AccountingDecimal(2),
    oldUnits: new AccountingDecimal(1),
    sourceReference: raw.sourceReference,
    idempotencyKey: raw.idempotencyKey,
    payloadHash: prepared.payloadHash,
    sourceFingerprint: 'verified-fixture-source',
    methodology: 'account-split-v1',
    request: prepared.request,
    recordedAt: new Date('2026-10-10'),
  }
  const effect = {
    id: 'effect1',
    actionId: action.id,
    positionId: 'p1',
    beforeQuantity: new AccountingDecimal(8),
    afterQuantity: new AccountingDecimal(16),
  }
  const position = {
    id: 'p1',
    accountId: 'a1',
    assetId: 'asset1',
    openDate: new Date('2026-09-01'),
    quantity: 4,
    positionType: 'LONG',
    origin: 'MANUAL',
    updatedAt: new Date('2026-10-10'),
    asset: { symbol: 'ABC.AX', exchange: { currency: 'AUD' } },
  }
  const trades = [
    {
      id: 'b1',
      positionId: 'p1',
      type: 'BUY',
      date: new Date('2026-09-01'),
      quantity: 10,
      totalValue: '1000',
      fees: '10',
    },
    {
      id: 's1',
      positionId: 'p1',
      type: 'SELL',
      date: new Date('2026-09-10'),
      quantity: 2,
      totalValue: '220',
      fees: '0',
    },
    {
      id: 's2',
      positionId: 'p1',
      type: 'SELL',
      date: new Date('2026-10-04'),
      quantity: 12,
      totalValue: '720',
      fees: '5',
    },
  ]
  mocks.positions.mockResolvedValue([position])
  mocks.trades.mockResolvedValue(trades)
  mocks.split.mockResolvedValue([action])
  mocks.effects.mockResolvedValue([effect])
  return { action, effect, position, trades }
}

describe('opening preview endpoint and read-only service', () => {
  it.each([
    { date: '2026-09-20', opening: '16' },
    { date: '2026-10-03', opening: '8' },
  ])(
    'replays a split on $date without creating cash or false oversell issues',
    async ({ date, opening }) => {
      splitFixture(date)
      const response = await send()
      expect(response.status).toBe(200)
      expect(response.body.data.parcels[0]).toMatchObject({
        openingQuantity: opening,
        expectedCurrentQuantity: '4',
        recordedCurrentQuantity: '4',
      })
      expect(response.body.data.cashBalances[0].tradeOnlyEndingAmount).toBe(
        '1715'
      )
      expect(response.body.data.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'SPLIT_REPLAY_UNSUPPORTED',
            severity: 'BLOCKING',
            sourceId: 'split1',
          }),
        ])
      )
      expect(response.body.data.counts.blockingIssues).toBe(1)
      expect(mocks.split).toHaveBeenCalledWith({
        where: { accountId: 'a1' },
        orderBy: { id: 'asc' },
        take: 501,
      })
    }
  )
  it('includes retained split source content in fingerprints even when quantities do not change', async () => {
    const { action } = splitFixture()
    const before = await send()
    const changed = prepareAccountSplit(
      { ...action.request, sourceReference: 'corrected-statement' },
      'a1'
    )
    mocks.split.mockResolvedValue([
      {
        ...action,
        request: changed.request,
        payloadHash: changed.payloadHash,
        sourceReference: changed.request.sourceReference,
      },
    ])
    const after = await send()
    expect(before.status).toBe(200)
    expect(after.status).toBe(200)
    expect(after.body.data.parcels).toEqual(before.body.data.parcels)
    expect(after.body.data.sourceFingerprint).not.toBe(
      before.body.data.sourceFingerprint
    )
  })
  it('replays a later consolidation in the same parcel without changing cash', async () => {
    const { action, effect, position } = splitFixture()
    const next = prepareAccountSplit(
      {
        ...action.request,
        idempotencyKey: 'consolidation-key',
        effectiveDate: '2026-10-05',
        newUnits: '1',
        oldUnits: '2',
        sourceReference: 'statement-2',
      },
      'a1'
    )
    mocks.split.mockResolvedValue([
      action,
      {
        ...action,
        id: 'split2',
        effectiveDate: new Date(next.request.effectiveDate),
        newUnits: new AccountingDecimal(1),
        oldUnits: new AccountingDecimal(2),
        idempotencyKey: next.request.idempotencyKey,
        sourceReference: next.request.sourceReference,
        request: next.request,
        payloadHash: next.payloadHash,
      },
    ])
    mocks.effects.mockResolvedValue([
      effect,
      {
        ...effect,
        id: 'effect2',
        actionId: 'split2',
        beforeQuantity: new AccountingDecimal(4),
        afterQuantity: new AccountingDecimal(2),
      },
    ])
    mocks.positions.mockResolvedValue([{ ...position, quantity: 2 }])
    const response = await send()
    expect(response.status).toBe(200)
    expect(response.body.data.parcels[0]).toMatchObject({
      openingQuantity: '16',
      expectedCurrentQuantity: '2',
      recordedCurrentQuantity: '2',
    })
    expect(response.body.data.cashBalances[0].tradeOnlyEndingAmount).toBe(
      '1715'
    )
    expect(response.body.data.counts.blockingIssues).toBe(1)
  })
  it.each(['missing', 'inconsistent', 'wrong-position', 'wrong-source'])(
    'rejects %s retained split evidence instead of returning partial inventory',
    async (kind) => {
      const { action, effect } = splitFixture()
      if (kind === 'missing') mocks.effects.mockResolvedValue([])
      if (kind === 'inconsistent')
        mocks.effects.mockResolvedValue([
          { ...effect, afterQuantity: new AccountingDecimal(15) },
        ])
      if (kind === 'wrong-position')
        mocks.effects.mockResolvedValue([
          { ...effect, positionId: 'foreign-position' },
        ])
      if (kind === 'wrong-source')
        mocks.split.mockResolvedValue([{ ...action, payloadHash: 'invalid' }])
      const response = await send()
      expect(response.status).toBe(500)
      expect(response.body.data).toBeUndefined()
    }
  )
  it('does not require split effects on parcels sold before or acquired after the action', async () => {
    const { position, trades } = splitFixture()
    mocks.positions.mockResolvedValue([
      position,
      { ...position, id: 'closed', quantity: 0 },
      {
        ...position,
        id: 'later',
        quantity: 3,
        openDate: new Date('2026-10-05'),
      },
    ])
    mocks.trades.mockResolvedValue([
      ...trades,
      { ...trades[0], id: 'closed-buy', positionId: 'closed' },
      { ...trades[1], id: 'closed-sell', positionId: 'closed', quantity: 10 },
      {
        ...trades[0],
        id: 'later-buy',
        positionId: 'later',
        date: new Date('2026-10-05'),
        quantity: 3,
      },
    ])
    const response = await send()
    expect(response.status).toBe(200)
    expect(response.body.data.parcels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          positionId: 'closed',
          openingQuantity: '0',
          expectedCurrentQuantity: '0',
        }),
        expect.objectContaining({
          positionId: 'later',
          openingQuantity: '0',
          expectedCurrentQuantity: '3',
        }),
      ])
    )
  })
  it.each(['actions', 'effects'])(
    'rejects excessive split %s rather than using a truncated snapshot',
    async (kind) => {
      const { action, effect } = splitFixture()
      if (kind === 'actions')
        mocks.split.mockResolvedValue(Array(501).fill(action))
      else mocks.effects.mockResolvedValue(Array(50001).fill(effect))
      const response = await send()
      expect(response.status).toBe(422)
      expect(response.body.data).toBeUndefined()
    }
  )
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
