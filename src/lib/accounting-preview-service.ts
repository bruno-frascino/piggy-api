import { prisma } from './prisma.js'
import {
  buildOpeningPreview,
  parseOpeningPreviewInput,
  sydneyCalendarDate,
} from './accounting-preview.js'
import {
  projectStoredParcelInventory,
  readStoredSplitHistory,
} from './stored-parcel-inventory.js'
import { AccountingDecimal } from './accounting-values.js'

type PreviewDb = Pick<
  typeof prisma,
  | 'tradingAccount'
  | 'position'
  | 'importBatch'
  | 'transaction'
  | 'importedEvent'
  | 'accountSplitAction'
  | 'accountSplitParcelEffect'
>

export async function previewAccountOpening(
  userId: string,
  accountId: string,
  rawInput: unknown
) {
  const now = new Date()
  const input = parseOpeningPreviewInput(rawInput, now)
  return prisma.$transaction(
    (db) => readAccountOpeningPreview(db, userId, accountId, input, now),
    { isolationLevel: 'RepeatableRead', timeout: 15000 }
  )
}

export async function readAccountOpeningPreview(
  db: PreviewDb,
  userId: string,
  accountId: string,
  input: ReturnType<typeof parseOpeningPreviewInput>,
  now: Date,
  options: { excludeImportBatchId?: string } = {}
) {
  const account = await db.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true, status: true, isDemo: true, updatedAt: true },
  })
  if (!account)
    throw Object.assign(new Error('Trading account not found'), {
      status: 404,
      name: 'Not Found',
    })
  const positions = await db.position.findMany({
    where: { accountId, userId, voidedAt: null },
    orderBy: { id: 'asc' },
    take: 5001,
    select: {
      id: true,
      accountId: true,
      assetId: true,
      openDate: true,
      quantity: true,
      positionType: true,
      origin: true,
      updatedAt: true,
      asset: {
        select: { symbol: true, exchange: { select: { currency: true } } },
      },
    },
  })
  const batches = await db.importBatch.findMany({
    where: {
      accountId,
      userId,
      status: { not: 'DISCARDED' },
      ...(options.excludeImportBatchId
        ? { id: { not: options.excludeImportBatchId } }
        : {}),
    },
    orderBy: { id: 'asc' },
    take: 501,
    select: {
      id: true,
      status: true,
    },
  })
  if (positions.length > 5000 || batches.length > 500)
    throw Object.assign(
      new Error(
        'This account exceeds the interactive preview limit; no partial preview was generated.'
      ),
      { status: 422, name: 'Preview Limit' }
    )
  const trades = await db.transaction.findMany({
    where: { voidedAt: null, position: { accountId, userId, voidedAt: null } },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    take: 50001,
    select: {
      id: true,
      positionId: true,
      type: true,
      date: true,
      quantity: true,
      totalValue: true,
      fees: true,
    },
  })
  const events = await db.importedEvent.findMany({
    where: {
      userId,
      batch: {
        accountId,
        userId,
        status: { not: 'DISCARDED' },
        ...(options.excludeImportBatchId
          ? { id: { not: options.excludeImportBatchId } }
          : {}),
      },
      OR: [
        {
          kind: {
            in: ['STAKING_REWARD', 'DEPOSIT', 'WITHDRAWAL', 'UNSUPPORTED'],
          },
        },
        { status: { in: ['PENDING', 'DEFERRED'] } },
      ],
    },
    orderBy: { id: 'asc' },
    take: 10001,
    select: { id: true, kind: true, status: true },
  })
  if (trades.length > 50000 || events.length > 10000)
    throw Object.assign(
      new Error(
        'This account exceeds the transaction/event preview limit; no partial preview was generated.'
      ),
      { status: 422, name: 'Preview Limit' }
    )
  const tradesByPosition = new Map<string, typeof trades>()
  for (const trade of trades) {
    const rows = tradesByPosition.get(trade.positionId) ?? []
    rows.push(trade)
    tradesByPosition.set(trade.positionId, rows)
  }
  const {
    actions,
    effectsByPosition,
    sourceFingerprint: splitSourceFingerprint,
  } = await readStoredSplitHistory(db, accountId)
  const positionIds = new Set(positions.map((position) => position.id))
  const missingPositionIds: string[] = []
  for (const [positionId, effects] of effectsByPosition) {
    if (positionIds.has(positionId)) continue
    if (effects.some((effect) => !effect.action.reversal))
      throw new Error('Split effect is outside the effective account inventory')
    missingPositionIds.push(positionId)
  }
  if (missingPositionIds.length) {
    const voidedPositions = await db.position.findMany({
      where: {
        id: { in: missingPositionIds },
        accountId,
        userId,
        voidedAt: { not: null },
      },
      select: { id: true },
    })
    if (voidedPositions.length !== missingPositionIds.length)
      throw new Error('Split effect is outside the effective account inventory')
  }
  const splitInventoryByPosition = new Map<
    string,
    {
      openingQuantity: string
      currentQuantity: string
    }
  >()
  if (actions.length) {
    for (const position of positions) {
      const parcel = {
        ...position,
        transactions: tradesByPosition.get(position.id) ?? [],
        splitEffects: effectsByPosition.get(position.id) ?? [],
        asset: {
          splitActions: actions.filter(
            (action) => action.assetId === position.assetId
          ),
        },
      }
      const current = projectStoredParcelInventory(
        parcel,
        sydneyCalendarDate(now)
      )
      if (!current) continue
      const quantityAt = (date: string) => {
        if (sydneyCalendarDate(position.openDate) > date) return '0'
        const projection = projectStoredParcelInventory(parcel, date)
        return (
          projection?.remainingQuantity ??
          parcel.transactions
            .reduce(
              (quantity, trade) =>
                sydneyCalendarDate(trade.date) <= date
                  ? quantity.plus(
                      trade.type === 'BUY'
                        ? trade.quantity
                        : trade.type === 'SELL'
                          ? -trade.quantity
                          : 0
                    )
                  : quantity,
              new AccountingDecimal(0)
            )
            .toFixed()
        )
      }
      splitInventoryByPosition.set(position.id, {
        openingQuantity: quantityAt(input.openingDate),
        currentQuantity: current.remainingQuantity,
      })
    }
  }
  const importIssues = batches.flatMap((batch) => [
    ...(batch.status !== 'COMMITTED'
      ? [
          {
            id: batch.id,
            reason:
              'An import is not fully committed; review it before accounting setup.',
          },
        ]
      : []),
  ])
  importIssues.push(
    ...events.map((event) => ({
      id: event.id,
      reason: `Imported ${event.kind} (${event.status}) needs reconciliation; cash and income history are not assumed complete.`,
    }))
  )
  const preview = buildOpeningPreview(
    account,
    positions.map((p) => ({
      id: p.id,
      quantity: String(p.quantity),
      positionType: p.positionType,
      origin: p.origin,
      updatedAt: p.updatedAt,
      symbol: p.asset.symbol,
      currency: p.asset.exchange.currency,
      transactions: (tradesByPosition.get(p.id) ?? []).map((tx) => ({
        id: tx.id,
        type: tx.type,
        date: tx.date,
        quantity: String(tx.quantity),
        totalValue: tx.totalValue.toString(),
        fees: tx.fees.toString(),
      })),
      ...(splitInventoryByPosition.has(p.id)
        ? {
            splitInventory: splitInventoryByPosition.get(p.id),
          }
        : {}),
    })),
    input,
    importIssues,
    now,
    splitSourceFingerprint
  )
  const split = actions[0]
  if (split) {
    preview.issues.push({
      code: 'SPLIT_REPLAY_UNSUPPORTED',
      severity: 'BLOCKING',
      message:
        'Opening inventory includes retained stock splits, but cash-ledger audit integration is incomplete. Reconciliation cannot yet be certified.',
      sourceId: split.id,
    })
    preview.counts.blockingIssues += 1
  }
  return preview
}
