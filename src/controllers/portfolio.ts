import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'

const router = Router()
router.use(authenticateToken)

// ─── GET /api/portfolio/summary ───────────────────────────────────────────────

router.get(
  '/summary',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId

    const [openPositions, closedPositions] = await Promise.all([
      prisma.position.findMany({
        where: { userId, status: { in: ['OPEN', 'PARTIAL'] } },
        include: { asset: { include: { exchange: true } } },
      }),
      prisma.position.findMany({
        where: { userId, status: 'CLOSED' },
        select: {
          realizedPnL: true,
          capitalAllocated: true,
          returnPercentage: true,
        },
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

    const byAssetType = openPositions.reduce(
      (acc, p) => {
        const type = p.asset.assetType
        if (!acc[type]) acc[type] = { count: 0, invested: 0 }
        acc[type].count += 1
        acc[type].invested += Number(p.capitalAllocated)
        return acc
      },
      {} as Record<string, { count: number; invested: number }>
    )

    res.json({
      success: true,
      data: {
        openPositions: openPositions.length,
        closedPositions: closedPositions.length,
        totalInvested,
        totalUnrealizedPnL,
        totalRealizedPnL,
        totalPnL: totalUnrealizedPnL + totalRealizedPnL,
        byAssetType,
      },
    })
  })
)

// ─── GET /api/portfolio/history ───────────────────────────────────────────────

router.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: { userId: req.user!.userId },
      orderBy: { date: 'asc' },
    })
    res.json({ success: true, data: snapshots })
  })
)

// ─── POST /api/portfolio/snapshot ────────────────────────────────────────────

router.post(
  '/snapshot',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId

    const [openPositions, closedPositions] = await Promise.all([
      prisma.position.findMany({
        where: { userId, status: { in: ['OPEN', 'PARTIAL'] } },
        select: { capitalAllocated: true, unrealizedPnL: true },
      }),
      prisma.position.findMany({
        where: { userId, status: 'CLOSED' },
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
      where: { userId_date: { userId, date: today } },
      create: {
        userId,
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
