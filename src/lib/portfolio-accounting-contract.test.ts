import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

// Test-only reference arithmetic, not the production posting/valuation engine.
const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
type Amount = InstanceType<typeof Money>
type Cash = Readonly<Record<string, string>>
type Holding = { quantity: string; price: string; currency: string }
type Leg = { accountId: string; currency: string; amount: string }

function amount(value: string): Amount {
  const parsed = new Money(value)
  if (!parsed.isFinite()) throw new Error('Non-finite accounting amount')
  return parsed
}

function positive(value: string): Amount {
  const parsed = amount(value)
  if (!parsed.gt(0)) throw new Error('Amount must be positive')
  return parsed
}

function nonNegative(value: string): Amount {
  const parsed = amount(value)
  if (parsed.lt(0)) throw new Error('Amount must not be negative')
  return parsed
}

function tradeCash(side: 'BUY' | 'SELL', gross: string, fee: string): string {
  const consideration = positive(gross)
  const costs = nonNegative(fee)
  return (
    side === 'BUY'
      ? consideration.plus(costs).negated()
      : consideration.minus(costs)
  ).toString()
}

function post(cash: Cash, currency: string, delta: string): Cash {
  const balance = amount(cash[currency] ?? '0').plus(amount(delta))
  if (balance.lt(0)) throw new Error('Insufficient recorded cash')
  return { ...cash, [currency]: balance.toString() }
}

function value(
  cash: Cash,
  holdings: Holding[],
  ratesToReportingCurrency: Readonly<Record<string, string>>
): string {
  const convert = (quantity: Amount, currency: string) => {
    const rate = ratesToReportingCurrency[currency]
    if (rate === undefined) throw new Error(`Missing FX: ${currency}`)
    return quantity.times(positive(rate))
  }
  const cashValue = Object.entries(cash).reduce(
    (total, [currency, balance]) =>
      total.plus(convert(nonNegative(balance), currency)),
    amount('0')
  )
  return holdings
    .reduce(
      (total, holding) =>
        total.plus(
          convert(
            nonNegative(holding.quantity).times(positive(holding.price)),
            holding.currency
          )
        ),
      cashValue
    )
    .toString()
}

function gain(start: string, end: string, externalNetInflow: string): string {
  return amount(end)
    .minus(amount(start))
    .minus(amount(externalNetInflow))
    .toString()
}

function receipt(gross: string, withholding: string, frankingCredit: string) {
  const income = positive(gross)
  const tax = nonNegative(withholding)
  nonNegative(frankingCredit)
  if (tax.gt(income)) throw new Error('Withholding exceeds gross income')
  return {
    gross,
    withholding,
    frankingCredit,
    netCash: income.minus(tax).toString(),
  }
}

function transfer(
  source: string,
  destination: string,
  currency: string,
  principal: string,
  fee: string
): { principal: Leg[]; fee: Leg } {
  if (source === destination) throw new Error('Transfer accounts must differ')
  const quantity = positive(principal)
  const costs = nonNegative(fee)
  return {
    principal: [
      { accountId: source, currency, amount: quantity.negated().toString() },
      { accountId: destination, currency, amount: quantity.toString() },
    ],
    fee: { accountId: source, currency, amount: costs.negated().toString() },
  }
}

function scopedFlow(legs: Leg[], scope: string[]): string {
  return legs
    .filter((leg) => scope.includes(leg.accountId))
    .reduce((total, leg) => total.plus(amount(leg.amount)), amount('0'))
    .toString()
}

function twr(
  intervals: Array<{ startAfterFlow: string; endBeforeFlow: string }>
) {
  if (!intervals.length) throw new Error('Missing return intervals')
  return intervals
    .reduce(
      (factor, interval) =>
        factor.times(
          nonNegative(interval.endBeforeFlow).div(
            positive(interval.startAfterFlow)
          )
        ),
      amount('1')
    )
    .minus(1)
    .toString()
}

const TRADE_REFERENCE = [
  {
    side: 'BUY',
    gross: '1000',
    fee: '10',
    remaining: '10',
    price: '100',
    cash: '8990',
    accountValue: '9990',
  },
  {
    side: 'SELL',
    gross: '480',
    fee: '5',
    remaining: '6',
    price: '120',
    cash: '9465',
    accountValue: '10185',
  },
  {
    side: 'SELL',
    gross: '720',
    fee: '5',
    remaining: '0',
    price: '120',
    cash: '10180',
    accountValue: '10180',
  },
] as const

describe('portfolio-accounting-v1 executable reference contract', () => {
  it('reconciles opening cash, purchase, partial disposal and full disposal', () => {
    let cash: Cash = { AUD: '10000' }
    for (const step of TRADE_REFERENCE) {
      cash = post(cash, 'AUD', tradeCash(step.side, step.gross, step.fee))
      expect(cash.AUD).toBe(step.cash)
      expect(
        value(
          cash,
          [{ quantity: step.remaining, price: step.price, currency: 'AUD' }],
          { AUD: '1' }
        )
      ).toBe(step.accountValue)
    }
    expect(gain('10000', cash.AUD!, '0')).toBe('180')
  })

  it('prorates acquisition fees for trade P&L, not as another cash deduction', () => {
    const buyFeeAllocated = amount('10').times('4').div('10')
    expect(
      amount('480').minus('5').minus('400').minus(buyFeeAllocated).toString()
    ).toBe('71')
    expect(tradeCash('SELL', '480', '5')).toBe('475')
  })

  it('values opening inventory without treating historical gains as period profit', () => {
    const openingValue = value(
      { AUD: '200' },
      [{ quantity: '10', price: '120', currency: 'AUD' }],
      { AUD: '1' }
    )
    expect(openingValue).toBe('1400')
    expect(gain(openingValue, '1400', '0')).toBe('0')
  })

  it('classifies deposits and withdrawals as capital, not investment gain', () => {
    const funded = post({ AUD: '10000' }, 'AUD', '5000')
    expect(gain('10000', funded.AUD!, '5000')).toBe('0')
    const withdrawn = post(funded, 'AUD', '-2000')
    expect(gain('15000', withdrawn.AUD!, '-2000')).toBe('0')
  })

  it('records gross income and withholding but posts only actual cash', () => {
    const income = receipt('100', '15', '30')
    expect(income).toEqual({
      gross: '100',
      withholding: '15',
      frankingCredit: '30',
      netCash: '85',
    })
    expect(post({ AUD: '1000' }, 'AUD', income.netCash).AUD).toBe('1085')
    expect(gain('1000', '1085', '0')).toBe('85')
  })

  it('represents reinvestment as income plus one new acquisition without duplicate gain', () => {
    let cash = post({ AUD: '1000' }, 'AUD', receipt('100', '0', '0').netCash)
    cash = post(cash, 'AUD', tradeCash('BUY', '90', '0'))
    expect(cash.AUD).toBe('1010')
    const end = value(cash, [{ quantity: '9', price: '10', currency: 'AUD' }], {
      AUD: '1',
    })
    expect(end).toBe('1100')
    expect(gain('1000', end, '0')).toBe('100')
  })

  it('classifies transfer principal by scope and keeps fees as investment costs', () => {
    const operation = transfer('a', 'b', 'AUD', '1000', '5')
    expect(scopedFlow(operation.principal, ['a'])).toBe('-1000')
    expect(scopedFlow(operation.principal, ['b'])).toBe('1000')
    expect(scopedFlow(operation.principal, ['a', 'b'])).toBe('0')
    expect(scopedFlow(operation.principal, ['c'])).toBe('0')
    const source = post({ AUD: '2000' }, 'AUD', '-1005')
    const destination = post({ AUD: '0' }, 'AUD', '1000')
    expect(gain('2000', source.AUD!, '-1000')).toBe('-5')
    expect(gain('0', destination.AUD!, '1000')).toBe('0')
    expect(
      gain('2000', amount(source.AUD!).plus(destination.AUD!).toString(), '0')
    ).toBe('-5')
  })

  it('records both FX legs and fees without automatically converting cash for a trade', () => {
    let cash: Cash = { AUD: '1600', USD: '0' }
    cash = post(cash, 'AUD', '-1505')
    cash = post(cash, 'USD', '1000')
    expect(cash).toEqual({ AUD: '95', USD: '1000' })
    expect(value(cash, [], { AUD: '1', USD: '1.5' })).toBe('1595')
    expect(gain('1600', '1595', '0')).toBe('-5')
    expect(() => post(cash, 'USD', tradeCash('BUY', '1001', '0'))).toThrow(
      'Insufficient recorded cash'
    )
    expect(cash).toEqual({ AUD: '95', USD: '1000' })
  })

  it('preserves value and total cost when a split doubles units and halves price', () => {
    expect(
      value({}, [{ quantity: '10', price: '100', currency: 'AUD' }], {
        AUD: '1',
      })
    ).toBe(
      value({}, [{ quantity: '20', price: '50', currency: 'AUD' }], {
        AUD: '1',
      })
    )
    expect(amount('10').times('100').toString()).toBe(
      amount('20').times('50').toString()
    )
  })

  it('supports tiny crypto consideration without rounding intermediate amounts to cents', () => {
    const gross = positive('0.000000000123').times(
      positive('123456.123456789012')
    )
    const delta = tradeCash('BUY', gross.toString(), '0.00000001')
    expect(post({ AUD: '1' }, 'AUD', delta).AUD).toBe(
      '0.999984804896814814951524'
    )
  })

  it('reconciles decimal additions and an explicit reversal/replacement', () => {
    const initial: Cash = { AUD: '100' }
    const original = tradeCash('BUY', '10', '0.1')
    let cash = post(initial, 'AUD', original)
    cash = post(cash, 'AUD', amount(original).negated().toString())
    expect(cash).toEqual(initial)
    cash = post(cash, 'AUD', tradeCash('BUY', '10', '0.2'))
    expect(cash.AUD).toBe('89.8')
    expect(post(post({}, 'AUD', '0.1'), 'AUD', '0.2').AUD).toBe('0.3')
  })

  it('links TWR at externally funded boundaries, excluding the deposit', () => {
    expect(
      twr([
        { startAfterFlow: '1000', endBeforeFlow: '1100' },
        { startAfterFlow: '2000', endBeforeFlow: '2200' },
      ])
    ).toBe('0.21')
    expect(
      twr([
        { startAfterFlow: '1000', endBeforeFlow: '1000' },
        { startAfterFlow: '6000', endBeforeFlow: '6000' },
      ])
    ).toBe('0')
    expect(twr([{ startAfterFlow: '1000', endBeforeFlow: '0' }])).toBe('-1')
  })

  it('defines XIRR through a dated zero-NPV equation, not trade P&L', () => {
    // ACT/365: these dates are exactly 365 days apart.
    const days =
      (Date.parse('2026-01-01') - Date.parse('2025-01-01')) / 86_400_000
    const npvAtTenPercent = amount('-1000').plus(
      amount('1100').div(amount('1.1').pow(days / 365))
    )
    expect(npvAtTenPercent.toString()).toBe('0')
  })

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'rejects non-finite amount %s',
    (input) => {
      expect(() => amount(input)).toThrow('Non-finite accounting amount')
    }
  )

  it('rejects invalid fees, unfunded purchases, invalid income and self-transfers', () => {
    expect(() => tradeCash('BUY', '0', '0')).toThrow('Amount must be positive')
    expect(() => tradeCash('BUY', '10', '-1')).toThrow(
      'Amount must not be negative'
    )
    expect(() =>
      post({ AUD: '10' }, 'AUD', tradeCash('BUY', '10', '1'))
    ).toThrow('Insufficient recorded cash')
    expect(() => receipt('10', '11', '0')).toThrow(
      'Withholding exceeds gross income'
    )
    expect(() => transfer('a', 'a', 'AUD', '1', '0')).toThrow(
      'Transfer accounts must differ'
    )
  })

  it('does not silently value missing or invalid FX', () => {
    expect(() => value({ USD: '1' }, [], { AUD: '1' })).toThrow(
      'Missing FX: USD'
    )
    expect(() => value({ USD: '1' }, [], { USD: '0' })).toThrow(
      'Amount must be positive'
    )
  })

  it('does not produce TWR without usable boundary values', () => {
    expect(() => twr([])).toThrow('Missing return intervals')
    expect(() => twr([{ startAfterFlow: '0', endBeforeFlow: '100' }])).toThrow(
      'Amount must be positive'
    )
  })
})
