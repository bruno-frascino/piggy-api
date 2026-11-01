import { prisma } from './prisma.js'
import { normalizeInstrument } from './crypto/instrument.js'

// Business-logic helpers extracted from the positions controller so they can
// be unit-tested independently of Express/route wiring and are no longer
// excluded from coverage thresholds.

export async function findOrCreateAsset(
  symbol: string,
  exchangeCode: string,
  name?: string,
  assetType?: string,
  industry?: string,
  sector?: string,
  marketCap?: number
) {
  const normalizedExchange = exchangeCode.trim().toUpperCase()
  const instrument = normalizeInstrument(symbol, normalizedExchange, assetType)
  const normalizedSymbol = instrument.symbol

  const exchange = await prisma.exchange.findUnique({
    where: { code: normalizedExchange },
  })
  if (!exchange) {
    const err = new Error(
      `Exchange '${normalizedExchange}' not found`
    ) as Error & { status: number }
    err.status = 404
    throw err
  }

  const existing = await prisma.asset.findUnique({
    where: {
      symbol_exchangeId: { symbol: normalizedSymbol, exchangeId: exchange.id },
    },
  })
  if (existing) {
    if (
      existing.assetType &&
      existing.assetType !== instrument.assetType &&
      instrument.assetType === 'CRYPTO'
    ) {
      throw Object.assign(
        new Error(
          'This asset has an incompatible asset type. Correct the existing asset before adding crypto positions.'
        ),
        { status: 409 }
      )
    }
    const normalizedIndustry = industry?.trim() || null
    const normalizedSector = sector?.trim() || null
    const updateData: Record<string, unknown> = {}
    if (normalizedIndustry && existing.industry !== normalizedIndustry) {
      updateData.industry = normalizedIndustry
    }
    if (normalizedSector && existing.sector !== normalizedSector) {
      updateData.sector = normalizedSector
    }
    if (marketCap !== undefined && Number(existing.marketCap) !== marketCap) {
      updateData.marketCap = marketCap
    }
    if (Object.keys(updateData).length > 0) {
      return prisma.asset.update({
        where: { id: existing.id },
        data: updateData,
      })
    }
    return existing
  }

  return prisma.asset.create({
    data: {
      symbol: normalizedSymbol,
      name: name?.trim() || normalizedSymbol,
      assetType: instrument.assetType,
      industry: industry?.trim() || null,
      sector: sector?.trim() || null,
      marketCap: marketCap ?? null,
      exchangeId: exchange.id,
    },
  })
}

export async function resolveTradingAccount(
  userId: string,
  accountName?: string,
  accountId?: string,
  db: Pick<typeof prisma, 'tradingAccount'> = prisma
) {
  if (accountId) {
    const byId = await db.tradingAccount.findFirst({
      where: { id: accountId, userId },
    })
    if (byId) return byId
    throw Object.assign(new Error('Trading account not found'), {
      status: 404,
      name: 'Not Found',
    })
  }

  const normalizedName = (accountName?.trim() || 'Main').slice(0, 80)
  return db.tradingAccount.upsert({
    where: {
      userId_name: {
        userId,
        name: normalizedName,
      },
    },
    create: {
      userId,
      name: normalizedName,
      isDemo: false,
    },
    update: {},
  })
}

export function toDateOnly(value: Date) {
  const d = new Date(value)
  // UTC: dates are stored as midnight-UTC calendar dates regardless of server timezone.
  d.setUTCHours(0, 0, 0, 0)
  return d
}

type PositionDb = Pick<typeof prisma, 'position'>

export function quantityTolerance(...quantities: number[]) {
  return Number.EPSILON * 8 * Math.max(...quantities.map(Math.abs))
}

export async function recomputePositionFromTransactions(
  positionId: string,
  db: PositionDb = prisma
) {
  const position = await db.position.findUnique({
    where: { id: positionId },
    include: { transactions: { orderBy: { date: 'asc' } } },
  })
  if (!position) return null

  const buyTxs = position.transactions.filter((tx) => tx.type === 'BUY')
  const sellTxs = position.transactions.filter((tx) => tx.type === 'SELL')

  const buyQty = buyTxs.reduce((sum, tx) => sum + Number(tx.quantity), 0)
  const sellQty = sellTxs.reduce((sum, tx) => sum + Number(tx.quantity), 0)
  const rawRemainingQty = Math.max(0, buyQty - sellQty)
  const sellValue = sellTxs.reduce((sum, tx) => sum + Number(tx.totalValue), 0)
  const sellFees = sellTxs.reduce((sum, tx) => sum + Number(tx.fees), 0)
  const buyFees = Number(position.buyFees)
  const costBasisSold = Number(position.entryPrice) * sellQty
  const proratedBuyFees = buyQty > 0 ? buyFees * (sellQty / buyQty) : 0
  const realizedPnL = sellValue - sellFees - costBasisSold - proratedBuyFees
  const returnPercentage =
    costBasisSold + proratedBuyFees > 0
      ? (realizedPnL / (costBasisSold + proratedBuyFees)) * 100
      : 0

  const hasAnySell = sellTxs.length > 0
  const latestSell = hasAnySell ? sellTxs[sellTxs.length - 1] : null
  const isClosed =
    hasAnySell &&
    buyQty > 0 &&
    rawRemainingQty <= quantityTolerance(buyQty, sellQty)
  const remainingQty = isClosed ? 0 : rawRemainingQty
  const status = isClosed ? 'CLOSED' : hasAnySell ? 'PARTIAL' : 'OPEN'

  return db.position.update({
    where: { id: positionId },
    data: {
      quantity: remainingQty,
      status,
      closeDate: isClosed && latestSell ? toDateOnly(latestSell.date) : null,
      exitPrice: latestSell ? Number(latestSell.price) : null,
      totalSellValue: hasAnySell ? sellValue : null,
      sellFees: hasAnySell ? sellFees : null,
      realizedPnL: hasAnySell ? realizedPnL : null,
      returnPercentage: hasAnySell ? returnPercentage : null,
    },
  })
}
