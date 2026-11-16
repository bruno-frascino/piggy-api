import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingDate,
} from './accounting-values.js'

export type ParcelInventoryEvent =
  | { id: string; date: string; type: 'SELL'; quantity: string }
  | {
      id: string
      date: string
      type: 'SPLIT'
      newUnits: string
      oldUnits: string
    }

export type CostFraction = { numerator: string; denominator: string }

const SCALE = 1_000_000_000_000n

type Fraction = { numerator: bigint; denominator: bigint }

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function fraction(numerator: bigint, denominator: bigint): Fraction {
  const divisor = greatestCommonDivisor(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

function serializeFraction(value: Fraction): CostFraction {
  return {
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString(),
  }
}

function quantityString(value: bigint): string {
  const whole = value / SCALE
  const fractional = (value % SCALE).toString().padStart(12, '0')
  const suffix = fractional.replace(/0+$/, '')
  return suffix ? `${whole}.${suffix}` : whole.toString()
}

function assertStorableQuantity(value: bigint): void {
  const text = quantityString(value)
  const decimal = new AccountingDecimal(text)
  if (
    decimal.gt(Number.MAX_SAFE_INTEGER) ||
    !new AccountingDecimal(String(Number(text))).eq(decimal)
  ) {
    throw new Error('Parcel quantity cannot be stored exactly')
  }
}

function parseQuantity(value: string): bigint {
  if (!isAccountingAmount(value) || !new AccountingDecimal(value).gt(0)) {
    throw new Error('Invalid parcel quantity')
  }
  const [whole, fractional = ''] = value.split('.')
  const result = BigInt(whole!) * SCALE + BigInt(fractional.padEnd(12, '0'))
  assertStorableQuantity(result)
  return result
}

function ratioPart(value: string): bigint {
  if (!/^[1-9]\d{0,25}$/.test(value)) {
    throw new Error('Invalid split ratio')
  }
  return BigInt(value)
}

/**
 * Projects one original acquisition parcel without changing its recorded BUY.
 * Cost fractions are exact shares of the original total acquisition cost, including fees.
 */
export function projectParcelInventory(input: {
  acquisitionDate: string
  acquisitionQuantity: string
  events: readonly ParcelInventoryEvent[]
}): {
  remainingQuantity: string
  remainingCostFraction: CostFraction
  sales: { id: string; costFraction: CostFraction }[]
} {
  if (!isAccountingDate(input.acquisitionDate)) {
    throw new Error('Invalid acquisition date')
  }
  let quantity = parseQuantity(input.acquisitionQuantity)
  let remainingCost = fraction(1n, 1n)
  const sales: { id: string; costFraction: CostFraction }[] = []
  const ids = new Set<string>()
  const events = [...input.events].sort((a, b) => a.date.localeCompare(b.date))

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    if (
      !event.id ||
      ids.has(event.id) ||
      !isAccountingDate(event.date) ||
      event.date < input.acquisitionDate
    ) {
      throw new Error('Invalid parcel event identity or date')
    }
    ids.add(event.id)
    if (
      (event.type === 'SPLIT' && event.date === input.acquisitionDate) ||
      (index > 0 &&
        events[index - 1]!.date === event.date &&
        (events[index - 1]!.type === 'SPLIT' || event.type === 'SPLIT'))
    ) {
      throw new Error('Ambiguous same-day split ordering')
    }

    if (event.type === 'SPLIT') {
      const newUnits = ratioPart(event.newUnits)
      const oldUnits = ratioPart(event.oldUnits)
      if (newUnits === oldUnits || quantity === 0n) {
        throw new Error('Split must change a nonempty parcel')
      }
      const scaled = quantity * newUnits
      if (scaled % oldUnits !== 0n) {
        throw new Error('Split quantity requires rounding')
      }
      quantity = scaled / oldUnits
      assertStorableQuantity(quantity)
    } else if (event.type === 'SELL') {
      const sold = parseQuantity(event.quantity)
      if (sold > quantity) {
        throw new Error('Sale exceeds available parcel quantity')
      }
      const allocated = fraction(
        remainingCost.numerator * sold,
        remainingCost.denominator * quantity
      )
      remainingCost = fraction(
        remainingCost.numerator * (quantity - sold),
        remainingCost.denominator * quantity
      )
      quantity -= sold
      sales.push({ id: event.id, costFraction: serializeFraction(allocated) })
    } else {
      throw new Error('Unsupported parcel event')
    }
  }

  return {
    remainingQuantity: quantityString(quantity),
    remainingCostFraction: serializeFraction(remainingCost),
    sales,
  }
}
