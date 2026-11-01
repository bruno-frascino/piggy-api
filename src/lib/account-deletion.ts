import { prisma } from './prisma.js'
import { lockActiveUser, lockUserLifecycle } from './user-lock.js'

/** Days a deleted account is retained before it is permanently purged.
 * The window exists so a deletion triggered by mistake — or by someone who
 * stole a session — can still be undone by the real account owner. */
export const DELETION_GRACE_DAYS = 30

export function purgeAfterFrom(deletedAt: Date): Date {
  return new Date(
    deletedAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000
  )
}

const transactionOptions = {
  isolationLevel: 'ReadCommitted',
  timeout: 15000,
  maxWait: 5000,
} as const

function unauthorized(message: string): never {
  throw Object.assign(new Error(message), { status: 401, name: 'Unauthorized' })
}

export async function persistUserSession(
  userId: string,
  verifiedPasswordHash: string,
  token: string,
  expiresAt: Date
) {
  await prisma.$transaction(async (db) => {
    await lockActiveUser(db, userId)
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    })
    if (!user || user.passwordHash !== verifiedPasswordHash)
      unauthorized('Invalid credentials')
    await db.refreshToken.create({ data: { userId, token, expiresAt } })
  }, transactionOptions)
}

export async function rotateUserSession(
  userId: string,
  previousToken: string,
  token: string,
  expiresAt: Date
) {
  await prisma.$transaction(async (db) => {
    await lockActiveUser(db, userId)
    const revoked = await db.refreshToken.deleteMany({
      where: { userId, token: previousToken, expiresAt: { gt: new Date() } },
    })
    if (revoked.count !== 1) unauthorized('Refresh token revoked or expired')
    await db.refreshToken.create({ data: { userId, token, expiresAt } })
  }, transactionOptions)
}

export async function scheduleUserDeletion(
  userId: string,
  verifiedPasswordHash: string,
  deletedAt = new Date()
) {
  return prisma.$transaction(async (db) => {
    await lockUserLifecycle(db, userId)
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, deletedAt: true },
    })
    if (!user || user.deletedAt)
      unauthorized('Session expired. Please log in again.')
    if (user.passwordHash !== verifiedPasswordHash)
      unauthorized('Password changed during deletion. Authenticate again.')
    const purgeAfter = purgeAfterFrom(deletedAt)
    await db.user.update({
      where: { id: userId },
      data: { deletedAt, purgeAfter },
    })
    await db.refreshToken.deleteMany({ where: { userId } })
    await db.passwordResetToken.deleteMany({ where: { userId } })
    return { deletedAt, purgeAfter }
  }, transactionOptions)
}

export async function restoreDeletedUser(
  userId: string,
  verifiedPasswordHash: string,
  expectedDeletedAt: Date,
  refreshToken: string,
  expiresAt: Date
) {
  await prisma.$transaction(async (db) => {
    await lockUserLifecycle(db, userId)
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, deletedAt: true },
    })
    if (!user || user.passwordHash !== verifiedPasswordHash)
      unauthorized('Invalid credentials')
    if (
      !user.deletedAt ||
      user.deletedAt.getTime() !== expectedDeletedAt.getTime()
    )
      throw Object.assign(
        new Error(
          'Account deletion state changed. Sign in or review restoration again.'
        ),
        {
          status: 409,
          name: 'Conflict',
        }
      )
    await db.user.update({
      where: { id: userId },
      data: { deletedAt: null, purgeAfter: null },
    })
    await db.refreshToken.create({
      data: { userId, token: refreshToken, expiresAt },
    })
  }, transactionOptions)
}

/** Permanently removes accounts whose grace period has expired. Every
 * user-scoped table cascades from `users`, so one delete per user suffices. */
export async function purgeExpiredAccounts(
  now = new Date()
): Promise<string[]> {
  const due = await prisma.user.findMany({
    where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
    select: { id: true },
  })

  const purged: string[] = []
  for (const user of due) {
    const result = await prisma.user.deleteMany({
      where: {
        id: user.id,
        deletedAt: { not: null },
        purgeAfter: { lte: now },
      },
    })
    if (result.count === 1) purged.push(user.id)
  }
  return purged
}
