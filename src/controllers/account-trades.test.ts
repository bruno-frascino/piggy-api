import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  post,
  postCapital,
  postFx,
  readFxReview,
  correctFx,
  postIncome,
  postReinvestment,
  readReinvestment,
  correctReinvestment,
  postTransfer,
  readTransferReview,
  correctTransfer,
  correctIncome,
  correctCapital,
  readCapital,
  correct,
  correctBuy,
  correctImported,
  voidTrade,
  readVoids,
  readCapability,
  postSplit,
  readSplits,
  reverseSplit,
} = vi.hoisted(() => ({
  post: vi.fn(),
  postCapital: vi.fn(),
  postFx: vi.fn(),
  readFxReview: vi.fn(),
  correctFx: vi.fn(),
  postIncome: vi.fn(),
  postReinvestment: vi.fn(),
  readReinvestment: vi.fn(),
  correctReinvestment: vi.fn(),
  postTransfer: vi.fn(),
  readTransferReview: vi.fn(),
  correctTransfer: vi.fn(),
  correctIncome: vi.fn(),
  correctCapital: vi.fn(),
  readCapital: vi.fn(),
  correct: vi.fn(),
  correctBuy: vi.fn(),
  correctImported: vi.fn(),
  voidTrade: vi.fn(),
  readVoids: vi.fn(),
  readCapability: vi.fn(),
  postSplit: vi.fn(),
  readSplits: vi.fn(),
  reverseSplit: vi.fn(),
}))
vi.mock('../lib/draft-cash-ledger.js', () => ({
  postAccountTrade: post,
  postAccountCapitalFlow: postCapital,
  postAccountFxConversion: postFx,
  readLiveFxConversionReview: readFxReview,
  correctLiveFxConversion: correctFx,
  postAccountIncomeReceipt: postIncome,
  postAccountReinvestment: postReinvestment,
  readLiveReinvestmentReview: readReinvestment,
  correctLiveReinvestment: correctReinvestment,
  postAccountCashTransfer: postTransfer,
  readLiveCashTransferReview: readTransferReview,
  correctLiveCashTransfer: correctTransfer,
  correctLiveIncomeReceipt: correctIncome,
  correctLiveCapitalOperation: correctCapital,
  readLiveCapitalOperations: readCapital,
  correctLiveManualSale: correct,
  correctLiveManualAcquisition: correctBuy,
  correctLiveImportedExecution: correctImported,
  voidLiveManualTrade: voidTrade,
  readLiveManualTradeVoids: readVoids,
  readAccountTradeCapability: readCapability,
  postAccountSplit: postSplit,
  readAccountSplitHistory: readSplits,
  reverseAccountSplit: reverseSplit,
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

describe('stock split routes', () => {
  beforeEach(() => {
    postSplit.mockReset()
    readSplits.mockReset()
    reverseSplit.mockReset()
  })

  it('requires authentication and forwards split posting with retry status', async () => {
    const path = '/api/accounts/a1/splits'
    await request(app()).post(path).expect(401)

    const input = {
      idempotencyKey: 'split-1',
      assetId: 'asset-1',
      effectiveDate: '2026-10-15',
      newUnits: '2',
      oldUnits: '1',
      sourceReference: 'statement-1',
      statementConfirmed: true,
    }
    postSplit.mockResolvedValueOnce({ created: false, actionId: 'action-1' })
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(200)
    expect(postSplit).toHaveBeenCalledWith('u1', 'a1', input)

    postSplit.mockResolvedValueOnce({ created: true, actionId: 'action-1' })
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(201)
  })

  it('reads paginated retained split history', async () => {
    readSplits.mockResolvedValueOnce({ total: 1, items: [] })
    await request(app())
      .get('/api/accounts/a1/splits?limit=20&offset=5')
      .set('Authorization', 'Bearer test')
      .expect(200)
    expect(readSplits).toHaveBeenCalledWith('u1', 'a1', 20, 5)
  })

  it('matches the path action and forwards terminal reversal', async () => {
    const input = {
      idempotencyKey: 'reverse-split-1',
      actionId: 'action-1',
      expectedAuditNumber: 4,
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Correct statement',
      reversalConfirmed: true,
    }
    await request(app())
      .post('/api/accounts/a1/splits/action-1/reversal')
      .set('Authorization', 'Bearer test')
      .send({ ...input, actionId: 'other-action' })
      .expect(400)
    expect(reverseSplit).not.toHaveBeenCalled()

    reverseSplit.mockResolvedValueOnce({ created: true, actionId: 'action-1' })
    await request(app())
      .post('/api/accounts/a1/splits/action-1/reversal')
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(201)
    expect(reverseSplit).toHaveBeenCalledWith('u1', 'a1', input)
  })
})

describe('explicit FX posting route', () => {
  it('authenticates and forwards paired reinvestment review/correction with creation and retry status', async () => {
    const path = '/api/accounts/a1/reinvestments/i1/corrections'
    await request(app()).get(path).expect(401)
    readReinvestment.mockResolvedValueOnce({ current: null })
    await request(app())
      .get(path)
      .set('Authorization', 'Bearer test')
      .expect(200)
    expect(readReinvestment).toHaveBeenCalledWith('u1', 'a1', 'i1')
    const input = {
      idempotencyKey: 'reverse',
      expectedIncomeRevisionId: 'i1',
      expectedAcquisitionRevisionId: 'b1',
      expectedAuditNumber: 2,
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Cancelled statement',
      replacement: null,
    }
    await request(app()).post(path).send(input).expect(401)
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send({ ...input, expectedAcquisitionRevisionId: '' })
      .expect(400)
    expect(correctReinvestment).not.toHaveBeenCalled()
    for (const created of [true, false]) {
      correctReinvestment.mockResolvedValueOnce({ created })
      await request(app())
        .post(path)
        .set('Authorization', 'Bearer test')
        .send(input)
        .expect(created ? 201 : 200)
      expect(correctReinvestment).toHaveBeenLastCalledWith(
        'u1',
        'a1',
        'i1',
        input
      )
    }
    correctReinvestment.mockRejectedValueOnce(
      Object.assign(new Error('Effective sales remain'), { status: 409 })
    )
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(409)
    const message =
      'This inventory change would remove holdings supporting an active income entitlement. Correct or reverse the income before making the change.'
    correctReinvestment.mockRejectedValueOnce(
      Object.assign(new Error(message), {
        status: 409,
        name: 'Accounting Conflict',
      })
    )
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: 'Accounting Conflict', message })
      )
    const splitMessage =
      'A retained stock split depends on this reinvestment acquisition; reverse the split before changing its date or quantity or reversing it'
    correctReinvestment.mockRejectedValueOnce(
      Object.assign(new Error(splitMessage), {
        status: 409,
        name: 'Accounting Conflict',
      })
    )
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          error: 'Accounting Conflict',
          message: splitMessage,
        })
      )
  })
  it('authenticates, validates and forwards atomic reinvestment creation and retry', async () => {
    const input = {
      idempotencyKey: 'drp-1',
      income: {
        assetId: 'asset-1',
        entitlementDate: '2026-10-01',
        paymentDate: '2026-10-15',
        sequence: 1,
        currency: 'AUD',
        grossAmount: '100',
        withholdingAmount: '15',
        frankedAmount: '60',
        unfrankedAmount: '40',
        frankingCreditAud: '25',
        sourceReference: 'statement-1',
      },
      acquisition: {
        effectiveDate: '2026-10-15',
        sequence: 2,
        quantity: '4',
        price: '20',
        fees: '1',
      },
      residualAmount: '4',
      residualDisposition: 'ACCOUNT_CASH',
      statementConfirmed: true,
    }
    const path = '/api/accounts/a1/reinvestments'
    await request(app()).post(path).send(input).expect(401)
    for (const patch of [
      { statementConfirmed: false },
      { residualDisposition: 'ISSUER_CREDIT' },
      { acquisition: { ...input.acquisition, sequence: 0 } },
      { income: { ...input.income, grossAmount: 100 } },
    ])
      await request(app())
        .post(path)
        .set('Authorization', 'Bearer test')
        .send({ ...input, ...patch })
        .expect(400)
    expect(postReinvestment).not.toHaveBeenCalled()
    for (const created of [true, false]) {
      postReinvestment.mockResolvedValueOnce({
        created,
        incomeOperationId: 'i1',
        acquisitionOperationId: 'b1',
        positionId: 'p1',
        replay: { funded: true },
      })
      const response = await request(app())
        .post(path)
        .set('Authorization', 'Bearer test')
        .send(input)
        .expect(created ? 201 : 200)
      expect(response.body.data.positionId).toBe('p1')
      expect(postReinvestment).toHaveBeenLastCalledWith('u1', 'a1', input)
    }
    postReinvestment.mockRejectedValueOnce(
      Object.assign(new Error('Unfunded dated history'), { status: 409 })
    )
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(409)
  })
  it('authenticates FX review and validates revision heads before invoking the writer', async () => {
    await request(app())
      .get('/api/accounts/a1/fx-conversions/fx1/corrections')
      .expect(401)
    readFxReview.mockResolvedValue({ operationId: 'fx1', current: null })
    const review = await request(app())
      .get('/api/accounts/a1/fx-conversions/fx1/corrections')
      .set('Authorization', 'Bearer token')
      .expect(200)
    expect(review.body.data.current).toBeNull()
    expect(readFxReview).toHaveBeenCalledWith('u1', 'a1', 'fx1')
    await request(app())
      .post('/api/accounts/a1/fx-conversions/fx1/corrections')
      .set('Authorization', 'Bearer token')
      .send({ replacement: null })
      .expect(400)
    expect(correctFx).not.toHaveBeenCalled()
  })
  it.each([true, false])(
    'returns audited FX creation/retry status (created=%s)',
    async (created) => {
      const input = {
        idempotencyKey: 'fx-reverse',
        expectedRevisionId: 'fx1',
        expectedAuditNumber: 1,
        expectedSourceFingerprint: 'a'.repeat(64),
        reason: 'Duplicate exchange',
        replacement: null,
      }
      correctFx.mockResolvedValueOnce({
        operationId: 'fx1',
        revisionId: 'r1',
        created,
      })
      const response = await request(app())
        .post('/api/accounts/a1/fx-conversions/fx1/corrections')
        .set('Authorization', 'Bearer token')
        .send(input)
        .expect(created ? 201 : 200)
      expect(response.body.data).toMatchObject({ revisionId: 'r1', created })
      expect(correctFx).toHaveBeenCalledWith('u1', 'a1', 'fx1', input)
      correctFx.mockRejectedValueOnce(
        Object.assign(new Error('Stale cash head'), { status: 409 })
      )
      await request(app())
        .post('/api/accounts/a1/fx-conversions/fx1/corrections')
        .set('Authorization', 'Bearer token')
        .send(input)
        .expect(409)
    }
  )
  const fx = {
    idempotencyKey: 'fx1',
    effectiveDate: '2026-11-12',
    sequence: 1,
    from: { currency: 'AUD', amount: '1500' },
    to: { currency: 'USD', amount: '975' },
    fees: [{ currency: 'AUD', amount: '5' }],
    sourceReference: 'statement-fx',
  }
  it('requires auth and validates transport before calling the ledger writer', async () => {
    await request(app())
      .post('/api/accounts/a1/fx-conversions')
      .send(fx)
      .expect(401)
    await request(app())
      .post('/api/accounts/a1/fx-conversions')
      .set('Authorization', 'Bearer token')
      .send({ ...fx, to: { currency: 'USD', amount: 975 } })
      .expect(400)
    expect(postFx).not.toHaveBeenCalled()
  })
  it.each([true, false])(
    'returns creation/retry status and surfaces writer conflicts (created=%s)',
    async (created) => {
      postFx.mockResolvedValueOnce({
        operationId: 'fx-op',
        created,
        replay: { funded: true },
      })
      const response = await request(app())
        .post('/api/accounts/a1/fx-conversions')
        .set('Authorization', 'Bearer token')
        .send(fx)
        .expect(created ? 201 : 200)
      expect(response.body.data).toMatchObject({
        operationId: 'fx-op',
        created,
      })
      expect(postFx).toHaveBeenCalledWith('u1', 'a1', fx)
      postFx.mockRejectedValueOnce(
        Object.assign(new Error('Insufficient dated USD cash'), { status: 422 })
      )
      await request(app())
        .post('/api/accounts/a1/fx-conversions')
        .set('Authorization', 'Bearer token')
        .send(fx)
        .expect(422)
    }
  )
})

beforeEach(() => {
  vi.resetAllMocks()
  post.mockResolvedValue({
    operationId: 'op1',
    transactionId: 'tx1',
    created: true,
  })
  postCapital.mockResolvedValue({
    operationId: 'capital1',
    created: true,
    replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
  })
  postIncome.mockResolvedValue({
    operationId: 'income1',
    created: true,
    replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
  })
  correctCapital.mockResolvedValue({
    operationId: 'capital1',
    revisionId: 'revision1',
    created: true,
    replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
  })
  correctIncome.mockResolvedValue({
    operationId: 'income1',
    revisionId: 'revision1',
    created: true,
    replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
  })
  readCapital.mockResolvedValue({
    items: [],
    total: 0,
    limit: 100,
    offset: 0,
    activity: [],
    activityTotal: 0,
    auditOperations: [],
    auditTotal: 0,
    accountStatus: 'ACTIVE',
    ledgerState: 'ACTIVE',
    openingBoundary: {
      date: '2026-10-01',
      timezone: 'Australia/Sydney',
      type: 'END_OF_DAY',
    },
    reviewedAsOfDate: '2026-10-31',
    checkedAt: '2026-11-08T00:00:00.000Z',
    sourceFreshness: {
      status: 'CURRENT',
      acceptedFingerprint: 'a'.repeat(64),
      currentFingerprint: 'a'.repeat(64),
    },
    cashCompleteness: 'COMPLETE',
    unsupportedEvents: [],
    sourceReviewIssues: [],
    evidence: [],
    evidenceStatus: 'NO_ATTESTATION',
    auditNumber: 1,
    sourceFingerprint: 'a'.repeat(64),
    replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
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
  readCapability.mockResolvedValue({
    accountId: 'a1',
    mode: 'LIVE_LEDGER',
    reason: null,
    openingDate: '2026-10-01',
    effectiveDate: '2026-10-02',
    nextSequence: 2,
  })
})

describe('account trade endpoint', () => {
  it('authenticates review/correction, validates both heads and forwards terminal paired reversal status', async () => {
    const path = '/api/accounts/a1/cash-transfers/out1/corrections'
    await request(app()).get(path).expect(401)
    readTransferReview.mockResolvedValue({ current: null })
    await request(app())
      .get(path)
      .set('Authorization', 'Bearer test')
      .expect(200)
    expect(readTransferReview).toHaveBeenCalledWith('u1', 'a1', 'out1')
    const input = {
      idempotencyKey: 'fix',
      reason: 'Statement correction',
      sourceHead: {
        revisionId: 'out1',
        auditNumber: 1,
        sourceFingerprint: 'a'.repeat(64),
      },
      destinationHead: {
        revisionId: 'in1',
        auditNumber: 2,
        sourceFingerprint: 'b'.repeat(64),
      },
      replacement: null,
    }
    await request(app()).post(path).send(input).expect(401)
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send({ ...input, destinationHead: {} })
      .expect(400)
    expect(correctTransfer).not.toHaveBeenCalled()
    correctTransfer.mockResolvedValue({ created: true })
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(201)
    expect(correctTransfer).toHaveBeenCalledWith('u1', 'a1', 'out1', input)
    correctTransfer.mockResolvedValue({ created: false })
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(200)
    correctTransfer.mockRejectedValue(
      Object.assign(new Error('Stale review'), { status: 409 })
    )
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(409)
  })

  it('authenticates, validates and forwards paired cash transfers including retry status', async () => {
    const path = '/api/accounts/a1/cash-transfers'
    const input = {
      toAccountId: 'a2',
      idempotencyKey: 'transfer-1',
      effectiveDate: '2026-11-13',
      sourceSequence: 1,
      destinationSequence: 2,
      currency: 'AUD',
      amount: '40',
      fee: '0.5',
      sourceReference: 'statement-1',
    }
    await request(app()).post(path).send(input).expect(401)
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send({ ...input, amount: 40 })
      .expect(400)
    expect(postTransfer).not.toHaveBeenCalled()
    postTransfer.mockResolvedValue({
      sourceOperationId: 'out',
      destinationOperationId: 'in',
      created: true,
    })
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(201)
    expect(postTransfer).toHaveBeenCalledWith('u1', 'a1', input)
    postTransfer.mockResolvedValue({ created: false })
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(200)
    postTransfer.mockRejectedValue(
      Object.assign(new Error('Insufficient recorded cash'), { status: 422 })
    )
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(input)
      .expect(422)
  })

  it('resolves an authenticated, validated account trade capability', async () => {
    const path = '/api/accounts/a1/trade-capability'
    await request(app()).get(path).expect(401)
    await request(app())
      .get(`${path}?effectiveDate=not-a-date`)
      .set('Authorization', '******')
      .expect(400)
    expect(readCapability).not.toHaveBeenCalled()
    await request(app())
      .get(`${path}?effectiveDate=2026-10-02`)
      .set('Authorization', '******')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          mode: 'LIVE_LEDGER',
          effectiveDate: '2026-10-02',
          nextSequence: 2,
        })
      })
    expect(readCapability).toHaveBeenCalledWith('u1', 'a1', '2026-10-02')
    readCapability.mockResolvedValue({
      accountId: 'a1',
      mode: 'BLOCKED',
      reason:
        'Retained stock split history requires split-aware accounting before financial writes.',
      openingDate: null,
      effectiveDate: '2026-10-02',
      nextSequence: null,
    })
    await request(app())
      .get(`${path}?effectiveDate=2026-10-02`)
      .set('Authorization', '******')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({ mode: 'BLOCKED', nextSequence: null })
      })
  })

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
    voidTrade.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'This inventory change would remove holdings supporting an active income entitlement. Correct or reverse the income before making the change.'
        ),
        {
          status: 409,
          name: 'Accounting Conflict',
        }
      )
    )
    const response = await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(409)
    expect(response.body).toMatchObject({
      error: 'Accounting Conflict',
      message:
        'This inventory change would remove holdings supporting an active income entitlement. Correct or reverse the income before making the change.',
    })
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

  it('accepts symbol-based BUY metadata and sale close metadata', async () => {
    const buyInput = {
      ...buy,
      assetId: undefined,
      symbol: 'AAPL',
      exchangeCode: 'NASDAQ',
      assetName: 'Apple',
      assetType: 'EQUITY',
      industry: 'Technology',
      openReason: 'Long-term holding',
      stopLossPrice: '150',
    }
    await request(app())
      .post('/api/accounts/a1/trades')
      .set('Authorization', '******')
      .send(buyInput)
      .expect(201)
    expect(post).toHaveBeenCalledWith('u1', 'a1', buyInput)

    const sellInput = {
      kind: 'SELL',
      positionId: 'position-1',
      idempotencyKey: 'sell-1',
      effectiveDate: '2026-10-02',
      sequence: 2,
      quantity: '1',
      price: '12',
      fees: '0',
      closeReason: 'TARGET',
      notes: 'Target reached',
    }
    await request(app())
      .post('/api/accounts/a1/trades')
      .set('Authorization', '******')
      .send(sellInput)
      .expect(201)
    expect(post).toHaveBeenLastCalledWith('u1', 'a1', sellInput)
  })

  it('returns 200 for an idempotent retry', async () => {
    post.mockResolvedValue({ operationId: 'op1', created: false })
    await request(app())
      .post('/api/accounts/a1/trades')
      .set('Authorization', '******')
      .send(buy)
      .expect(200)
  })

  it('surfaces income entitlement conflicts when posting a sale', async () => {
    const message =
      'This inventory change would remove holdings supporting an active income entitlement. Correct or reverse the income before making the change.'
    post.mockRejectedValueOnce(
      Object.assign(new Error(message), {
        status: 409,
        name: 'Accounting Conflict',
      })
    )
    await request(app())
      .post('/api/accounts/a1/trades')
      .set('Authorization', 'Bearer test')
      .send({
        kind: 'SELL',
        positionId: 'position-1',
        idempotencyKey: 'sell-1',
        effectiveDate: '2026-10-02',
        sequence: 2,
        quantity: '1',
        price: '12',
        fees: '0',
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: 'Accounting Conflict', message })
      )
  })

  it('authenticates, validates and forwards exact live capital flows and retries', async () => {
    const input = {
      kind: 'DEPOSIT',
      idempotencyKey: 'deposit-1',
      effectiveDate: '2026-10-02',
      sequence: 1,
      currency: 'AUD',
      amount: '100.000000000001',
      sourceReference: 'bank-transfer-123',
    }
    const path = '/api/accounts/a1/cash-operations'
    await request(app()).post(path).send(input).expect(401)
    for (const invalid of [
      { ...input, kind: 'BUY' },
      { ...input, sequence: 0 },
      { ...input, effectiveDate: '2026-02-30' },
      { ...input, amount: 100 },
      { ...input, sourceReference: '' },
    ]) {
      await request(app())
        .post(path)
        .set('Authorization', '******')
        .send(invalid)
        .expect(400)
    }
    expect(postCapital).not.toHaveBeenCalled()
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(201)
    expect(postCapital).toHaveBeenCalledWith('u1', 'a1', input)
    postCapital.mockResolvedValueOnce({
      operationId: 'capital1',
      created: false,
      replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
    })

    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(200)
    postCapital.mockRejectedValueOnce(
      Object.assign(new Error('Insufficient funds'), { status: 422 })
    )
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(422)
  })

  it('authenticates, validates and forwards statement-supported income receipts', async () => {
    const input = {
      idempotencyKey: 'income-1',
      assetId: 'asset-1',
      entitlementDate: '2026-10-01',
      paymentDate: '2026-10-15',
      sequence: 1,
      currency: 'AUD',
      grossAmount: '100',
      withholdingAmount: '15',
      frankedAmount: '60',
      unfrankedAmount: '40',
      frankingCreditAud: '25',
      sourceReference: 'broker-dividend-statement',
    }
    const path = '/api/accounts/a1/income-receipts'
    await request(app()).post(path).send(input).expect(401)
    for (const invalid of [
      { ...input, paymentDate: '2026-02-30' },
      { ...input, sequence: 0 },
      { ...input, grossAmount: 100 },
      { ...input, sourceReference: '' },
    ]) {
      await request(app())
        .post(path)
        .set('Authorization', '******')
        .send(invalid)
        .expect(400)
    }
    expect(postIncome).not.toHaveBeenCalled()
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(201)
    expect(postIncome).toHaveBeenCalledWith('u1', 'a1', input)
    postIncome.mockResolvedValueOnce({
      operationId: 'income1',
      created: false,
      replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
    })
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(input)
      .expect(200)
  })

  it('authenticates, validates and forwards audited income corrections and reversals', async () => {
    const correction = {
      idempotencyKey: 'income-correction-1',
      expectedRevisionId: 'income1',
      expectedAuditNumber: 3,
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Corrected withholding from the issuer statement',
      replacement: {
        entitlementDate: '2026-10-01',
        paymentDate: '2026-10-16',
        sequence: 2,
        grossAmount: '100',
        withholdingAmount: '20',
        frankedAmount: '60',
        unfrankedAmount: '40',
        frankingCreditAud: '25',
      },
    }
    const path = '/api/accounts/a1/income-receipts/income1/corrections'
    await request(app()).post(path).send(correction).expect(401)
    for (const invalid of [
      { ...correction, expectedAuditNumber: -1 },
      { ...correction, expectedSourceFingerprint: 'bad' },
      {
        ...correction,
        replacement: { ...correction.replacement, assetId: 'asset-2' },
      },
      {
        ...correction,
        replacement: { ...correction.replacement, sequence: 0 },
      },
    ]) {
      await request(app())
        .post(path)
        .set('Authorization', '******')
        .send(invalid)
        .expect(400)
    }
    expect(correctIncome).not.toHaveBeenCalled()
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(correction)
      .expect(201)
    expect(correctIncome).toHaveBeenCalledWith(
      'u1',
      'a1',
      'income1',
      correction
    )
    correctIncome.mockResolvedValueOnce({
      operationId: 'income1',
      revisionId: 'revision1',
      created: false,
      replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
    })
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send({ ...correction, replacement: null })
      .expect(200)
  })

  it('reads and corrects/reverses audited live capital operations', async () => {
    const readPath = '/api/accounts/a1/cash-operations'
    await request(app()).get(readPath).expect(401)
    await request(app())
      .get(`${readPath}?limit=101`)
      .set('Authorization', '******')
      .expect(400)
    const read = await request(app())
      .get(`${readPath}?limit=25&offset=5`)
      .set('Authorization', '******')
      .expect(200)
    expect(read.body.data).toMatchObject({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
      openingBoundary: { type: 'END_OF_DAY' },
      sourceFreshness: { status: 'CURRENT' },
      evidenceStatus: 'NO_ATTESTATION',
    })
    expect(readCapital).toHaveBeenCalledWith('u1', 'a1', 25, 5)

    const correction = {
      idempotencyKey: 'capital-correction-1',
      expectedRevisionId: 'capital1',
      expectedAuditNumber: 1,
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Correct bank statement amount',
      replacement: {
        effectiveDate: '2026-10-03',
        sequence: 2,
        amount: '90.25',
      },
    }
    const path = `${readPath}/capital1/corrections`
    await request(app()).post(path).send(correction).expect(401)
    for (const invalid of [
      { ...correction, expectedAuditNumber: -1 },
      { ...correction, expectedSourceFingerprint: 'invalid' },
      { ...correction, reason: '' },
      { ...correction, replacement: { ...correction.replacement, amount: 0 } },
    ])
      await request(app())
        .post(path)
        .set('Authorization', '******')
        .send(invalid)
        .expect(400)
    expect(correctCapital).not.toHaveBeenCalled()
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(correction)
      .expect(201)
    expect(correctCapital).toHaveBeenCalledWith(
      'u1',
      'a1',
      'capital1',
      correction
    )
    correctCapital.mockResolvedValueOnce({
      operationId: 'capital1',
      revisionId: 'revision1',
      created: false,
      replay: { funded: true, balances: [], activity: [], fundingIssues: [] },
    })
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(correction)
      .expect(200)
    const reversal = {
      ...correction,
      idempotencyKey: 'capital-reversal-1',
      replacement: null,
    }
    correctCapital.mockRejectedValueOnce(
      Object.assign(new Error('Funding would leave cash unfunded'), {
        status: 422,
      })
    )
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(reversal)
      .expect(422)
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
    const message =
      'This inventory change would remove holdings supporting an active income entitlement. Correct or reverse the income before making the change.'
    correct.mockRejectedValueOnce(
      Object.assign(new Error(message), {
        status: 409,
        name: 'Accounting Conflict',
      })
    )
    await request(app())
      .post(path)
      .set('Authorization', '******')
      .send(correction)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: 'Accounting Conflict', message })
      )
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
    correctBuy.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'This inventory change would remove holdings supporting an active income entitlement. Correct or reverse the income before making the change.'
        ),
        {
          status: 409,
          name: 'Accounting Conflict',
        }
      )
    )
    await request(app())
      .post(path)
      .set('Authorization', 'Bearer test')
      .send(correction)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          error: 'Accounting Conflict',
          message:
            'This inventory change would remove holdings supporting an active income entitlement. Correct or reverse the income before making the change.',
        })
      )
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
