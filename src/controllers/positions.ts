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
    query('status').optional().isIn(['OPEN', 'CLOSED', 'PARTIAL']),
    query('assetType').optional().isIn(['EQUITY', 'ETF', 'CRYPTO']),
    query('exchangeCode').optional().isString().trim().toUpperCase(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const { status, assetType, exchangeCode } = req.query
    const limit = Number(req.query.limit) || 50
    const offset = Number(req.query.offset) || 0

    const where: Record<string, unknown> = { userId: req.user!.userId }
    if (status) where.status = status
    if (assetType || exchangeCode) {
      where.asset = {
        ...(assetType ? { assetType } : {}),
        ...(exchangeCode ? { exchange: { code: exchangeCode } } : {}),
      }
    }

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
 *               - openReason
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
 *               openDate:
 *                 type: string
 *                 format: date-time
 *               entryPrice:
 *                 type: number
 *               quantity:
 *                 type: integer
 *                 minimum: 1
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

/**
 * @swagger
 * /api/positions/{id}:
 *   get:
 *     summary: Get a single position by ID
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
 *         description: Position with asset and transactions
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Position not found
 */
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

/**
 * @swagger
 * /api/positions/{id}/transactions:
 *   get:
 *     summary: List all buy/sell transactions for a position
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
 *         description: List of transactions ordered by date
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Position not found
 */
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
 *                 type: integer
 *                 minimum: 1
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
