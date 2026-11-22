import { prisma } from './prisma.js'
import { lockOwnedPosition } from './account-lock.js'
import { sydneyCalendarDate } from './accounting-preview.js'

type Position = NonNullable<
  Awaited<ReturnType<typeof prisma.position.findUnique>>
>

type HistorySource = Pick<
  Position,
  | 'id'
  | 'userId'
  | 'accountId'
  | 'assetId'
  | 'entryPrice'
  | 'openDate'
  | 'status'
  | 'closeDate'
  | 'maxDrawdownPercent'
  | 'maxRunUpPercent'
  | 'updatedAt'
>

type StopSource = HistorySource &
  Pick<
    Position,
    | 'positionType'
    | 'stopLossPrice'
    | 'stopLossSetAt'
    | 'stopLossReviewedAt'
    | 'stopLossHitAt'
  >

type DerivedValues = {
  maxDrawdownPercent?: number | null
  maxRunUpPercent?: number | null
}

type SplitHistorySource = Pick<
  StopSource,
  'id' | 'accountId' | 'assetId' | 'openDate'
>

function sourceChanged(): never {
  throw Object.assign(
    new Error('Position changed during calculation. Reload and try again.'),
    { status: 409, name: 'Conflict' }
  )
}

const transactionOptions = {
  isolationLevel: 'ReadCommitted',
  timeout: 15000,
  maxWait: 5000,
} as const

function retainedSplitWhere(source: SplitHistorySource) {
  return {
    OR: [
      {
        accountId: source.accountId,
        assetId: source.assetId,
        effectiveDate: {
          gte: new Date(`${sydneyCalendarDate(source.openDate)}T00:00:00Z`),
        },
      },
      { effects: { some: { positionId: source.id } } },
    ],
  }
}

export async function hasRelevantRetainedSplitHistory(
  db: Pick<typeof prisma, 'accountSplitAction'>,
  source: SplitHistorySource
): Promise<boolean> {
  const action = await db.accountSplitAction.findFirst({
    where: retainedSplitWhere(source),
    select: { id: true },
  })
  return action !== null
}

export async function hasUnreviewedRetainedSplitHistory(
  db: Pick<typeof prisma, 'accountSplitAction'>,
  source: SplitHistorySource & Pick<StopSource, 'stopLossReviewedAt'>
): Promise<boolean> {
  if (!source.stopLossReviewedAt)
    return hasRelevantRetainedSplitHistory(db, source)
  const reviewedDate = new Date(
    `${sydneyCalendarDate(source.stopLossReviewedAt)}T00:00:00Z`
  )
  const action = await db.accountSplitAction.findFirst({
    where: {
      AND: [
        retainedSplitWhere(source),
        {
          OR: [
            { recordedAt: { gt: source.stopLossReviewedAt } },
            {
              reversal: {
                is: { recordedAt: { gt: source.stopLossReviewedAt } },
              },
            },
            { effectiveDate: { gt: reviewedDate } },
          ],
        },
      ],
    },
    select: { id: true },
  })
  return action !== null
}

export async function requireSupportedStopLossHistory(
  db: Pick<typeof prisma, 'accountSplitAction'>,
  source: SplitHistorySource & Pick<StopSource, 'stopLossReviewedAt'>
): Promise<void> {
  if (await hasUnreviewedRetainedSplitHistory(db, source))
    throw Object.assign(
      new Error(
        'Stop-loss monitoring is unavailable until the latest retained split is manually reviewed.'
      ),
      { status: 409, name: 'Conflict' }
    )
}

export async function requireSupportedPriceHistory(
  db: Pick<typeof prisma, 'accountSplitAction'>,
  source: Pick<HistorySource, 'id' | 'accountId' | 'assetId' | 'openDate'>
): Promise<void> {
  if (await hasRelevantRetainedSplitHistory(db, source))
    throw Object.assign(
      new Error(
        'Drawdown and run-up calculations are unavailable for positions with retained split history.'
      ),
      { status: 409, name: 'Conflict' }
    )
}

export async function savePositionHistory(
  source: HistorySource,
  data: DerivedValues
): Promise<void> {
  await prisma.$transaction(async (db) => {
    await lockOwnedPosition(db, source.userId, source.id)
    await requireSupportedPriceHistory(db, source)
    const ledger = await db.accountCashLedger.findUnique({
      where: { accountId: source.accountId },
      select: { accountId: true },
    })
    const result = await db.position.updateMany({
      where: {
        id: source.id,
        userId: source.userId,
        accountId: source.accountId,
        voidedAt: null,
        assetId: source.assetId,
        entryPrice: source.entryPrice,
        openDate: source.openDate,
        status: source.status,
        closeDate: source.closeDate,
        updatedAt: source.updatedAt,
        ...(data.maxDrawdownPercent !== undefined
          ? { maxDrawdownPercent: source.maxDrawdownPercent }
          : {}),
        ...(data.maxRunUpPercent !== undefined
          ? { maxRunUpPercent: source.maxRunUpPercent }
          : {}),
      },
      data: { ...data, ...(ledger ? { updatedAt: source.updatedAt } : {}) },
    })
    if (result.count !== 1) sourceChanged()
  }, transactionOptions)
}

export async function savePositionStopLossHit(
  source: StopSource,
  hitAt: Date
): Promise<void> {
  await prisma.$transaction(async (db) => {
    await lockOwnedPosition(db, source.userId, source.id)
    await requireSupportedStopLossHistory(db, source)
    const ledger = await db.accountCashLedger.findUnique({
      where: { accountId: source.accountId },
      select: { accountId: true },
    })
    const result = await db.position.updateMany({
      where: {
        id: source.id,
        userId: source.userId,
        accountId: source.accountId,
        voidedAt: null,
        assetId: source.assetId,
        openDate: source.openDate,
        status: source.status,
        positionType: source.positionType,
        stopLossPrice: source.stopLossPrice,
        stopLossSetAt: source.stopLossSetAt,
        stopLossHitAt: source.stopLossHitAt,
        updatedAt: source.updatedAt,
      },
      data: {
        stopLossHitAt: hitAt,
        ...(ledger ? { updatedAt: source.updatedAt } : {}),
      },
    })
    if (result.count !== 1) sourceChanged()
  }, transactionOptions)
}
