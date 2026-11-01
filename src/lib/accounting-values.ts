import { Decimal } from 'decimal.js'

// Includes headroom for bounded ledger sums without rounding stored 38-digit amounts.
export const AccountingDecimal = Decimal.clone({ precision: 50 })
const amountPattern = /^(?:0|[1-9]\d{0,25})(?:\.\d{1,12})?$/
const currencies = new Set(Intl.supportedValuesOf('currency'))

export function isAccountingCurrency(value: unknown): value is string {
  return typeof value === 'string' && currencies.has(value)
}

export function isAccountingAmount(value: unknown): value is string {
  return typeof value === 'string' && amountPattern.test(value)
}

export function isAccountingDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  )
}
