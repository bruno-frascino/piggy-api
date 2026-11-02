import { createHash } from 'node:crypto'
import { AccountingDecimal } from './accounting-values.js'
import {
  prepareCashCommand,
  type CashCommand,
  type CashLeg,
} from './cash-ledger.js'
import {
  prepareDraftTradeRequest,
  prepareDraftTradeCash,
  type DraftTradeRequest,
} from './draft-trade-command.js'

export interface CashRevisionRequest {
  idempotencyKey: string
  expectedRevisionId: string
  reason: string
  replacement: CashCommand | null
  proposedTrade?: DraftTradeRequest | null
}

export interface PreparedCashRevision {
  request: CashRevisionRequest
  payloadHash: string
}

function cashRevisionConflict(message: string, status = 409): never {
  throw Object.assign(new Error(message), {
    status,
    name: status === 400 ? 'Validation Error' : 'Accounting Conflict',
  })
}

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
    cashRevisionConflict(
      'Correction requires bounded identifiers and an audit reason without control characters',
      400
    )
  return value
}

export function prepareCashRevision(
  raw: unknown,
  now = new Date()
): PreparedCashRevision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Cash correction must be an object', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'idempotencyKey',
          'expectedRevisionId',
          'reason',
          'replacement',
          'proposedTrade',
        ].includes(key)
    )
  )
    cashRevisionConflict(
      'Correction requires bounded identifiers, an audit reason and no unsupported fields',
      400
    )
  const request: CashRevisionRequest = {
    idempotencyKey: text(row.idempotencyKey, 200),
    expectedRevisionId: text(row.expectedRevisionId, 200),
    reason: text(row.reason, 1000),
    replacement:
      row.replacement === null
        ? null
        : prepareCashCommand(row.replacement, now).command,
    ...('proposedTrade' in row
      ? {
          proposedTrade:
            row.proposedTrade === null
              ? null
              : prepareDraftTradeRequest(row.proposedTrade, now).request,
        }
      : {}),
  }
  if (
    request.replacement &&
    request.replacement.idempotencyKey !== request.idempotencyKey
  )
    cashRevisionConflict(
      'Replacement command must use the correction idempotency key',
      400
    )
  if ('proposedTrade' in request) {
    const trade = request.proposedTrade
    const cash = request.replacement
    if (trade === null) {
      if (cash !== null)
        cashRevisionConflict('Trade reversal must also reverse its cash', 400)
    } else {
      if (
        !trade ||
        !cash ||
        (cash.kind !== 'BUY' && cash.kind !== 'SELL') ||
        cash.transactionIds.length !== 1 ||
        prepareDraftTradeCash(trade, cash.transactionIds[0], now)
          .payloadHash !== prepareCashCommand(cash, now).payloadHash
      )
        cashRevisionConflict(
          'Proposed trade correction must exactly match its cash replacement',
          400
        )
    }
  }
  return {
    request,
    payloadHash: createHash('sha256')
      .update(
        JSON.stringify({
          methodology: 'cash-revisions-v1',
          request,
        })
      )
      .digest('hex'),
  }
}

export function prepareDraftTradeRevision(
  raw: unknown,
  tradeId: string,
  now = new Date()
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Trade correction must be an object', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'idempotencyKey',
          'expectedRevisionId',
          'reason',
          'replacement',
        ].includes(key)
    )
  )
    cashRevisionConflict('Unsupported proposed trade correction fields', 400)
  const trade =
    row.replacement === null
      ? null
      : prepareDraftTradeRequest(row.replacement, now).request
  return prepareCashRevision(
    {
      idempotencyKey: row.idempotencyKey,
      expectedRevisionId: row.expectedRevisionId,
      reason: row.reason,
      replacement: trade
        ? prepareDraftTradeCash(trade, tradeId, now).command
        : null,
      proposedTrade: trade,
    },
    now
  )
}

export interface RevisionLeg extends CashLeg {
  phase: 'REVERSAL' | 'REPLACEMENT'
}

export function prepareRevisionLegs(
  original: CashCommand,
  replacement: CashCommand | null,
  now = new Date()
): RevisionLeg[] {
  const prior = prepareCashCommand(original, now)
  if (replacement) {
    const next = prepareCashCommand(replacement, now).command
    const transactionIds = (command: CashCommand) =>
      command.kind === 'BUY' || command.kind === 'SELL'
        ? command.transactionIds
        : []
    if (
      next.accountId !== prior.command.accountId ||
      next.kind !== prior.command.kind ||
      JSON.stringify(next.source) !== JSON.stringify(prior.command.source) ||
      JSON.stringify(transactionIds(next)) !==
        JSON.stringify(transactionIds(prior.command))
    )
      cashRevisionConflict(
        'Replacement must retain account, operation kind, execution source and parcel transaction identities'
      )
  }
  return [
    ...prior.legs.map((leg) => ({
      ...leg,
      amount: new AccountingDecimal(leg.amount).negated().toFixed(),
      phase: 'REVERSAL' as const,
    })),
    ...(replacement
      ? prepareCashCommand(replacement, now).legs.map((leg) => ({
          ...leg,
          phase: 'REPLACEMENT' as const,
        }))
      : []),
  ]
}
