import { Router, Request, Response } from 'express'
import { body, param } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import { findOrCreateAsset } from '../lib/position-service.js'

const router = Router()
router.use(authenticateToken)

async function loadOwnedWatchlist(watchlistId: string, userId: string) {
  return prisma.watchlist.findFirst({
    where: { id: watchlistId, userId },
  })
}

/**
 * @swagger
 * /api/watchlists:
 *   get:
 *     summary: List the authenticated user's watchlists
 *     tags: [Watchlists]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Watchlists
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const watchlists = await prisma.watchlist.findMany({
      where: { userId: req.user!.userId },
      include: { _count: { select: { items: true } } },
      orderBy: { name: 'asc' },
    })
    res.json({ success: true, data: watchlists })
  })
)

/**
 * @swagger
 * /api/watchlists:
 *   post:
 *     summary: Create a new named watchlist
 *     tags: [Watchlists]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       201:
 *         description: Watchlist created
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       409:
 *         description: A watchlist with this name already exists
 */
router.post(
  '/',
  [
    body('name').isString().trim().isLength({ min: 1, max: 80 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const created = await prisma.watchlist.create({
      data: { userId: req.user!.userId, name: String(req.body.name).trim() },
    })
    res.status(201).json({ success: true, data: created })
  })
)

/**
 * @swagger
 * /api/watchlists/{id}:
 *   get:
 *     summary: Get a watchlist and its items
 *     tags: [Watchlists]
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
 *         description: Watchlist detail
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  [param('id').isString().trim().isLength({ min: 1 }), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const watchlist = await prisma.watchlist.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        items: {
          include: { asset: { include: { exchange: true } } },
          orderBy: { addedAt: 'desc' },
        },
      },
    })
    if (!watchlist) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Watchlist not found' })
    }
    res.json({ success: true, data: watchlist })
  })
)

/**
 * @swagger
 * /api/watchlists/{id}:
 *   patch:
 *     summary: Rename a watchlist
 *     tags: [Watchlists]
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
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Watchlist updated
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Not found
 */
router.patch(
  '/:id',
  [
    param('id').isString().trim().isLength({ min: 1 }),
    body('name').isString().trim().isLength({ min: 1, max: 80 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await loadOwnedWatchlist(req.params.id, req.user!.userId)
    if (!existing) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Watchlist not found' })
    }
    const updated = await prisma.watchlist.update({
      where: { id: existing.id },
      data: { name: String(req.body.name).trim() },
    })
    res.json({ success: true, data: updated })
  })
)

/**
 * @swagger
 * /api/watchlists/{id}:
 *   delete:
 *     summary: Delete a watchlist and its items
 *     tags: [Watchlists]
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
 *         description: Deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id',
  [param('id').isString().trim().isLength({ min: 1 }), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await loadOwnedWatchlist(req.params.id, req.user!.userId)
    if (!existing) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Watchlist not found' })
    }
    await prisma.watchlist.delete({ where: { id: existing.id } })
    res.json({ success: true })
  })
)

/**
 * @swagger
 * /api/watchlists/{id}/items:
 *   post:
 *     summary: Add a stock to a watchlist (creates/reuses the underlying Asset record)
 *     tags: [Watchlists]
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
 *               - symbol
 *               - exchangeCode
 *             properties:
 *               symbol:
 *                 type: string
 *               exchangeCode:
 *                 type: string
 *               name:
 *                 type: string
 *               assetType:
 *                 type: string
 *               sector:
 *                 type: string
 *               industry:
 *                 type: string
 *               marketCap:
 *                 type: number
 *     responses:
 *       201:
 *         description: Item added
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Watchlist or exchange not found
 *       409:
 *         description: Symbol already in this watchlist
 */
router.post(
  '/:id/items',
  [
    param('id').isString().trim().isLength({ min: 1 }),
    body('symbol').isString().trim().isLength({ min: 1, max: 20 }),
    body('exchangeCode').isString().trim().isLength({ min: 1, max: 20 }),
    body('name').optional().isString().trim().isLength({ max: 200 }),
    body('assetType').optional().isString().trim(),
    body('sector').optional().isString().trim().isLength({ max: 60 }),
    body('industry').optional().isString().trim().isLength({ max: 60 }),
    body('marketCap').optional().isFloat({ min: 0 }).toFloat(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const watchlist = await loadOwnedWatchlist(req.params.id, req.user!.userId)
    if (!watchlist) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Watchlist not found' })
    }

    const asset = await findOrCreateAsset(
      String(req.body.symbol),
      String(req.body.exchangeCode),
      req.body.name ? String(req.body.name) : undefined,
      req.body.assetType ? String(req.body.assetType) : undefined,
      req.body.industry ? String(req.body.industry) : undefined,
      req.body.sector ? String(req.body.sector) : undefined,
      req.body.marketCap !== undefined ? Number(req.body.marketCap) : undefined
    )

    const existingItem = await prisma.watchlistItem.findUnique({
      where: {
        watchlistId_assetId: { watchlistId: watchlist.id, assetId: asset.id },
      },
    })
    if (existingItem) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'This symbol is already in the watchlist',
      })
    }

    const item = await prisma.watchlistItem.create({
      data: { watchlistId: watchlist.id, assetId: asset.id },
      include: { asset: { include: { exchange: true } } },
    })
    res.status(201).json({ success: true, data: item })
  })
)

/**
 * @swagger
 * /api/watchlists/{id}/items/{itemId}:
 *   delete:
 *     summary: Remove a stock from a watchlist
 *     tags: [Watchlists]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Removed
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Watchlist or item not found
 */
router.delete(
  '/:id/items/:itemId',
  [
    param('id').isString().trim().isLength({ min: 1 }),
    param('itemId').isString().trim().isLength({ min: 1 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const watchlist = await loadOwnedWatchlist(req.params.id, req.user!.userId)
    if (!watchlist) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Watchlist not found' })
    }

    const item = await prisma.watchlistItem.findFirst({
      where: { id: req.params.itemId, watchlistId: watchlist.id },
    })
    if (!item) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Watchlist item not found' })
    }

    await prisma.watchlistItem.delete({ where: { id: item.id } })
    res.json({ success: true })
  })
)

export default router
