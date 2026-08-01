import { Router, Request, Response } from 'express'
import { query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import {
  buildHistogram,
  bucketRealizedSeries,
  bucketSnapshotSeries,
  computeBreakdowns,
  computeRiskFromEquitySeries,
  computeSummary,
  mapTradeRows,
} from '../lib/statistics-engine.js'

const router = Router()
router.use(authenticateToken)

const MAX_RANGE_DAYS = 366 * 5

const parseCsv = (value: unknown, upper = false): string[] => {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (upper ? item.toUpperCase() : item))
}

const toDateBounds = (dateFrom?: string, dateTo?: string) => {
  const bounds: Record<string, Date> = {}
  if (dateFrom) bounds.gte = new Date(`${dateFrom}T00:00:00.000Z`)
  if (dateTo) bounds.lte = new Date(`${dateTo}T23:59:59.999Z`)
  return Object.keys(bounds).length > 0 ? bounds : undefined
}

const dateSpanWithinLimit = (
  dateFromRaw: unknown,
  dateToRaw: unknown
): boolean => {
  if (typeof dateFromRaw !== 'string' || typeof dateToRaw !== 'string')
    return true
  const start = Date.parse(`${dateFromRaw}T00:00:00.000Z`)
  const end = Date.parse(`${dateToRaw}T23:59:59.999Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true
  const diffDays = (end - start) / 86_400_000
  return diffDays <= MAX_RANGE_DAYS
}

const buildPositionScope = (req: Request) => {
  const status = parseCsv(req.query.status, true)
  const accountIds = parseCsv(req.query.accountIds)
  const exchangeCodes = parseCsv(req.query.exchangeCodes, true)
  const assetTypes = parseCsv(req.query.assetTypes, true)

  const where: Record<string, unknown> = { userId: req.user!.userId }

  if (status.length === 1) where.status = status[0]
  else if (status.length > 1) where.status = { in: status }

  if (accountIds.length === 1) where.accountId = accountIds[0]
  else if (accountIds.length > 1) where.accountId = { in: accountIds }

  if (exchangeCodes.length > 0 || assetTypes.length > 0) {
    where.asset = {
      ...(assetTypes.length === 1
        ? { assetType: assetTypes[0] }
        : assetTypes.length > 1
          ? { assetType: { in: assetTypes } }
          : {}),
      ...(exchangeCodes.length === 1
        ? { exchange: { code: exchangeCodes[0] } }
        : exchangeCodes.length > 1
          ? { exchange: { code: { in: exchangeCodes } } }
          : {}),
    }
  }

  return where
}

const commonValidation = [
  query('status')
    .optional()
    .isString()
    .custom((value) => {
      const allowed = new Set(['OPEN', 'PARTIAL', 'CLOSED'])
      const values = parseCsv(value, true)
      return values.length > 0 && values.every((item) => allowed.has(item))
    }),
  query('accountIds').optional().isString(),
  query('exchangeCodes').optional().isString(),
  query('assetTypes')
    .optional()
    .isString()
    .custom((value) => {
      const allowed = new Set(['EQUITY', 'ETF', 'CRYPTO'])
      const values = parseCsv(value, true)
      return values.length > 0 && values.every((item) => allowed.has(item))
    }),
  query('dateFrom').optional().isISO8601({ strict: true }),
  query('dateTo')
    .optional()
    .isISO8601({ strict: true })
    .custom((value, { req }) => {
      const from = req.query?.dateFrom
      if (!from) return true
      return Date.parse(String(from)) <= Date.parse(String(value))
    })
    .custom((value, { req }) =>
      dateSpanWithinLimit(req.query?.dateFrom, value)
    ),
]

// ─── GET /api/statistics/summary ─────────────────────────────────────────────

/**
 * @swagger
 * /api/statistics/summary:
 *   get:
 *     summary: Get statistics summary KPIs for the selected scope
 *     tags: [Statistics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: accountIds
 *         schema:
 *           type: string
 *         description: CSV trading account IDs
 *       - in: query
 *         name: exchangeCodes
 *         schema:
 *           type: string
 *         description: CSV exchange codes (e.g. NASDAQ, ASX)
 *       - in: query
 *         name: assetTypes
 *         schema:
 *           type: string
 *           enum: [EQUITY, ETF, CRYPTO]
 *         description: CSV asset types
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [OPEN, PARTIAL, CLOSED]
 *         description: CSV position statuses
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Aggregated summary metrics
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/summary',
  [...commonValidation, handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const positionScope = buildPositionScope(req)
    const dateBounds = toDateBounds(
      typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined
    )

    const [events, openPositions] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          type: 'SELL',
          ...(dateBounds ? { date: dateBounds } : {}),
          position: positionScope,
        },
        include: {
          position: {
            select: {
              id: true,
              accountId: true,
              quantity: true,
              entryPrice: true,
              buyFees: true,
              openDate: true,
              asset: {
                select: { symbol: true, exchange: { select: { code: true } } },
              },
            },
          },
        },
      }),
      prisma.position.findMany({
        where: {
          ...positionScope,
          status: { in: ['OPEN', 'PARTIAL'] },
        },
        select: { unrealizedPnL: true },
      }),
    ])

    const trades = mapTradeRows(events as never[])
    const unrealizedPnL = openPositions.reduce(
      (acc, pos) => acc + Number(pos.unrealizedPnL ?? 0),
      0
    )
    const summary = computeSummary({ trades, unrealizedPnL })

    res.json({
      success: true,
      data: {
        ...summary,
        metricDefinitionVersion: 'stats-v1',
        asOf: new Date().toISOString(),
      },
    })
  })
)

// ─── GET /api/statistics/timeseries ──────────────────────────────────────────

/**
 * @swagger
 * /api/statistics/timeseries:
 *   get:
 *     summary: Get time-series points for statistics charts
 *     tags: [Statistics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: metric
 *         schema:
 *           type: string
 *           enum: [equity, totalPnL, realizedPnL]
 *         required: true
 *       - in: query
 *         name: granularity
 *         schema:
 *           type: string
 *           enum: [day, week, month]
 *           default: month
 *       - in: query
 *         name: accountIds
 *         schema:
 *           type: string
 *         description: CSV trading account IDs
 *       - in: query
 *         name: exchangeCodes
 *         schema:
 *           type: string
 *         description: CSV exchange codes (e.g. NASDAQ, ASX)
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Aggregated time-series points
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/timeseries',
  [
    ...commonValidation,
    query('metric').isIn(['equity', 'totalPnL', 'realizedPnL']),
    query('granularity').optional().isIn(['day', 'week', 'month']),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const metric = String(req.query.metric) as
      | 'equity'
      | 'totalPnL'
      | 'realizedPnL'
    const granularity =
      (req.query.granularity as 'day' | 'week' | 'month' | undefined) ?? 'month'
    const positionScope = buildPositionScope(req)
    const accountIds = parseCsv(req.query.accountIds)
    const exchangeCodes = parseCsv(req.query.exchangeCodes, true)
    const dateBounds = toDateBounds(
      typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined
    )

    if (metric === 'realizedPnL') {
      const events = await prisma.transaction.findMany({
        where: {
          type: 'SELL',
          ...(dateBounds ? { date: dateBounds } : {}),
          position: positionScope,
        },
        include: {
          position: {
            select: {
              id: true,
              accountId: true,
              quantity: true,
              entryPrice: true,
              buyFees: true,
              openDate: true,
              asset: {
                select: { symbol: true, exchange: { select: { code: true } } },
              },
            },
          },
        },
      })
      const trades = mapTradeRows(events as never[])
      return res.json({
        success: true,
        data: {
          points: bucketRealizedSeries(trades, granularity),
          currency: 'USD',
          asOf: new Date().toISOString(),
        },
      })
    }

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        userId: req.user!.userId,
        ...(accountIds.length === 1
          ? { accountId: accountIds[0] }
          : accountIds.length > 1
            ? { accountId: { in: accountIds } }
            : {}),
        ...(exchangeCodes.length === 1
          ? { exchange: { code: exchangeCodes[0] } }
          : exchangeCodes.length > 1
            ? { exchange: { code: { in: exchangeCodes } } }
            : {}),
        ...(dateBounds ? { date: dateBounds } : {}),
      },
      select: {
        date: true,
        totalValue: true,
        totalPnL: true,
      },
      orderBy: { date: 'asc' },
    })

    const points = bucketSnapshotSeries(
      snapshots.map((snapshot) => ({
        date: snapshot.date,
        totalValue: Number(snapshot.totalValue),
        totalPnL: Number(snapshot.totalPnL),
      })),
      metric === 'equity' ? 'equity' : 'totalPnL',
      granularity
    )

    res.json({
      success: true,
      data: {
        points,
        currency: 'USD',
        asOf: new Date().toISOString(),
      },
    })
  })
)

// ─── GET /api/statistics/distributions ───────────────────────────────────────

/**
 * @swagger
 * /api/statistics/distributions:
 *   get:
 *     summary: Get histogram distributions for returns, PnL and holding days
 *     tags: [Statistics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: accountIds
 *         schema:
 *           type: string
 *         description: CSV trading account IDs
 *       - in: query
 *         name: exchangeCodes
 *         schema:
 *           type: string
 *         description: CSV exchange codes (e.g. NASDAQ, ASX)
 *       - in: query
 *         name: assetTypes
 *         schema:
 *           type: string
 *           enum: [EQUITY, ETF, CRYPTO]
 *         description: CSV asset types
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Histogram buckets for charting
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/distributions',
  [...commonValidation, handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const positionScope = buildPositionScope(req)
    const dateBounds = toDateBounds(
      typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined
    )

    const events = await prisma.transaction.findMany({
      where: {
        type: 'SELL',
        ...(dateBounds ? { date: dateBounds } : {}),
        position: positionScope,
      },
      include: {
        position: {
          select: {
            id: true,
            accountId: true,
            quantity: true,
            entryPrice: true,
            buyFees: true,
            openDate: true,
            asset: {
              select: { symbol: true, exchange: { select: { code: true } } },
            },
          },
        },
      },
    })

    const trades = mapTradeRows(events as never[])
    res.json({
      success: true,
      data: {
        returnPctHistogram: buildHistogram(
          trades.map((trade) => trade.returnPct),
          10
        ),
        pnlHistogram: buildHistogram(
          trades.map((trade) => trade.pnl),
          10
        ),
        holdingDaysHistogram: buildHistogram(
          trades.map((trade) => trade.holdingDays),
          10
        ),
        sampleSize: trades.length,
      },
    })
  })
)

// ─── GET /api/statistics/risk ────────────────────────────────────────────────

/**
 * @swagger
 * /api/statistics/risk:
 *   get:
 *     summary: Get risk metrics from portfolio snapshot return series
 *     tags: [Statistics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: accountIds
 *         schema:
 *           type: string
 *         description: CSV trading account IDs
 *       - in: query
 *         name: exchangeCodes
 *         schema:
 *           type: string
 *         description: CSV exchange codes (e.g. NASDAQ, ASX)
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Volatility, Sharpe and drawdown metrics
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/risk',
  [...commonValidation, handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const accountIds = parseCsv(req.query.accountIds)
    const exchangeCodes = parseCsv(req.query.exchangeCodes, true)
    const dateBounds = toDateBounds(
      typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined
    )

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        userId: req.user!.userId,
        ...(accountIds.length === 1
          ? { accountId: accountIds[0] }
          : accountIds.length > 1
            ? { accountId: { in: accountIds } }
            : {}),
        ...(exchangeCodes.length === 1
          ? { exchange: { code: exchangeCodes[0] } }
          : exchangeCodes.length > 1
            ? { exchange: { code: { in: exchangeCodes } } }
            : {}),
        ...(dateBounds ? { date: dateBounds } : {}),
      },
      select: { date: true, totalValue: true },
      orderBy: { date: 'asc' },
    })

    const risk = computeRiskFromEquitySeries(
      snapshots.map((snapshot) => ({
        date: snapshot.date,
        equity: Number(snapshot.totalValue),
      }))
    )

    res.json({ success: true, data: risk })
  })
)

// ─── GET /api/statistics/breakdowns ──────────────────────────────────────────

/**
 * @swagger
 * /api/statistics/breakdowns:
 *   get:
 *     summary: Get grouped portfolio breakdown rows for charts/tables
 *     tags: [Statistics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: by
 *         schema:
 *           type: string
 *           enum: [account, exchange, assetType, industry]
 *         required: true
 *       - in: query
 *         name: metric
 *         schema:
 *           type: string
 *           enum: [marketValue, realizedPnL, totalPnL]
 *         required: true
 *       - in: query
 *         name: accountIds
 *         schema:
 *           type: string
 *         description: CSV trading account IDs
 *       - in: query
 *         name: exchangeCodes
 *         schema:
 *           type: string
 *         description: CSV exchange codes (e.g. NASDAQ, ASX)
 *       - in: query
 *         name: assetTypes
 *         schema:
 *           type: string
 *           enum: [EQUITY, ETF, CRYPTO]
 *         description: CSV asset types
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [OPEN, PARTIAL, CLOSED]
 *         description: CSV position statuses
 *     responses:
 *       200:
 *         description: Grouped rows with weights
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/breakdowns',
  [
    ...commonValidation,
    query('by').isIn(['account', 'exchange', 'assetType', 'industry']),
    query('metric').isIn(['marketValue', 'realizedPnL', 'totalPnL']),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const by = String(req.query.by) as
      | 'account'
      | 'exchange'
      | 'assetType'
      | 'industry'
    const metric = String(req.query.metric) as
      | 'marketValue'
      | 'realizedPnL'
      | 'totalPnL'
    const positionScope = buildPositionScope(req)

    const positions = await prisma.position.findMany({
      where: positionScope,
      select: {
        accountId: true,
        realizedPnL: true,
        unrealizedPnL: true,
        capitalAllocated: true,
        asset: {
          select: {
            industry: true,
            assetType: true,
            exchange: { select: { code: true } },
          },
        },
      },
    })

    const result = computeBreakdowns(
      positions.map((position) => {
        const realizedPnL = Number(position.realizedPnL ?? 0)
        const unrealizedPnL = Number(position.unrealizedPnL ?? 0)
        const marketValue =
          Number(position.capitalAllocated ?? 0) + unrealizedPnL
        return {
          accountId: position.accountId,
          exchangeCode: position.asset.exchange.code,
          assetType: position.asset.assetType,
          industry: position.asset.industry,
          marketValue,
          realizedPnL,
          totalPnL: realizedPnL + unrealizedPnL,
        }
      }),
      by,
      metric
    )

    res.json({ success: true, data: result })
  })
)

// ─── GET /api/statistics/closed-trades ───────────────────────────────────────

/**
 * @swagger
 * /api/statistics/closed-trades:
 *   get:
 *     summary: Get paginated closed trade rows for the selected scope
 *     tags: [Statistics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: accountIds
 *         schema:
 *           type: string
 *         description: CSV trading account IDs
 *       - in: query
 *         name: exchangeCodes
 *         schema:
 *           type: string
 *         description: CSV exchange codes (e.g. NASDAQ, ASX)
 *       - in: query
 *         name: assetTypes
 *         schema:
 *           type: string
 *           enum: [EQUITY, ETF, CRYPTO]
 *         description: CSV asset types
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 200
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [closeDate, pnl, returnPct, holdingDays]
 *           default: closeDate
 *       - in: query
 *         name: sortDir
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *     responses:
 *       200:
 *         description: Paginated closed trades
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/closed-trades',
  [
    ...commonValidation,
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('sortBy')
      .optional()
      .isIn(['closeDate', 'pnl', 'returnPct', 'holdingDays']),
    query('sortDir').optional().isIn(['asc', 'desc']),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const positionScope = buildPositionScope(req)
    const dateBounds = toDateBounds(
      typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined
    )

    const limit = Number(req.query.limit) || 50
    const offset = Number(req.query.offset) || 0
    const sortBy =
      (req.query.sortBy as
        | 'closeDate'
        | 'pnl'
        | 'returnPct'
        | 'holdingDays'
        | undefined) ?? 'closeDate'
    const sortDir = (req.query.sortDir as 'asc' | 'desc' | undefined) ?? 'desc'

    if (sortBy === 'closeDate') {
      const [events, total] = await Promise.all([
        prisma.transaction.findMany({
          where: {
            type: 'SELL',
            ...(dateBounds ? { date: dateBounds } : {}),
            position: positionScope,
          },
          include: {
            position: {
              select: {
                id: true,
                accountId: true,
                quantity: true,
                entryPrice: true,
                buyFees: true,
                openDate: true,
                asset: {
                  select: {
                    symbol: true,
                    exchange: { select: { code: true } },
                  },
                },
              },
            },
          },
          orderBy: { date: sortDir },
          take: limit,
          skip: offset,
        }),
        prisma.transaction.count({
          where: {
            type: 'SELL',
            ...(dateBounds ? { date: dateBounds } : {}),
            position: positionScope,
          },
        }),
      ])

      const rows = mapTradeRows(events as never[])
      return res.json({
        success: true,
        data: rows,
        meta: { total, limit, offset },
      })
    }

    const events = await prisma.transaction.findMany({
      where: {
        type: 'SELL',
        ...(dateBounds ? { date: dateBounds } : {}),
        position: positionScope,
      },
      include: {
        position: {
          select: {
            id: true,
            accountId: true,
            quantity: true,
            entryPrice: true,
            buyFees: true,
            openDate: true,
            asset: {
              select: { symbol: true, exchange: { select: { code: true } } },
            },
          },
        },
      },
    })

    const rows = mapTradeRows(events as never[])
    rows.sort((a, b) => {
      const aValue = a[sortBy]
      const bValue = b[sortBy]
      if (typeof aValue === 'number' && typeof bValue === 'number') {
        return sortDir === 'asc' ? aValue - bValue : bValue - aValue
      }
      return 0
    })

    const paged = rows.slice(offset, offset + limit)
    res.json({
      success: true,
      data: paged,
      meta: { total: rows.length, limit, offset },
    })
  })
)

export default router
