import { createHash } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingDate,
} from './accounting-values.js'

type AccountTradeCommon = {
  idempotencyKey: string
  effectiveDate: string
  sequence: number
  quantity: string
  price: string
  fees: string
}

export type AccountTradeInput = AccountTradeCommon &
  (
    | {
        kind: 'BUY'
        assetId: string
        symbol?: never
        exchangeCode?: never
        assetName?: never
        assetType?: never
        industry?: never
        openReason?: never
        stopLossPrice?: never
      }
    | {
        kind: 'BUY'
        assetId?: never
        symbol: string
        exchangeCode: string
        assetName?: string
        assetType?: 'EQUITY' | 'ETF' | 'CRYPTO'
        industry?: string
        openReason?: string
        stopLossPrice?: string | null
      }
    | {
        kind: 'SELL'
        positionId: string
        closeReason?: 'STOP_LOSS' | 'TARGET' | 'MANUAL' | 'OTHER'
        notes?: string
      }
  )

function invalid(): never {
  throw Object.assign(new Error('Invalid live trade command'), {
    status: 400,
    name: 'Validation Error',
  })
}

function object(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key))
  )
    invalid()
  return row
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    invalid()
  return value
}

function amount(
  value: unknown,
  integerDigits: number,
  fractionDigits: number,
  positive: boolean
): string {
  if (!isAccountingAmount(value)) invalid()
  const parsed = new AccountingDecimal(value)
  if (
    parsed.gte(new AccountingDecimal(10).pow(integerDigits)) ||
    parsed.decimalPlaces() > fractionDigits ||
    (positive && !parsed.gt(0))
  )
    invalid()
  return parsed.toFixed()
}

function quantity(value: unknown): string {
  const parsed = amount(value, 16, 12, true)
  if (
    !new AccountingDecimal(String(Number(parsed))).eq(parsed) ||
    new AccountingDecimal(parsed).gt(Number.MAX_SAFE_INTEGER)
  )
    invalid()
  return parsed
}

export function parseAccountTradeInput(raw: unknown): AccountTradeInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const initial = raw as Record<string, unknown>
  if (initial.kind !== 'BUY' && initial.kind !== 'SELL') invalid()
  const commonKeys = [
    'kind',
    'idempotencyKey',
    'effectiveDate',
    'sequence',
    'quantity',
    'price',
    'fees',
  ]
  const identityKeys =
    initial.kind === 'BUY'
      ? [
          'assetId',
          'symbol',
          'exchangeCode',
          'assetName',
          'assetType',
          'industry',
          'openReason',
          'stopLossPrice',
        ]
      : ['positionId', 'closeReason', 'notes']
  const row = object(
    raw,
    [...commonKeys, ...identityKeys].filter((key) => key in raw)
  )
  if (
    !isAccountingDate(row.effectiveDate) ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1
  )
    invalid()
  const common = {
    idempotencyKey: text(row.idempotencyKey, 200),
    effectiveDate: row.effectiveDate,
    sequence: row.sequence,
    quantity: quantity(row.quantity),
    price: amount(row.price, 12, 12, true),
    fees: amount(row.fees, 10, 8, false),
  }
  if (row.kind === 'BUY') {
    if (typeof row.assetId === 'string') {
      if (
        row.symbol !== undefined ||
        row.exchangeCode !== undefined ||
        row.assetName !== undefined ||
        row.assetType !== undefined ||
        row.industry !== undefined ||
        row.openReason !== undefined ||
        row.stopLossPrice !== undefined
      )
        invalid()
      return { ...common, kind: 'BUY', assetId: text(row.assetId, 200) }
    }
    if (typeof row.symbol !== 'string' || typeof row.exchangeCode !== 'string')
      invalid()
    const metadata = {
      symbol: text(row.symbol, 20).toUpperCase(),
      exchangeCode: text(row.exchangeCode, 200).toUpperCase(),
      ...(row.assetName !== undefined
        ? { assetName: text(row.assetName, 200) }
        : {}),
      ...(row.assetType !== undefined
        ? {
            assetType: (() => {
              if (!['EQUITY', 'ETF', 'CRYPTO'].includes(String(row.assetType)))
                return invalid()
              return row.assetType as 'EQUITY' | 'ETF' | 'CRYPTO'
            })(),
          }
        : {}),
      ...(row.industry !== undefined
        ? { industry: text(row.industry, 200) }
        : {}),
      ...(row.openReason !== undefined
        ? { openReason: text(row.openReason, 2000) }
        : {}),
      ...(row.stopLossPrice !== undefined
        ? {
            stopLossPrice:
              row.stopLossPrice === null
                ? null
                : amount(row.stopLossPrice, 12, 12, true),
          }
        : {}),
    }
    return { ...common, kind: 'BUY', ...metadata }
  }
  if (typeof row.positionId !== 'string') invalid()
  if (
    row.closeReason !== undefined &&
    !['STOP_LOSS', 'TARGET', 'MANUAL', 'OTHER'].includes(
      String(row.closeReason)
    )
  )
    invalid()
  return {
    ...common,
    kind: 'SELL',
    positionId: text(row.positionId, 200),
    ...(row.closeReason !== undefined
      ? {
          closeReason: row.closeReason as
            | 'STOP_LOSS'
            | 'TARGET'
            | 'MANUAL'
            | 'OTHER',
        }
      : {}),
    ...(row.notes !== undefined ? { notes: text(row.notes, 2000) } : {}),
  }
}

export function accountTradePayloadHash(input: AccountTradeInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        methodology: 'account-trade-v1',
        request: parseAccountTradeInput(input),
      })
    )
    .digest('hex')
}
