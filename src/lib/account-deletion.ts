import { prisma } from './prisma.js'

/** Days a deleted account is retained before it is permanently purged.
 * The window exists so a deletion triggered by mistake — or by someone who
 * stole a session — can still be undone by the real account owner. */
export const DELETION_GRACE_DAYS = 30

export function purgeAfterFrom(deletedAt: Date): Date {
  return new Date(
    deletedAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000
  )
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

  for (const user of due) {
    await prisma.user.delete({ where: { id: user.id } })
  }

  return due.map((user) => user.id)
}
