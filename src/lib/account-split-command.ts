import { createHash } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingDate,
} from './accounting-values.js'
import { sydneyCalendarDate } from './accounting-preview.js'
import {
  projectParcelInventory,
  type ParcelInventoryEvent,
} from './parcel-inventory.js'

export interface AccountSplitInput {
  idempotencyKey: string
  assetId: string
  effectiveDate: string
  newUnits: string
  oldUnits: string
  sourceReference: string
  statementConfirmed: true
}

export interface SplitReviewParcel {
  id: string
  accountId: string
  assetId: string
  positionType: 'LONG' | 'SHORT'
  acquisitionDate: string
  acquisitionQuantity: string
  recordedQuantity: string
  events: readonly ParcelInventoryEvent[]
}

function invalid(message = 'Invalid statement-supported stock split'): never {
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

function ratioPart(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,25}$/.test(value)) invalid()
  return value
}

export function prepareAccountSplit(
  raw: unknown,
  accountId: string,
  now = new Date()
): { accountId: string; request: AccountSplitInput; payloadHash: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  const keys = [
    'idempotencyKey',
    'assetId',
    'effectiveDate',
    'newUnits',
    'oldUnits',
    'sourceReference',
    'statementConfirmed',
  ]
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    !isAccountingDate(row.effectiveDate) ||
    row.effectiveDate > sydneyCalendarDate(now) ||
    row.statementConfirmed !== true
  )
    invalid()
  const newUnits = ratioPart(row.newUnits)
  const oldUnits = ratioPart(row.oldUnits)
  if (newUnits === oldUnits) invalid('Split ratio must change the quantity')

  const request: AccountSplitInput = {
    idempotencyKey: identifier(row.idempotencyKey),
    assetId: identifier(row.assetId),
    effectiveDate: row.effectiveDate,
    newUnits,
    oldUnits,
    sourceReference: identifier(row.sourceReference),
    statementConfirmed: true,
  }
  const normalizedAccountId = identifier(accountId)
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify({
        methodology: 'account-split-v1',
        accountId: normalizedAccountId,
        request,
      })
    )
    .digest('hex')
  return { accountId: normalizedAccountId, request, payloadHash }
}

/**
 * Plans against a complete, source-verified snapshot of effective account/asset parcels.
 * The caller must enforce ownership, source freshness and locking before any future write.
 */
export function reviewAccountSplit(
  prepared: ReturnType<typeof prepareAccountSplit>,
  snapshot: {
    accountId: string
    assetType: string
    openingDate: string
    asOfDate: string
    parcels: readonly SplitReviewParcel[]
  }
) {
  const { request } = prepared
  if (
    !isAccountingDate(snapshot.openingDate) ||
    !isAccountingDate(snapshot.asOfDate) ||
    snapshot.accountId !== prepared.accountId ||
    request.effectiveDate <= snapshot.openingDate ||
    request.effectiveDate > snapshot.asOfDate ||
    (snapshot.assetType !== 'EQUITY' && snapshot.assetType !== 'ETF')
  )
    invalid('Split must be within the reviewed period for an equity or ETF')

  const ids = new Set<string>()
  const affected: {
    positionId: string
    beforeQuantity: string
    afterQuantity: string
  }[] = []
  for (const parcel of snapshot.parcels) {
    if (
      !parcel.id ||
      ids.has(parcel.id) ||
      parcel.accountId !== snapshot.accountId ||
      parcel.assetId !== request.assetId ||
      !isAccountingDate(parcel.acquisitionDate) ||
      parcel.acquisitionDate > snapshot.asOfDate ||
      !isAccountingAmount(parcel.recordedQuantity) ||
      parcel.events.some((event) => event.date > snapshot.asOfDate)
    )
      invalid('Invalid or inconsistent split review snapshot')
    ids.add(parcel.id)
    if (parcel.acquisitionDate > request.effectiveDate) continue
    if (parcel.positionType !== 'LONG')
      invalid('Only long parcels are supported')

    const current = projectParcelInventory({
      acquisitionDate: parcel.acquisitionDate,
      acquisitionQuantity: parcel.acquisitionQuantity,
      events: parcel.events,
    })
    if (
      !new AccountingDecimal(current.remainingQuantity).eq(
        parcel.recordedQuantity
      )
    )
      invalid('Recorded parcel quantity does not match effective history')
    if (parcel.acquisitionDate === request.effectiveDate)
      invalid('Acquisition and split cannot share an ambiguous date')

    const earlierEvents = parcel.events.filter(
      (event) => event.date < request.effectiveDate
    )
    const before = projectParcelInventory({
      acquisitionDate: parcel.acquisitionDate,
      acquisitionQuantity: parcel.acquisitionQuantity,
      events: earlierEvents,
    })
    if (before.remainingQuantity === '0') continue
    if (parcel.events.some((event) => event.date >= request.effectiveDate))
      invalid('Void later sales and resolve same-day or later actions first')
    const proposedId = `split-proposal:${prepared.payloadHash}`
    const after = projectParcelInventory({
      acquisitionDate: parcel.acquisitionDate,
      acquisitionQuantity: parcel.acquisitionQuantity,
      events: [
        ...earlierEvents,
        {
          id: proposedId,
          date: request.effectiveDate,
          type: 'SPLIT',
          newUnits: request.newUnits,
          oldUnits: request.oldUnits,
        },
      ],
    })
    affected.push({
      positionId: parcel.id,
      beforeQuantity: before.remainingQuantity,
      afterQuantity: after.remainingQuantity,
    })
  }
  if (!affected.length) invalid('No eligible holdings on the split date')
  affected.sort((a, b) => a.positionId.localeCompare(b.positionId))
  return { parcels: affected }
}
