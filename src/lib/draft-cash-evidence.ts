import { createHash } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingCurrency,
  isAccountingDate,
} from './accounting-values.js'
import { sydneyCalendarDate } from './accounting-preview.js'
import type { CashReplay } from './cash-ledger.js'
import { prepareCashCommand } from './cash-ledger.js'

export const cashEvidenceReasons = [
  'UNRECORDED_OPERATION',
  'TIMING_DIFFERENCE',
  'SOURCE_CORRECTION_REQUIRED',
  'OTHER',
] as const

export type DraftCashEvidenceReason = (typeof cashEvidenceReasons)[number]

export interface DraftCashEvidenceRequest {
  idempotencyKey: string
  asOfDate: string
  source: string
  reference: string
  attested: true
  cashBalances: { currency: string; amount: string }[]
  decisions: {
    currency: string
    reason: DraftCashEvidenceReason
    note: string
  }[]
}

export function prepareDraftCashFlow(
  raw: unknown,
  accountId: string,
  now = new Date()
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    invalid('Cash flow must be an object')
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'idempotencyKey',
          'effectiveDate',
          'sequence',
          'kind',
          'currency',
          'amount',
          'sourceReference',
        ].includes(key)
    ) ||
    (row.kind !== 'DEPOSIT' && row.kind !== 'WITHDRAWAL') ||
    !isAccountingCurrency(row.currency) ||
    !isAccountingAmount(row.amount)
  )
    invalid('Only explicit dated manual deposits and withdrawals are supported')
  return prepareCashCommand(
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
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), {
    status: 400,
    name: 'Validation Error',
  })
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim() !== value ||
    value.length > maximum ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return (code < 32 && code !== 9 && code !== 10) || code === 127
    })
  )
    invalid(
      `${label} must be non-empty, bounded text without control characters`
    )
  return value
}

export function prepareDraftCashEvidence(
  raw: unknown,
  openingDate: string,
  now = new Date()
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    invalid('Cash evidence must be an object')
  const row = raw as Record<string, unknown>
  const allowed = [
    'idempotencyKey',
    'asOfDate',
    'source',
    'reference',
    'attested',
    'cashBalances',
    'decisions',
  ]
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    invalid('Unsupported cash evidence fields must not be ignored')
  const idempotencyKey = boundedText(row.idempotencyKey, 200, 'Idempotency key')
  const asOfDate = row.asOfDate
  if (
    !isAccountingDate(asOfDate) ||
    asOfDate <= openingDate ||
    asOfDate > sydneyCalendarDate(now)
  )
    invalid(
      'Evidence date must be after the opening boundary and no later than today'
    )
  const source = boundedText(row.source, 120, 'Statement source')
  const reference = boundedText(row.reference, 200, 'Statement reference')
  if (row.attested !== true)
    invalid(
      'You must explicitly attest that the entered statement balances are accurate'
    )
  if (
    !Array.isArray(row.cashBalances) ||
    row.cashBalances.length < 1 ||
    row.cashBalances.length > 20
  )
    invalid('Enter between 1 and 20 statement cash balances')
  const seen = new Set<string>()
  const cashBalances = row.cashBalances
    .map((rawBalance: unknown) => {
      if (
        !rawBalance ||
        typeof rawBalance !== 'object' ||
        Array.isArray(rawBalance)
      )
        invalid('Each statement balance must include a currency and amount')
      const balance = rawBalance as Record<string, unknown>
      if (
        Object.keys(balance).some(
          (key) => !['currency', 'amount'].includes(key)
        ) ||
        !isAccountingCurrency(balance.currency) ||
        seen.has(balance.currency) ||
        !isAccountingAmount(balance.amount)
      )
        invalid(
          'Statement currencies must be unique and balances exact decimal strings'
        )
      seen.add(balance.currency)
      return {
        currency: balance.currency,
        amount: new AccountingDecimal(balance.amount).toFixed(),
      }
    })
    .sort((a, b) => a.currency.localeCompare(b.currency))
  if (!Array.isArray(row.decisions) || row.decisions.length > 20)
    invalid('Cash discrepancy decisions must be an array')
  const decisionCurrencies = new Set<string>()
  const decisions = row.decisions
    .map((rawDecision: unknown) => {
      if (
        !rawDecision ||
        typeof rawDecision !== 'object' ||
        Array.isArray(rawDecision)
      )
        invalid('Each cash discrepancy decision must be an object')
      const decision = rawDecision as Record<string, unknown>
      if (
        Object.keys(decision).some(
          (key) => !['currency', 'reason', 'note'].includes(key)
        ) ||
        !isAccountingCurrency(decision.currency) ||
        decisionCurrencies.has(decision.currency) ||
        !cashEvidenceReasons.includes(
          decision.reason as DraftCashEvidenceReason
        )
      )
        invalid(
          'Cash discrepancy decisions require a unique currency and supported reason'
        )
      decisionCurrencies.add(decision.currency)
      return {
        currency: decision.currency,
        reason: decision.reason as DraftCashEvidenceReason,
        note: boundedText(decision.note, 1000, 'Decision note'),
      }
    })
    .sort((a, b) => a.currency.localeCompare(b.currency))
  const request: DraftCashEvidenceRequest = {
    idempotencyKey,
    asOfDate,
    source,
    reference,
    attested: true,
    cashBalances,
    decisions,
  }
  return {
    request,
    payloadHash: createHash('sha256')
      .update(
        JSON.stringify({ methodology: 'draft-cash-evidence-v1', request })
      )
      .digest('hex'),
  }
}

export function compareDraftCashEvidence(
  request: DraftCashEvidenceRequest,
  replay: CashReplay,
  requireDecisions = true
) {
  const expected = new Map(
    replay.balances.map((balance) => [balance.currency, balance.endingAmount])
  )
  const actual = new Map(
    request.cashBalances.map((balance) => [balance.currency, balance.amount])
  )
  if (
    expected.size !== actual.size ||
    [...expected.keys()].some((currency) => !actual.has(currency))
  )
    invalid(
      'Statement evidence must include every explicitly tracked cash currency, including zero balances'
    )
  const variances = [...expected].flatMap(([currency, expectedAmount]) => {
    const actualAmount = actual.get(currency)
    if (actualAmount === undefined)
      invalid(
        'Statement evidence is missing an explicitly tracked cash currency'
      )
    const difference = new AccountingDecimal(actualAmount)
      .minus(expectedAmount)
      .toFixed()
    return difference === '0'
      ? []
      : [
          {
            currency,
            expectedAmount,
            statementAmount: actualAmount,
            difference,
          },
        ]
  })
  const decisionSet = new Set(
    request.decisions.map((decision) => decision.currency)
  )
  const varianceSet = new Set(variances.map((variance) => variance.currency))
  if (
    requireDecisions &&
    (decisionSet.size !== varianceSet.size ||
      [...decisionSet].some((currency) => !varianceSet.has(currency)))
  )
    invalid(
      'Record one explicit decision for each differing currency and none for matching balances'
    )
  return {
    matchesReplay: variances.length === 0,
    variances,
    decisions: request.decisions,
  }
}
