import { prisma } from './prisma.js'

type LockDb = Pick<typeof prisma, '$queryRaw'>

/** Shared user barrier before account locks; deletion/purge takes the user row exclusively. */
export async function lockActiveUser(
  db: LockDb,
  userId: string
): Promise<void> {
  const rows = await db.$queryRaw<{ id: string; deletedAt: Date | null }[]>`
    SELECT id, "deletedAt" FROM users WHERE id = ${userId} FOR SHARE
  `
  if (rows.length !== 1 || rows[0].deletedAt)
    throw Object.assign(new Error('Session expired. Please log in again.'), {
      status: 401,
      name: 'Unauthorized',
    })
}

export async function lockUserLifecycle(
  db: LockDb,
  userId: string
): Promise<void> {
  if (!(await lockExistingUserLifecycle(db, userId)))
    throw Object.assign(new Error('Session expired. Please log in again.'), {
      status: 401,
      name: 'Unauthorized',
    })
}

export async function lockExistingUserLifecycle(
  db: LockDb,
  userId: string
): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE id = ${userId} FOR UPDATE
  `
  return rows.length === 1
}
