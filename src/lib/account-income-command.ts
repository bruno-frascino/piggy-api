import { createHash } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingCurrency,
  isAccountingDate,
} from './accounting-values.js'
import { prepareCashCommand, type PreparedCashCommand } from './cash-ledger.js'
import { sydneyCalendarDate } from './accounting-preview.js'

export interface AccountIncomeReceiptInput {
  idempotencyKey: string
  assetId: string
  entitlementDate: string
  paymentDate: string
  sequence: number
  currency: string
  grossAmount: string
  withholdingAmount: string
  frankedAmount: string
  unfrankedAmount: string
  frankingCreditAud: string
  sourceReference: string
}

export interface PreparedAccountIncomeReceipt {
  request: AccountIncomeReceiptInput
  cash: PreparedCashCommand
}

function invalid(message = 'Invalid account income receipt'): never {
  throw Object.assign(new Error(message), {
    status: 400,
    name: 'Validation Error',
  })
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 200 ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    invalid()
  return value
}

function amount(value: unknown, positive: boolean): string {
  if (!isAccountingAmount(value)) invalid()
  const parsed = new AccountingDecimal(value)
  if (positive ? !parsed.gt(0) : parsed.lt(0)) invalid()
  return parsed.toFixed()
}

export function prepareAccountIncomeReceipt(
  raw: unknown,
  accountId: string,
  now = new Date()
): PreparedAccountIncomeReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  const allowed = [
    'idempotencyKey',
    'assetId',
    'entitlementDate',
    'paymentDate',
    'sequence',
    'currency',
    'grossAmount',
    'withholdingAmount',
    'frankedAmount',
    'unfrankedAmount',
    'frankingCreditAud',
    'sourceReference',
  ]
  if (
    Object.keys(row).length !== allowed.length ||
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    !isAccountingCurrency(row.currency) ||
    !isAccountingDate(row.entitlementDate) ||
    !isAccountingDate(row.paymentDate) ||
    row.entitlementDate > row.paymentDate ||
    row.paymentDate > sydneyCalendarDate(now) ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1
  )
    invalid()

  const grossAmount = amount(row.grossAmount, true)
  const withholdingAmount = amount(row.withholdingAmount, false)
  const frankedAmount = amount(row.frankedAmount, false)
  const unfrankedAmount = amount(row.unfrankedAmount, false)
  const frankingCreditAud = amount(row.frankingCreditAud, false)
  const gross = new AccountingDecimal(grossAmount)
  if (
    new AccountingDecimal(withholdingAmount).gt(gross) ||
    !new AccountingDecimal(frankedAmount).plus(unfrankedAmount).eq(gross) ||
    ((new AccountingDecimal(frankedAmount).gt(0) ||
      new AccountingDecimal(frankingCreditAud).gt(0)) &&
      row.currency !== 'AUD')
  )
    invalid(
      'Withholding cannot exceed gross income; franked and unfranked components must equal gross income, and franking credits require AUD'
    )

  const request: AccountIncomeReceiptInput = {
    idempotencyKey: identifier(row.idempotencyKey),
    assetId: identifier(row.assetId),
    entitlementDate: row.entitlementDate,
    paymentDate: row.paymentDate,
    sequence: row.sequence,
    currency: row.currency,
    grossAmount,
    withholdingAmount,
    frankedAmount,
    unfrankedAmount,
    frankingCreditAud,
    sourceReference: identifier(row.sourceReference),
  }
  const netAmount = gross.minus(withholdingAmount).toFixed()
  const cash = prepareCashCommand(
    {
      accountId: identifier(accountId),
      idempotencyKey: request.idempotencyKey,
      source: { origin: 'MANUAL', reference: request.sourceReference },
      effectiveDate: request.paymentDate,
      sequence: request.sequence,
      kind: 'INCOME',
      cash: { currency: request.currency, amount: netAmount },
      income: {
        assetId: request.assetId,
        entitlementDate: request.entitlementDate,
        grossAmount: request.grossAmount,
        withholdingAmount: request.withholdingAmount,
        frankedAmount: request.frankedAmount,
        unfrankedAmount: request.unfrankedAmount,
        frankingCreditAud: request.frankingCreditAud,
      },
    },
    now
  )
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify({
        methodology: 'account-income-receipt-v1',
        request,
        cashCommand: cash.command,
      })
    )
    .digest('hex')
  return {
    request,
    cash: { ...cash, payloadHash },
  }
}
