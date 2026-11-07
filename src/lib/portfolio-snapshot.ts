import { prisma } from './prisma.js'
import { lockOwnedTradingAccount } from './account-lock.js'
import { computeSnapshotValues } from './portfolio-calc.js'

export async function savePortfolioSnapshot(
  userId: string,
  accountId: string,
  exchangeId: string
) {
  return prisma.$transaction(
    async (db) => {
      await lockOwnedTradingAccount(db, userId, accountId)
      const [open, closed] = await Promise.all([
        db.position.findMany({
          where: {
            userId,
            accountId,
            voidedAt: null,
            status: { in: ['OPEN', 'PARTIAL'] },
            asset: { exchangeId },
          },
          select: { capitalAllocated: true, unrealizedPnL: true },
        }),
        db.position.findMany({
          where: {
            userId,
            accountId,
            status: 'CLOSED',
            voidedAt: null,
            asset: { exchangeId },
          },
          select: { realizedPnL: true },
        }),
      ])
      const values = computeSnapshotValues(
        open.map((p) => ({
          capitalAllocated: Number(p.capitalAllocated),
          unrealizedPnL:
            p.unrealizedPnL !== null ? Number(p.unrealizedPnL) : null,
        })),
        closed.map((p) => ({
          realizedPnL: p.realizedPnL !== null ? Number(p.realizedPnL) : null,
        }))
      )
      const date = new Date()
      date.setHours(0, 0, 0, 0)
      return db.portfolioSnapshot.upsert({
        where: {
          userId_accountId_exchangeId_date: {
            userId,
            accountId,
            exchangeId,
            date,
          },
        },
        create: { userId, accountId, exchangeId, date, ...values },
        update: values,
      })
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}
