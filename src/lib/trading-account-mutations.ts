import { prisma } from './prisma.js'
import { lockOwnedTradingAccount } from './account-lock.js'

const transactionOptions = {
  isolationLevel: 'ReadCommitted',
  timeout: 15000,
  maxWait: 5000,
} as const

function conflict(message: string): never {
  throw Object.assign(new Error(message), { status: 409, name: 'Conflict' })
}

async function loadAccount(
  db: Pick<typeof prisma, 'tradingAccount'>,
  userId: string,
  id: string
) {
  const account = await db.tradingAccount.findFirst({ where: { id, userId } })
  if (!account)
    throw Object.assign(new Error('Trading account not found'), {
      status: 404,
      name: 'Not Found',
    })
  return account
}

export async function closeTradingAccount(userId: string, id: string) {
  return prisma.$transaction(async (db) => {
    await lockOwnedTradingAccount(db, userId, id)
    const account = await loadAccount(db, userId, id)
    const count = await db.position.count({
      where: { accountId: id, userId, status: { in: ['OPEN', 'PARTIAL'] } },
    })
    if (count > 0)
      conflict(
        'Account still has open positions. Close them before archiving this account.'
      )
    if (account.status === 'CLOSED') return account
    return db.tradingAccount.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
  }, transactionOptions)
}

export async function reopenTradingAccount(userId: string, id: string) {
  return prisma.$transaction(async (db) => {
    await lockOwnedTradingAccount(db, userId, id)
    await loadAccount(db, userId, id)
    return db.tradingAccount.update({
      where: { id },
      data: { status: 'ACTIVE', closedAt: null },
    })
  }, transactionOptions)
}

export async function renameTradingAccount(
  userId: string,
  id: string,
  name: string
) {
  return prisma.$transaction(async (db) => {
    await lockOwnedTradingAccount(db, userId, id)
    await loadAccount(db, userId, id)
    const existing = await db.tradingAccount.findFirst({
      where: { userId, name, id: { not: id } },
      select: { id: true },
    })
    if (existing) conflict('An account with this name already exists')
    return db.tradingAccount.update({ where: { id }, data: { name } })
  }, transactionOptions)
}

export async function deleteTradingAccount(userId: string, id: string) {
  return prisma.$transaction(async (db) => {
    await lockOwnedTradingAccount(db, userId, id)
    const account = await loadAccount(db, userId, id)
    if (!account.isDemo) {
      const count = await db.position.count({
        where: { accountId: id, userId },
      })
      if (count > 0)
        conflict(
          `Account '${account.name}' still has ${count} position${count === 1 ? '' : 's'}. Delete them first, or close the account to keep its history.`
        )
      const reports = await db.taxReport.findMany({
        where: { userId },
        select: { financialYearLabel: true, accountsKey: true },
      })
      const years = [
        ...new Set(
          reports
            .filter((report) => report.accountsKey.split(',').includes(id))
            .map((report) => report.financialYearLabel)
        ),
      ].sort()
      if (years.length)
        conflict(
          `Account '${account.name}' is included in generated tax report${years.length === 1 ? '' : 's'} for ${years.join(', ')}. Delete those reports first, or close the account to keep its history.`
        )
    }
    await db.tradingAccount.delete({ where: { id } })
    return account.isDemo
      ? `Demo account '${account.name}' and all its data deleted`
      : `Account '${account.name}' deleted`
  }, transactionOptions)
}
