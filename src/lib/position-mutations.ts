import { prisma } from './prisma.js'
import { lockActiveUser } from './user-lock.js'
import { lockOwnedPosition, lockOwnedTradingAccount } from './account-lock.js'
import {
  quantityTolerance,
  recomputePositionFromTransactions,
  resolveTradingAccount,
} from './position-service.js'

const transactionOptions = {
  isolationLevel: 'ReadCommitted',
  timeout: 15000,
  maxWait: 5000,
} as const

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), {
    status,
    name:
      status === 404
        ? 'Not Found'
        : status === 409
          ? 'Conflict'
          : 'Bad Request',
  })
}

function validDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    fail(400, 'Trade date must be valid')
}

function nonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0)
    fail(400, `${label} must be a finite non-negative number`)
}

type MutationDb = Pick<
  typeof prisma,
  'draftOperationTradeLink' | 'accountCashOperation'
>

async function requireUnlinkedTrades(
  db: MutationDb,
  transactionIds: string[]
): Promise<void> {
  const link = await db.draftOperationTradeLink.findFirst({
    where: { transactionId: { in: transactionIds } },
    select: { operationId: true },
  })
  if (link)
    fail(
      409,
      'This trade is linked to an inactive cash draft. Financial edits, moves and deletion require coordinated trade/cash correction. Use the opening reconciliation review for manual acquisition or sale corrections; moves and deletion are not yet supported there. Notes remain editable.'
    )
  const liveLink = await db.accountCashOperation.findFirst({
    where: { transactionId: { in: transactionIds } },
    select: { id: true },
  })
  if (liveLink)
    fail(
      409,
      'This trade is linked to the active account cash ledger. Financial edits, moves and deletion require a coordinated cash correction, which is not yet available. Notes remain editable.'
    )
}

async function requireNoCashLedger(
  db: Pick<typeof prisma, 'accountCashLedger'>,
  accountIds: string[]
): Promise<void> {
  for (const accountId of new Set(accountIds)) {
    if (
      await db.accountCashLedger.findUnique({
        where: { accountId },
        select: { accountId: true },
      })
    )
      fail(
        409,
        'This account has a confirmed cash ledger. Financial edits, moves and deletion require a coordinated accounting workflow, which is not yet available.'
      )
  }
}

function requireManualSource(imported: boolean): void {
  if (imported)
    fail(
      409,
      'Imported execution records must be preserved. Financial edits, moves and deletion require a source-aware adjustment workflow, which is not yet available. Notes remain editable.'
    )
}

export interface ClosePositionInput {
  closeDate: Date
  exitPrice: number
  quantity?: number
  fees?: number
  notes?: string
  closeReason?: 'STOP_LOSS' | 'TARGET' | 'MANUAL' | 'OTHER'
}

export async function closePosition(
  userId: string,
  positionId: string,
  input: ClosePositionInput
) {
  validDate(input.closeDate)
  nonNegative(input.exitPrice, 'Exit price')
  nonNegative(input.fees ?? 0, 'Fees')
  if (
    input.exitPrice <= 0 ||
    (input.quantity !== undefined &&
      (!Number.isFinite(input.quantity) || input.quantity <= 0))
  )
    fail(400, 'Exit price and close quantity must be positive')
  return prisma.$transaction(async (db) => {
    await lockOwnedPosition(db, userId, positionId)
    const position = await db.position.findFirst({
      where: { id: positionId, userId },
      include: { transactions: { orderBy: { date: 'asc' } } },
    })
    if (!position) fail(404, 'Position not found')
    await requireNoCashLedger(db, [position.accountId])
    if (position.status === 'CLOSED') fail(400, 'Position is already closed')
    const buyQty = position.transactions
      .filter((tx) => tx.type === 'BUY')
      .reduce((sum, tx) => sum + Number(tx.quantity), 0)
    const soldQty = position.transactions
      .filter((tx) => tx.type === 'SELL')
      .reduce((sum, tx) => sum + Number(tx.quantity), 0)
    const remainingQty = Math.max(0, buyQty - soldQty)
    if (!Number.isFinite(remainingQty))
      fail(400, 'Recorded parcel quantities require reconciliation')
    if (remainingQty <= 0) fail(400, 'No remaining units to close')
    const requestedQty = input.quantity ?? remainingQty
    if (
      requestedQty >
      remainingQty + quantityTolerance(buyQty, soldQty, requestedQty)
    )
      fail(400, `Close quantity exceeds remaining units (${remainingQty})`)
    const closeQty = Math.min(requestedQty, remainingQty)
    const totalSellValue = input.exitPrice * closeQty
    if (!Number.isFinite(totalSellValue))
      fail(400, 'Sale consideration must be finite')
    await db.transaction.create({
      data: {
        positionId,
        type: 'SELL',
        date: input.closeDate,
        quantity: closeQty,
        price: input.exitPrice,
        totalValue: totalSellValue,
        fees: input.fees ?? 0,
        notes: input.notes?.trim() || null,
        closeReason: input.closeReason ?? 'MANUAL',
      },
    })
    if (!(await recomputePositionFromTransactions(positionId, db)))
      fail(404, 'Position not found')
    const updated = await db.position.findFirst({
      where: { id: positionId, userId },
      include: {
        asset: { include: { exchange: true } },
        transactions: { orderBy: { date: 'asc' } },
      },
    })
    if (!updated) fail(404, 'Position not found')
    return updated
  }, transactionOptions)
}

export interface UpdateCloseEventInput {
  closeDate?: Date
  exitPrice?: number
  sellFees?: number
  notes?: string
  closeReason?: 'STOP_LOSS' | 'TARGET' | 'MANUAL' | 'OTHER' | null
}

export async function updateCloseEvent(
  userId: string,
  transactionId: string,
  input: UpdateCloseEventInput
) {
  if (input.closeDate !== undefined) validDate(input.closeDate)
  if (input.exitPrice !== undefined) {
    nonNegative(input.exitPrice, 'Exit price')
    if (input.exitPrice <= 0) fail(400, 'Exit price must be positive')
  }
  if (input.sellFees !== undefined) nonNegative(input.sellFees, 'Fees')
  return prisma.$transaction(async (db) => {
    const where = {
      id: transactionId,
      type: 'SELL' as const,
      position: { userId },
    }
    const pointer = await db.transaction.findFirst({
      where,
      select: {
        positionId: true,
        quantity: true,
        position: { select: { accountId: true } },
      },
    })
    if (!pointer) fail(404, 'Close event not found')
    await lockOwnedPosition(db, userId, pointer.positionId)
    const event = await db.transaction.findFirst({
      where,
      select: {
        positionId: true,
        quantity: true,
        date: true,
        price: true,
        fees: true,
        brokerRef: true,
      },
    })
    if (!event) fail(404, 'Close event not found')
    if (event.positionId !== pointer.positionId)
      fail(409, 'Close event moved parcels concurrently. Reload and try again.')
    const financial =
      (input.closeDate !== undefined &&
        input.closeDate.getTime() !== event.date.getTime()) ||
      (input.exitPrice !== undefined &&
        input.exitPrice !== Number(event.price)) ||
      (input.sellFees !== undefined && input.sellFees !== Number(event.fees))
    if (financial) {
      requireManualSource(event.brokerRef !== null)
      await requireNoCashLedger(db, [pointer.position.accountId])
      await requireUnlinkedTrades(db, [transactionId])
    }
    const totalValue =
      input.exitPrice === undefined
        ? undefined
        : input.exitPrice * Number(event.quantity)
    if (totalValue !== undefined && !Number.isFinite(totalValue))
      fail(400, 'Sale consideration must be finite')
    const updated = await db.transaction.update({
      where: { id: transactionId },
      data: {
        ...(financial &&
          input.closeDate !== undefined && { date: input.closeDate }),
        ...(financial &&
          input.exitPrice !== undefined && {
            price: input.exitPrice,
            totalValue,
          }),
        ...(financial &&
          input.sellFees !== undefined && { fees: input.sellFees }),
        ...(input.notes !== undefined && { notes: input.notes.trim() || null }),
        ...(input.closeReason !== undefined && {
          closeReason: input.closeReason,
        }),
      },
    })
    if (!(await recomputePositionFromTransactions(event.positionId, db)))
      fail(404, 'Position not found')
    return updated
  }, transactionOptions)
}

export async function deletePosition(
  userId: string,
  positionId: string
): Promise<void> {
  await prisma.$transaction(async (db) => {
    await lockOwnedPosition(db, userId, positionId)
    const position = await db.position.findFirst({
      where: { id: positionId, userId },
      include: { transactions: { select: { id: true, brokerRef: true } } },
    })
    if (!position) fail(404, 'Position not found')
    await requireNoCashLedger(db, [position.accountId])
    requireManualSource(
      position.origin !== 'MANUAL' ||
        position.transactions.some(
          (transaction) => transaction.brokerRef !== null
        )
    )
    await requireUnlinkedTrades(
      db,
      position.transactions.map((transaction) => transaction.id)
    )
    await db.position.delete({ where: { id: positionId } })
  }, transactionOptions)
}

type CreatePositionData = Parameters<typeof prisma.position.create>[0]['data']

export async function createPosition(
  userId: string,
  account: { accountId?: string; accountName?: string },
  data: Omit<
    Extract<CreatePositionData, { assetId: string }>,
    'accountId' | 'userId'
  >
) {
  return prisma.$transaction(async (db) => {
    await lockActiveUser(db, userId)
    const resolved = await resolveTradingAccount(
      userId,
      account.accountName,
      account.accountId,
      db
    )
    await lockOwnedTradingAccount(db, userId, resolved.id)
    const currentAccount = await db.tradingAccount.findFirst({
      where: { id: resolved.id, userId },
      select: { status: true },
    })
    if (!currentAccount) fail(404, 'Trading account not found')
    if (currentAccount.status === 'CLOSED')
      fail(409, 'Reopen the trading account before adding open holdings')
    await requireNoCashLedger(db, [resolved.id])
    return db.position.create({
      data: { ...data, userId, accountId: resolved.id },
      include: {
        account: true,
        asset: { include: { exchange: true } },
        transactions: true,
      },
    })
  }, transactionOptions)
}

export interface UpdateAcquisitionInput {
  openDate?: Date
  entryPrice?: number
  quantity?: number
  buyFees?: number
}

export async function updatePositionAcquisition(
  userId: string,
  positionId: string,
  input: UpdateAcquisitionInput,
  metadata: Record<string, unknown>,
  destinationAccountId?: string
) {
  if (input.openDate !== undefined) validDate(input.openDate)
  if (input.entryPrice !== undefined) {
    nonNegative(input.entryPrice, 'Entry price')
    if (input.entryPrice <= 0) fail(400, 'Entry price must be positive')
  }
  if (
    input.quantity !== undefined &&
    (!Number.isFinite(input.quantity) || input.quantity <= 0)
  )
    fail(400, 'Bought quantity must be positive and finite')
  if (input.buyFees !== undefined) nonNegative(input.buyFees, 'Buy fees')
  return prisma.$transaction(async (db) => {
    await lockOwnedPosition(db, userId, positionId, destinationAccountId)
    const existing = await db.position.findFirst({
      where: { id: positionId, userId },
      include: {
        account: { select: { isDemo: true, status: true } },
        transactions: { orderBy: { date: 'asc' } },
      },
    })
    if (!existing) fail(404, 'Position not found')
    let accountStatus = existing.account?.status
    if (destinationAccountId) {
      const destination = await db.tradingAccount.findFirst({
        where: { id: destinationAccountId, userId },
        select: { isDemo: true, status: true },
      })
      if (!destination) fail(404, 'Trading account not found')
      if (destination.isDemo !== existing.account.isDemo)
        fail(400, 'Positions cannot be moved between demo and real accounts')
      accountStatus = destination.status
    }
    const buys = existing.transactions.filter((tx) => tx.type === 'BUY')
    const financial =
      (input.openDate !== undefined &&
        input.openDate.getTime() !== existing.openDate.getTime()) ||
      (input.entryPrice !== undefined &&
        input.entryPrice !== Number(existing.entryPrice)) ||
      (input.quantity !== undefined &&
        (buys.length !== 1 || input.quantity !== Number(buys[0].quantity))) ||
      (input.buyFees !== undefined &&
        input.buyFees !== Number(existing.buyFees))
    const moving =
      destinationAccountId !== undefined &&
      destinationAccountId !== existing.accountId
    const changingAsset =
      metadata.assetId !== undefined && metadata.assetId !== existing.assetId
    if (financial || moving || changingAsset) {
      await requireNoCashLedger(db, [
        existing.accountId,
        ...(destinationAccountId ? [destinationAccountId] : []),
      ])
      requireManualSource(
        existing.origin !== 'MANUAL' ||
          (financial && buys.some((buy) => buy.brokerRef !== null)) ||
          ((moving || changingAsset) &&
            existing.transactions.some(
              (transaction) => transaction.brokerRef !== null
            ))
      )
      await requireUnlinkedTrades(
        db,
        existing.transactions.map((transaction) => transaction.id)
      )
    }
    const data = {
      ...metadata,
      ...(destinationAccountId ? { accountId: destinationAccountId } : {}),
    }
    if (financial) {
      if (buys.length !== 1)
        fail(
          409,
          'Acquisition edits require exactly one BUY transaction; reconcile this parcel first'
        )
      const buy = buys[0]
      const sold = existing.transactions
        .filter((tx) => tx.type === 'SELL')
        .reduce((sum, tx) => sum + Number(tx.quantity), 0)
      const quantity = input.quantity ?? Number(buy.quantity)
      const price = input.entryPrice ?? Number(existing.entryPrice)
      const fees = input.buyFees ?? Number(existing.buyFees)
      if (
        !Number.isFinite(sold) ||
        sold < 0 ||
        !Number.isFinite(quantity) ||
        quantity < sold - quantityTolerance(quantity, sold)
      )
        fail(400, 'Bought quantity cannot be less than units already sold')
      const total = price * quantity
      if (!Number.isFinite(total) || !Number.isFinite(total + fees))
        fail(400, 'Acquisition consideration must be finite')
      await db.transaction.update({
        where: { id: buy.id },
        data: {
          ...(input.openDate !== undefined && { date: input.openDate }),
          ...(input.quantity !== undefined && { quantity }),
          ...(input.entryPrice !== undefined && { price }),
          ...(input.buyFees !== undefined && { fees }),
          ...(input.quantity !== undefined ||
          input.entryPrice !== undefined ||
          input.buyFees !== undefined
            ? { totalValue: total }
            : {}),
        },
      })
      Object.assign(data, {
        openDate: input.openDate ?? existing.openDate,
        entryPrice: price,
        quantity: Math.max(0, quantity - sold),
        buyFees: fees,
        totalBuyValue: total,
        capitalAllocated: total + fees,
      })
    }
    await db.position.update({ where: { id: positionId }, data })
    if (financial && !(await recomputePositionFromTransactions(positionId, db)))
      fail(404, 'Position not found')
    const updated = await db.position.findFirst({
      where: { id: positionId, userId },
      include: { asset: { include: { exchange: true } } },
    })
    if (!updated) fail(404, 'Position not found')
    if (accountStatus === 'CLOSED' && updated.status !== 'CLOSED')
      fail(409, 'Reopen the trading account before adding open holdings')
    return updated
  }, transactionOptions)
}
