import { createHash } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingDate,
} from './accounting-values.js'

export type AccountTradeInput = {
  idempotencyKey: string
  effectiveDate: string
  sequence: number
  quantity: string
  price: string
  fees: string
} & ({ kind: 'BUY'; assetId: string } | { kind: 'SELL'; positionId: string })

function invalid(): never {
  throw Object.assign(new Error('Invalid live trade command'), {
    status: 400,
    name: 'Validation Error',
  })
}

function object(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key))
  )
    invalid()
  return row
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    invalid()
  return value
}

function amount(
  value: unknown,
  integerDigits: number,
  fractionDigits: number,
  positive: boolean
): string {
  if (!isAccountingAmount(value)) invalid()
  const parsed = new AccountingDecimal(value)
  if (
    parsed.gte(new AccountingDecimal(10).pow(integerDigits)) ||
    parsed.decimalPlaces() > fractionDigits ||
    (positive && !parsed.gt(0))
  )
    invalid()
  return parsed.toFixed()
}

function quantity(value: unknown): string {
  const parsed = amount(value, 16, 12, true)
  if (
    !new AccountingDecimal(String(Number(parsed))).eq(parsed) ||
    new AccountingDecimal(parsed).gt(Number.MAX_SAFE_INTEGER)
  )
    invalid()
  return parsed
}

export function parseAccountTradeInput(raw: unknown): AccountTradeInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const initial = raw as Record<string, unknown>
  if (initial.kind !== 'BUY' && initial.kind !== 'SELL') invalid()
  const identity = initial.kind === 'BUY' ? 'assetId' : 'positionId'
  const row = object(raw, [
    'kind',
    'idempotencyKey',
    'effectiveDate',
    'sequence',
    'quantity',
    'price',
    'fees',
    identity,
  ])
  if (
    !isAccountingDate(row.effectiveDate) ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1
  )
    invalid()
  const common = {
    idempotencyKey: text(row.idempotencyKey, 200),
    effectiveDate: row.effectiveDate,
    sequence: row.sequence,
    quantity: quantity(row.quantity),
    price: amount(row.price, 12, 12, true),
    fees: amount(row.fees, 10, 8, false),
  }
  return row.kind === 'BUY'
    ? { ...common, kind: 'BUY', assetId: text(row.assetId, 200) }
    : { ...common, kind: 'SELL', positionId: text(row.positionId, 200) }
}

export function accountTradePayloadHash(input: AccountTradeInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        methodology: 'account-trade-v1',
        request: parseAccountTradeInput(input),
      })
    )
    .digest('hex')
}
