import { Router, Request, Response } from 'express'
import { body, query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'

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

// ─── POST /api/portfolio/snapshot ────────────────────────────────────────────
/**
 * @swagger
 * /api/portfolio/snapshot:
 *   post:
 *     summary: Create or update today's portfolio snapshot
 *     description: Upserts a single daily snapshot row. Call this at end-of-day to record the equity curve.
 *     tags: [Portfolio]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Snapshot created or updated for today
 *       401:
 *         description: Unauthorized
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

    const [openPositions, closedPositions] = await Promise.all([
      prisma.position.findMany({
        where: {
          userId,
          accountId: account.id,
          status: { in: ['OPEN', 'PARTIAL'] },
          asset: { exchangeId: exchange.id },
        },
        select: { capitalAllocated: true, unrealizedPnL: true },
      }),
      prisma.position.findMany({
        where: {
          userId,
          accountId: account.id,
          status: 'CLOSED',
          asset: { exchangeId: exchange.id },
        },
        select: { realizedPnL: true },
      }),
    ])

    const totalInvested = openPositions.reduce(
      (sum, p) => sum + Number(p.capitalAllocated),
      0
    )
    const totalUnrealizedPnL = openPositions.reduce(
      (sum, p) => sum + Number(p.unrealizedPnL ?? 0),
      0
    )
    const totalRealizedPnL = closedPositions.reduce(
      (sum, p) => sum + Number(p.realizedPnL ?? 0),
      0
    )
    const totalPnL = totalUnrealizedPnL + totalRealizedPnL
    const totalValue = totalInvested + totalUnrealizedPnL
    const totalReturnPct =
      totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const snapshot = await prisma.portfolioSnapshot.upsert({
      where: {
        userId_accountId_exchangeId_date: {
          userId,
          accountId: account.id,
          exchangeId: exchange.id,
          date: today,
        },
      },
      create: {
        userId,
        accountId: account.id,
        exchangeId: exchange.id,
        date: today,
        totalValue,
        totalInvested,
        totalPnL,
        totalReturnPct,
      },
      update: { totalValue, totalInvested, totalPnL, totalReturnPct },
    })

    res.json({ success: true, data: snapshot })
  })
)

export default router
