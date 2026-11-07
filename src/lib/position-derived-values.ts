import { prisma } from './prisma.js'
import { lockOwnedPosition } from './account-lock.js'

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
>

type StopSource = HistorySource &
  Pick<
    Position,
    'positionType' | 'stopLossPrice' | 'stopLossSetAt' | 'stopLossHitAt'
  >

type DerivedValues = {
  maxDrawdownPercent?: number | null
  maxRunUpPercent?: number | null
}

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

export async function savePositionHistory(
  source: HistorySource,
  data: DerivedValues
): Promise<void> {
  await prisma.$transaction(async (db) => {
    await lockOwnedPosition(db, source.userId, source.id)
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
        ...(data.maxDrawdownPercent !== undefined
          ? { maxDrawdownPercent: source.maxDrawdownPercent }
          : {}),
        ...(data.maxRunUpPercent !== undefined
          ? { maxRunUpPercent: source.maxRunUpPercent }
          : {}),
      },
      data,
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
      },
      data: { stopLossHitAt: hitAt },
    })
    if (result.count !== 1) sourceChanged()
  }, transactionOptions)
}
