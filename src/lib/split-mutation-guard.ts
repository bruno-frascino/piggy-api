import type { prisma } from './prisma.js'

/** Call under the account lock until writers can replay and audit split history. */
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
        'This account has retained stock split history. Financial writes, imports, moves and deletion require split-aware accounting, which is not yet available. Notes remain editable.'
      ),
      { status: 409, name: 'Accounting Conflict' }
    )
  }
}
