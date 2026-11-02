import { createHash } from 'node:crypto'
import { AccountingDecimal, isAccountingAmount } from './accounting-values.js'
import { prepareCashCommand, type PreparedCashCommand } from './cash-ledger.js'

export type DraftTradeRequest = {
  accountId: string
  idempotencyKey: string
  effectiveDate: string
  sequence: number
  currency: string
  quantity: string
  price: string
  fees: string
} & ({ kind: 'BUY'; assetId: string } | { kind: 'SELL'; parcelKey: string })

function invalid(message: string): never {
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
    invalid(
      'Draft trade identifiers must be bounded and contain no control characters'
    )
  return value
}

function amount(value: unknown, positive: boolean): string {
  if (
    !isAccountingAmount(value) ||
    (positive && !new AccountingDecimal(value).gt(0))
  )
    invalid(
      'Draft quantity, price and fees require exact decimal strings within Decimal(38,12)'
    )
  return new AccountingDecimal(value).toFixed()
}

export function prepareDraftTradeRequest(raw: unknown, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    invalid('Proposed trade must be an object')
  const row = raw as Record<string, unknown>
  if (row.kind !== 'BUY' && row.kind !== 'SELL')
    invalid('Only proposed BUY/SELL trades are supported')
  const identity = row.kind === 'BUY' ? 'assetId' : 'parcelKey'
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'accountId',
          'idempotencyKey',
          'effectiveDate',
          'sequence',
          'currency',
          'quantity',
          'price',
          'fees',
          'kind',
          identity,
        ].includes(key)
    )
  )
    invalid('Unsupported proposed trade fields must not be ignored')
  const request: DraftTradeRequest = {
    accountId: identifier(row.accountId),
    idempotencyKey: identifier(row.idempotencyKey),
    effectiveDate:
      typeof row.effectiveDate === 'string' ? row.effectiveDate : '',
    sequence: typeof row.sequence === 'number' ? row.sequence : 0,
    currency: typeof row.currency === 'string' ? row.currency : '',
    quantity: amount(row.quantity, true),
    price: amount(row.price, true),
    fees: amount(row.fees, false),
    ...(row.kind === 'BUY'
      ? { kind: 'BUY', assetId: identifier(row.assetId) }
      : { kind: 'SELL', parcelKey: identifier(row.parcelKey) }),
  }
  // Reuse cash validation for the date, currency, order and exact consideration limit.
  prepareDraftTradeCash(request, 'validation-only', now)
  return {
    request,
    requestHash: createHash('sha256')
      .update(
        JSON.stringify({
          methodology: 'draft-manual-trades-v1',
          request,
        })
      )
      .digest('hex'),
  }
}

export function prepareDraftTradeCash(
  request: DraftTradeRequest,
  tradeId: string,
  now = new Date()
): PreparedCashCommand {
  return prepareCashCommand(
    {
      accountId: request.accountId,
      idempotencyKey: request.idempotencyKey,
      source: { origin: 'MANUAL', reference: `draft-trade:${tradeId}` },
      effectiveDate: request.effectiveDate,
      sequence: request.sequence,
      kind: request.kind,
      consideration: {
        currency: request.currency,
        amount: new AccountingDecimal(request.quantity)
          .mul(request.price)
          .toFixed(),
      },
      fees: [{ currency: request.currency, amount: request.fees }],
      transactionIds: [tradeId],
    },
    now
  )
}

export interface ProposedParcelTrade {
  id: string
  parcelKey: string
  request: DraftTradeRequest
}

export interface DraftOpeningParcel {
  parcelKey: string
  positionId: string
  symbol: string
  currency: string
  quantity: string
}

export function requireSameDraftTradeIdentity(
  original: DraftTradeRequest,
  next: DraftTradeRequest
) {
  if (
    next.accountId !== original.accountId ||
    next.currency !== original.currency ||
    (next.kind === 'BUY' &&
      (original.kind !== 'BUY' || next.assetId !== original.assetId)) ||
    (next.kind === 'SELL' &&
      (original.kind !== 'SELL' || next.parcelKey !== original.parcelKey))
  )
    throw Object.assign(
      new Error(
        'Proposed correction cannot rebind its account, asset, parcel or currency'
      ),
      {
        status: 409,
        name: 'Accounting Conflict',
      }
    )
}

export function replayDraftTradeParcels(
  trades: readonly ProposedParcelTrade[],
  openingParcels: readonly DraftOpeningParcel[] = []
) {
  const parcels = new Map<
    string,
    {
      parcelKey: string
      assetId: string | null
      positionId?: string
      symbol?: string
      currency: string
      acquired: string
      remaining: string
    }
  >()
  for (const parcel of openingParcels) {
    if (parcels.has(parcel.parcelKey))
      invalid('Opening parcel identities must be unique')
    parcels.set(parcel.parcelKey, {
      parcelKey: parcel.parcelKey,
      assetId: null,
      positionId: parcel.positionId,
      symbol: parcel.symbol,
      currency: parcel.currency,
      acquired: amount(parcel.quantity, false),
      remaining: amount(parcel.quantity, false),
    })
  }
  const ordered = [...trades].sort(
    (a, b) =>
      a.request.effectiveDate.localeCompare(b.request.effectiveDate) ||
      a.request.sequence - b.request.sequence
  )
  for (const trade of ordered) {
    const request = trade.request
    if (request.kind === 'BUY') {
      if (trade.parcelKey !== trade.id || parcels.has(trade.parcelKey))
        invalid('Each proposed parcel must have exactly one BUY')
      parcels.set(trade.parcelKey, {
        parcelKey: trade.parcelKey,
        assetId: request.assetId,
        currency: request.currency,
        acquired: request.quantity,
        remaining: request.quantity,
      })
    } else {
      const parcel = parcels.get(trade.parcelKey)
      if (
        !parcel ||
        request.parcelKey !== trade.parcelKey ||
        request.currency !== parcel.currency ||
        new AccountingDecimal(parcel.remaining).lt(request.quantity)
      )
        throw Object.assign(
          new Error(
            'Proposed sale must use an earlier draft BUY or confirmed opening parcel with sufficient units in its currency'
          ),
          { status: 422, name: 'Insufficient Draft Units' }
        )
      parcel.remaining = new AccountingDecimal(parcel.remaining)
        .minus(request.quantity)
        .toFixed()
    }
  }
  return [...parcels.values()]
}
