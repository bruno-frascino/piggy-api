import { createHash } from 'node:crypto'
import { AccountingDecimal, isAccountingDate } from './accounting-values.js'
import { sydneyCalendarDate } from './accounting-preview.js'
import { prepareAccountSplit } from './account-split-command.js'
import {
  projectParcelInventory,
  type ParcelInventoryEvent,
} from './parcel-inventory.js'
import {
  prepareStoredAccountSplitReversal,
  type StoredAccountSplitReversal,
} from './account-split-reversal.js'
import type { prisma } from './prisma.js'

type StoredAction = NonNullable<
  Awaited<ReturnType<typeof prisma.accountSplitAction.findUnique>>
> & { reversal?: StoredAccountSplitReversal | null }
type StoredEffect = NonNullable<
  Awaited<ReturnType<typeof prisma.accountSplitParcelEffect.findUnique>>
> & { action: StoredAction }

type SplitHistoryDb = Pick<
  typeof prisma,
  'accountSplitAction' | 'accountSplitParcelEffect'
>

export function hasRelevantStoredSplitHistory(position: {
  accountId: string
  openDate: Date
  splitEffects: unknown[]
  asset: { splitActions: { accountId: string; effectiveDate: Date }[] }
}) {
  return (
    position.splitEffects.length > 0 ||
    position.asset.splitActions.some(
      (action) =>
        action.accountId === position.accountId &&
        action.effectiveDate.toISOString().slice(0, 10) >=
          sydneyCalendarDate(position.openDate)
    )
  )
}

export function hasUnreviewedStoredSplitHistory(position: {
  accountId: string
  openDate: Date
  stopLossReviewedAt: Date | null
  splitEffects: { action: StoredAction }[]
  asset: { splitActions: StoredAction[] }
}) {
  const acquisitionDate = sydneyCalendarDate(position.openDate)
  const relevantActions = new Map<string, StoredAction>()
  for (const effect of position.splitEffects)
    relevantActions.set(effect.action.id, effect.action)
  for (const action of position.asset.splitActions) {
    if (
      action.accountId === position.accountId &&
      sydneyCalendarDate(action.effectiveDate) >= acquisitionDate
    )
      relevantActions.set(action.id, action)
  }
  if (!relevantActions.size) return false
  const reviewedAt = position.stopLossReviewedAt
  if (!reviewedAt) return true
  const reviewedDate = sydneyCalendarDate(reviewedAt)
  return [...relevantActions.values()].some(
    (action) =>
      action.recordedAt > reviewedAt ||
      (action.reversal?.recordedAt ?? new Date(0)) > reviewedAt ||
      sydneyCalendarDate(action.effectiveDate) > reviewedDate
  )
}

export function retainedSplitPriceAdjustments(position: {
  accountId: string
  openDate: Date | string
  splitEffects?: { action: StoredAction }[]
  asset?: { splitActions?: StoredAction[] }
}) {
  const openDate =
    position.openDate instanceof Date
      ? position.openDate
      : new Date(position.openDate)
  if (Number.isNaN(openDate.getTime())) return []
  const acquisitionDate = sydneyCalendarDate(openDate)
  const relevant = new Map<string, StoredAction>()
  for (const effect of position.splitEffects ?? [])
    relevant.set(effect.action.id, effect.action)
  for (const action of position.asset?.splitActions ?? []) {
    if (
      action.accountId === position.accountId &&
      sydneyCalendarDate(action.effectiveDate) >= acquisitionDate
    )
      relevant.set(action.id, action)
  }
  return [...relevant.values()]
    .filter((action) => !action.reversal)
    .sort(
      (left, right) =>
        left.effectiveDate.getTime() - right.effectiveDate.getTime()
    )
    .map((action) => ({
      effectiveDate: action.effectiveDate,
      newUnits: action.newUnits.toFixed(),
      oldUnits: action.oldUnits.toFixed(),
    }))
}

export async function readStoredSplitHistory(
  db: SplitHistoryDb,
  accountId: string,
  assetId?: string
) {
  const where = { accountId, ...(assetId ? { assetId } : {}) }
  const actions = await db.accountSplitAction.findMany({
    where,
    orderBy: { id: 'asc' },
    include: { reversal: true },
    take: 501,
  })
  if (actions.length > 500)
    throw Object.assign(
      new Error(
        'This account exceeds the split-action preview limit; no partial preview was generated.'
      ),
      { status: 422, name: 'Preview Limit' }
    )
  const effects = actions.length
    ? await db.accountSplitParcelEffect.findMany({
        where: { action: where },
        orderBy: { id: 'asc' },
        take: 50001,
      })
    : []
  if (effects.length > 50000)
    throw Object.assign(
      new Error(
        'This account exceeds the split-effect preview limit; no partial preview was generated.'
      ),
      { status: 422, name: 'Preview Limit' }
    )
  const actionById = new Map(actions.map((action) => [action.id, action]))
  const effectsByPosition = new Map<string, StoredEffect[]>()
  for (const effect of effects) {
    const action = actionById.get(effect.actionId)
    if (!action)
      throw new Error('Split effect is outside the effective account inventory')
    const rows = effectsByPosition.get(effect.positionId) ?? []
    rows.push({ ...effect, action })
    effectsByPosition.set(effect.positionId, rows)
  }
  const sourceFingerprint = actions.length
    ? createHash('sha256')
        .update(
          JSON.stringify({
            actions: actions.map((action) => {
              // Keep the original source representation; audit heads cannot hash themselves.
              const original = {
                id: action.id,
                accountId: action.accountId,
                assetId: action.assetId,
                effectiveDate: action.effectiveDate,
                newUnits: action.newUnits,
                oldUnits: action.oldUnits,
                sourceReference: action.sourceReference,
                idempotencyKey: action.idempotencyKey,
                payloadHash: action.payloadHash,
                sourceFingerprint: action.sourceFingerprint,
                methodology: action.methodology,
                request: prepareStoredAccountSplit(action, accountId).request,
                recordedAt: action.recordedAt,
              }
              return action.reversal
                ? {
                    ...original,
                    reversal: {
                      id: action.reversal.id,
                      accountId: action.reversal.accountId,
                      actionId: action.reversal.actionId,
                      idempotencyKey: action.reversal.idempotencyKey,
                      payloadHash: action.reversal.payloadHash,
                      reason: action.reversal.reason,
                      request: prepareStoredAccountSplitReversal(
                        action.reversal,
                        accountId,
                        action.id
                      ).request,
                      recordedAt: action.reversal.recordedAt,
                    },
                  }
                : original
            }),
            effects,
          })
        )
        .digest('hex')
    : undefined
  return { actions, effectsByPosition, sourceFingerprint }
}
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
  if (action.reversal)
    prepareStoredAccountSplitReversal(action.reversal, accountId, action.id)
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
  const allApplicableActions = position.asset.splitActions.filter((action) => {
    const actionDay = action.effectiveDate.toISOString().slice(0, 10)
    return (
      action.accountId === position.accountId &&
      actionDay >= acquisitionDate &&
      actionDay <= asOfDate
    )
  })
  for (const action of allApplicableActions)
    prepareStoredAccountSplit(action, position.accountId)
  const applicableEffects = position.splitEffects
    .filter(
      (effect) =>
        !effect.action.reversal &&
        effect.action.effectiveDate.toISOString().slice(0, 10) <= asOfDate
    )
    .sort(
      (a, b) =>
        a.action.effectiveDate.getTime() - b.action.effectiveDate.getTime()
    )
  const applicableActions = allApplicableActions.filter(
    (action) => !action.reversal
  )
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

export function storedParcelObservationDate(
  position: Parameters<typeof projectStoredParcelInventory>[0]
) {
  return [
    sydneyCalendarDate(position.openDate),
    ...position.transactions
      .filter((trade) => !trade.voidedAt)
      .map((trade) => sydneyCalendarDate(trade.date)),
    ...position.splitEffects.map((effect) =>
      effect.action.reversal
        ? sydneyCalendarDate(position.openDate)
        : effect.action.effectiveDate.toISOString().slice(0, 10)
    ),
    ...position.asset.splitActions
      .filter(
        (action) => action.accountId === position.accountId && !action.reversal
      )
      .map((action) => action.effectiveDate.toISOString().slice(0, 10)),
  ].reduce(
    (latest, date) => (date > latest ? date : latest),
    sydneyCalendarDate(position.openDate)
  )
}

type StoredCostPosition = Parameters<typeof projectStoredParcelInventory>[0] & {
  quantity: number
  entryPrice: string | number | { toString(): string }
  buyFees: string | number | { toString(): string }
}

function validatedStoredCostProjection(position: StoredCostPosition) {
  if (!position.splitEffects.length && !position.asset.splitActions.length)
    return null
  const projection = projectStoredParcelInventory(
    position,
    storedParcelObservationDate(position)
  )
  if (!projection) return null

  const acquisitionDate = sydneyCalendarDate(position.openDate)
  const relevantActions = new Map(
    [
      ...position.splitEffects.map((effect) => effect.action),
      ...position.asset.splitActions.filter(
        (action) =>
          action.accountId === position.accountId &&
          action.effectiveDate.toISOString().slice(0, 10) >= acquisitionDate
      ),
    ].map((action) => [action.id, action])
  )
  for (const action of relevantActions.values()) {
    if (
      action.auditNumber === null ||
      !Number.isSafeInteger(action.auditNumber) ||
      action.auditNumber < 1 ||
      !/^[a-f0-9]{64}$/.test(action.previousFingerprint ?? '') ||
      !/^[a-f0-9]{64}$/.test(action.nextFingerprint ?? '') ||
      action.sourceFingerprint !== action.previousFingerprint ||
      action.previousFingerprint === action.nextFingerprint
    )
      throw new Error('Split action has no valid audited continuation')
  }

  if (
    !new AccountingDecimal(String(position.quantity)).eq(
      projection.remainingQuantity
    )
  )
    throw new Error('Stored parcel quantity does not match split inventory')

  const acquisition = position.transactions.find(
    (trade) => trade.type === 'BUY' && !trade.voidedAt
  )
  if (!acquisition)
    throw new Error('Split parcel must have exactly one effective acquisition')

  const originalFees = new AccountingDecimal(String(position.buyFees))
  const originalCostBasis = new AccountingDecimal(String(position.entryPrice))
    .mul(String(acquisition.quantity))
    .plus(originalFees)
  return { projection, originalFees, originalCostBasis }
}

export function projectStoredParcelSaleCosts(position: StoredCostPosition) {
  const validated = validatedStoredCostProjection(position)
  if (!validated) return null
  const { projection, originalFees, originalCostBasis } = validated
  return new Map(
    projection.sales.map(({ id, costFraction }) => {
      const allocate = (amount: typeof originalFees) =>
        amount
          .mul(costFraction.numerator)
          .div(costFraction.denominator)
          .toFixed(12)
      return [
        id.slice('sell:'.length),
        {
          costBasis: allocate(originalCostBasis),
          buyFees: allocate(originalFees),
        },
      ] as const
    })
  )
}

export function projectStoredParcelCostBasis(position: StoredCostPosition) {
  const validated = validatedStoredCostProjection(position)
  if (!validated) return null
  const { projection, originalFees, originalCostBasis } = validated
  const remainingCostBasis = originalCostBasis
    .mul(projection.remainingCostFraction.numerator)
    .div(projection.remainingCostFraction.denominator)
  const remainingQuantity = new AccountingDecimal(projection.remainingQuantity)
  const averageUnitCost = remainingQuantity.gt(0)
    ? remainingCostBasis.div(remainingQuantity).toFixed(12)
    : null

  return {
    remainingQuantity: projection.remainingQuantity,
    remainingCostBasis: remainingCostBasis.toFixed(12),
    remainingBuyFees: originalFees
      .mul(projection.remainingCostFraction.numerator)
      .div(projection.remainingCostFraction.denominator)
      .toFixed(12),
    averageUnitCost,
  }
}

export function reviewStoredParcelSale(
  position: Parameters<typeof projectStoredParcelInventory>[0],
  sale: { id: string; date: Date; quantity: number }
) {
  const observationDate = storedParcelObservationDate({
    ...position,
    transactions: [...position.transactions, { ...sale, type: 'SELL' }],
  })
  const before = projectStoredParcelInventory(position, observationDate)
  if (!before) return null
  const after = projectStoredParcelInventory(
    {
      ...position,
      transactions: [...position.transactions, { ...sale, type: 'SELL' }],
    },
    observationDate
  )
  return { before, after }
}

/** Internal read: the caller supplies an owned, locked account or consistent snapshot. */
export async function readAccountAssetQuantityAt(
  db: SplitHistoryDb & Pick<typeof prisma, 'position' | 'transaction'>,
  userId: string,
  accountId: string,
  assetId: string,
  date: string,
  excludePositionId?: string
) {
  if (!isAccountingDate(date))
    throw new Error('Invalid entitlement observation date')
  const where = {
    userId,
    accountId,
    assetId,
    voidedAt: null,
    positionType: 'LONG' as const,
    ...(excludePositionId ? { id: { not: excludePositionId } } : {}),
  }
  const positions = await db.position.findMany({
    where,
    orderBy: { id: 'asc' },
    take: 50001,
    select: { id: true, accountId: true, assetId: true, openDate: true },
  })
  const trades = await db.transaction.findMany({
    where: { voidedAt: null, type: { in: ['BUY', 'SELL'] }, position: where },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      positionId: true,
      date: true,
      type: true,
      quantity: true,
    },
    take: 50001,
  })
  if (positions.length > 50000 || trades.length > 50000)
    throw Object.assign(
      new Error('Entitlement history exceeds the supported audit limit'),
      {
        status: 422,
        name: 'Accounting Conflict',
      }
    )
  const history = await readStoredSplitHistory(db, accountId, assetId)
  const tradesByPosition = new Map<string, typeof trades>()
  for (const trade of trades) {
    const rows = tradesByPosition.get(trade.positionId) ?? []
    rows.push(trade)
    tradesByPosition.set(trade.positionId, rows)
  }
  let quantity = new AccountingDecimal(0)
  for (const position of positions) {
    if (sydneyCalendarDate(position.openDate) > date) continue
    const transactions = tradesByPosition.get(position.id) ?? []
    const projection = projectStoredParcelInventory(
      {
        ...position,
        transactions,
        splitEffects: history.effectsByPosition.get(position.id) ?? [],
        asset: { splitActions: history.actions },
      },
      date
    )
    const remaining = projection
      ? new AccountingDecimal(projection.remainingQuantity)
      : transactions
          .filter((trade) => sydneyCalendarDate(trade.date) <= date)
          .reduce(
            (sum, trade) =>
              trade.type === 'BUY'
                ? sum.plus(String(trade.quantity))
                : sum.minus(String(trade.quantity)),
            new AccountingDecimal(0)
          )
    if (!remaining.isFinite() || remaining.lt(0))
      throw new Error('Invalid historical parcel quantity')
    quantity = quantity.plus(remaining)
  }
  return quantity
}
