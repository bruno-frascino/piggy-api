import { createHash } from 'node:crypto'
import {
  parseExecutionSnapshot,
  type ExecutionSnapshot,
} from './execution-correction.js'
import { AccountingDecimal } from './accounting-values.js'

export type ManualTradeVoidInput = {
  idempotencyKey: string
  expectedRevisionId: string
  expectedSourceFingerprint: string
  reason: string
}

export type ManualTradeVoidAudit = {
  kind: 'BUY' | 'SELL'
  number: number
  previousFingerprint: string
  nextFingerprint: string
  input: ManualTradeVoidInput
  before: ExecutionSnapshot
  voidedAt: string
}

function invalid(): never {
  throw Object.assign(new Error('Invalid manual trade void or source audit'), {
    status: 400,
    name: 'Validation Error',
  })
}

export function parseManualTradeVoidInput(raw: unknown): ManualTradeVoidInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  const keys = [
    'idempotencyKey',
    'expectedRevisionId',
    'expectedSourceFingerprint',
    'reason',
  ]
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key))
  )
    invalid()
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
      invalid()
    return value
  }
  const fingerprint = text(row.expectedSourceFingerprint, 64)
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) invalid()
  return {
    idempotencyKey: text(row.idempotencyKey, 200),
    expectedRevisionId: text(row.expectedRevisionId, 200),
    expectedSourceFingerprint: fingerprint,
    reason: text(row.reason, 1000),
  }
}

export function parseManualTradeVoidAudit(raw: unknown): ManualTradeVoidAudit {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  const keys = [
    'kind',
    'number',
    'previousFingerprint',
    'nextFingerprint',
    'input',
    'before',
    'voidedAt',
  ]
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    (row.kind !== 'BUY' && row.kind !== 'SELL') ||
    typeof row.number !== 'number' ||
    !Number.isSafeInteger(row.number) ||
    row.number < 1 ||
    typeof row.previousFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.previousFingerprint) ||
    typeof row.nextFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.nextFingerprint) ||
    typeof row.voidedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.voidedAt)) ||
    new Date(row.voidedAt).toISOString() !== row.voidedAt
  )
    invalid()
  const input = parseManualTradeVoidInput(row.input)
  const before = parseExecutionSnapshot(row.before)
  if (
    input.expectedSourceFingerprint !== row.previousFingerprint ||
    !new AccountingDecimal(before.quantity)
      .mul(before.price)
      .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
      .eq(before.totalValue)
  )
    invalid()
  return {
    kind: row.kind,
    number: row.number,
    previousFingerprint: row.previousFingerprint,
    nextFingerprint: row.nextFingerprint,
    input,
    before,
    voidedAt: row.voidedAt,
  }
}

export function manualTradeVoidHash(input: ManualTradeVoidInput): string {
  return createHash('sha256')
    .update(JSON.stringify(parseManualTradeVoidInput(input)))
    .digest('hex')
}
