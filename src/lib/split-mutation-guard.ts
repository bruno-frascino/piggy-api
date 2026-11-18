import type { prisma } from './prisma.js'

/** Call under the account lock for write paths not yet split-aware. */
export async function requireNoSplitHistory(
  db: Pick<typeof prisma, 'accountSplitAction'>,
  accountIds: readonly string[]
): Promise<void> {
  const action = await db.accountSplitAction.findFirst({
    where: { accountId: { in: [...new Set(accountIds)] } },
    select: { id: true },
  })
  if (action) {
    throw Object.assign(
      new Error(
        'This account has retained stock split history. This financial change, import, move or deletion is not supported with the current split-aware accounting scope. Notes remain editable.'
      ),
      { status: 409, name: 'Accounting Conflict' }
    )
  }
}
