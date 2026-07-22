import { Router, Request, Response } from 'express'
import { body, param, query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import { fetchHistoricalMaxDrawdown } from '../lib/historical-drawdown.js'
import type { AssetType } from '@prisma/client'

const router = Router()
router.use(authenticateToken)

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findOrCreateAsset(
  symbol: string,
  exchangeCode: string,
  name?: string,
  assetType?: string,
  industry?: string
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
    if (normalizedIndustry && existing.industry !== normalizedIndustry) {
      return prisma.asset.update({
        where: { id: existing.id },
        data: { industry: normalizedIndustry },
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
      exchangeId: exchange.id,
    },
  })
}

async function resolveTradingAccount(
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

function toDateOnly(value: Date) {
  const d = new Date(value)
  d.setHours(0, 0, 0, 0)
  return d
}

async function recomputePositionFromTransactions(positionId: string) {
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

// ─── GET /api/positions ───────────────────────────────────────────────────────

/**
 * @swagger
 * /api/positions:
 *   get:
 *     summary: List all positions for the authenticated user
 *     tags: [Positions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [OPEN, CLOSED, PARTIAL]
 *       - in: query
 *         name: assetType
 *         schema:
 *           type: string
 *           enum: [EQUITY, ETF, CRYPTO]
 *       - in: query
 *         name: exchangeCode
 *         schema:
 *           type: string
 *         description: Filter by exchange code (e.g. NYSE, ASX)
 *       - in: query
 *         name: accountId
 *         schema:
 *           type: string
 *         description: Filter by trading account ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *     responses:
 *       200:
 *         description: Paginated list of positions
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  [
    query('status')
      .optional()
      .isString()
      .trim()
      .custom((value) => {
        const allowed = new Set(['OPEN', 'CLOSED', 'PARTIAL'])
        const values = String(value)
          .split(',')
          .map((v) => v.trim().toUpperCase())
          .filter(Boolean)
        return values.length > 0 && values.every((v) => allowed.has(v))
      }),
    query('assetType').optional().isIn(['EQUITY', 'ETF', 'CRYPTO']),
    query('exchangeCode').optional().isString().trim().toUpperCase(),
    query('accountId').optional().isString().trim(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const { status, assetType, exchangeCode, accountId } = req.query
    const limit = Number(req.query.limit) || 50
    const offset = Number(req.query.offset) || 0
    const statuses =
      typeof status === 'string'
        ? status
            .split(',')
            .map((v) => v.trim().toUpperCase())
            .filter(Boolean)
        : []

    const where: Record<string, unknown> = { userId: req.user!.userId }
    if (statuses.length === 1) {
      where.status = statuses[0]
    } else if (statuses.length > 1) {
      where.status = { in: statuses }
    }
    if (accountId) where.accountId = accountId
    if (assetType || exchangeCode) {
      where.asset = {
        ...(assetType ? { assetType } : {}),
        ...(exchangeCode ? { exchange: { code: exchangeCode } } : {}),
      }
    }

    const [positions, total] = await Promise.all([
      prisma.position.findMany({
        where,
        include: {
          account: true,
          asset: { include: { exchange: true } },
          transactions: { orderBy: { date: 'asc' } },
        },
        orderBy: { openDate: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.position.count({ where }),
    ])

    res.json({ success: true, data: positions, meta: { total, limit, offset } })
  })
)

// ─── POST /api/positions ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/positions:
 *   post:
 *     summary: Open a new position
 *     tags: [Positions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - symbol
 *               - exchangeCode
 *               - openDate
 *               - entryPrice
 *               - quantity
 *               - capitalAllocated
 *             properties:
 *               symbol:
 *                 type: string
 *                 example: AAPL
 *               exchangeCode:
 *                 type: string
 *                 example: NASDAQ
 *               assetName:
 *                 type: string
 *               assetType:
 *                 type: string
 *                 enum: [EQUITY, ETF, CRYPTO]
 *                 default: EQUITY
 *               industry:
 *                 type: string
 *               accountName:
 *                 type: string
 *                 description: Trading account name (defaults to Main)
 *               accountId:
 *                 type: string
 *                 description: Existing trading account id (preferred)
 *               openDate:
 *                 type: string
 *                 format: date-time
 *               entryPrice:
 *                 type: number
 *               quantity:
 *                 type: number
 *                 minimum: 0.000001
 *               capitalAllocated:
 *                 type: number
 *               openReason:
 *                 type: string
 *               positionType:
 *                 type: string
 *                 enum: [LONG, SHORT]
 *                 default: LONG
 *               buyFees:
 *                 type: number
 *                 default: 0
 *               stopLossPrice:
 *                 type: number
 *               takeProfitPrice:
 *                 type: number
 *               strategy:
 *                 type: string
 *               setupType:
 *                 type: string
 *               timeframe:
 *                 type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Position opened
 *       400:
 *         description: Validation error or exchange not found
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/',
  [
    body('symbol')
      .isString()
      .trim()
      .toUpperCase()
      .isLength({ min: 1, max: 20 }),
    body('exchangeCode').isString().trim().toUpperCase(),
    body('assetName').optional().isString().trim(),
    body('assetType').optional().isIn(['EQUITY', 'ETF', 'CRYPTO']),
    body('industry').optional().isString().trim(),
    body('accountName')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 1, max: 80 }),
    body('accountId').optional().isString().trim(),
    body('openDate').isISO8601().toDate(),
    body('entryPrice').isFloat({ min: 0.0001 }).toFloat(),
    body('quantity').isFloat({ min: 0.000001 }).toFloat(),
    body('capitalAllocated').isFloat({ min: 0 }).toFloat(),
    body('openReason').optional().isString().trim().isLength({ min: 1 }),
    body('positionType').optional().isIn(['LONG', 'SHORT']),
    body('buyFees').optional().isFloat({ min: 0 }).toFloat(),
    body('stopLossPrice')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .toFloat(),
    body('takeProfitPrice')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .toFloat(),
    body('strategy').optional().isString().trim(),
    body('setupType').optional().isString().trim(),
    body('timeframe').optional().isString().trim(),
    body('tags').optional().isArray(),
    body('tags.*').optional().isString(),
    body('notes').optional().isString().trim(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const {
      symbol,
      exchangeCode,
      assetName,
      assetType,
      industry,
      accountName,
      accountId,
      openDate,
      entryPrice,
      quantity,
      capitalAllocated,
      openReason,
      positionType,
      buyFees = 0,
      stopLossPrice,
      takeProfitPrice,
      strategy,
      setupType,
      timeframe,
      tags,
      notes,
    } = req.body

    const asset = await findOrCreateAsset(
      symbol,
      exchangeCode,
      assetName,
      assetType,
      industry
    )
    const account = await resolveTradingAccount(
      req.user!.userId,
      accountName,
      accountId
    )
    const totalBuyValue = entryPrice * quantity

    const position = await prisma.position.create({
      data: {
        userId: req.user!.userId,
        assetId: asset.id,
        accountId: account.id,
        openDate,
        entryPrice,
        quantity,
        positionType: positionType || 'LONG',
        totalBuyValue,
        buyFees,
        capitalAllocated,
        openReason: openReason ?? null,
        stopLossPrice: stopLossPrice ?? null,
        takeProfitPrice: takeProfitPrice ?? null,
        strategy: strategy ?? null,
        setupType: setupType ?? null,
        timeframe: timeframe ?? null,
        tags: tags ?? [],
        notes: notes ?? null,
        transactions: {
          create: {
            type: 'BUY',
            date: openDate,
            quantity,
            price: entryPrice,
            totalValue: totalBuyValue,
            fees: buyFees,
          },
        },
      },
      include: {
        account: true,
        asset: { include: { exchange: true } },
        transactions: true,
      },
    })

    res.status(201).json({ success: true, data: position })

    // Fire-and-forget: compute historical max drawdown in the background.
    // This must run after res.json() so it never delays the API response.
    void fetchHistoricalMaxDrawdown(asset.symbol, entryPrice, openDate)
      .then((drawdown) => {
        if (drawdown !== null) {
          return prisma.position.update({
            where: { id: position.id },
            data: { maxDrawdownPercent: drawdown },
          })
        }
      })
      .catch(() => {
        // silent — a failed history fetch must never crash the request cycle
      })
  })
)

// ─── GET /api/positions/close-events ─────────────────────────────────────────

/**
 * @swagger
 * /api/positions/close-events:
 *   get:
 *     summary: List close events (SELL transactions) for the authenticated user
 *     tags: [Positions]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of SELL transactions with position and asset context
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/close-events',
  asyncHandler(async (req: Request, res: Response) => {
    const events = await prisma.transaction.findMany({
      where: {
        type: 'SELL',
        position: {
          userId: req.user!.userId,
        },
      },
      include: {
        position: {
          include: {
            asset: { include: { exchange: true } },
            account: true,
            transactions: { orderBy: { date: 'asc' } },
          },
        },
      },
      orderBy: { date: 'desc' },
    })

    res.json({ success: true, data: events })
  })
)

// ─── POST /api/positions/:id/recalculate-drawdown ────────────────────────────

/**
 * @swagger
 * /api/positions/{id}/recalculate-drawdown:
 *   post:
 *     summary: Recalculate max drawdown from Yahoo Finance historical data
 *     description: >
 *       Fetches daily OHLC history from the position's open date to today,
 *       finds the lowest intraday low, and persists it as maxDrawdownPercent.
 *       Returns the new value (or null if history is unavailable / no drawdown).
 *     tags: [Positions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Recalculation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 maxDrawdownPercent:
 *                   type: number
 *                   nullable: true
 *                 message:
 *                   type: string
 *       404:
 *         description: Position not found
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/:id/recalculate-drawdown',
  [param('id').isString(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const position = await prisma.position.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: { asset: true },
    })
    if (!position) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Position not found' })
    }

    const drawdown = await fetchHistoricalMaxDrawdown(
      position.asset.symbol,
      Number(position.entryPrice),
      new Date(position.openDate)
    )

    await prisma.position.update({
      where: { id: position.id },
      data: { maxDrawdownPercent: drawdown },
    })

    res.json({
      success: true,
      maxDrawdownPercent: drawdown,
      message:
        drawdown !== null
          ? `Max drawdown updated to ${drawdown.toFixed(2)}%`
          : 'No historical drawdown found; value cleared',
    })
  })
)

// ─── PATCH /api/positions/:id ─────────────────────────────────────────────────

/**
 * @swagger
 * /api/positions/{id}:
 *   patch:
 *     summary: Update metadata on an open position
 *     tags: [Positions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               symbol:
 *                 type: string
 *               exchangeCode:
 *                 type: string
 *               accountName:
 *                 type: string
 *               accountId:
 *                 type: string
 *               openDate:
 *                 type: string
 *                 format: date-time
 *               entryPrice:
 *                 type: number
 *               quantity:
 *                 type: number
 *                 minimum: 0.000001
 *               buyFees:
 *                 type: number
 *               assetName:
 *                 type: string
 *               industry:
 *                 type: string
 *               stopLossPrice:
 *                 type: number
 *               takeProfitPrice:
 *                 type: number
 *               strategy:
 *                 type: string
 *               setupType:
 *                 type: string
 *               timeframe:
 *                 type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               notes:
 *                 type: string
 *               tradeGrade:
 *                 type: string
 *                 enum: [A, B, C, D, F]
 *               lessonsLearned:
 *                 type: string
 *               unrealizedPnL:
 *                 type: number
 *               currentPrice:
 *                 type: number
 *                 description: Current market price (used to calculate max drawdown)
 *     responses:
 *       200:
 *         description: Position updated
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Position not found
 */
router.patch(
  '/:id',
  [
    param('id').isString(),
    body('symbol')
      .optional()
      .isString()
      .trim()
      .toUpperCase()
      .isLength({ min: 1, max: 20 }),
    body('exchangeCode').optional().isString().trim().toUpperCase(),
    body('accountName')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 1, max: 80 }),
    body('accountId').optional().isString().trim(),
    body('openDate').optional().isISO8601().toDate(),
    body('entryPrice').optional().isFloat({ min: 0.0001 }).toFloat(),
    body('quantity').optional().isFloat({ min: 0.000001 }).toFloat(),
    body('buyFees').optional().isFloat({ min: 0 }).toFloat(),
    body('assetName').optional().isString().trim(),
    body('industry').optional().isString().trim(),
    body('stopLossPrice')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .toFloat(),
    body('takeProfitPrice')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .toFloat(),
    body('strategy').optional().isString().trim(),
    body('setupType').optional().isString().trim(),
    body('timeframe').optional().isString().trim(),
    body('tags').optional().isArray(),
    body('notes').optional().isString().trim(),
    body('tradeGrade').optional().isIn(['A', 'B', 'C', 'D', 'F']),
    body('lessonsLearned').optional().isString().trim(),
    body('unrealizedPnL').optional().isFloat().toFloat(),
    body('currentPrice').optional().isFloat({ min: 0 }).toFloat(),
    body('maxDrawdownPercent')
      .optional({ nullable: true })
      .custom((v) => {
        if (v === null) return true
        if (typeof v === 'number' && isFinite(v) && v >= 0) return true
        throw new Error('Must be null or a non-negative number')
      }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.position.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        asset: { include: { exchange: true } },
        transactions: { orderBy: { date: 'asc' } },
      },
    })
    if (!existing) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Position not found' })
    }

    const {
      stopLossPrice,
      takeProfitPrice,
      strategy,
      setupType,
      timeframe,
      tags,
      notes,
      tradeGrade,
      lessonsLearned,
      unrealizedPnL,
      currentPrice,
      maxDrawdownPercent: maxDrawdownPercentBody,
      symbol,
      exchangeCode,
      accountName,
      accountId,
      openDate,
      entryPrice,
      quantity,
      buyFees,
      assetName,
      industry,
    } = req.body

    const updates: Record<string, unknown> = {
      ...(stopLossPrice !== undefined && { stopLossPrice }),
      ...(takeProfitPrice !== undefined && { takeProfitPrice }),
      ...(strategy !== undefined && { strategy }),
      ...(setupType !== undefined && { setupType }),
      ...(timeframe !== undefined && { timeframe }),
      ...(tags !== undefined && { tags }),
      ...(notes !== undefined && { notes }),
      ...(tradeGrade !== undefined && { tradeGrade }),
      ...(lessonsLearned !== undefined && { lessonsLearned }),
      ...(unrealizedPnL !== undefined && { unrealizedPnL }),
    }

    // Allow explicit maxDrawdownPercent override (null resets it; a number sets it directly).
    // Falls back to auto-calculating from currentPrice only when not explicitly provided.
    if (maxDrawdownPercentBody !== undefined) {
      updates.maxDrawdownPercent =
        maxDrawdownPercentBody === null ? null : Number(maxDrawdownPercentBody)
    } else if (currentPrice !== undefined && currentPrice > 0) {
      const entryPriceValue = Number(existing.entryPrice)
      const drawdownPct =
        ((currentPrice - entryPriceValue) / entryPriceValue) * 100

      // Only track negative drawdowns (when price is below entry)
      if (drawdownPct < 0) {
        const absDrawdownPct = Math.abs(drawdownPct)
        const existingMaxDrawdown =
          (existing as any).maxDrawdownPercent !== undefined &&
          (existing as any).maxDrawdownPercent !== null
            ? Number((existing as any).maxDrawdownPercent)
            : 0

        // Update if this is a new maximum drawdown
        if (absDrawdownPct > existingMaxDrawdown) {
          updates.maxDrawdownPercent = absDrawdownPct
        }
      }
    }
    const resolvedSymbol =
      typeof symbol === 'string' && symbol.trim()
        ? symbol.trim().toUpperCase()
        : null
    const resolvedExchangeCode =
      typeof exchangeCode === 'string' && exchangeCode.trim()
        ? exchangeCode.trim().toUpperCase()
        : null

    let resolvedAssetId = existing.assetId
    if (
      resolvedSymbol ||
      resolvedExchangeCode ||
      assetName !== undefined ||
      industry !== undefined
    ) {
      const targetSymbol = resolvedSymbol ?? existing.asset.symbol
      const targetExchangeCode =
        resolvedExchangeCode ?? existing.asset.exchange.code
      const asset = await findOrCreateAsset(
        targetSymbol,
        targetExchangeCode,
        assetName ?? existing.asset.name,
        existing.asset.assetType,
        industry ?? existing.asset.industry ?? undefined
      )
      resolvedAssetId = asset.id
      updates.assetId = asset.id
    }

    if (accountId !== undefined || accountName !== undefined) {
      const account = await resolveTradingAccount(
        req.user!.userId,
        accountName,
        accountId
      )
      updates.accountId = account.id
    }

    const resolvedQuantity =
      typeof quantity === 'number' ? quantity : existing.quantity
    const resolvedEntryPrice =
      typeof entryPrice === 'number' ? entryPrice : Number(existing.entryPrice)
    const resolvedBuyFees =
      typeof buyFees === 'number' ? buyFees : Number(existing.buyFees)
    const resolvedOpenDate = openDate ?? existing.openDate

    if (
      quantity !== undefined ||
      entryPrice !== undefined ||
      buyFees !== undefined ||
      openDate !== undefined
    ) {
      const primaryBuy = existing.transactions.find((tx) => tx.type === 'BUY')
      if (primaryBuy) {
        await prisma.transaction.update({
          where: { id: primaryBuy.id },
          data: {
            ...(openDate !== undefined && { date: resolvedOpenDate }),
            ...(quantity !== undefined && { quantity: resolvedQuantity }),
            ...(entryPrice !== undefined && { price: resolvedEntryPrice }),
            ...(buyFees !== undefined && { fees: resolvedBuyFees }),
            ...(quantity !== undefined ||
            entryPrice !== undefined ||
            buyFees !== undefined
              ? {
                  totalValue: resolvedEntryPrice * resolvedQuantity,
                }
              : {}),
          },
        })
      }

      updates.openDate = resolvedOpenDate
      updates.entryPrice = resolvedEntryPrice
      updates.quantity = resolvedQuantity
      updates.buyFees = resolvedBuyFees
      updates.totalBuyValue = resolvedEntryPrice * resolvedQuantity
      updates.capitalAllocated =
        resolvedEntryPrice * resolvedQuantity + resolvedBuyFees
    }

    const updated = await prisma.position.update({
      where: { id: req.params.id },
      data: updates,
      include: { asset: { include: { exchange: true } } },
    })
    res.json({ success: true, data: updated })
  })
)

// ─── POST /api/positions/:id/close ───────────────────────────────────────────

/**
 * @swagger
 * /api/positions/{id}/close:
 *   post:
 *     summary: Close (or partially close) an open position
 *     tags: [Positions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - closeDate
 *               - exitPrice
 *             properties:
 *               closeDate:
 *                 type: string
 *                 format: date-time
 *               exitPrice:
 *                 type: number
 *               quantity:
 *                 type: number
 *                 minimum: 0.000001
 *                 description: Omit to close the full position
 *               fees:
 *                 type: number
 *                 default: 0
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Position closed (or partially closed — status becomes PARTIAL)
 *       400:
 *         description: Position is already closed
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Position not found
 */
router.post(
  '/:id/close',
  [
    param('id').isString(),
    body('closeDate').isISO8601().toDate(),
    body('exitPrice').isFloat({ min: 0.0001 }).toFloat(),
    body('quantity').optional().isFloat({ min: 0.000001 }).toFloat(),
    body('fees').optional().isFloat({ min: 0 }).toFloat(),
    body('notes').optional().isString().trim(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const position = await prisma.position.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        transactions: { orderBy: { date: 'asc' } },
      },
    })
    if (!position) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Position not found' })
    }
    if (position.status === 'CLOSED') {
      return res
        .status(400)
        .json({ error: 'Bad Request', message: 'Position is already closed' })
    }

    const { closeDate, exitPrice, fees = 0, notes } = req.body
    const normalizedCloseNotes =
      typeof notes === 'string' && notes.trim() ? notes.trim() : null
    const buyQty = position.transactions
      .filter((tx) => tx.type === 'BUY')
      .reduce((sum, tx) => sum + Number(tx.quantity), 0)
    const soldQty = position.transactions
      .filter((tx) => tx.type === 'SELL')
      .reduce((sum, tx) => sum + Number(tx.quantity), 0)
    const remainingQty = Math.max(0, buyQty - soldQty)

    if (remainingQty <= 0) {
      return res
        .status(400)
        .json({ error: 'Bad Request', message: 'No remaining units to close' })
    }

    const closeQty =
      req.body.quantity !== undefined ? Number(req.body.quantity) : remainingQty

    if (closeQty > remainingQty + 1e-9) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Close quantity exceeds remaining units (${remainingQty})`,
      })
    }

    const totalSellValue = exitPrice * closeQty
    await prisma.transaction.create({
      data: {
        positionId: req.params.id,
        type: 'SELL',
        date: closeDate,
        quantity: closeQty,
        price: exitPrice,
        totalValue: totalSellValue,
        fees,
        notes: normalizedCloseNotes,
      },
    })

    await recomputePositionFromTransactions(req.params.id)

    const updated = await prisma.position.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        asset: { include: { exchange: true } },
        transactions: { orderBy: { date: 'asc' } },
      },
    })

    res.json({ success: true, data: updated })
  })
)

// ─── DELETE /api/positions/:id ────────────────────────────────────────────────

/**
 * @swagger
 * /api/positions/{id}:
 *   delete:
 *     summary: Permanently delete a position and all its transactions
 *     tags: [Positions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Position deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Position not found
 */
router.delete(
  '/:id',
  [param('id').isString(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const position = await prisma.position.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    })
    if (!position) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Position not found' })
    }
    await prisma.position.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Position deleted' })
  })
)

export default router
