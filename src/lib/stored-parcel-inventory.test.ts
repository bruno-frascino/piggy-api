import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { AccountingDecimal } from './accounting-values.js'
import { prepareAccountSplit } from './account-split-command.js'
import { prepareAccountSplitReversal } from './account-split-reversal.js'

const mocks = vi.hoisted(() => ({
  positions: vi.fn(),
  trades: vi.fn(),
  actions: vi.fn(),
  effects: vi.fn(),
}))
vi.mock('./prisma.js', () => ({
  prisma: {
    position: { findMany: mocks.positions },
    transaction: { findMany: mocks.trades },
    accountSplitAction: { findMany: mocks.actions },
    accountSplitParcelEffect: { findMany: mocks.effects },
  },
}))
import { prisma } from './prisma.js'
import {
  projectStoredParcelCostBasis,
  readAccountAssetQuantityAt,
  readStoredSplitHistory,
  reviewStoredParcelSale,
} from './stored-parcel-inventory.js'

function fixture() {
  const request = {
    idempotencyKey: 'split-key',
    assetId: 'asset1',
    effectiveDate: '2025-08-01',
    newUnits: '2',
    oldUnits: '1',
    sourceReference: 'statement-1',
    statementConfirmed: true,
  }
  const action = {
    id: 'split1',
    accountId: 'a1',
    assetId: 'asset1',
    effectiveDate: new Date(request.effectiveDate),
    newUnits: new AccountingDecimal(2),
    oldUnits: new AccountingDecimal(1),
    sourceReference: request.sourceReference,
    idempotencyKey: request.idempotencyKey,
    payloadHash: prepareAccountSplit(request, 'a1').payloadHash,
    sourceFingerprint: 'a'.repeat(64),
    methodology: 'account-split-v1',
    request,
    recordedAt: new Date('2025-08-02'),
    auditNumber: 1,
    previousFingerprint: 'a'.repeat(64),
    nextFingerprint: 'b'.repeat(64),
  }
  const effect = {
    id: 'effect1',
    actionId: action.id,
    positionId: 'p1',
    beforeQuantity: new AccountingDecimal(8),
    afterQuantity: new AccountingDecimal(16),
  }
  const transactions = [
    {
      id: 'buy',
      positionId: 'p1',
      date: new Date('2025-01-01'),
      type: 'BUY',
      quantity: 10,
    },
    {
      id: 'prior',
      positionId: 'p1',
      date: new Date('2025-07-01'),
      type: 'SELL',
      quantity: 2,
    },
    {
      id: 'later',
      positionId: 'p1',
      date: new Date('2025-10-01'),
      type: 'SELL',
      quantity: 4,
    },
  ]
  const position = {
    id: 'p1',
    accountId: 'a1',
    assetId: 'asset1',
    openDate: new Date('2025-01-01'),
    transactions,
    splitEffects: [{ ...effect, action }],
    asset: { splitActions: [action] },
  }
  return { action, effect, position, transactions }
}

beforeEach(() => {
  vi.resetAllMocks()
  const f = fixture()
  mocks.positions.mockResolvedValue([f.position])
  mocks.trades.mockResolvedValue(f.transactions)
  mocks.actions.mockResolvedValue([f.action])
  mocks.effects.mockResolvedValue([f.effect])
})

describe('split source fingerprint stability', () => {
  it('preserves the original source hash and excludes audit continuation metadata', async () => {
    const { action, effect } = fixture()
    const {
      auditNumber: _auditNumber,
      previousFingerprint: _previous,
      nextFingerprint: _next,
      ...original
    } = action
    const expected = createHash('sha256')
      .update(JSON.stringify({ actions: [original], effects: [effect] }))
      .digest('hex')
    expect((await readStoredSplitHistory(prisma, 'a1')).sourceFingerprint).toBe(
      expected
    )
    mocks.actions.mockResolvedValue([
      {
        ...action,
        auditNumber: 2,
        previousFingerprint: 'a'.repeat(64),
        nextFingerprint: 'b'.repeat(64),
      },
    ])
    expect((await readStoredSplitHistory(prisma, 'a1')).sourceFingerprint).toBe(
      expected
    )
    mocks.effects.mockResolvedValue([{ ...effect, id: 'changed-evidence' }])
    expect(
      (await readStoredSplitHistory(prisma, 'a1')).sourceFingerprint
    ).not.toBe(expected)
  })

  it('includes reversal evidence in source identity but excludes its audit head', async () => {
    const { action, effect } = fixture()
    const request = {
      idempotencyKey: 'reverse-key',
      actionId: action.id,
      expectedAuditNumber: 1,
      expectedSourceFingerprint: action.nextFingerprint,
      reason: 'Corrected statement evidence',
      reversalConfirmed: true as const,
    }
    const prepared = prepareAccountSplitReversal(request, 'a1')
    const reversal = {
      id: 'reversal1',
      accountId: 'a1',
      actionId: action.id,
      idempotencyKey: request.idempotencyKey,
      payloadHash: prepared.payloadHash,
      reason: request.reason,
      request,
      auditNumber: 2,
      previousFingerprint: 'b'.repeat(64),
      nextFingerprint: 'c'.repeat(64),
      recordedAt: new Date('2025-08-03'),
    }
    const reversedAction = { ...action, reversal }
    mocks.actions.mockResolvedValue([reversedAction])
    const withReversal = (await readStoredSplitHistory(prisma, 'a1'))
      .sourceFingerprint
    mocks.actions.mockResolvedValue([
      {
        ...reversedAction,
        reversal: {
          ...reversal,
          nextFingerprint: 'e'.repeat(64),
        },
      },
    ])
    expect((await readStoredSplitHistory(prisma, 'a1')).sourceFingerprint).toBe(
      withReversal
    )
    mocks.effects.mockResolvedValue([{ ...effect, id: 'changed-effect' }])
    expect(
      (await readStoredSplitHistory(prisma, 'a1')).sourceFingerprint
    ).not.toBe(withReversal)
  })
})

describe('dated account/asset entitlement inventory', () => {
  it.each([
    ['2024-12-31', '0'],
    ['2025-06-30', '10'],
    ['2025-07-01', '8'],
    ['2025-08-01', '16'],
    ['2025-10-01', '12'],
  ])(
    'replays entitlement on %s as %s units, not current holdings',
    async (date, quantity) => {
      expect(
        (
          await readAccountAssetQuantityAt(prisma, 'u1', 'a1', 'asset1', date)
        ).toFixed()
      ).toBe(quantity)
    }
  )

  it('scopes both positions and effective trades and excludes a revised reinvestment parcel', async () => {
    mocks.positions.mockResolvedValue([])
    mocks.trades.mockResolvedValue([])
    expect(
      (
        await readAccountAssetQuantityAt(
          prisma,
          'u1',
          'a1',
          'asset1',
          '2025-10-01',
          'p1'
        )
      ).toFixed()
    ).toBe('0')
    const where = {
      userId: 'u1',
      accountId: 'a1',
      assetId: 'asset1',
      voidedAt: null,
      positionType: 'LONG',
      id: { not: 'p1' },
    }
    expect(mocks.positions).toHaveBeenCalledWith(
      expect.objectContaining({ where })
    )
    expect(mocks.trades).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          voidedAt: null,
          type: { in: ['BUY', 'SELL'] },
          position: where,
        },
      })
    )
    expect(mocks.actions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'a1', assetId: 'asset1' },
      })
    )
  })

  it('preserves transaction-only historical quantities when no split is retained', async () => {
    mocks.actions.mockResolvedValue([])
    expect(
      (
        await readAccountAssetQuantityAt(
          prisma,
          'u1',
          'a1',
          'asset1',
          '2025-08-01'
        )
      ).toFixed()
    ).toBe('8')
    expect(mocks.effects).not.toHaveBeenCalled()
  })

  it('retroactively removes a reversed split from effective inventory', async () => {
    const { action, effect, transactions } = fixture()
    const request = {
      idempotencyKey: 'reverse-key',
      actionId: action.id,
      expectedAuditNumber: 1,
      expectedSourceFingerprint: action.nextFingerprint,
      reason: 'Corrected statement evidence',
      reversalConfirmed: true as const,
    }
    const prepared = prepareAccountSplitReversal(request, 'a1')
    mocks.actions.mockResolvedValue([
      {
        ...action,
        reversal: {
          id: 'reversal1',
          accountId: 'a1',
          actionId: action.id,
          idempotencyKey: request.idempotencyKey,
          payloadHash: prepared.payloadHash,
          reason: request.reason,
          request,
          auditNumber: 2,
          previousFingerprint: 'b'.repeat(64),
          nextFingerprint: 'c'.repeat(64),
          recordedAt: new Date('2025-08-03'),
        },
      },
    ])
    const effectiveTrades = transactions.filter((trade) => trade.id !== 'later')
    mocks.trades.mockResolvedValue(effectiveTrades)
    mocks.effects.mockResolvedValue([effect])
    expect(
      (
        await readAccountAssetQuantityAt(
          prisma,
          'u1',
          'a1',
          'asset1',
          '2025-08-01'
        )
      ).toFixed()
    ).toBe('8')
  })

  it('rejects missing effects rather than inventing entitlement units', async () => {
    mocks.effects.mockResolvedValue([])
    await expect(
      readAccountAssetQuantityAt(prisma, 'u1', 'a1', 'asset1', '2025-08-01')
    ).rejects.toThrow('Split action is missing its parcel effect')
  })

  it('rejects invalid dates and negative historical parcel inventory explicitly', async () => {
    await expect(
      readAccountAssetQuantityAt(prisma, 'u1', 'a1', 'asset1', 'bad-date')
    ).rejects.toThrow('Invalid entitlement observation date')
    expect(mocks.positions).not.toHaveBeenCalled()
    mocks.actions.mockResolvedValue([])
    mocks.trades.mockResolvedValue([
      { ...fixture().transactions[0], type: 'SELL' },
    ])
    await expect(
      readAccountAssetQuantityAt(prisma, 'u1', 'a1', 'asset1', '2025-08-01')
    ).rejects.toThrow('Invalid historical parcel quantity')
  })

  it.each(['positions', 'trades'])(
    'rejects oversized %s without returning partial entitlement',
    async (kind) => {
      const f = fixture()
      if (kind === 'positions')
        mocks.positions.mockResolvedValue(Array(50001).fill(f.position))
      else mocks.trades.mockResolvedValue(Array(50001).fill(f.transactions[0]))
      await expect(
        readAccountAssetQuantityAt(prisma, 'u1', 'a1', 'asset1', '2025-08-01')
      ).rejects.toMatchObject({ status: 422 })
    }
  )
})

describe('proposed sales against retained split history', () => {
  it('reviews a full sale after a split without rewriting acquisition or retained effects', () => {
    const { position } = fixture()
    const before = position.transactions.map((trade) => ({
      ...trade,
      date: new Date(trade.date),
    }))
    const review = reviewStoredParcelSale(position, {
      id: 'proposed',
      date: new Date('2025-11-01'),
      quantity: 12,
    })
    expect(review?.before.remainingQuantity).toBe('12')
    expect(review?.after).toMatchObject({
      remainingQuantity: '0',
      remainingCostFraction: { numerator: '0', denominator: '1' },
    })
    expect(position.transactions).toEqual(before)
    expect(position.splitEffects[0].beforeQuantity.toFixed()).toBe('8')
  })

  it.each([
    { date: '2025-11-01', quantity: 13, message: 'Sale exceeds' },
    {
      date: '2025-07-15',
      quantity: 1,
      message: 'Split parcel quantities do not match',
    },
    {
      date: '2025-08-01',
      quantity: 1,
      message: 'Ambiguous same-day split ordering',
    },
  ])(
    'rejects a conflicting proposed sale on $date',
    ({ date, quantity, message }) => {
      expect(() =>
        reviewStoredParcelSale(fixture().position, {
          id: 'proposed',
          date: new Date(date),
          quantity,
        })
      ).toThrow(message)
    }
  )

  it('reserves enough units for later retained sales when reviewing a backdated sale', () => {
    const { position } = fixture()
    expect(
      reviewStoredParcelSale(position, {
        id: 'proposed',
        date: new Date('2025-09-01'),
        quantity: 12,
      })?.after?.remainingQuantity
    ).toBe('0')
    expect(() =>
      reviewStoredParcelSale(position, {
        id: 'proposed',
        date: new Date('2025-09-01'),
        quantity: 13,
      })
    ).toThrow('Sale exceeds')
  })

  it('keeps the existing no-split sale path separate', () => {
    const { position } = fixture()
    expect(
      reviewStoredParcelSale(
        {
          ...position,
          splitEffects: [],
          asset: { splitActions: [] },
        },
        { id: 'proposed', date: new Date('2025-11-01'), quantity: 1 }
      )
    ).toBeNull()
  })
})

describe('split-adjusted holding cost basis', () => {
  it('projects remaining quantity, cost, fees, and average unit cost after sales and a split', () => {
    const { position } = fixture()
    expect(
      projectStoredParcelCostBasis({
        ...position,
        quantity: 12,
        entryPrice: new AccountingDecimal(10),
        buyFees: new AccountingDecimal(10),
      })
    ).toEqual({
      remainingQuantity: '12',
      remainingCostBasis: '66.000000000000',
      remainingBuyFees: '6.000000000000',
      averageUnitCost: '5.500000000000',
    })
  })

  it('returns a null average unit cost for a fully disposed split parcel', () => {
    const { position } = fixture()
    const transactions = position.transactions.map((transaction) =>
      transaction.id === 'later'
        ? { ...transaction, quantity: 16 }
        : transaction
    )
    expect(
      projectStoredParcelCostBasis({
        ...position,
        transactions,
        quantity: 0,
        entryPrice: new AccountingDecimal(10),
        buyFees: new AccountingDecimal(10),
      })
    ).toMatchObject({
      remainingQuantity: '0',
      remainingCostBasis: '0.000000000000',
      remainingBuyFees: '0.000000000000',
      averageUnitCost: null,
    })
  })

  it('rejects a stored quantity that disagrees with effective split history', () => {
    const { position } = fixture()
    expect(() =>
      projectStoredParcelCostBasis({
        ...position,
        quantity: 11,
        entryPrice: new AccountingDecimal(10),
        buyFees: new AccountingDecimal(10),
      })
    ).toThrow('Stored parcel quantity does not match split inventory')
  })

  it('does not adopt a split without a valid audited continuation', () => {
    const { action, position } = fixture()
    const unauditedAction = {
      ...action,
      auditNumber: null,
      previousFingerprint: null,
      nextFingerprint: null,
    }
    expect(() =>
      projectStoredParcelCostBasis({
        ...position,
        quantity: 16,
        entryPrice: new AccountingDecimal(10),
        buyFees: new AccountingDecimal(10),
        splitEffects: position.splitEffects.map((effect) => ({
          ...effect,
          action: unauditedAction,
        })),
        asset: { splitActions: [unauditedAction] },
      })
    ).toThrow('Split action has no valid audited continuation')
  })
})
