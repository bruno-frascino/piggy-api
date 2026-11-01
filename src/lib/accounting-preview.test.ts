import { describe, expect, it } from 'vitest'
import {
  buildOpeningPreview,
  parseOpeningPreviewInput,
  sydneyCalendarDate,
  type PreviewPosition,
  type PreviewTransaction,
} from './accounting-preview.js'

const now = new Date('2026-10-31T12:00:00Z')
const account = { id: 'a1', status: 'ACTIVE', isDemo: false, updatedAt: now }
const input = {
  openingDate: '2026-10-01',
  cashBalances: [{ currency: 'AUD', amount: '1000' }],
}
const tx = (
  id: string,
  type: string,
  date: string,
  quantity: string,
  totalValue: string,
  fees = '0'
): PreviewTransaction => ({
  id,
  type,
  date: new Date(date),
  quantity,
  totalValue,
  fees,
})
const position = (
  transactions: PreviewTransaction[],
  quantity = '6'
): PreviewPosition => ({
  id: 'p1',
  symbol: 'ABC.AX',
  currency: 'AUD',
  positionType: 'LONG',
  origin: 'MANUAL',
  quantity,
  updatedAt: now,
  transactions,
})
const preview = (positions: PreviewPosition[], cash = input) =>
  buildOpeningPreview(account, positions, cash, [], now)

describe('opening preview input', () => {
  it('validates and canonicalizes cash without converting decimal strings to numbers', () => {
    expect(
      parseOpeningPreviewInput(
        {
          openingDate: '2026-10-01',
          cashBalances: [
            { currency: 'USD', amount: '0.000000000001' },
            { currency: 'AUD', amount: '1000.00' },
          ],
        },
        now
      )
    ).toEqual({
      openingDate: '2026-10-01',
      cashBalances: [
        { currency: 'AUD', amount: '1000' },
        { currency: 'USD', amount: '0.000000000001' },
      ],
    })
  })
  it.each([
    null,
    {},
    { openingDate: 1, cashBalances: [] },
    { openingDate: '2026-02-30', cashBalances: input.cashBalances },
    { openingDate: '2026-11-01', cashBalances: input.cashBalances },
    { ...input, cashBalances: [] },
    {
      ...input,
      cashBalances: Array(21).fill({ currency: 'AUD', amount: '0' }),
    },
    { ...input, cashBalances: [null] },
    { ...input, cashBalances: [{ currency: 'aud', amount: '0' }] },
    { ...input, cashBalances: [{ currency: 'ZZZ', amount: '0' }] },
    { ...input, cashBalances: [{ currency: 'AUD', amount: 1 }] },
    { ...input, cashBalances: [{ currency: 'AUD', amount: '-1' }] },
    { ...input, cashBalances: [{ currency: 'AUD', amount: '1e10' }] },
    {
      ...input,
      cashBalances: [{ currency: 'AUD', amount: '0.0000000000001' }],
    },
    {
      ...input,
      cashBalances: [
        { currency: 'AUD', amount: '0' },
        { currency: 'AUD', amount: '1' },
      ],
    },
  ])('rejects invalid preview input %#', (raw) => {
    expect(() => parseOpeningPreviewInput(raw, now)).toThrow()
  })
  it('uses the Sydney day across the UTC boundary', () => {
    expect(sydneyCalendarDate(new Date('2026-10-01T14:00:00Z'))).toBe(
      '2026-10-02'
    )
  })
})

describe('opening inventory and trade-only cash', () => {
  it('includes cutover-day trades in opening inventory but does not charge cash again', () => {
    const result = preview([
      position([
        tx('buy', 'BUY', '2026-10-01', '10', '1000', '10'),
        tx('sell', 'SELL', '2026-10-02', '4', '480', '5'),
      ]),
    ])
    expect(result.parcels[0]).toMatchObject({
      openingQuantity: '10',
      expectedCurrentQuantity: '6',
    })
    expect(result.cashBalances[0]).toEqual({
      currency: 'AUD',
      openingAmount: '1000',
      tradeOnlyEndingAmount: '1475',
      minimumTradeOnlyAmount: '1000',
    })
    expect(result.counts).toEqual({
      parcels: 1,
      postBoundaryTrades: 1,
      blockingIssues: 0,
    })
    expect(result.mode).toBe('PREVIEW_ONLY')
    expect(result.issues[0].code).toBe('CASH_HISTORY_NOT_VERIFIED')
  })
  it('reconstructs old partial and fully closed parcels, including purchases after cutover', () => {
    const result = preview([
      position(
        [
          tx('b', 'BUY', '2026-09-01', '10', '1000'),
          tx('s1', 'SELL', '2026-09-30', '4', '480'),
          tx('s2', 'SELL', '2026-10-02', '6', '720'),
        ],
        '0'
      ),
      {
        ...position([tx('b2', 'BUY', '2026-10-03', '1', '100')], '1'),
        id: 'p2',
      },
    ])
    expect(result.parcels.map((p) => p.openingQuantity)).toEqual(['6', '0'])
    expect(result.cashBalances[0].tradeOnlyEndingAmount).toBe('1620')
  })
  it('reports dated funding gaps even when later sales restore a positive balance', () => {
    const result = preview([
      position(
        [
          tx('b', 'BUY', '2026-10-02', '10', '1000', '10'),
          tx('s', 'SELL', '2026-10-03', '10', '1200'),
        ],
        '0'
      ),
    ])
    expect(result.cashBalances[0]).toMatchObject({
      tradeOnlyEndingAmount: '1190',
      minimumTradeOnlyAmount: '-10',
    })
    expect(result.issues.find((i) => i.code === 'FUNDING_GAP')?.sourceId).toBe(
      'b'
    )
  })
  it('does not infer zero cash or convert another currency to fund missing USD', () => {
    const result = preview([
      {
        ...position([tx('b', 'BUY', '2026-10-02', '1', '10')], '1'),
        currency: 'USD',
      },
    ])
    expect(result.issues.some((i) => i.code === 'MISSING_OPENING_CASH')).toBe(
      true
    )
    expect(result.cashBalances).toHaveLength(1)
    expect(result.cashBalances[0].tradeOnlyEndingAmount).toBe('1000')
  })
  it('requires an explicit zero or actual cash balance for opening holdings currencies too', () => {
    const result = preview([
      {
        ...position([tx('b', 'BUY', '2026-09-01', '1', '10')], '1'),
        currency: 'USD',
      },
    ])
    expect(result.counts.postBoundaryTrades).toBe(0)
    expect(result.issues.some((i) => i.code === 'MISSING_OPENING_CASH')).toBe(
      true
    )
  })
  it('marks intraday funding order unverified and exposes a conservative lower cash bound', () => {
    const result = preview([
      position(
        [
          tx('b', 'BUY', '2026-10-02', '10', '1000', '10'),
          tx('s', 'SELL', '2026-10-02', '10', '1200'),
        ],
        '0'
      ),
    ])
    expect(
      result.issues.some((i) => i.code === 'INTRADAY_ORDER_UNVERIFIED')
    ).toBe(true)
    expect(result.cashBalances[0].minimumTradeOnlyAmount).toBe('-10')
  })
  it('reports malformed parcels, unsupported events and inventory mismatches', () => {
    const result = preview([
      {
        ...position(
          [
            tx('s', 'SELL', '2026-09-01', '1', '10'),
            tx('d', 'DIVIDEND', '2026-09-02', '1', '1'),
            tx('bad', 'BUY', '2026-10-02', '-1', '1'),
          ],
          '2'
        ),
        origin: 'STAKING_REWARD',
        positionType: 'SHORT',
      },
    ])
    expect(result.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'UNSUPPORTED_SHORT',
        'STAKING_INCOME_UNSUPPORTED',
        'OVERSELL',
        'UNSUPPORTED_TRANSACTION',
        'INVALID_TRADE',
        'INVENTORY_MISMATCH',
        'OPENING_INVENTORY_NEGATIVE',
      ])
    )
  })
  it('rejects missing and multiple BUY parcels as blockers', () => {
    expect(
      preview([position([], '0')]).issues.some(
        (i) => i.code === 'PARCEL_BUY_COUNT'
      )
    ).toBe(true)
    expect(
      preview([
        position(
          [
            tx('b1', 'BUY', '2026-09-01', '1', '10'),
            tx('b2', 'BUY', '2026-09-02', '1', '10'),
          ],
          '2'
        ),
      ]).issues.some((i) => i.code === 'PARCEL_BUY_COUNT')
    ).toBe(true)
  })
  it('blocks future trades rather than incorporating them into current cash', () => {
    const result = preview([
      position([tx('b', 'BUY', '2026-11-01', '1', '10')], '1'),
    ])
    expect(result.issues.some((i) => i.code === 'FUTURE_TRANSACTION')).toBe(
      true
    )
    expect(result.counts.postBoundaryTrades).toBe(0)
  })
  it('does not claim imported parcel currency is the original execution cash currency', () => {
    const result = preview([
      {
        ...position([tx('b', 'BUY', '2026-09-01', '1', '10')], '1'),
        origin: 'IMPORT_TRADE',
      },
    ])
    expect(
      result.issues.some((i) => i.code === 'IMPORT_CASH_CURRENCY_UNVERIFIED')
    ).toBe(true)
  })
  it('flags invalid stored quantities rather than treating them as reconciled', () => {
    const result = preview([
      position([tx('b', 'BUY', '2026-09-01', '1', '10')], 'NaN'),
    ])
    expect(
      result.issues.some((i) => i.code === 'INVALID_POSITION_QUANTITY')
    ).toBe(true)
  })
  it('does not flag a same-timestamp disposal as preceding its own purchase by ID order', () => {
    const result = preview([
      position(
        [
          tx('z-buy', 'BUY', '2026-09-01', '1', '10'),
          tx('a-sell', 'SELL', '2026-09-01', '1', '10'),
        ],
        '0'
      ),
    ])
    expect(result.issues.some((i) => i.code === 'OVERSELL')).toBe(false)
  })
  it('blocks demo, closed and unresolved-import accounts without dropping their records', () => {
    const result = buildOpeningPreview(
      { ...account, isDemo: true, status: 'CLOSED' },
      [],
      input,
      [{ id: 'imp', reason: 'Unsupported transfer' }],
      now
    )
    expect(result.counts.blockingIssues).toBe(3)
    expect(result.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'DEMO_ACCOUNT',
        'CLOSED_ACCOUNT',
        'IMPORT_RECONCILIATION',
      ])
    )
  })
  it('retains crypto dust and fingerprints request and source changes deterministically', () => {
    const p = position(
      [tx('b', 'BUY', '2026-09-01', '0.000000000001', '0')],
      '0.000000000001'
    )
    const first = preview([p])
    expect(first.parcels[0].openingQuantity).toBe('0.000000000001')
    expect(first.counts.blockingIssues).toBe(0)
    expect(preview([p]).sourceFingerprint).toBe(first.sourceFingerprint)
    expect(preview([{ ...p, quantity: '0' }]).sourceFingerprint).not.toBe(
      first.sourceFingerprint
    )
    expect(
      preview([p], {
        ...input,
        cashBalances: [{ currency: 'AUD', amount: '999' }],
      }).sourceFingerprint
    ).not.toBe(first.sourceFingerprint)
  })
})
