import { Router, Request, Response } from 'express'
import { body, param } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import type { AssetType } from '@prisma/client'

const router = Router()
router.use(authenticateToken)

// ─── GET /api/watchlist ───────────────────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const items = await prisma.watchlist.findMany({
      where: { userId: req.user!.userId },
      include: { asset: { include: { exchange: true } } },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, data: items })
  })
)

// ─── POST /api/watchlist ──────────────────────────────────────────────────────

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
    body('name').optional().isString().trim(),
    body('notes').optional().isString().trim(),
    body('targetPrice')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .toFloat(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const {
      symbol,
      exchangeCode,
      assetName,
      assetType,
      name,
      notes,
      targetPrice,
    } = req.body

    const normalizedSymbol = symbol.trim().toUpperCase()
    const normalizedExchange = exchangeCode.trim().toUpperCase()

    const exchange = await prisma.exchange.findUnique({
      where: { code: normalizedExchange },
    })
    if (!exchange) {
      return res
        .status(404)
        .json({
          error: 'Not Found',
          message: `Exchange '${normalizedExchange}' not found`,
        })
    }

    let asset = await prisma.asset.findUnique({
      where: {
        symbol_exchangeId: {
          symbol: normalizedSymbol,
          exchangeId: exchange.id,
        },
      },
    })
    if (!asset) {
      asset = await prisma.asset.create({
        data: {
          symbol: normalizedSymbol,
          name: assetName?.trim() || normalizedSymbol,
          assetType: (assetType as AssetType) || 'EQUITY',
          exchangeId: exchange.id,
        },
      })
    }

    const item = await prisma.watchlist.create({
      data: {
        userId: req.user!.userId,
        assetId: asset.id,
        name: name ?? null,
        notes: notes ?? null,
        targetPrice: targetPrice ?? null,
      },
      include: { asset: { include: { exchange: true } } },
    })

    res.status(201).json({ success: true, data: item })
  })
)

// ─── PATCH /api/watchlist/:id ─────────────────────────────────────────────────

router.patch(
  '/:id',
  [
    param('id').isString(),
    body('name').optional({ nullable: true }).isString().trim(),
    body('notes').optional({ nullable: true }).isString().trim(),
    body('targetPrice')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .toFloat(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const item = await prisma.watchlist.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    })
    if (!item) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Watchlist item not found' })
    }

    const { name, notes, targetPrice } = req.body
    const updated = await prisma.watchlist.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(notes !== undefined && { notes }),
        ...(targetPrice !== undefined && { targetPrice }),
      },
      include: { asset: { include: { exchange: true } } },
    })
    res.json({ success: true, data: updated })
  })
)

// ─── DELETE /api/watchlist/:id ────────────────────────────────────────────────

router.delete(
  '/:id',
  [param('id').isString(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const item = await prisma.watchlist.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    })
    if (!item) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Watchlist item not found' })
    }
    await prisma.watchlist.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Removed from watchlist' })
  })
)

export default router
