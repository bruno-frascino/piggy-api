import { createHash } from 'node:crypto'
import type { Decimal } from 'decimal.js'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingCurrency,
  isAccountingDate,
} from './accounting-values.js'

export interface OpeningPreviewInput {
  openingDate: string
  cashBalances: { currency: string; amount: string }[]
}

export interface PreviewTransaction {
  id: string
  type: string
  date: Date
  quantity: string
  totalValue: string
  fees: string
}

export interface PreviewPosition {
  id: string
  symbol: string
  currency: string
  positionType: string
  origin: string
  quantity: string
  updatedAt: Date
  transactions: PreviewTransaction[]
}

export interface OpeningPreview {
  accountId: string
  openingDate: string
  timezone: 'Australia/Sydney'
  boundary: 'END_OF_DAY'
  asOfDate: string
  mode: 'PREVIEW_ONLY'
  sourceFingerprint: string
  parcels: {
    positionId: string
    symbol: string
    currency: string
    openingQuantity: string
    expectedCurrentQuantity: string
    recordedCurrentQuantity: string
  }[]
  cashBalances: {
    currency: string
    openingAmount: string
    tradeOnlyEndingAmount: string
    minimumTradeOnlyAmount: string
  }[]
  issues: {
    code: string
    severity: 'BLOCKING' | 'WARNING'
    message: string
    sourceId: string | null
  }[]
  counts: {
    parcels: number
    postBoundaryTrades: number
    blockingIssues: number
  }
}

export function sydneyCalendarDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function invalidInput(message: string): never {
  throw Object.assign(new Error(message), {
    status: 400,
    name: 'Validation Error',
  })
}

export function parseOpeningPreviewInput(
  input: unknown,
  now = new Date()
): OpeningPreviewInput {
  if (
    !input ||
    typeof input !== 'object' ||
    !('openingDate' in input) ||
    !('cashBalances' in input)
  )
    invalidInput('Opening date and cash balances are required')
  const { openingDate, cashBalances } = input
  if (!isAccountingDate(openingDate) || openingDate > sydneyCalendarDate(now))
    invalidInput('Opening date must be a valid date no later than today')
  if (
    !Array.isArray(cashBalances) ||
    cashBalances.length < 1 ||
    cashBalances.length > 20
  )
    invalidInput(
      'Enter between 1 and 20 currency balances, including explicit zero balances'
    )
  const seen = new Set<string>()
  const parsed = cashBalances.map((row: unknown) => {
    if (
      !row ||
      typeof row !== 'object' ||
      !('currency' in row) ||
      !('amount' in row)
    )
      invalidInput('Each cash balance requires currency and amount')
    const { currency, amount } = row
    if (!isAccountingCurrency(currency) || seen.has(currency))
      invalidInput(
        'Currencies must be supported uppercase ISO codes with no duplicates'
      )
    if (!isAccountingAmount(amount))
      invalidInput(
        'Balances must be non-negative decimal strings with at most 26 integer and 12 fractional digits'
      )
    seen.add(currency)
    return { currency, amount: new AccountingDecimal(amount).toFixed() }
  })
  return {
    openingDate,
    cashBalances: parsed.sort((a, b) => a.currency.localeCompare(b.currency)),
  }
}

export function buildOpeningPreview(
  account: { id: string; status: string; isDemo: boolean; updatedAt: Date },
  positions: PreviewPosition[],
  input: OpeningPreviewInput,
  importIssues: { id: string; reason: string }[],
  now = new Date()
): OpeningPreview {
  const issues: OpeningPreview['issues'] = []
  const issue = (
    code: string,
    message: string,
    sourceId: string | null = null,
    severity: 'BLOCKING' | 'WARNING' = 'BLOCKING'
  ) => issues.push({ code, message, sourceId, severity })
  const asOfDate = sydneyCalendarDate(now)
  if (account.isDemo)
    issue('DEMO_ACCOUNT', 'Demo accounts cannot enable real accounting.')
  if (account.status !== 'ACTIVE')
    issue('CLOSED_ACCOUNT', 'Reopen this account before enabling accounting.')
  issue(
    'CASH_HISTORY_NOT_VERIFIED',
    'Cash below replays recorded trades only. Deposits, withdrawals, income and FX are not yet recorded in a cash ledger. This preview cannot confirm balances or enable accounting.',
    null,
    'WARNING'
  )
  for (const row of importIssues)
    issue('IMPORT_RECONCILIATION', row.reason, row.id)

  const parcels: OpeningPreview['parcels'] = []
  const trades: {
    id: string
    date: string
    currency: string
    delta: Decimal
  }[] = []
  const sourcePositions = [...positions].sort((a, b) =>
    a.id.localeCompare(b.id)
  )
  for (const position of sourcePositions) {
    const txs = [...position.transactions].sort(
      (a, b) =>
        a.date.getTime() - b.date.getTime() ||
        Number(b.type === 'BUY') - Number(a.type === 'BUY') ||
        a.id.localeCompare(b.id)
    )
    const buys = txs.filter((tx) => tx.type === 'BUY')
    if (buys.length !== 1)
      issue(
        'PARCEL_BUY_COUNT',
        'A parcel must have exactly one BUY transaction.',
        position.id
      )
    if (position.positionType !== 'LONG')
      issue(
        'UNSUPPORTED_SHORT',
        'Short or margin accounting is not supported.',
        position.id
      )
    if (position.origin === 'STAKING_REWARD')
      issue(
        'STAKING_INCOME_UNSUPPORTED',
        'Staking income and reward accounting require reconciliation before enabling this account.',
        position.id
      )
    if (position.origin === 'IMPORT_TRADE')
      issue(
        'IMPORT_CASH_CURRENCY_UNVERIFIED',
        'Imported parcel allocations may use a different currency from the actual execution. This parcel-currency cash projection requires reconciliation to exchange receipts.',
        position.id
      )
    let openingQty = new AccountingDecimal(0)
    let totalQty = new AccountingDecimal(0)
    for (const tx of txs) {
      const day = sydneyCalendarDate(tx.date)
      const qty = new AccountingDecimal(tx.quantity)
      const gross = new AccountingDecimal(tx.totalValue)
      const fee = new AccountingDecimal(tx.fees)
      if (
        !qty.isFinite() ||
        !gross.isFinite() ||
        !fee.isFinite() ||
        qty.lte(0) ||
        gross.lt(0) ||
        fee.lt(0)
      ) {
        issue(
          'INVALID_TRADE',
          'Invalid quantity, consideration or fees in recorded transaction.',
          tx.id
        )
        continue
      }
      if (tx.type !== 'BUY' && tx.type !== 'SELL') {
        issue(
          'UNSUPPORTED_TRANSACTION',
          `Recorded ${tx.type} needs a dedicated accounting policy.`,
          tx.id
        )
        continue
      }
      const signedQty = tx.type === 'BUY' ? qty : qty.negated()
      totalQty = totalQty.plus(signedQty)
      if (totalQty.lt(0))
        issue(
          'OVERSELL',
          'Disposals exceed acquired units at this point in history.',
          tx.id
        )
      if (day <= input.openingDate) openingQty = openingQty.plus(signedQty)
      if (day > asOfDate)
        issue(
          'FUTURE_TRANSACTION',
          'Future-dated transactions prevent a current-balance reconciliation.',
          tx.id
        )
      if (day > input.openingDate && day <= asOfDate)
        trades.push({
          id: tx.id,
          date: day,
          currency: position.currency,
          delta:
            tx.type === 'BUY' ? gross.plus(fee).negated() : gross.minus(fee),
        })
    }
    const recorded = new AccountingDecimal(position.quantity)
    if (!recorded.isFinite() || recorded.lt(0))
      issue(
        'INVALID_POSITION_QUANTITY',
        'Recorded remaining quantity is invalid.',
        position.id
      )
    // Existing quantities use Float; compare at their scale, never erase crypto dust.
    const tolerance = AccountingDecimal.max(
      recorded.abs(),
      totalQty.abs()
    ).times(Number.EPSILON * 8)
    if (recorded.minus(totalQty).abs().gt(tolerance))
      issue(
        'INVENTORY_MISMATCH',
        'Recorded remaining quantity does not reconcile to BUY and SELL transactions.',
        position.id
      )
    if (openingQty.lt(0))
      issue(
        'OPENING_INVENTORY_NEGATIVE',
        'Opening inventory is negative.',
        position.id
      )
    parcels.push({
      positionId: position.id,
      symbol: position.symbol,
      currency: position.currency,
      openingQuantity: openingQty.toFixed(),
      expectedCurrentQuantity: totalQty.toFixed(),
      recordedCurrentQuantity: recorded.toFixed(),
    })
  }

  const balances = new Map(
    input.cashBalances.map((row) => [
      row.currency,
      {
        currency: row.currency,
        openingAmount: row.amount,
        balance: new AccountingDecimal(row.amount),
        minimum: new AccountingDecimal(row.amount),
      },
    ])
  )
  for (const currency of new Set(parcels.map((parcel) => parcel.currency))) {
    if (!balances.has(currency))
      issue(
        'MISSING_OPENING_CASH',
        `Enter an explicit opening balance for ${currency}; missing balances are not assumed zero.`
      )
  }
  const dayCounts = new Map<string, number>()
  for (const trade of trades) {
    const key = `${trade.date}:${trade.currency}`
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of dayCounts) {
    if (count > 1)
      issue(
        'INTRADAY_ORDER_UNVERIFIED',
        `Multiple trades on ${key} lack a verified cash sequence; funding results use a conservative debit-first order.`,
        null
      )
  }
  trades.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.delta.cmp(b.delta) ||
      a.id.localeCompare(b.id)
  )
  for (const trade of trades) {
    const row = balances.get(trade.currency)
    if (!row) {
      continue
    }
    row.balance = row.balance.plus(trade.delta)
    row.minimum = AccountingDecimal.min(row.minimum, row.balance)
    if (row.balance.lt(0))
      issue(
        'FUNDING_GAP',
        `Trade-only ${trade.currency} cash has a funding gap on ${trade.date}. Supply actual funding records; no deposit has been created.`,
        trade.id
      )
  }
  const sourceFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        account,
        positions: sourcePositions.map((p) => ({
          ...p,
          transactions: [...p.transactions].sort((a, b) =>
            a.id.localeCompare(b.id)
          ),
        })),
        importIssues,
        input,
        asOfDate,
      })
    )
    .digest('hex')
  return {
    accountId: account.id,
    openingDate: input.openingDate,
    timezone: 'Australia/Sydney',
    boundary: 'END_OF_DAY',
    asOfDate,
    mode: 'PREVIEW_ONLY',
    sourceFingerprint,
    parcels,
    cashBalances: [...balances.values()].map((row) => ({
      currency: row.currency,
      openingAmount: row.openingAmount,
      tradeOnlyEndingAmount: row.balance.toFixed(),
      minimumTradeOnlyAmount: row.minimum.toFixed(),
    })),
    issues,
    counts: {
      parcels: parcels.length,
      postBoundaryTrades: trades.length,
      blockingIssues: issues.filter((row) => row.severity === 'BLOCKING')
        .length,
    },
  }
}
