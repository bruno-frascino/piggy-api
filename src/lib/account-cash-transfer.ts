import { createHash } from 'node:crypto'
import { prepareCashCommand } from './cash-ledger.js'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingDate,
} from './accounting-values.js'
import { sydneyCalendarDate } from './accounting-preview.js'

export interface TransferRevisionHead {
  revisionId: string
  auditNumber: number
  sourceFingerprint: string
}

export interface TransferReplacement {
  effectiveDate: string
  sourceSequence: number
  destinationSequence: number
  amount: string
  fee: string
}

export interface AccountCashTransferCorrectionInput {
  idempotencyKey: string
  reason: string
  sourceHead: TransferRevisionHead
  destinationHead: TransferRevisionHead
  replacement: TransferReplacement | null
}

function invalidCorrection(): never {
  throw Object.assign(
    new Error('Invalid paired transfer correction or review heads'),
    {
      status: 400,
      name: 'Validation Error',
    }
  )
}

function exactObject(raw: unknown, fields: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== fields.length ||
    Object.keys(raw).some((key) => !fields.includes(key))
  )
    invalidCorrection()
  return raw as Record<string, unknown>
}

function text(raw: unknown, limit: number): string {
  if (
    typeof raw !== 'string' ||
    !raw.length ||
    raw.length > limit ||
    raw.trim() !== raw ||
    Array.from(raw).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    invalidCorrection()
  return raw
}

function order(raw: unknown, minimum = 1): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum)
    invalidCorrection()
  return raw
}

export function parseAccountCashTransferCorrection(
  raw: unknown,
  now = new Date()
): AccountCashTransferCorrectionInput {
  const row = exactObject(raw, [
    'idempotencyKey',
    'reason',
    'sourceHead',
    'destinationHead',
    'replacement',
  ])
  const head = (rawHead: unknown): TransferRevisionHead => {
    const value = exactObject(rawHead, [
      'revisionId',
      'auditNumber',
      'sourceFingerprint',
    ])
    if (
      typeof value.sourceFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
    )
      invalidCorrection()
    return {
      revisionId: text(value.revisionId, 200),
      auditNumber: order(value.auditNumber, 0),
      sourceFingerprint: value.sourceFingerprint,
    }
  }
  let replacement: TransferReplacement | null = null
  if (row.replacement !== null) {
    const next = exactObject(row.replacement, [
      'effectiveDate',
      'sourceSequence',
      'destinationSequence',
      'amount',
      'fee',
    ])
    if (
      !isAccountingDate(next.effectiveDate) ||
      next.effectiveDate > sydneyCalendarDate(now) ||
      !isAccountingAmount(next.amount) ||
      !new AccountingDecimal(next.amount).gt(0) ||
      !isAccountingAmount(next.fee)
    )
      invalidCorrection()
    replacement = {
      effectiveDate: next.effectiveDate,
      sourceSequence: order(next.sourceSequence),
      destinationSequence: order(next.destinationSequence),
      amount: new AccountingDecimal(next.amount).toFixed(),
      fee: new AccountingDecimal(next.fee).toFixed(),
    }
  }
  return {
    idempotencyKey: text(row.idempotencyKey, 200),
    reason: text(row.reason, 1000),
    sourceHead: head(row.sourceHead),
    destinationHead: head(row.destinationHead),
    replacement,
  }
}

export interface AccountCashTransferInput {
  toAccountId: string
  idempotencyKey: string
  effectiveDate: string
  sourceSequence: number
  destinationSequence: number
  currency: string
  amount: string
  fee: string
  sourceReference: string
}

export function prepareAccountCashTransfer(
  raw: unknown,
  fromAccountId: string,
  now = new Date()
) {
  const allowed = [
    'toAccountId',
    'idempotencyKey',
    'effectiveDate',
    'sourceSequence',
    'destinationSequence',
    'currency',
    'amount',
    'fee',
    'sourceReference',
  ]
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== allowed.length ||
    Object.keys(raw).some((key) => !allowed.includes(key))
  )
    throw Object.assign(new Error('Invalid paired cash transfer command'), {
      status: 400,
      name: 'Validation Error',
    })
  const row = raw as Record<string, unknown>
  const common = {
    idempotencyKey: row.idempotencyKey,
    effectiveDate: row.effectiveDate,
    source: { origin: 'MANUAL', reference: row.sourceReference },
    cash: { currency: row.currency, amount: row.amount },
    transfer: { fromAccountId, toAccountId: row.toAccountId },
  }
  const outgoing = prepareCashCommand(
    {
      ...common,
      accountId: fromAccountId,
      kind: 'TRANSFER_OUT',
      sequence: row.sourceSequence,
      fee: row.fee,
    },
    now
  )
  const incoming = prepareCashCommand(
    {
      ...common,
      accountId: row.toAccountId,
      kind: 'TRANSFER_IN',
      sequence: row.destinationSequence,
      fee: '0',
    },
    now
  )
  if (
    outgoing.command.kind !== 'TRANSFER_OUT' ||
    incoming.command.kind !== 'TRANSFER_IN'
  )
    throw new Error('Invalid prepared transfer kind')
  const request: AccountCashTransferInput = {
    toAccountId: incoming.command.accountId,
    idempotencyKey: outgoing.command.idempotencyKey,
    effectiveDate: outgoing.command.effectiveDate,
    sourceSequence: outgoing.command.sequence,
    destinationSequence: incoming.command.sequence,
    currency: outgoing.command.cash.currency,
    amount: outgoing.command.cash.amount,
    fee: outgoing.command.fee,
    sourceReference: outgoing.command.source.reference,
  }
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify({
        methodology: 'paired-cash-transfer-v1',
        fromAccountId,
        request,
      })
    )
    .digest('hex')
  return { request, payloadHash, outgoing, incoming }
}
