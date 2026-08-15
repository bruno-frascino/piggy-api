import { prisma } from './prisma.js'
import type { AssetType } from '@prisma/client'

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
  const normalizedSymbol = symbol.trim().toUpperCase()
  const normalizedExchange = exchangeCode.trim().toUpperCase()

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
      assetType: (assetType as AssetType) || 'EQUITY',
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
  accountId?: string
) {
  if (accountId) {
    const byId = await prisma.tradingAccount.findFirst({
      where: { id: accountId, userId },
    })
    if (byId) return byId
  }

  const normalizedName = (accountName?.trim() || 'Main').slice(0, 80)
  return prisma.tradingAccount.upsert({
    where: {
      userId_name: {
        userId,
        name: normalizedName,
      },
    },
    create: {
      userId,
      name: normalizedName,
    },
    update: {},
  })
}

export function toDateOnly(value: Date) {
  const d = new Date(value)
  d.setHours(0, 0, 0, 0)
  return d
}

export async function recomputePositionFromTransactions(positionId: string) {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: { transactions: { orderBy: { date: 'asc' } } },
  })
  if (!position) return null

  const buyTxs = position.transactions.filter((tx) => tx.type === 'BUY')
  const sellTxs = position.transactions.filter((tx) => tx.type === 'SELL')

  const buyQty = buyTxs.reduce((sum, tx) => sum + Number(tx.quantity), 0)
  const sellQty = sellTxs.reduce((sum, tx) => sum + Number(tx.quantity), 0)
  const remainingQty = Math.max(0, buyQty - sellQty)
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
  const isClosed = buyQty > 0 && sellQty >= buyQty - 1e-9
  const status = isClosed ? 'CLOSED' : hasAnySell ? 'PARTIAL' : 'OPEN'

  return prisma.position.update({
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
