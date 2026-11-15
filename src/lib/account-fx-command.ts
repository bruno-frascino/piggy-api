import { prepareCashCommand } from './cash-ledger.js'

export interface AccountFxConversionInput {
  idempotencyKey: string
  effectiveDate: string
  sequence: number
  from: { currency: string; amount: string }
  to: { currency: string; amount: string }
  fees: { currency: string; amount: string }[]
  sourceReference: string
}

export function prepareAccountFxConversion(
  raw: unknown,
  accountId: string,
  now = new Date()
) {
  const fields = [
    'idempotencyKey',
    'effectiveDate',
    'sequence',
    'from',
    'to',
    'fees',
    'sourceReference',
  ]
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== fields.length ||
    Object.keys(raw).some((key) => !fields.includes(key))
  )
    throw Object.assign(new Error('Invalid explicit FX conversion command'), {
      status: 400,
      name: 'Validation Error',
    })
  const row = raw as Record<string, unknown>
  const cash = prepareCashCommand(
    {
      accountId,
      kind: 'FX_CONVERSION',
      idempotencyKey: row.idempotencyKey,
      effectiveDate: row.effectiveDate,
      sequence: row.sequence,
      source: { origin: 'MANUAL', reference: row.sourceReference },
      from: row.from,
      to: row.to,
      fees: row.fees,
    },
    now
  )
  if (cash.command.kind !== 'FX_CONVERSION')
    throw new Error('Invalid prepared FX conversion kind')
  const request: AccountFxConversionInput = {
    idempotencyKey: cash.command.idempotencyKey,
    effectiveDate: cash.command.effectiveDate,
    sequence: cash.command.sequence,
    from: cash.command.from,
    to: cash.command.to,
    fees: cash.command.fees,
    sourceReference: cash.command.source.reference,
  }
  return { request, cash }
}
