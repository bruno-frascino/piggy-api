import { Router, Request, Response } from 'express'
import { body, query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import { savePortfolioSnapshot } from '../lib/portfolio-snapshot.js'

const router = Router()
router.use(authenticateToken)

// ─── GET /api/portfolio/history ───────────────────────────────────────────────

/**
 * @swagger
 * /api/portfolio/history:
 *   get:
 *     summary: Get historical portfolio snapshots (for charting equity curve)
 *     tags: [Portfolio]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of daily portfolio snapshots ordered by date ascending
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/history',
  [
    query('accountId').isString().trim(),
    query('exchangeCode').isString().trim().toUpperCase(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const accountId = String(req.query.accountId)
    const exchangeCode = String(req.query.exchangeCode)

    const exchange = await prisma.exchange.findUnique({
      where: { code: exchangeCode },
      select: { id: true },
    })

    if (!exchange) {
      return res.json({ success: true, data: [] })
    }

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        userId: req.user!.userId,
        accountId,
        exchangeId: exchange.id,
      },
      orderBy: { date: 'asc' },
    })
    res.json({ success: true, data: snapshots })
  })
)

// ─── GET /api/portfolio/realized-pnl ─────────────────────────────────────────

/**
 * @swagger
 * /api/portfolio/realized-pnl:
 *   get:
 *     summary: Sum realized P&L banked from closed and partially closed positions
 *     description: >
 *       Server-side aggregate for a single account + exchange scope. Exists so the
 *       dashboard does not have to download every close event just to total them.
 *     tags: [Portfolio]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: accountId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: exchangeCode
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Realized P&L total for the scope
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     realizedPnL:
 *                       type: number
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/realized-pnl',
  [
    query('accountId').isString().trim().notEmpty(),
    query('exchangeCode').isString().trim().notEmpty(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const aggregate = await prisma.position.aggregate({
      where: {
        userId: req.user!.userId,
        accountId: String(req.query.accountId),
        status: { in: ['CLOSED', 'PARTIAL'] },
        asset: {
          exchange: { code: String(req.query.exchangeCode).toUpperCase() },
        },
      },
      _sum: { realizedPnL: true },
    })

    res.json({
      success: true,
      data: { realizedPnL: Number(aggregate._sum.realizedPnL ?? 0) },
    })
  })
)

// ─── POST /api/portfolio/snapshot ────────────────────────────────────────────

/**
 * @swagger
 * /api/portfolio/snapshot:
 *   post:
 *     summary: Create or update today's portfolio snapshot
 *     description: Upserts a single daily legacy snapshot row under shared-user and owned-account locks. Rereads holdings after locking; a deleted user or account cannot receive a late snapshot. Legacy totals and daily date semantics are unchanged; inactive draft cash is excluded. Call this at end-of-day to record the equity curve.
 *     tags: [Portfolio]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Snapshot created or updated for today
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Owned account or exchange not found, including an account deleted while waiting for its lock
 */ router.post(
  '/snapshot',
  [
    body('accountId').isString().trim(),
    body('exchangeCode').isString().trim().toUpperCase(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const accountId = String(req.body.accountId)
    const exchangeCode = String(req.body.exchangeCode)

    const [account, exchange] = await Promise.all([
      prisma.tradingAccount.findFirst({
        where: { id: accountId, userId },
        select: { id: true },
      }),
      prisma.exchange.findUnique({
        where: { code: exchangeCode },
        select: { id: true },
      }),
    ])

    if (!account) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trading account not found',
      })
    }

    if (!exchange) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Exchange '${exchangeCode}' not found`,
      })
    }

    const snapshot = await savePortfolioSnapshot(
      userId,
      account.id,
      exchange.id
    )

    res.json({ success: true, data: snapshot })
  })
)

export default router
