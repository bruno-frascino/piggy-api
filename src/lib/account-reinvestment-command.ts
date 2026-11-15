import { createHash } from 'node:crypto'
import { AccountingDecimal, isAccountingAmount } from './accounting-values.js'
import {
  prepareAccountIncomeReceipt,
  type AccountIncomeReceiptInput,
} from './account-income-command.js'
import { parseAccountTradeInput } from './account-trade-command.js'
import { sydneyCalendarDate } from './accounting-preview.js'

export interface AccountReinvestmentInput {
  idempotencyKey: string
  income: Omit<AccountIncomeReceiptInput, 'idempotencyKey'>
  acquisition: {
    effectiveDate: string
    sequence: number
    quantity: string
    price: string
    fees: string
  }
  residualAmount: string
  residualDisposition: 'ACCOUNT_CASH'
  statementConfirmed: true
}

function invalid(
  message = 'Invalid statement-supported dividend reinvestment'
): never {
  throw Object.assign(new Error(message), {
    status: 400,
    name: 'Validation Error',
  })
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  return raw as Record<string, unknown>
}

export function prepareAccountReinvestment(
  raw: unknown,
  accountId: string,
  now = new Date()
) {
  const row = record(raw)
  const keys = [
    'idempotencyKey',
    'income',
    'acquisition',
    'residualAmount',
    'residualDisposition',
    'statementConfirmed',
  ]
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    row.residualDisposition !== 'ACCOUNT_CASH' ||
    row.statementConfirmed !== true ||
    !isAccountingAmount(row.residualAmount)
  )
    invalid()
  const incomeInput = record(row.income)
  if ('idempotencyKey' in incomeInput) invalid()
  const income = prepareAccountIncomeReceipt(
    { ...incomeInput, idempotencyKey: row.idempotencyKey },
    accountId,
    now
  )
  const acquisition = record(row.acquisition)
  const acquisitionKeys = [
    'effectiveDate',
    'sequence',
    'quantity',
    'price',
    'fees',
  ]
  if (
    Object.keys(acquisition).length !== acquisitionKeys.length ||
    Object.keys(acquisition).some((key) => !acquisitionKeys.includes(key))
  )
    invalid()
  const trade = parseAccountTradeInput({
    ...acquisition,
    idempotencyKey: `drp-buy:${createHash('sha256').update(income.request.idempotencyKey).digest('hex')}`,
    kind: 'BUY',
    assetId: income.request.assetId,
  })
  const gross = new AccountingDecimal(trade.quantity).mul(trade.price)
  if (
    trade.effectiveDate > sydneyCalendarDate(now) ||
    trade.effectiveDate < income.request.paymentDate ||
    (trade.effectiveDate === income.request.paymentDate &&
      trade.sequence <= income.request.sequence) ||
    gross.decimalPlaces() > 2 ||
    !gross.gt(0) ||
    gross.gte('10000000000') ||
    !new AccountingDecimal(income.request.grossAmount)
      .minus(income.request.withholdingAmount)
      .minus(gross)
      .minus(trade.fees)
      .eq(row.residualAmount)
  ) {
    invalid(
      'Acquisition must follow the income in date/sequence order; exact consideration plus fees and account-cash residual must equal net income without rounding or extra funding'
    )
  }
  const { idempotencyKey, ...incomeRequest } = income.request
  const request: AccountReinvestmentInput = {
    idempotencyKey,
    income: incomeRequest,
    acquisition: {
      effectiveDate: trade.effectiveDate,
      sequence: trade.sequence,
      quantity: trade.quantity,
      price: trade.price,
      fees: trade.fees,
    },
    residualAmount: new AccountingDecimal(row.residualAmount).toFixed(),
    residualDisposition: 'ACCOUNT_CASH',
    statementConfirmed: true,
  }
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify({
        methodology: 'account-reinvestment-v1',
        accountId,
        request,
      })
    )
    .digest('hex')
  return { request, income, trade, payloadHash }
}
