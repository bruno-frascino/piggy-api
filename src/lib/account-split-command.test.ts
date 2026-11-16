import { describe, expect, it } from 'vitest'
import {
  prepareAccountSplit,
  reviewAccountSplit,
  type SplitReviewParcel,
} from './account-split-command.js'

const now = new Date('2026-11-15T01:00:00Z')
const input = {
  idempotencyKey: 'key-1',
  assetId: 'asset-1',
  effectiveDate: '2026-10-01',
  newUnits: '2',
  oldUnits: '1',
  sourceReference: 'statement-1',
  statementConfirmed: true,
} as const

function parcel(overrides: Partial<SplitReviewParcel> = {}): SplitReviewParcel {
  return {
    id: 'parcel-1',
    accountId: 'account-1',
    assetId: 'asset-1',
    positionType: 'LONG',
    acquisitionDate: '2026-01-02',
    acquisitionQuantity: '10',
    recordedQuantity: '10',
    events: [],
    ...overrides,
  }
}

function snapshot(parcels: SplitReviewParcel[]) {
  return {
    accountId: 'account-1',
    assetType: 'EQUITY',
    openingDate: '2026-01-01',
    asOfDate: '2026-11-01',
    parcels,
  }
}

describe('statement-supported account split preparation', () => {
  it('binds the normalized request and payload hash to the account', () => {
    const prepared = prepareAccountSplit(input, 'account-1', now)
    expect(prepared.request).toEqual(input)
    expect(prepareAccountSplit({ ...input }, 'account-1', now)).toEqual(
      prepared
    )
    expect(prepareAccountSplit(input, 'account-2', now).payloadHash).not.toBe(
      prepared.payloadHash
    )
    expect(
      prepareAccountSplit({ ...input, newUnits: '3' }, 'account-1', now)
        .payloadHash
    ).not.toBe(prepared.payloadHash)
  })

  it.each([
    { ...input, statementConfirmed: false },
    { ...input, effectiveDate: '2026-11-16' },
    { ...input, effectiveDate: '2026-02-30' },
    { ...input, newUnits: '0' },
    { ...input, newUnits: '02' },
    { ...input, newUnits: '1', oldUnits: '1' },
    { ...input, sourceReference: ' statement' },
    { ...input, unexpected: true },
  ])('rejects invalid statement input', (invalid) => {
    expect(() => prepareAccountSplit(invalid, 'account-1', now)).toThrow()
  })
})

describe('account split parcel review', () => {
  const prepared = prepareAccountSplit(input, 'account-1', now)

  it('plans all held parcels using earlier sales while excluding closed and later acquisitions', () => {
    const reviewed = reviewAccountSplit(
      prepared,
      snapshot([
        parcel({
          id: 'z',
          recordedQuantity: '8',
          events: [
            { id: 'sale', type: 'SELL', date: '2026-05-01', quantity: '2' },
          ],
        }),
        parcel({ id: 'a', acquisitionQuantity: '4', recordedQuantity: '4' }),
        parcel({
          id: 'closed',
          recordedQuantity: '0',
          events: [
            { id: 'close', type: 'SELL', date: '2026-06-01', quantity: '10' },
          ],
        }),
        parcel({ id: 'later-buy', acquisitionDate: '2026-10-02' }),
      ])
    )
    expect(reviewed).toEqual({
      parcels: [
        { positionId: 'a', beforeQuantity: '4', afterQuantity: '8' },
        { positionId: 'z', beforeQuantity: '8', afterQuantity: '16' },
      ],
    })
  })

  it('blocks effective same-day or later sales and later split actions', () => {
    expect(() =>
      reviewAccountSplit(
        prepared,
        snapshot([
          parcel({
            recordedQuantity: '9',
            events: [
              { id: 'sale', type: 'SELL', date: '2026-10-02', quantity: '1' },
            ],
          }),
        ])
      )
    ).toThrow('Void later sales')
    expect(() =>
      reviewAccountSplit(
        prepared,
        snapshot([
          parcel({
            recordedQuantity: '9',
            events: [
              { id: 'sale', type: 'SELL', date: '2026-10-01', quantity: '1' },
            ],
          }),
        ])
      )
    ).toThrow('Void later sales')
    expect(() =>
      reviewAccountSplit(
        prepared,
        snapshot([
          parcel({
            recordedQuantity: '20',
            events: [
              {
                id: 'other',
                type: 'SPLIT',
                date: '2026-10-02',
                newUnits: '2',
                oldUnits: '1',
              },
            ],
          }),
        ])
      )
    ).toThrow('Void later sales')
  })

  it('uses earlier split-adjusted units rather than original BUY units', () => {
    expect(
      reviewAccountSplit(
        prepared,
        snapshot([
          parcel({
            recordedQuantity: '20',
            events: [
              {
                id: 'previous',
                type: 'SPLIT',
                date: '2026-04-01',
                newUnits: '2',
                oldUnits: '1',
              },
            ],
          }),
        ])
      )
    ).toEqual({
      parcels: [
        { positionId: 'parcel-1', beforeQuantity: '20', afterQuantity: '40' },
      ],
    })
  })

  it('rejects inconsistent ownership, stale inventory and duplicate parcels', () => {
    expect(() =>
      reviewAccountSplit(
        prepared,
        snapshot([parcel({ accountId: 'account-2' })])
      )
    ).toThrow('Invalid or inconsistent')
    expect(() =>
      reviewAccountSplit(prepared, snapshot([parcel({ assetId: 'other' })]))
    ).toThrow('Invalid or inconsistent')
    expect(() =>
      reviewAccountSplit(
        prepared,
        snapshot([parcel({ recordedQuantity: '9' })])
      )
    ).toThrow('does not match effective history')
    expect(() =>
      reviewAccountSplit(prepared, snapshot([parcel(), parcel()]))
    ).toThrow('Invalid or inconsistent')
    expect(() =>
      reviewAccountSplit(prepared, {
        ...snapshot([parcel()]),
        accountId: 'account-2',
      })
    ).toThrow('reviewed period')
  })

  it('rejects unsupported, ambiguous and unrepresentable actions', () => {
    expect(() =>
      reviewAccountSplit(prepared, {
        ...snapshot([parcel()]),
        assetType: 'CRYPTO',
      })
    ).toThrow('equity or ETF')
    expect(() =>
      reviewAccountSplit(prepared, {
        ...snapshot([parcel()]),
        openingDate: input.effectiveDate,
      })
    ).toThrow('reviewed period')
    expect(() =>
      reviewAccountSplit(
        prepared,
        snapshot([parcel({ acquisitionDate: input.effectiveDate })])
      )
    ).toThrow('ambiguous date')
    expect(() =>
      reviewAccountSplit(
        prepared,
        snapshot([parcel({ positionType: 'SHORT' })])
      )
    ).toThrow('Only long parcels')
    expect(() => reviewAccountSplit(prepared, snapshot([]))).toThrow(
      'No eligible holdings'
    )
    const consolidation = prepareAccountSplit(
      {
        ...input,
        newUnits: '1',
        oldUnits: '3',
      },
      'account-1',
      now
    )
    expect(() =>
      reviewAccountSplit(
        consolidation,
        snapshot([parcel({ acquisitionQuantity: '1', recordedQuantity: '1' })])
      )
    ).toThrow('requires rounding')
  })
})
