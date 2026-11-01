import { prisma } from './prisma.js'
import { lockExistingUserLifecycle } from './user-lock.js'

const transactionOptions = {
  isolationLevel: 'ReadCommitted',
  timeout: 15000,
  maxWait: 5000,
} as const

function invalidResetToken(): never {
  throw Object.assign(new Error('Invalid or expired reset token'), {
    status: 400,
    name: 'Bad Request',
  })
}

export async function issuePasswordReset(
  userId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<boolean> {
  return prisma.$transaction(async (db) => {
    if (!(await lockExistingUserLifecycle(db, userId))) return false
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    })
    // Preserve the endpoint's non-enumerating response for deleted/purged users.
    if (!user || user.deletedAt) return false
    await db.passwordResetToken.deleteMany({ where: { userId } })
    await db.passwordResetToken.create({
      data: { userId, token: tokenHash, expiresAt },
    })
    return true
  }, transactionOptions)
}

export async function completePasswordReset(
  userId: string,
  tokenHash: string,
  passwordHash: string
): Promise<void> {
  await prisma.$transaction(async (db) => {
    if (!(await lockExistingUserLifecycle(db, userId))) invalidResetToken()
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    })
    if (!user || user.deletedAt) invalidResetToken()
    const consumed = await db.passwordResetToken.deleteMany({
      where: { userId, token: tokenHash, expiresAt: { gt: new Date() } },
    })
    if (consumed.count !== 1) invalidResetToken()
    await db.user.update({ where: { id: userId }, data: { passwordHash } })
    await db.passwordResetToken.deleteMany({ where: { userId } })
    await db.refreshToken.deleteMany({ where: { userId } })
  }, transactionOptions)
}
