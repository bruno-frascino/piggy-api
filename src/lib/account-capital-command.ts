import { prepareCashCommand, type PreparedCashCommand } from './cash-ledger.js'

export interface AccountCapitalFlowInput {
  kind: 'DEPOSIT' | 'WITHDRAWAL'
  idempotencyKey: string
  effectiveDate: string
  sequence: number
  currency: string
  amount: string
  sourceReference: string
}

export interface PreparedAccountCapitalFlow {
  request: AccountCapitalFlowInput
  cash: PreparedCashCommand
}

function invalid(): never {
  throw Object.assign(new Error('Invalid live capital flow command'), {
    status: 400,
    name: 'Validation Error',
  })
}

export function prepareAccountCapitalFlow(
  raw: unknown,
  accountId: string,
  now = new Date()
): PreparedAccountCapitalFlow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  const allowed = [
    'kind',
    'idempotencyKey',
    'effectiveDate',
    'sequence',
    'currency',
    'amount',
    'sourceReference',
  ]
  if (
    Object.keys(row).length !== allowed.length ||
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    (row.kind !== 'DEPOSIT' && row.kind !== 'WITHDRAWAL')
  )
    invalid()

  const cash = prepareCashCommand(
    {
      accountId,
      idempotencyKey: row.idempotencyKey,
      source: { origin: 'MANUAL', reference: row.sourceReference },
      effectiveDate: row.effectiveDate,
      sequence: row.sequence,
      kind: row.kind,
      cash: { currency: row.currency, amount: row.amount },
    },
    now
  )
  if (cash.command.kind !== 'DEPOSIT' && cash.command.kind !== 'WITHDRAWAL')
    invalid()

  return {
    request: {
      kind: cash.command.kind,
      idempotencyKey: cash.command.idempotencyKey,
      effectiveDate: cash.command.effectiveDate,
      sequence: cash.command.sequence,
      currency: cash.command.cash.currency,
      amount: cash.command.cash.amount,
      sourceReference: cash.command.source.reference,
    },
    cash,
  }
}
