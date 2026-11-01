import { prisma } from './prisma.js'
import {
  buildOpeningPreview,
  parseOpeningPreviewInput,
} from './accounting-preview.js'

type PreviewDb = Pick<
  typeof prisma,
  | 'tradingAccount'
  | 'position'
  | 'importBatch'
  | 'transaction'
  | 'importedEvent'
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
  now: Date
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
    where: { accountId, userId },
    orderBy: { id: 'asc' },
    take: 5001,
    select: {
      id: true,
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
    where: { accountId, userId, status: { not: 'DISCARDED' } },
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
    where: { position: { accountId, userId } },
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
      batch: { accountId, userId, status: { not: 'DISCARDED' } },
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
  return buildOpeningPreview(
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
    })),
    input,
    importIssues,
    now
  )
}
