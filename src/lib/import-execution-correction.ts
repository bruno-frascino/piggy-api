import { createHash } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingCurrency,
  isAccountingDate,
} from './accounting-values.js'

export type ImportedExecutionCorrectionInput = {
  idempotencyKey: string
  expectedRevisionId: string
  expectedSourceFingerprint: string
  reason: string
  effectiveDate: string
  sequence: number
  price: string
  fees: string
}

export type ImportedExecutionTradeSnapshot = {
  transactionId: string
  positionId: string
  date: string
  quantity: string
  price: string
  totalValue: string
  fees: string
  currency: string
}

export type ImportedExecutionAudit = {
  eventId: string
  number: number
  previousFingerprint: string
  nextFingerprint: string
  input: ImportedExecutionCorrectionInput
  before: ImportedExecutionTradeSnapshot[]
  after: ImportedExecutionTradeSnapshot[]
}

function invalid(message = 'Invalid imported execution correction'): never {
  throw Object.assign(new Error(message), {
    status: 400,
    name: 'Validation Error',
  })
}

function object(
  value: unknown,
  allowed: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => !allowed.includes(key))) return invalid()
  return row
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return invalid()
  return value
}

function money(value: unknown, decimals: number, positive = false): string {
  if (!isAccountingAmount(value)) return invalid()
  const decimal = new AccountingDecimal(value)
  if (
    decimal.decimalPlaces() > decimals ||
    decimal.gte('10000000000') ||
    (positive && !decimal.gt(0))
  )
    return invalid()
  return decimal.toFixed()
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    return invalid()
  return value
}

export function parseImportedExecutionCorrectionInput(
  raw: unknown
): ImportedExecutionCorrectionInput {
  const row = object(raw, [
    'idempotencyKey',
    'expectedRevisionId',
    'expectedSourceFingerprint',
    'reason',
    'effectiveDate',
    'sequence',
    'price',
    'fees',
  ])
  if (
    !isAccountingDate(row.effectiveDate) ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1
  )
    return invalid()
  return {
    idempotencyKey: text(row.idempotencyKey, 200),
    expectedRevisionId: text(row.expectedRevisionId, 200),
    expectedSourceFingerprint: fingerprint(row.expectedSourceFingerprint),
    reason: text(row.reason, 1000),
    effectiveDate: row.effectiveDate,
    sequence: row.sequence,
    price: money(row.price, 12, true),
    fees: money(row.fees, 8),
  }
}

function parseTradeSnapshot(raw: unknown): ImportedExecutionTradeSnapshot {
  const row = object(raw, [
    'transactionId',
    'positionId',
    'date',
    'quantity',
    'price',
    'totalValue',
    'fees',
    'currency',
  ])
  if (
    typeof row.date !== 'string' ||
    !Number.isFinite(Date.parse(row.date)) ||
    new Date(row.date).toISOString() !== row.date ||
    !isAccountingCurrency(row.currency) ||
    !isAccountingAmount(row.quantity) ||
    !new AccountingDecimal(row.quantity).gt(0)
  )
    return invalid()
  return {
    transactionId: text(row.transactionId, 200),
    positionId: text(row.positionId, 200),
    date: row.date,
    quantity: new AccountingDecimal(row.quantity).toFixed(),
    price: money(row.price, 12, true),
    totalValue: money(row.totalValue, 8, true),
    fees: money(row.fees, 8),
    currency: row.currency,
  }
}

function parseTradeSnapshots(raw: unknown): ImportedExecutionTradeSnapshot[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 5000)
    return invalid()
  const snapshots = raw.map(parseTradeSnapshot)
  if (
    new Set(snapshots.map((snapshot) => snapshot.transactionId)).size !==
    snapshots.length
  )
    return invalid()
  return snapshots
}

export function parseImportedExecutionAudit(
  raw: unknown
): ImportedExecutionAudit {
  const row = object(raw, [
    'eventId',
    'number',
    'previousFingerprint',
    'nextFingerprint',
    'input',
    'before',
    'after',
  ])
  if (
    typeof row.number !== 'number' ||
    !Number.isSafeInteger(row.number) ||
    row.number < 1
  )
    return invalid()
  return {
    eventId: text(row.eventId, 200),
    number: row.number,
    previousFingerprint: fingerprint(row.previousFingerprint),
    nextFingerprint: fingerprint(row.nextFingerprint),
    input: parseImportedExecutionCorrectionInput(row.input),
    before: parseTradeSnapshots(row.before),
    after: parseTradeSnapshots(row.after),
  }
}

export function importedExecutionCorrectionHash(
  input: ImportedExecutionCorrectionInput
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ methodology: 'import-execution-correction-v1', input })
    )
    .digest('hex')
}

export function correctImportedExecutionSnapshots(
  before: readonly ImportedExecutionTradeSnapshot[],
  price: string,
  totalFees: string,
  effectiveDate: string
): ImportedExecutionTradeSnapshot[] {
  if (!before.length) return invalid('Imported execution has no linked trades')
  const currency = before[0].currency
  if (
    before.some((snapshot) => snapshot.currency !== currency) ||
    !isAccountingAmount(price) ||
    !new AccountingDecimal(price).gt(0) ||
    !isAccountingAmount(totalFees) ||
    !isAccountingDate(effectiveDate)
  )
    return invalid(
      'Imported execution correction requires a single-currency allocation'
    )
  const totalQuantity = before.reduce(
    (sum, snapshot) => sum.plus(snapshot.quantity),
    new AccountingDecimal(0)
  )
  const feeTotal = new AccountingDecimal(totalFees)
  let allocatedFees = new AccountingDecimal(0)
  return before.map((snapshot, index) => {
    const last = index === before.length - 1
    const fees = last
      ? feeTotal.minus(allocatedFees)
      : feeTotal
          .mul(snapshot.quantity)
          .div(totalQuantity)
          .toDecimalPlaces(8, AccountingDecimal.ROUND_HALF_UP)
    allocatedFees = allocatedFees.plus(fees)
    const totalValue = new AccountingDecimal(snapshot.quantity)
      .mul(price)
      .toDecimalPlaces(8, AccountingDecimal.ROUND_HALF_UP)
    if (
      !isAccountingAmount(totalValue.toFixed()) ||
      totalValue.gte('10000000000') ||
      fees.lt(0)
    )
      return invalid('Corrected imported execution exceeds supported precision')
    return {
      ...snapshot,
      date: new Date(`${effectiveDate}T01:00:00.000Z`).toISOString(),
      price: new AccountingDecimal(price).toFixed(),
      totalValue: totalValue.toFixed(),
      fees: fees.toFixed(),
    }
  })
}
