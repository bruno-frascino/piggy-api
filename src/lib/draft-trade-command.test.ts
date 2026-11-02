import { describe, expect, it } from 'vitest'
import {
  prepareDraftTradeRequest,
  prepareDraftTradeCash,
  replayDraftTradeParcels,
  requireSameDraftTradeIdentity,
} from './draft-trade-command.js'

const now = new Date('2026-10-31')
const buy = {
  accountId: 'a1',
  idempotencyKey: 'buy-key',
  effectiveDate: '2026-10-02',
  sequence: 1,
  currency: 'AUD',
  quantity: '10',
  price: '5',
  fees: '1',
  kind: 'BUY',
  assetId: 'asset1',
}
const request = (raw: unknown = buy) =>
  prepareDraftTradeRequest(raw, now).request
const sale = (quantity = '4', overrides: Record<string, unknown> = {}) =>
  request({
    accountId: 'a1',
    idempotencyKey: 'sell-key',
    effectiveDate: '2026-10-03',
    sequence: 1,
    currency: 'AUD',
    quantity,
    price: '6',
    fees: '1',
    kind: 'SELL',
    parcelKey: 'buy1',
    ...overrides,
  })

describe('confirmed opening unit replay', () => {
  const opening = [
    {
      parcelKey: 'opening:row1',
      positionId: 'p1',
      symbol: 'TEST',
      currency: 'AUD',
      quantity: '0.000000000003',
    },
  ]
  it('uses exact boundary units without a synthetic acquisition or mutating the opening', () => {
    const trades = [
      {
        id: 'sell1',
        parcelKey: opening[0].parcelKey,
        request: sale('0.000000000001', { parcelKey: opening[0].parcelKey }),
      },
    ]
    expect(replayDraftTradeParcels(trades, opening)[0]).toMatchObject({
      assetId: null,
      positionId: 'p1',
      acquired: '0.000000000003',
      remaining: '0.000000000002',
    })
    expect(replayDraftTradeParcels([], opening)[0].remaining).toBe(
      '0.000000000003'
    )
    expect(opening[0].quantity).toBe('0.000000000003')
  })
  it('rejects oversales, zero-unit parcels and currency mismatch', () => {
    for (const trade of [
      sale('0.000000000004', { parcelKey: opening[0].parcelKey }),
      sale('0.000000000001', {
        parcelKey: opening[0].parcelKey,
        currency: 'USD',
      }),
    ])
      expect(() =>
        replayDraftTradeParcels(
          [{ id: 'sale1', parcelKey: opening[0].parcelKey, request: trade }],
          opening
        )
      ).toThrow('sufficient units')
    expect(() =>
      replayDraftTradeParcels(
        [
          {
            id: 'sale1',
            parcelKey: opening[0].parcelKey,
            request: sale('1', { parcelKey: opening[0].parcelKey }),
          },
        ],
        [{ ...opening[0], quantity: '0' }]
      )
    ).toThrow('sufficient units')
  })
  it('rejects duplicate seeds and appending an acquisition to opening units', () => {
    expect(() => replayDraftTradeParcels([], [...opening, ...opening])).toThrow(
      'unique'
    )
    expect(() =>
      replayDraftTradeParcels(
        [
          {
            id: opening[0].parcelKey,
            parcelKey: opening[0].parcelKey,
            request: request(),
          },
        ],
        opening
      )
    ).toThrow('exactly one BUY')
  })
})

describe('isolated proposed trade contracts', () => {
  it('allows financial corrections without rebinding account, asset, selected parcel or currency', () => {
    const original = request()
    expect(() =>
      requireSameDraftTradeIdentity(
        original,
        request({ ...buy, quantity: '9', price: '6' })
      )
    ).not.toThrow()
    expect(() => requireSameDraftTradeIdentity(sale(), sale('3'))).not.toThrow()
    for (const next of [
      request({ ...buy, assetId: 'other' }),
      request({ ...buy, accountId: 'other' }),
      request({ ...buy, currency: 'USD' }),
      sale(),
    ])
      expect(() => requireSameDraftTradeIdentity(original, next)).toThrow(
        'cannot rebind'
      )
    expect(() =>
      requireSameDraftTradeIdentity(sale(), sale('3', { parcelKey: 'other' }))
    ).toThrow('cannot rebind')
    expect(() => requireSameDraftTradeIdentity(sale(), original)).toThrow(
      'cannot rebind'
    )
  })
  it('normalizes decimal request identity and derives exact consideration and fee cash', () => {
    const first = prepareDraftTradeRequest(buy, now)
    const second = prepareDraftTradeRequest(
      {
        ...buy,
        quantity: '10.000',
        price: '5.00',
        fees: '1.0',
      },
      now
    )
    expect(first.requestHash).toBe(second.requestHash)
    const cash = prepareDraftTradeCash(first.request, 'buy1', now)
    expect(cash.command).toMatchObject({
      consideration: { currency: 'AUD', amount: '50' },
      transactionIds: ['buy1'],
      source: { origin: 'MANUAL', reference: 'draft-trade:buy1' },
    })
    expect(cash.legs.map((leg) => leg.amount)).toEqual(['-50', '-1'])
    expect(
      prepareDraftTradeCash(sale(), 'sell1', now).legs.map((leg) => leg.amount)
    ).toEqual(['24', '-1'])
  })
  it('creates one parcel per BUY and partially then fully consumes only that parcel', () => {
    const trades = [
      { id: 'buy1', parcelKey: 'buy1', request: request() },
      { id: 'sell1', parcelKey: 'buy1', request: sale() },
    ]
    expect(replayDraftTradeParcels(trades)).toEqual([
      {
        parcelKey: 'buy1',
        assetId: 'asset1',
        currency: 'AUD',
        acquired: '10',
        remaining: '6',
      },
    ])
    expect(
      replayDraftTradeParcels([
        ...trades,
        {
          id: 'sell2',
          parcelKey: 'buy1',
          request: sale('6', { effectiveDate: '2026-10-04' }),
        },
      ])[0].remaining
    ).toBe('0')
  })
  it('preserves tiny fractional units without legacy float tolerances', () => {
    const tiny = request({ ...buy, quantity: '0.000000000003', price: '1' })
    expect(
      replayDraftTradeParcels([
        { id: 'buy1', parcelKey: 'buy1', request: tiny },
        { id: 'sell1', parcelKey: 'buy1', request: sale('0.000000000001') },
      ])[0].remaining
    ).toBe('0.000000000002')
  })
  it.each([
    null,
    [],
    {},
    { ...buy, kind: 'SHORT' },
    { ...buy, assetId: '' },
    { ...buy, assetId: ' padded ' },
    { ...buy, accountId: '\n' },
    { ...buy, price: '0' },
    { ...buy, quantity: '-1' },
    { ...buy, fees: 0 },
    { ...buy, quantity: '0.0000000000001' },
    { ...buy, currency: 'BAD' },
    { ...buy, sequence: 0 },
    { ...buy, effectiveDate: '2030-01-01' },
    { ...buy, price: '99999999999999999999999999', quantity: '10' },
    { ...buy, price: '0.1', quantity: '0.000000000001' },
    { ...buy, parcelKey: 'cannot-append' },
    { ...buy, extra: true },
  ])(
    'rejects invalid requests and precision overflow without rounding %#',
    (raw) => {
      expect(() => prepareDraftTradeRequest(raw, now)).toThrow()
    }
  )
  it.each([
    sale('11'),
    sale('1', { effectiveDate: '2026-10-01' }),
    sale('1', { currency: 'USD' }),
    sale('1', { parcelKey: 'other' }),
  ])(
    'rejects oversells, earlier sells and cross-parcel/currency allocation %#',
    (sell) => {
      expect(() =>
        replayDraftTradeParcels([
          { id: 'buy1', parcelKey: 'buy1', request: request() },
          { id: 'sell1', parcelKey: 'buy1', request: sell },
        ])
      ).toThrow('earlier draft BUY')
    }
  )
  it('rejects appending a BUY to an existing parcel', () => {
    expect(() =>
      replayDraftTradeParcels([
        { id: 'buy1', parcelKey: 'buy1', request: request() },
        { id: 'buy2', parcelKey: 'buy1', request: request() },
      ])
    ).toThrow('exactly one BUY')
  })
})
