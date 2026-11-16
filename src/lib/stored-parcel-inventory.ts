import { AccountingDecimal, isAccountingDate } from './accounting-values.js'
import { sydneyCalendarDate } from './accounting-preview.js'
import { prepareAccountSplit } from './account-split-command.js'
import {
  projectParcelInventory,
  type ParcelInventoryEvent,
} from './parcel-inventory.js'
import type { prisma } from './prisma.js'

type StoredAction = NonNullable<
  Awaited<ReturnType<typeof prisma.accountSplitAction.findUnique>>
>
type StoredEffect = NonNullable<
  Awaited<ReturnType<typeof prisma.accountSplitParcelEffect.findUnique>>
> & { action: StoredAction }

export function prepareStoredAccountSplit(
  action: StoredAction,
  accountId: string
) {
  const prepared = prepareAccountSplit(action.request, accountId)
  if (
    action.accountId !== accountId ||
    action.methodology !== 'account-split-v1' ||
    !action.sourceFingerprint ||
    prepared.payloadHash !== action.payloadHash ||
    prepared.request.assetId !== action.assetId ||
    prepared.request.effectiveDate !==
      action.effectiveDate.toISOString().slice(0, 10) ||
    prepared.request.sourceReference !== action.sourceReference ||
    prepared.request.idempotencyKey !== action.idempotencyKey ||
    prepared.request.newUnits !== action.newUnits.toFixed() ||
    prepared.request.oldUnits !== action.oldUnits.toFixed()
  )
    throw new Error('Invalid split action source or parcel identity')
  return prepared
}

export function projectStoredParcelInventory(
  position: {
    id: string
    accountId: string
    assetId: string
    openDate: Date
    transactions: {
      id: string
      type: string
      date: Date
      quantity: number
      voidedAt?: Date | null
    }[]
    splitEffects: StoredEffect[]
    asset: { splitActions: StoredAction[] }
  },
  asOfDate: string
) {
  if (!isAccountingDate(asOfDate))
    throw new Error('Invalid parcel observation date')
  const acquisitionDate = sydneyCalendarDate(position.openDate)
  const applicableEffects = position.splitEffects
    .filter(
      (effect) =>
        effect.action.effectiveDate.toISOString().slice(0, 10) <= asOfDate
    )
    .sort(
      (a, b) =>
        a.action.effectiveDate.getTime() - b.action.effectiveDate.getTime()
    )
  const applicableActions = position.asset.splitActions.filter((action) => {
    const actionDay = action.effectiveDate.toISOString().slice(0, 10)
    return (
      action.accountId === position.accountId &&
      actionDay >= acquisitionDate &&
      actionDay <= asOfDate
    )
  })
  if (!applicableEffects.length && !applicableActions.length) return null

  const effectiveTrades = position.transactions.filter(
    (trade) => !trade.voidedAt
  )
  const buys = effectiveTrades.filter((trade) => trade.type === 'BUY')
  if (buys.length !== 1)
    throw new Error('Split parcel must have exactly one effective acquisition')
  const acquisitionQuantity = new AccountingDecimal(
    String(buys[0]!.quantity)
  ).toFixed()
  const sales: ParcelInventoryEvent[] = effectiveTrades
    .filter(
      (trade) =>
        trade.type === 'SELL' && sydneyCalendarDate(trade.date) <= asOfDate
    )
    .map((trade) => ({
      id: `sell:${trade.id}`,
      type: 'SELL',
      date: sydneyCalendarDate(trade.date),
      quantity: new AccountingDecimal(String(trade.quantity)).toFixed(),
    }))
  const splits: ParcelInventoryEvent[] = []
  for (const effect of applicableEffects) {
    const action = effect.action
    const actionDate = action.effectiveDate.toISOString().slice(0, 10)
    const prepared = prepareStoredAccountSplit(action, position.accountId)
    if (
      action.assetId !== position.assetId ||
      effect.positionId !== position.id ||
      effect.actionId !== action.id
    )
      throw new Error('Invalid split action source or parcel identity')
    const priorEvents = [
      ...sales.filter((sale) => sale.date < actionDate),
      ...splits,
    ]
    const before = projectParcelInventory({
      acquisitionDate,
      acquisitionQuantity,
      events: priorEvents,
    })
    const split: ParcelInventoryEvent = {
      id: `split:${action.id}`,
      type: 'SPLIT',
      date: actionDate,
      newUnits: prepared.request.newUnits,
      oldUnits: prepared.request.oldUnits,
    }
    const after = projectParcelInventory({
      acquisitionDate,
      acquisitionQuantity,
      events: [...priorEvents, split],
    })
    if (
      !new AccountingDecimal(before.remainingQuantity).eq(
        effect.beforeQuantity.toFixed()
      ) ||
      !new AccountingDecimal(after.remainingQuantity).eq(
        effect.afterQuantity.toFixed()
      )
    )
      throw new Error('Split parcel quantities do not match effective history')
    splits.push(split)
  }
  for (const action of applicableActions) {
    prepareStoredAccountSplit(action, position.accountId)
    if (applicableEffects.some((effect) => effect.action.id === action.id))
      continue
    const actionDay = action.effectiveDate.toISOString().slice(0, 10)
    const before = projectParcelInventory({
      acquisitionDate,
      acquisitionQuantity,
      events: [...sales, ...splits].filter((event) => event.date < actionDay),
    })
    if (before.remainingQuantity !== '0')
      throw new Error('Split action is missing its parcel effect')
  }
  return projectParcelInventory({
    acquisitionDate,
    acquisitionQuantity,
    events: [...sales, ...splits],
  })
}
