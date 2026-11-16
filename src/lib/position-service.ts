import { prisma } from './prisma.js'
import { normalizeInstrument } from './crypto/instrument.js'
import { AccountingDecimal } from './accounting-values.js'
import { sydneyCalendarDate } from './accounting-preview.js'
import { projectStoredParcelInventory } from './stored-parcel-inventory.js'
import {
  getKrakenMarkets,
  KrakenMarketsUnavailable,
} from './crypto/kraken-markets.js'

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
  marketCap?: number,
  db: Pick<typeof prisma, 'asset'> = prisma
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

  const existing = await db.asset.findUnique({
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
      return db.asset.update({
        where: { id: existing.id },
        data: updateData,
      })
    }
    return existing
  }

  return db.asset.create({
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

export async function validateKrakenMarket(
  symbol: string,
  exchangeCode: string,
  assetType?: string
) {
  const instrument = normalizeInstrument(symbol, exchangeCode, assetType)
  if (exchangeCode === 'KRAKEN' || exchangeCode === 'KRAKEN_USD') {
    try {
      const markets = await getKrakenMarkets()
      if (
        !markets.some(
          (market) =>
            market.symbol === instrument.symbol &&
            market.exchangeCode === exchangeCode
        )
      ) {
        throw Object.assign(
          new Error(
            "This coin is not listed in Kraken's catalogue for the selected currency. Choose another coin or import historical trades."
          ),
          { status: 400 }
        )
      }
    } catch (error) {
      if (!(error instanceof KrakenMarketsUnavailable)) throw error
      console.error('Kraken position validation failed:', error.message)
      throw Object.assign(
        new Error(
          'Kraken market validation is temporarily unavailable. Please try again.'
        ),
        { status: 503 }
      )
    }
  }
  return instrument
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
    include: {
      transactions: { orderBy: { date: 'asc' } },
      splitEffects: { include: { action: true } },
      asset: { include: { splitActions: true } },
    },
  })
  if (!position) return null

  const buyTxs = position.transactions.filter(
    (tx) => tx.type === 'BUY' && !tx.voidedAt
  )
  const sellTxs = position.transactions.filter(
    (tx) => tx.type === 'SELL' && !tx.voidedAt
  )

  const buyQty = buyTxs.reduce((sum, tx) => sum + Number(tx.quantity), 0)
  const sellQty = sellTxs.reduce((sum, tx) => sum + Number(tx.quantity), 0)
  const observationDate = [
    sydneyCalendarDate(position.openDate),
    ...position.transactions
      .filter((tx) => !tx.voidedAt)
      .map((tx) => sydneyCalendarDate(tx.date)),
    ...position.splitEffects.map((effect) =>
      effect.action.effectiveDate.toISOString().slice(0, 10)
    ),
    ...position.asset.splitActions
      .filter((action) => action.accountId === position.accountId)
      .map((action) => action.effectiveDate.toISOString().slice(0, 10)),
  ]
    .sort()
    .at(-1)!
  const projected = projectStoredParcelInventory(position, observationDate)
  if (projected && position.positionType !== 'LONG')
    throw new Error('Only long split parcels are supported')
  const rawRemainingQty = projected
    ? Number(projected.remainingQuantity)
    : Math.max(0, buyQty - sellQty)
  const sellValue = sellTxs.reduce((sum, tx) => sum + Number(tx.totalValue), 0)
  const sellFees = sellTxs.reduce((sum, tx) => sum + Number(tx.fees), 0)
  const buyFees = Number(position.buyFees)
  const costBasisSold = Number(position.entryPrice) * sellQty
  const proratedBuyFees = buyQty > 0 ? buyFees * (sellQty / buyQty) : 0
  const allocatedCost = projected
    ? new AccountingDecimal(String(buyQty))
        .times(position.entryPrice.toFixed())
        .plus(position.buyFees.toFixed())
        .times(
          new AccountingDecimal(
            projected.remainingCostFraction.denominator
          ).minus(projected.remainingCostFraction.numerator)
        )
        .div(projected.remainingCostFraction.denominator)
        .toNumber()
    : costBasisSold + proratedBuyFees
  const realizedPnL = projected
    ? sellValue - sellFees - allocatedCost
    : sellValue - sellFees - costBasisSold - proratedBuyFees
  const returnPercentage =
    allocatedCost > 0 ? (realizedPnL / allocatedCost) * 100 : 0

  const hasAnySell = sellTxs.length > 0
  const latestSell = hasAnySell ? sellTxs[sellTxs.length - 1] : null
  const isClosed =
    hasAnySell &&
    buyQty > 0 &&
    (projected
      ? rawRemainingQty === 0
      : rawRemainingQty <= quantityTolerance(buyQty, sellQty))
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
