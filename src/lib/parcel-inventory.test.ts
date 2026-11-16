import { describe, expect, it } from 'vitest'
import { projectParcelInventory } from './parcel-inventory.js'

describe('split-aware parcel inventory projection', () => {
  it('leaves an untouched acquisition unchanged', () => {
    expect(
      projectParcelInventory({
        acquisitionDate: '2026-01-01',
        acquisitionQuantity: '0.1200',
        events: [],
      })
    ).toEqual({
      remainingQuantity: '0.12',
      remainingCostFraction: { numerator: '1', denominator: '1' },
      sales: [],
    })
  })

  it('allocates original acquisition cost across sales before and after a split', () => {
    const events = [
      { id: 'later', date: '2026-03-01', type: 'SELL', quantity: '4' },
      {
        id: 'split',
        date: '2026-02-01',
        type: 'SPLIT',
        newUnits: '2',
        oldUnits: '1',
      },
      { id: 'earlier', date: '2026-01-02', type: 'SELL', quantity: '2' },
    ] as const
    expect(
      projectParcelInventory({
        acquisitionDate: '2026-01-01',
        acquisitionQuantity: '10',
        events,
      })
    ).toEqual({
      remainingQuantity: '12',
      remainingCostFraction: { numerator: '3', denominator: '5' },
      sales: [
        { id: 'earlier', costFraction: { numerator: '1', denominator: '5' } },
        { id: 'later', costFraction: { numerator: '1', denominator: '5' } },
      ],
    })
    expect(events[0].id).toBe('later')
  })

  it('preserves fractional cost through multiple actions and a full disposal', () => {
    expect(
      projectParcelInventory({
        acquisitionDate: '2025-01-01',
        acquisitionQuantity: '10',
        events: [
          { id: 'sale1', date: '2025-02-01', type: 'SELL', quantity: '1' },
          {
            id: 'a',
            date: '2025-03-01',
            type: 'SPLIT',
            newUnits: '2',
            oldUnits: '1',
          },
          {
            id: 'b',
            date: '2025-04-01',
            type: 'SPLIT',
            newUnits: '1',
            oldUnits: '3',
          },
          { id: 'sale2', date: '2025-05-01', type: 'SELL', quantity: '2' },
          { id: 'sale3', date: '2025-06-01', type: 'SELL', quantity: '4' },
        ],
      })
    ).toEqual({
      remainingQuantity: '0',
      remainingCostFraction: { numerator: '0', denominator: '1' },
      sales: [
        { id: 'sale1', costFraction: { numerator: '1', denominator: '10' } },
        { id: 'sale2', costFraction: { numerator: '3', denominator: '10' } },
        { id: 'sale3', costFraction: { numerator: '3', denominator: '5' } },
      ],
    })
  })

  it('rejects fractional results requiring rounding or an inexact Float round trip', () => {
    const split = {
      id: 's',
      date: '2026-02-01',
      type: 'SPLIT',
      newUnits: '1',
      oldUnits: '3',
    } as const
    expect(() =>
      projectParcelInventory({
        acquisitionDate: '2026-01-01',
        acquisitionQuantity: '1',
        events: [split],
      })
    ).toThrow('Split quantity requires rounding')
    expect(() =>
      projectParcelInventory({
        acquisitionDate: '2026-01-01',
        acquisitionQuantity: '9007199254740991',
        events: [{ ...split, newUnits: '2', oldUnits: '1' }],
      })
    ).toThrow('Parcel quantity cannot be stored exactly')
    expect(
      projectParcelInventory({
        acquisitionDate: '2026-01-01',
        acquisitionQuantity: '0.12',
        events: [{ ...split, newUnits: '3', oldUnits: '2' }],
      }).remainingQuantity
    ).toBe('0.18')
    expect(() =>
      projectParcelInventory({
        acquisitionDate: '2026-01-01',
        acquisitionQuantity: '1000000000000000.1',
        events: [{ ...split, newUnits: '3', oldUnits: '2' }],
      })
    ).toThrow('Parcel quantity cannot be stored exactly')
  })

  it('rejects ambiguous same-day actions, including acquisition day', () => {
    const split = {
      id: 's',
      date: '2026-01-01',
      type: 'SPLIT',
      newUnits: '2',
      oldUnits: '1',
    } as const
    expect(() =>
      projectParcelInventory({
        acquisitionDate: '2026-01-01',
        acquisitionQuantity: '10',
        events: [split],
      })
    ).toThrow('Ambiguous same-day split ordering')
    expect(() =>
      projectParcelInventory({
        acquisitionDate: '2025-01-01',
        acquisitionQuantity: '10',
        events: [
          split,
          { id: 'sale', date: split.date, type: 'SELL', quantity: '1' },
        ],
      })
    ).toThrow('Ambiguous same-day split ordering')
  })

  it('rejects invalid histories rather than silently changing the parcel', () => {
    const base = { acquisitionDate: '2026-01-01', acquisitionQuantity: '10' }
    expect(() =>
      projectParcelInventory({
        ...base,
        events: [{ id: 's', date: '2026-02-01', type: 'SELL', quantity: '11' }],
      })
    ).toThrow('Sale exceeds available parcel quantity')
    expect(() =>
      projectParcelInventory({
        ...base,
        events: [{ id: 's', date: '2025-12-31', type: 'SELL', quantity: '1' }],
      })
    ).toThrow('Invalid parcel event identity or date')
    expect(() =>
      projectParcelInventory({
        ...base,
        acquisitionQuantity: '0',
        events: [],
      })
    ).toThrow('Invalid parcel quantity')
    expect(() =>
      projectParcelInventory({
        ...base,
        acquisitionDate: '2026-02-30',
        events: [],
      })
    ).toThrow('Invalid acquisition date')
    expect(() =>
      projectParcelInventory({
        ...base,
        events: [
          { id: 's', date: '2026-02-01', type: 'SELL', quantity: '10' },
          {
            id: 'action',
            date: '2026-03-01',
            type: 'SPLIT',
            newUnits: '2',
            oldUnits: '1',
          },
        ],
      })
    ).toThrow('Split must change a nonempty parcel')
    expect(() =>
      projectParcelInventory({
        ...base,
        events: [
          {
            id: 's',
            date: '2026-02-01',
            type: 'SPLIT',
            newUnits: '0',
            oldUnits: '1',
          },
        ],
      })
    ).toThrow('Invalid split ratio')
    expect(() =>
      projectParcelInventory({
        ...base,
        events: [
          {
            id: 's',
            date: '2026-02-01',
            type: 'SPLIT',
            newUnits: '1',
            oldUnits: '1',
          },
        ],
      })
    ).toThrow('Split must change a nonempty parcel')
    expect(() =>
      projectParcelInventory({
        ...base,
        events: [
          { id: 's', date: '2026-02-01', type: 'SELL', quantity: '1' },
          { id: 's', date: '2026-03-01', type: 'SELL', quantity: '1' },
        ],
      })
    ).toThrow('Invalid parcel event identity or date')
  })

  it('keeps thirds exact instead of rounding intermediate cost allocations', () => {
    expect(
      projectParcelInventory({
        acquisitionDate: '2026-01-01',
        acquisitionQuantity: '3',
        events: [
          { id: 'a', date: '2026-02-01', type: 'SELL', quantity: '1' },
          { id: 'b', date: '2026-03-01', type: 'SELL', quantity: '1' },
        ],
      })
    ).toEqual({
      remainingQuantity: '1',
      remainingCostFraction: { numerator: '1', denominator: '3' },
      sales: [
        { id: 'a', costFraction: { numerator: '1', denominator: '3' } },
        { id: 'b', costFraction: { numerator: '1', denominator: '3' } },
      ],
    })
  })
})
