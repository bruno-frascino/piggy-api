import { describe, expect, it } from 'vitest'
import { parseKrakenCsv } from './adapters/kraken-csv.js'
import { loadKrakenFixture } from './kraken-fixture.js'
import { buildPlan, sydneyDate, sydneyDateKey } from './planner.js'
import type { ExistingParcel, NormalizedEvent, PlannerEvent } from './types.js'

const NOW = new Date('2026-10-18T00:00:00Z')
const rate = (currency: string) => (currency === 'USD' ? 1.5 : 1)

function plannerEvents(events: NormalizedEvent[]): PlannerEvent[] {
  return events.map((event, index) => ({ ...event, id: 'e' + index }))
}

function plan(
  events: PlannerEvent[],
  overrides: Partial<Parameters<typeof buildPlan>[1]> = {}
) {
  return buildPlan(events, {
    now: NOW,
    dustThresholdAud: '1',
    existingParcels: [],
    rateToAud: rate,
    ...overrides,
  })
}

function ev(
  overrides: Partial<PlannerEvent> & Pick<PlannerEvent, 'id' | 'kind'>
): PlannerEvent {
  return {
    source: 'KRAKEN',
    externalId: 'KRAKEN:order:' + overrides.id,
    occurredAt: new Date('2026-01-10T01:00:00Z'),
    baseAsset: 'BTC',
    quoteCurrency: 'AUD',
    quantity: '1',
    price: '100',
    grossValue: '100',
    fee: '1',
    raw: {},
    ...overrides,
  }
}

describe('sydney dates', () => {
  it('uses the Australia/Sydney calendar date', () => {
    expect(sydneyDateKey(new Date('2026-10-15T18:59:34Z'))).toBe('2026-10-16')
    expect(sydneyDate(new Date('2026-10-15T18:59:34Z')).toISOString()).toBe(
      '2026-10-16T00:00:00.000Z'
    )
    expect(sydneyDateKey(new Date('2026-06-15T13:01:31Z'))).toBe('2026-06-15')
  })
})

describe('buildPlan — golden table for the real Kraken export', () => {
  const fixture = loadKrakenFixture()
  const parsed = parseKrakenCsv(fixture.trades, fixture.ledgers)
  const result = plan(plannerEvents(parsed.events), {
    ledgerBalances: parsed.ledgerBalances,
  })

  const golden = [
    {
      symbol: 'SOL-AUD',
      acquired: '2025-10-31',
      disposed: '2025-11-01',
      qty: 12.40671641,
      cost: 3500.0,
      proceeds: 3507.67343,
      fees: 9.18618,
      gain: -1.51,
    },
    {
      symbol: 'BTC-AUD',
      acquired: '2026-05-03',
      disposed: '2026-05-16',
      qty: 0.03197303,
      cost: 3498.47913,
      proceeds: 3493.69298,
      fees: 10.48108,
      gain: -15.27,
    },
    {
      symbol: 'BTC-AUD',
      acquired: '2026-05-20',
      disposed: '2026-06-01',
      qty: 0.03189703,
      cost: 3483.21977,
      proceeds: 3197.2913,
      fees: 9.59187,
      gain: -295.52,
    },
    {
      symbol: 'BTC-AUD',
      acquired: '2026-06-15',
      disposed: '2026-08-21',
      qty: 0.03376209,
      cost: 3187.68979,
      proceeds: 3615.36964,
      fees: 28.92295,
      gain: 398.76,
    },
    {
      symbol: 'BTC-AUD',
      acquired: '2026-10-06',
      disposed: '2026-10-16',
      qty: 0.0290832,
      cost: 3577.0,
      proceeds: 3459.51644,
      fees: 10.41423,
      gain: -127.9,
    },
  ]

  it('creates 5 import parcels and 5 resolved sells with no issues', () => {
    expect(result.summary).toMatchObject({
      buys: 5,
      sells: 5,
      unsupported: 0,
      blockingIssues: 0,
    })
    expect(result.issues).toEqual([])
    expect(result.sells.every((s) => s.resolved)).toBe(true)
  })

  it.each(golden.map((g, i) => [i, g] as const))(
    'parcel %i matches the golden row',
    (index, row) => {
      const parcel = result.newPositions.filter(
        (p) => p.origin === 'IMPORT_TRADE'
      )[index]
      const sell = result.sells[index]
      const allocation = sell.allocations[0]

      expect(parcel.symbol).toBe(row.symbol)
      expect(parcel.exchangeCode).toBe('KRAKEN')
      expect(parcel.openDate.toISOString().slice(0, 10)).toBe(row.acquired)
      expect(sell.sellDate.toISOString().slice(0, 10)).toBe(row.disposed)
      expect(Number(parcel.quantity)).toBeCloseTo(row.qty, 8)

      const costBase =
        Number(parcel.entryPrice) * Number(parcel.quantity) +
        Number(parcel.buyFees)
      expect(costBase).toBeCloseTo(row.cost, 1)
      expect(Number(allocation.totalValue)).toBeCloseTo(row.proceeds, 2)
      expect(Number(allocation.fees)).toBeCloseTo(row.fees, 2)
      expect(allocation.quantity).toBe(parcel.quantity)

      const gain =
        Number(allocation.totalValue) - Number(allocation.fees) - costBase
      expect(Math.abs(gain - row.gain)).toBeLessThan(0.02)
    }
  )

  it('suggests FIFO: every sell closes the preceding buy', () => {
    const parcels = result.newPositions.filter(
      (p) => p.origin === 'IMPORT_TRADE'
    )
    result.sells.forEach((sell, index) => {
      expect(sell.allocations).toHaveLength(1)
      expect(sell.allocations[0].positionRef).toBe(parcels[index].ref)
      expect(sell.userOverridden).toBe(false)
    })
  })

  it('pre-fills close reasons from the order type', () => {
    expect(result.sells.map((s) => s.closeReason)).toEqual([
      'STOP_LOSS',
      null,
      null,
      'STOP_LOSS',
      null,
    ])
  })

  it('skips every completed staking month as dust and defers the current one', () => {
    expect(result.summary.stakingMonthsApplied).toBe(0)
    expect(result.summary.stakingMonthsDust).toBe(15)
    expect(result.summary.stakingMonthsDeferred).toBe(2)
    expect(Number(result.summary.dustTotalAud)).toBeGreaterThan(0)
    expect(Number(result.summary.dustTotalAud)).toBeLessThan(15)
  })

  it('reconciles with the ledger balances, counting dust and deferred rewards', () => {
    expect(result.reconciliation).toEqual({ reconciled: true, rows: [] })
  })

  it('shows a per-asset difference when the first buy is missing', () => {
    const firstBuy = parsed.events[0].externalId
    const withoutFirstBuy = plannerEvents(
      parsed.events.filter((e) => e.externalId !== firstBuy)
    )
    const broken = plan(withoutFirstBuy, {
      ledgerBalances: parsed.ledgerBalances,
    })
    expect(broken.reconciliation?.reconciled).toBe(false)
    expect(
      broken.issues.some(
        (i) => i.type === 'INSUFFICIENT_HOLDINGS' && i.blocking
      )
    ).toBe(true)
  })
})

describe('buildPlan — reconciliation failure detail', () => {
  it('reports the difference per asset', () => {
    const result = plan([ev({ id: 'b1', kind: 'BUY', quantity: '1' })], {
      ledgerBalances: { BTC: '3' },
    })
    expect(result.reconciliation).toEqual({
      reconciled: false,
      rows: [{ asset: 'BTC', expected: '3', simulated: '1', difference: '-2' }],
    })
  })
})

describe('buildPlan — sell allocation', () => {
  const buy = (id: string, day: string, qty: string) =>
    ev({
      id,
      kind: 'BUY',
      quantity: qty,
      occurredAt: new Date(day + 'T01:00:00Z'),
    })
  const sell = (id: string, qty: string, extra: Partial<PlannerEvent> = {}) =>
    ev({
      id,
      kind: 'SELL',
      quantity: qty,
      price: '200',
      grossValue: String(Number(qty) * 200),
      fee: '2',
      occurredAt: new Date('2026-03-01T01:00:00Z'),
      ...extra,
    })

  it('splits a sell across parcels FIFO and prorates gross and fees', () => {
    const result = plan([
      buy('b1', '2026-01-01', '1'),
      buy('b2', '2026-01-02', '2'),
      sell('s1', '2.5'),
    ])
    const [s] = result.sells
    expect(s.allocations.map((a) => [a.positionRef, a.quantity])).toEqual([
      ['event:KRAKEN:order:b1', '1'],
      ['event:KRAKEN:order:b2', '1.5'],
    ])
    expect(s.allocations.map((a) => Number(a.totalValue))).toEqual([200, 300])
    expect(s.allocations.map((a) => Number(a.fees))).toEqual([0.8, 1.2])
  })

  it('honours a user allocation that overrides FIFO', () => {
    const result = plan([
      buy('b1', '2026-01-01', '1'),
      buy('b2', '2026-01-02', '1'),
      sell('s1', '1', {
        resolution: {
          allocations: [
            { positionRef: 'event:KRAKEN:order:b2', quantity: '1' },
          ],
        },
      }),
    ])
    expect(result.sells[0].userOverridden).toBe(true)
    expect(result.sells[0].allocations[0].positionRef).toBe(
      'event:KRAKEN:order:b2'
    )
    expect(result.issues).toEqual([])
  })

  it('rejects an allocation that does not add up or uses an ineligible parcel', () => {
    const short = plan([
      buy('b1', '2026-01-01', '2'),
      sell('s1', '2', {
        resolution: {
          allocations: [
            { positionRef: 'event:KRAKEN:order:b1', quantity: '1' },
          ],
        },
      }),
    ])
    expect(short.issues[0]).toMatchObject({
      type: 'INVALID_ALLOCATION',
      blocking: true,
    })
    expect(short.sells[0].resolved).toBe(false)

    const unknown = plan([
      buy('b1', '2026-01-01', '2'),
      sell('s1', '1', {
        resolution: { allocations: [{ positionRef: 'nope', quantity: '1' }] },
      }),
    ])
    expect(unknown.issues[0].type).toBe('INVALID_ALLOCATION')
  })

  it('does not let a sell draw on a parcel bought after it', () => {
    const result = plan([sell('s1', '1'), buy('b1', '2026-04-01', '1')])
    expect(result.issues[0]).toMatchObject({
      type: 'INSUFFICIENT_HOLDINGS',
      blocking: true,
    })
  })

  it('uses existing open parcels of the same venue, FIFO before newer imports', () => {
    const existing: ExistingParcel = {
      id: 'pos-old',
      baseAsset: 'BTC',
      exchangeCode: 'KRAKEN_USD',
      currency: 'USD',
      openDate: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingQty: '1',
      entryPrice: '50',
    }
    const result = plan([buy('b1', '2026-01-01', '1'), sell('s1', '1')], {
      existingParcels: [existing],
    })
    expect(result.sells[0].allocations[0].positionRef).toBe('pos-old')
    expect(result.sells[0].eligible.map((e) => e.positionRef)).toEqual([
      'pos-old',
      'event:KRAKEN:order:b1',
    ])
  })

  it('ignores parcels of other venues', () => {
    const other: ExistingParcel = {
      id: 'pos-asx',
      baseAsset: 'BTC',
      exchangeCode: 'ASX',
      currency: 'AUD',
      openDate: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingQty: '5',
      entryPrice: '50',
    }
    const result = plan([sell('s1', '1')], { existingParcels: [other] })
    expect(result.issues[0].type).toBe('INSUFFICIENT_HOLDINGS')
  })

  it('converts a USD sale to the parcel currency via AUD', () => {
    const result = plan([
      buy('b1', '2026-01-01', '1'),
      sell('s1', '1', {
        quoteCurrency: 'USD',
        price: '100',
        grossValue: '100',
        fee: '1',
      }),
    ])
    const [allocation] = result.sells[0].allocations
    // US$100 -> A$150 at 1.5 (the parcel is an AUD parcel)
    expect(Number(allocation.totalValue)).toBeCloseTo(150, 8)
    expect(Number(allocation.fees)).toBeCloseTo(1.5, 8)
    expect(allocation.notes).toContain('sold in USD')
  })

  it('raises MISSING_FX when no rate is available for a cross-currency sale', () => {
    const result = plan(
      [buy('b1', '2026-01-01', '1'), sell('s1', '1', { quoteCurrency: 'USD' })],
      { rateToAud: (currency) => (currency === 'AUD' ? 1 : null) }
    )
    expect(result.issues[0]).toMatchObject({
      type: 'MISSING_FX',
      blocking: true,
    })
    expect(result.sells[0].resolved).toBe(false)
  })

  it('lets the user skip an event and override the close reason', () => {
    const result = plan([
      buy('b1', '2026-01-01', '1'),
      sell('s1', '1', {
        resolution: { closeReason: 'MANUAL' },
        raw: { ordertype: 'stop market' },
      }),
      buy('b2', '2026-01-03', '1'),
      ev({ id: 'skipme', kind: 'BUY', resolution: { skip: true } }),
    ])
    expect(result.sells[0].closeReason).toBe('MANUAL')
    expect(result.skipped).toHaveLength(1)
    expect(result.summary.buys).toBe(2)
  })

  it('maps take-profit orders to TARGET', () => {
    const result = plan([
      buy('b1', '2026-01-01', '1'),
      sell('s1', '1', { raw: { ordertype: 'take-profit' } }),
    ])
    expect(result.sells[0].closeReason).toBe('TARGET')
  })
})

describe('buildPlan — staking', () => {
  const reward = (id: string, day: string, qty: string, usd?: string) =>
    ev({
      id,
      kind: 'STAKING_REWARD',
      externalId: 'KRAKEN:ledger:' + id,
      baseAsset: 'SOL',
      quoteCurrency: undefined,
      quantity: qty,
      occurredAt: new Date(day + 'T05:00:00Z'),
      raw: usd === undefined ? {} : { fmvUsd: usd },
    })

  it('aggregates a completed month into one parcel at the last reward date', () => {
    const result = plan([
      reward('r1', '2026-03-05', '0.5', '40'),
      reward('r2', '2026-03-20', '0.5', '60'),
    ])
    expect(result.newPositions).toHaveLength(1)
    const [parcel] = result.newPositions
    expect(parcel).toMatchObject({
      origin: 'STAKING_REWARD',
      externalRef: 'KRAKEN:staking:SOL:2026-03',
      symbol: 'SOL-AUD',
      exchangeCode: 'KRAKEN',
      quantity: '1',
      buyFees: '0',
      tags: ['import:kraken', 'staking'],
    })
    expect(parcel.openDate.toISOString()).toBe('2026-03-20T00:00:00.000Z')
    // (40 + 60) USD x 1.5
    expect(Number(parcel.totalBuyValue)).toBeCloseTo(150, 8)
    expect(Number(parcel.entryPrice)).toBeCloseTo(150, 8)
  })

  it('skips a month below the dust threshold, and a sale short by the dust raises DUST_SHORTFALL', () => {
    const result = plan([
      ev({
        id: 'b1',
        kind: 'BUY',
        baseAsset: 'SOL',
        quantity: '1',
        occurredAt: new Date('2026-01-01T00:00:00Z'),
      }),
      reward('r1', '2026-02-05', '0.001', '0.2'),
      ev({
        id: 's1',
        kind: 'SELL',
        baseAsset: 'SOL',
        quantity: '1.001',
        price: '200',
        grossValue: '200.2',
        fee: '2',
        occurredAt: new Date('2026-04-01T00:00:00Z'),
      }),
    ])
    expect(result.staking[0].status).toBe('DUST')
    expect(result.newPositions).toHaveLength(1)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      type: 'DUST_SHORTFALL',
      blocking: false,
    })
    const [sell] = result.sells
    expect(sell.resolved).toBe(true)
    expect(sell.dustIgnored).toBe('0.001')
    // proceeds are prorated to the quantity actually allocated
    expect(Number(sell.allocations[0].totalValue)).toBeCloseTo(
      200.2 * (1 / 1.001),
      6
    )
  })

  it('keeps a shortfall larger than the skipped dust as INSUFFICIENT_HOLDINGS', () => {
    const result = plan([
      ev({
        id: 'b1',
        kind: 'BUY',
        baseAsset: 'SOL',
        quantity: '1',
        occurredAt: new Date('2026-01-01T00:00:00Z'),
      }),
      reward('r1', '2026-02-05', '0.001', '0.2'),
      ev({
        id: 's1',
        kind: 'SELL',
        baseAsset: 'SOL',
        quantity: '1.5',
        occurredAt: new Date('2026-04-01T00:00:00Z'),
      }),
    ])
    expect(result.issues[0]).toMatchObject({
      type: 'INSUFFICIENT_HOLDINGS',
      blocking: true,
    })
  })

  it('defers rewards of the current Sydney month', () => {
    const result = plan([reward('r1', '2026-10-05', '1', '500')])
    expect(result.staking[0].status).toBe('DEFERRED')
    expect(result.newPositions).toHaveLength(0)
  })

  it('blocks a month whose value is unknown, and accepts a manual value or fallback', () => {
    const noValue = plan([reward('r1', '2026-03-05', '1')])
    expect(noValue.issues[0]).toMatchObject({
      type: 'MISSING_FMV',
      blocking: true,
    })
    expect(noValue.staking[0].status).toBe('BLOCKED')

    const manual = plan([
      { ...reward('r1', '2026-03-05', '1'), resolution: { fmvAud: '25' } },
    ])
    expect(manual.newPositions[0].totalBuyValue).toBe('25')

    const fallback = plan([reward('r1', '2026-03-05', '1')], {
      fmvFallbackAud: new Map([['r1', '30']]),
    })
    expect(fallback.newPositions[0].totalBuyValue).toBe('30')
  })

  it('lets a staking parcel be sold', () => {
    const result = plan([
      reward('r1', '2026-03-05', '2', '300'),
      ev({
        id: 's1',
        kind: 'SELL',
        baseAsset: 'SOL',
        quantity: '1',
        occurredAt: new Date('2026-05-01T00:00:00Z'),
      }),
    ])
    expect(result.sells[0].allocations[0].positionRef).toBe(
      'staking:KRAKEN:staking:SOL:2026-03'
    )
  })
})

describe('buildPlan — unsupported events and ordering', () => {
  it('lists unsupported events with their reason and never as positions', () => {
    const result = plan([
      ev({
        id: 'u1',
        kind: 'UNSUPPORTED',
        warning: 'Margin trades are not supported',
      }),
    ])
    expect(result.unsupported).toEqual([
      {
        eventId: 'u1',
        externalId: 'KRAKEN:order:u1',
        reason: 'Margin trades are not supported',
      },
    ])
    expect(result.newPositions).toEqual([])
  })

  it('orders steps chronologically with parcels before sells at the same instant', () => {
    const at = new Date('2026-02-01T00:00:00Z')
    const result = plan([
      ev({ id: 's1', kind: 'SELL', occurredAt: at }),
      ev({ id: 'b1', kind: 'BUY', occurredAt: at }),
    ])
    expect(result.steps.map((s) => s.type)).toEqual(['PARCEL', 'SELL'])
  })

  it('omits reconciliation when no ledger balances are supplied', () => {
    expect(plan([]).reconciliation).toBeNull()
  })
})
