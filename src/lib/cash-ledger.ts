import { createHash } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingCurrency,
  isAccountingDate,
} from './accounting-values.js'
import {
  parseOpeningPreviewInput,
  sydneyCalendarDate,
  type OpeningPreviewInput,
} from './accounting-preview.js'

type CashAmount = { currency: string; amount: string }
type CommandBase = {
  accountId: string
  idempotencyKey: string
  source: { origin: 'MANUAL' | 'IMPORT'; reference: string }
  effectiveDate: string
  sequence: number
}
export type CashCommand = CommandBase &
  (
    | {
        kind: 'BUY' | 'SELL'
        consideration: CashAmount
        fees: CashAmount[]
        transactionIds: string[]
      }
    | { kind: 'DEPOSIT' | 'WITHDRAWAL'; cash: CashAmount }
  )

export interface CashLeg {
  currency: string
  amount: string
  role: 'TRADE_CONSIDERATION' | 'CASH_FEE' | 'EXTERNAL_CAPITAL'
}

export interface PreparedCashCommand {
  methodology: 'cash-ledger-v1'
  command: CashCommand
  payloadHash: string
  legs: CashLeg[]
}

export interface CashReplay {
  accountId: string
  openingDate: string
  funded: boolean
  balances: {
    currency: string
    openingAmount: string
    endingAmount: string
    minimumAmount: string
    netExternalContribution: string
  }[]
  activity: {
    idempotencyKey: string
    effectiveDate: string
    sequence: number
    kind: CashCommand['kind']
    changes: { currency: string; amount: string; balanceAfter: string }[]
  }[]
  fundingIssues: {
    currency: string
    idempotencyKey: string
    effectiveDate: string
    sequence: number
    balance: string
  }[]
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), {
    status,
    name: status === 400 ? 'Validation Error' : 'Accounting Conflict',
  })
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(400, 'Accounting command must be an object')
  return value as Record<string, unknown>
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
    fail(
      400,
      'Accounting identifiers must contain 1 to 200 characters without surrounding whitespace or control characters'
    )
  return value
}

function fields(
  row: Record<string, unknown>,
  allowed: readonly string[]
): void {
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    fail(
      400,
      'Unsupported accounting fields must not be ignored or excluded from command identity'
    )
}

function money(value: unknown, positive: boolean): CashAmount {
  const row = record(value)
  fields(row, ['currency', 'amount'])
  if (!isAccountingCurrency(row.currency) || !isAccountingAmount(row.amount))
    fail(
      400,
      'Cash requires an explicit supported ISO currency and a non-negative decimal string within Decimal(38,12) precision'
    )
  const amount = new AccountingDecimal(row.amount)
  if (positive && !amount.gt(0))
    fail(400, 'Cash consideration and capital flows must be positive')
  return { currency: row.currency, amount: amount.toFixed() }
}

function storable(amount: InstanceType<typeof AccountingDecimal>): string {
  const value = amount.toFixed()
  if (!isAccountingAmount(value.startsWith('-') ? value.slice(1) : value))
    fail(
      422,
      'Cash arithmetic exceeds Decimal(38,12) precision; no amount was rounded or posted'
    )
  return value
}

export function prepareCashCommand(
  raw: unknown,
  now = new Date()
): PreparedCashCommand {
  const row = record(raw)
  const source = record(row.source)
  fields(source, ['origin', 'reference'])
  if (source.origin !== 'MANUAL' && source.origin !== 'IMPORT')
    fail(400, 'Cash commands require an explicit manual or import source')
  if (
    !isAccountingDate(row.effectiveDate) ||
    row.effectiveDate > sydneyCalendarDate(now)
  )
    fail(400, 'Effective date must be a valid date no later than today')
  if (
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1
  )
    fail(400, 'A positive, stable intraday sequence is required')
  const base: CommandBase = {
    accountId: identifier(row.accountId),
    idempotencyKey: identifier(row.idempotencyKey),
    source: { origin: source.origin, reference: identifier(source.reference) },
    effectiveDate: row.effectiveDate,
    sequence: row.sequence,
  }
  let command: CashCommand
  let legs: CashLeg[]
  const baseFields = [
    'accountId',
    'idempotencyKey',
    'source',
    'effectiveDate',
    'sequence',
    'kind',
  ]
  if (row.kind === 'BUY' || row.kind === 'SELL') {
    fields(row, [...baseFields, 'consideration', 'fees', 'transactionIds'])
    if (
      !Array.isArray(row.transactionIds) ||
      !row.transactionIds.length ||
      row.transactionIds.length > 5000
    )
      fail(
        400,
        'Trades require between 1 and 5000 existing parcel transaction links'
      )
    const transactionIds = Array.from(row.transactionIds, identifier).sort()
    if (new Set(transactionIds).size !== transactionIds.length)
      fail(400, 'Parcel transaction links must be unique within an execution')
    if (
      (row.kind === 'BUY' || source.origin === 'MANUAL') &&
      transactionIds.length !== 1
    )
      fail(
        400,
        'Each BUY and manual disposal must link exactly one parcel transaction; only imported sells can allocate across parcels'
      )
    if (!Array.isArray(row.fees) || row.fees.length > 20)
      fail(
        400,
        'Trades require an explicit fee list with at most 20 currencies; use an empty list for no fees'
      )
    const consideration = money(row.consideration, true)
    const fees = Array.from(row.fees, (fee) => money(fee, false)).sort((a, b) =>
      a.currency.localeCompare(b.currency)
    )
    if (new Set(fees.map((fee) => fee.currency)).size !== fees.length)
      fail(400, 'Cash fees must be aggregated per currency for the execution')
    command = { ...base, kind: row.kind, consideration, fees, transactionIds }
    const gross = new AccountingDecimal(consideration.amount)
    legs = [
      {
        currency: consideration.currency,
        amount: (row.kind === 'BUY' ? gross.negated() : gross).toFixed(),
        role: 'TRADE_CONSIDERATION',
      },
      ...fees.map((fee) => ({
        currency: fee.currency,
        amount: new AccountingDecimal(fee.amount).negated().toFixed(),
        role: 'CASH_FEE' as const,
      })),
    ]
  } else if (row.kind === 'DEPOSIT' || row.kind === 'WITHDRAWAL') {
    fields(row, [...baseFields, 'cash'])
    const cash = money(row.cash, true)
    command = { ...base, kind: row.kind, cash }
    const amount = new AccountingDecimal(cash.amount)
    legs = [
      {
        currency: cash.currency,
        amount: (row.kind === 'WITHDRAWAL'
          ? amount.negated()
          : amount
        ).toFixed(),
        role: 'EXTERNAL_CAPITAL',
      },
    ]
  } else
    fail(
      400,
      'Only BUY, SELL, DEPOSIT and WITHDRAWAL cash commands are currently supported'
    )
  return {
    methodology: 'cash-ledger-v1',
    command,
    payloadHash: createHash('sha256')
      .update(JSON.stringify({ methodology: 'cash-ledger-v1', command }))
      .digest('hex'),
    legs,
  }
}

/** Persistence must resolve this before replaying or writing a command a second time. */
export function resolveCashCommandRetry(
  prepared: PreparedCashCommand,
  existing: {
    accountId: string
    idempotencyKey: string
    payloadHash: string
  } | null
): 'NEW' | 'REUSE' {
  if (!existing) return 'NEW'
  if (
    existing.accountId !== prepared.command.accountId ||
    existing.idempotencyKey !== prepared.command.idempotencyKey ||
    existing.payloadHash !== prepared.payloadHash
  )
    fail(
      409,
      'Idempotency key is already associated with different accounting content'
    )
  return 'REUSE'
}

/** Rebuild a single account; caller must supply broker-verified execution totals and ordering. */
export function replayCashLedger(
  accountId: string,
  opening: OpeningPreviewInput,
  rawCommands: readonly unknown[],
  now = new Date()
): CashReplay {
  identifier(accountId)
  if (!Array.isArray(rawCommands) || rawCommands.length > 50000)
    fail(
      422,
      'Cash replay is limited to 50000 operations; partial balances are not returned'
    )
  const input = parseOpeningPreviewInput(opening, now)
  const commands: PreparedCashCommand[] = []
  let linkedTransactions = 0
  let postingLegs = 0
  for (const raw of rawCommands) {
    const prepared = prepareCashCommand(raw, now)
    postingLegs += prepared.legs.length
    if (prepared.command.kind === 'BUY' || prepared.command.kind === 'SELL')
      linkedTransactions += prepared.command.transactionIds.length
    if (linkedTransactions > 50000 || postingLegs > 100000)
      fail(
        422,
        'Cash replay is limited to 50000 transaction links and 100000 posting legs; partial balances are not returned'
      )
    commands.push(prepared)
  }
  const keys = new Set<string>()
  const sources = new Set<string>()
  const transactions = new Set<string>()
  const order = new Set<string>()
  for (const { command } of commands) {
    if (command.accountId !== accountId)
      fail(409, 'Cash replay cannot mix trading accounts')
    if (command.effectiveDate <= input.openingDate)
      fail(
        422,
        'Operations on or before the end-of-day opening boundary must not be posted again'
      )
    const source = JSON.stringify([
      command.source.origin,
      command.source.reference,
    ])
    const slot = `${command.effectiveDate}:${command.sequence}`
    if (keys.has(command.idempotencyKey) || sources.has(source))
      fail(
        409,
        'Duplicate command key or execution source would post cash twice'
      )
    if (order.has(slot))
      fail(
        409,
        'Operations require unique stable sequences per date; ordering cannot be inferred'
      )
    keys.add(command.idempotencyKey)
    sources.add(source)
    order.add(slot)
    if (command.kind === 'BUY' || command.kind === 'SELL') {
      for (const id of command.transactionIds) {
        if (transactions.has(id))
          fail(
            409,
            'A parcel transaction is already linked to another cash execution'
          )
        transactions.add(id)
      }
    }
  }
  commands.sort(
    (a, b) =>
      a.command.effectiveDate.localeCompare(b.command.effectiveDate) ||
      a.command.sequence - b.command.sequence
  )
  const balances = new Map(
    input.cashBalances.map((row) => [
      row.currency,
      {
        opening: row.amount,
        balance: new AccountingDecimal(row.amount),
        minimum: new AccountingDecimal(row.amount),
        external: new AccountingDecimal(0),
      },
    ])
  )
  const activity: CashReplay['activity'] = []
  const fundingIssues: CashReplay['fundingIssues'] = []
  for (const { command, legs } of commands) {
    const changes = new Map<string, InstanceType<typeof AccountingDecimal>>()
    for (const leg of legs) {
      const balance = balances.get(leg.currency)
      if (!balance)
        fail(
          422,
          `Missing explicit opening cash balance for ${leg.currency}; zero is not assumed`
        )
      changes.set(
        leg.currency,
        (changes.get(leg.currency) ?? new AccountingDecimal(0)).plus(leg.amount)
      )
      if (leg.role === 'EXTERNAL_CAPITAL')
        balance.external = balance.external.plus(leg.amount)
    }
    const entries: CashReplay['activity'][number]['changes'] = []
    for (const [currency, delta] of changes) {
      const balance = balances.get(currency)
      if (!balance)
        fail(422, `Missing explicit opening cash balance for ${currency}`)
      balance.balance = balance.balance.plus(delta)
      balance.minimum = AccountingDecimal.min(balance.minimum, balance.balance)
      const balanceAfter = storable(balance.balance)
      entries.push({ currency, amount: storable(delta), balanceAfter })
      if (balance.balance.lt(0))
        fundingIssues.push({
          currency,
          idempotencyKey: command.idempotencyKey,
          effectiveDate: command.effectiveDate,
          sequence: command.sequence,
          balance: balanceAfter,
        })
    }
    activity.push({
      idempotencyKey: command.idempotencyKey,
      effectiveDate: command.effectiveDate,
      sequence: command.sequence,
      kind: command.kind,
      changes: entries.sort((a, b) => a.currency.localeCompare(b.currency)),
    })
  }
  return {
    accountId,
    openingDate: input.openingDate,
    funded: fundingIssues.length === 0,
    balances: [...balances].map(([currency, value]) => ({
      currency,
      openingAmount: value.opening,
      endingAmount: storable(value.balance),
      minimumAmount: storable(value.minimum),
      netExternalContribution: storable(value.external),
    })),
    activity,
    fundingIssues,
  }
}

export function requireFundedCashLedger(replay: CashReplay): void {
  if (!replay.funded || replay.fundingIssues.length)
    throw Object.assign(
      new Error(
        'Insufficient recorded cash in the effective-dated timeline; no deposit was created'
      ),
      {
        status: 422,
        name: 'Insufficient Cash',
        details: replay.fundingIssues,
      }
    )
}
