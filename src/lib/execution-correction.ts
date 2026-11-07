import { createHash } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingCurrency,
  isAccountingDate,
} from './accounting-values.js'

export type SaleCorrectionInput = {
  idempotencyKey: string
  expectedRevisionId: string
  expectedSourceFingerprint: string
  reason: string
  effectiveDate: string
  sequence: number
  price: string
  fees: string
}

export type AcquisitionCorrectionInput = SaleCorrectionInput & {
  quantity: string
}

export type ExecutionSnapshot = {
  transactionId: string
  positionId: string
  date: string
  quantity: string
  price: string
  totalValue: string
  fees: string
  currency: string
}

type ExecutionAuditBase = {
  number: number
  previousFingerprint: string
  nextFingerprint: string
  before: ExecutionSnapshot
  after: ExecutionSnapshot
}

export type ExecutionAudit = ExecutionAuditBase &
  (
    | { kind: 'BUY'; input: AcquisitionCorrectionInput }
    | { kind?: never; input: SaleCorrectionInput }
  )

function invalid(): never {
  throw Object.assign(
    new Error('Invalid manual execution correction or source audit'),
    {
      status: 400,
      name: 'Validation Error',
    }
  )
}

function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key))
  )
    invalid()
  return row
}

function text(raw: unknown, limit: number): string {
  if (
    typeof raw !== 'string' ||
    !raw.length ||
    raw.trim() !== raw ||
    raw.length > limit ||
    Array.from(raw).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    invalid()
  return raw
}

function fingerprint(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) invalid()
  return raw
}

function money(
  raw: unknown,
  integers: number,
  decimals: number,
  positive = false
): string {
  if (!isAccountingAmount(raw)) invalid()
  const value = new AccountingDecimal(raw)
  if (
    value.gte(new AccountingDecimal(10).pow(integers)) ||
    value.decimalPlaces() > decimals ||
    (positive && !value.gt(0))
  )
    invalid()
  return value.toFixed()
}

export function parseSaleCorrection(raw: unknown): SaleCorrectionInput {
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
    !Number.isSafeInteger(row.sequence) ||
    typeof row.sequence !== 'number' ||
    row.sequence < 1
  )
    invalid()
  return {
    idempotencyKey: text(row.idempotencyKey, 200),
    expectedRevisionId: text(row.expectedRevisionId, 200),
    expectedSourceFingerprint: fingerprint(row.expectedSourceFingerprint),
    reason: text(row.reason, 1000),
    effectiveDate: row.effectiveDate,
    sequence: row.sequence,
    price: money(row.price, 12, 12, true),
    fees: money(row.fees, 10, 8),
  }
}

export function parseAcquisitionCorrection(
  raw: unknown
): AcquisitionCorrectionInput {
  const row = object(raw, [
    'idempotencyKey',
    'expectedRevisionId',
    'expectedSourceFingerprint',
    'reason',
    'effectiveDate',
    'sequence',
    'price',
    'fees',
    'quantity',
  ])
  const { quantity: rawQuantity, ...sale } = row
  const quantity = money(rawQuantity, 16, 12, true)
  // Live quantities are Float columns: reject inputs that change on a round trip.
  if (
    !new AccountingDecimal(String(Number(quantity))).eq(quantity) ||
    new AccountingDecimal(quantity).gt(Number.MAX_SAFE_INTEGER)
  )
    invalid()
  return { ...parseSaleCorrection(sale), quantity }
}

export function parseExecutionSnapshot(raw: unknown): ExecutionSnapshot {
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
  const date = text(row.date, 24)
  if (
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString() !== date ||
    !isAccountingCurrency(row.currency) ||
    !isAccountingAmount(row.quantity) ||
    !new AccountingDecimal(row.quantity).gt(0)
  )
    invalid()
  return {
    transactionId: text(row.transactionId, 200),
    positionId: text(row.positionId, 200),
    date,
    quantity: new AccountingDecimal(row.quantity).toFixed(),
    price: money(row.price, 12, 12, true),
    totalValue: money(row.totalValue, 10, 2, true),
    fees: money(row.fees, 10, 8),
    currency: row.currency,
  }
}

export function parseExecutionAudit(raw: unknown): ExecutionAudit {
  const acquisition = !!raw && typeof raw === 'object' && 'kind' in raw
  const row = object(raw, [
    'number',
    'previousFingerprint',
    'nextFingerprint',
    'input',
    'before',
    'after',
    ...(acquisition ? ['kind'] : []),
  ])
  if (
    typeof row.number !== 'number' ||
    !Number.isSafeInteger(row.number) ||
    row.number < 1
  )
    invalid()
  if (acquisition && row.kind !== 'BUY') invalid()
  const audit: ExecutionAudit = {
    number: row.number,
    previousFingerprint: fingerprint(row.previousFingerprint),
    nextFingerprint: fingerprint(row.nextFingerprint),
    ...(acquisition
      ? { kind: 'BUY', input: parseAcquisitionCorrection(row.input) }
      : { input: parseSaleCorrection(row.input) }),
    before: parseExecutionSnapshot(row.before),
    after: parseExecutionSnapshot(row.after),
  }
  if (
    audit.before.transactionId !== audit.after.transactionId ||
    audit.before.positionId !== audit.after.positionId ||
    (audit.kind === 'BUY'
      ? audit.input.quantity !== audit.after.quantity
      : audit.before.quantity !== audit.after.quantity) ||
    audit.before.currency !== audit.after.currency ||
    audit.input.expectedSourceFingerprint !== audit.previousFingerprint ||
    audit.input.price !== audit.after.price ||
    audit.input.fees !== audit.after.fees ||
    !new AccountingDecimal(audit.after.price)
      .mul(audit.after.quantity)
      .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
      .eq(audit.after.totalValue)
  )
    invalid()
  return audit
}

export function saleCorrectionHash(input: SaleCorrectionInput): string {
  return createHash('sha256')
    .update(JSON.stringify(parseSaleCorrection(input)))
    .digest('hex')
}

export function executionCorrectionHash(
  input: SaleCorrectionInput | AcquisitionCorrectionInput
): string {
  if (!('quantity' in input)) return saleCorrectionHash(input)
  return createHash('sha256')
    .update(JSON.stringify(parseAcquisitionCorrection(input)))
    .digest('hex')
}

export function continuedSourceFingerprint(
  original: string,
  audits: ExecutionAudit[]
): string {
  let current = original
  const snapshots = new Map<string, ExecutionSnapshot>()
  for (const [index, audit] of [...audits]
    .sort((a, b) => a.number - b.number)
    .entries()) {
    const previous = snapshots.get(audit.before.transactionId)
    if (
      audit.number !== index + 1 ||
      audit.previousFingerprint !== current ||
      (previous && JSON.stringify(previous) !== JSON.stringify(audit.before))
    )
      throw Object.assign(
        new Error('Manual execution source audit chain is inconsistent'),
        { status: 409 }
      )
    current = audit.nextFingerprint
    snapshots.set(audit.after.transactionId, audit.after)
  }
  return current
}
