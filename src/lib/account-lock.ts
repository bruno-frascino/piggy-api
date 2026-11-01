import { prisma } from './prisma.js'
import { lockActiveUser } from './user-lock.js'

type LockDb = Pick<typeof prisma, '$queryRaw'>

export async function lockOwnedTradingAccount(
  db: LockDb,
  userId: string,
  accountId: string
): Promise<void> {
  await lockActiveUser(db, userId)
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM trading_accounts
    WHERE id = ${accountId} AND "userId" = ${userId}
    FOR UPDATE
  `
  if (rows.length !== 1)
    throw Object.assign(new Error('Trading account not found'), {
      status: 404,
      name: 'Not Found',
    })
}

/** Account first, parcel second; a concurrent account move requires a fresh request. */
export async function lockOwnedPosition(
  db: LockDb,
  userId: string,
  positionId: string,
  destinationAccountId?: string
): Promise<void> {
  const candidates = await db.$queryRaw<{ accountId: string }[]>`
    SELECT "accountId" FROM positions WHERE id = ${positionId} AND "userId" = ${userId}
  `
  if (candidates.length !== 1)
    throw Object.assign(new Error('Position not found'), {
      status: 404,
      name: 'Not Found',
    })
  const accounts = [
    ...new Set([
      candidates[0].accountId,
      ...(destinationAccountId ? [destinationAccountId] : []),
    ]),
  ].sort()
  for (const accountId of accounts)
    await lockOwnedTradingAccount(db, userId, accountId)
  const positions = await db.$queryRaw<{ accountId: string }[]>`
    SELECT "accountId" FROM positions WHERE id = ${positionId} AND "userId" = ${userId}
    FOR UPDATE
  `
  if (positions.length !== 1)
    throw Object.assign(new Error('Position not found'), {
      status: 404,
      name: 'Not Found',
    })
  if (positions[0].accountId !== candidates[0].accountId)
    throw Object.assign(
      new Error('Position moved accounts concurrently. Reload and try again.'),
      {
        status: 409,
        name: 'Conflict',
      }
    )
}
