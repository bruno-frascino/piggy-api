import { Router, Request, Response } from 'express'
import { body, param, query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import type { AssetType } from '@prisma/client'

const router = Router()
router.use(authenticateToken)

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findOrCreateAsset(
  symbol: string,
  exchangeCode: string,
  name?: string,
  assetType?: string
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
  if (existing) return existing

  return prisma.asset.create({
    data: {
      symbol: normalizedSymbol,
      name: name?.trim() || normalizedSymbol,
      assetType: (assetType as AssetType) || 'EQUITY',
      exchangeId: exchange.id,
    },
  })
}

// ─── GET /api/positions ───────────────────────────────────────────────────────

router.get(
  '/',
  [
    query('status').optional().isIn(['OPEN', 'CLOSED', 'PARTIAL']),
    query('assetType').optional().isIn(['EQUITY', 'ETF', 'CRYPTO']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const { status, assetType } = req.query
    const limit = Number(req.query.limit) || 50
    const offset = Number(req.query.offset) || 0

    const where: Record<string, unknown> = { userId: req.user!.userId }
    if (status) where.status = status
    if (assetType) where.asset = { assetType }

    const [positions, total] = await Promise.all([
      prisma.position.findMany({
        where,
        include: { asset: { include: { exchange: true } } },
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
    body('openDate').isISO8601().toDate(),
    body('entryPrice').isFloat({ min: 0.0001 }).toFloat(),
    body('quantity').isInt({ min: 1 }).toInt(),
    body('capitalAllocated').isFloat({ min: 0 }).toFloat(),
    body('openReason').isString().trim().isLength({ min: 1 }),
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
      assetType
    )
    const totalBuyValue = entryPrice * quantity

    const position = await prisma.position.create({
      data: {
        userId: req.user!.userId,
        assetId: asset.id,
        openDate,
        entryPrice,
        quantity,
        positionType: positionType || 'LONG',
        totalBuyValue,
        buyFees,
        capitalAllocated,
        openReason,
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
      include: { asset: { include: { exchange: true } }, transactions: true },
    })

    res.status(201).json({ success: true, data: position })
  })
)

// ─── GET /api/positions/:id ───────────────────────────────────────────────────

router.get(
  '/:id',
  [param('id').isString(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const position = await prisma.position.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        asset: { include: { exchange: true } },
        transactions: { orderBy: { date: 'asc' } },
      },
    })
    if (!position) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Position not found' })
    }
    res.json({ success: true, data: position })
  })
)

// ─── GET /api/positions/:id/transactions ─────────────────────────────────────

router.get(
  '/:id/transactions',
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
    const transactions = await prisma.transaction.findMany({
      where: { positionId: req.params.id },
      orderBy: { date: 'asc' },
    })
    res.json({ success: true, data: transactions })
  })
)

// ─── PATCH /api/positions/:id ─────────────────────────────────────────────────

router.patch(
  '/:id',
  [
    param('id').isString(),
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
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.position.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
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
    } = req.body

    const updated = await prisma.position.update({
      where: { id: req.params.id },
      data: {
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
      },
      include: { asset: { include: { exchange: true } } },
    })
    res.json({ success: true, data: updated })
  })
)

// ─── POST /api/positions/:id/close ───────────────────────────────────────────

router.post(
  '/:id/close',
  [
    param('id').isString(),
    body('closeDate').isISO8601().toDate(),
    body('exitPrice').isFloat({ min: 0.0001 }).toFloat(),
    body('quantity').optional().isInt({ min: 1 }).toInt(),
    body('fees').optional().isFloat({ min: 0 }).toFloat(),
    body('notes').optional().isString().trim(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const position = await prisma.position.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
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
    const closeQty = req.body.quantity || position.quantity
    const totalSellValue = exitPrice * closeQty
    const totalBuyValue = Number(position.totalBuyValue)
    const buyFees = Number(position.buyFees)
    const realizedPnL = totalSellValue - fees - totalBuyValue - buyFees
    const returnPercentage =
      totalBuyValue > 0 ? (realizedPnL / (totalBuyValue + buyFees)) * 100 : 0
    const isFullClose = closeQty >= position.quantity

    const updated = await prisma.position.update({
      where: { id: req.params.id },
      data: {
        status: isFullClose ? 'CLOSED' : 'PARTIAL',
        closeDate: isFullClose ? closeDate : position.closeDate,
        exitPrice,
        totalSellValue,
        sellFees: fees,
        realizedPnL,
        returnPercentage,
        ...(notes && { notes }),
        transactions: {
          create: {
            type: 'SELL',
            date: closeDate,
            quantity: closeQty,
            price: exitPrice,
            totalValue: totalSellValue,
            fees,
            notes: notes ?? null,
          },
        },
      },
      include: {
        asset: { include: { exchange: true } },
        transactions: { orderBy: { date: 'asc' } },
      },
    })

    res.json({ success: true, data: updated })
  })
)

// ─── DELETE /api/positions/:id ────────────────────────────────────────────────

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
