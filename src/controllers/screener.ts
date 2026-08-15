import { Router, Request, Response } from 'express'
import { body, param, query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import {
  FmpUnavailableError,
  screenStocks,
  searchSymbol,
  getDividendsCalendar,
  type ScreenerResult,
} from '../lib/fmp-client.js'

const router = Router()
router.use(authenticateToken)

const MAX_DIVIDEND_CALENDAR_RANGE_DAYS = 90

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Flags each screener result with whether the symbol is already tracked as an Asset and/or already in one of the user's watchlists. */
async function annotateTracking(
  results: ScreenerResult[],
  userId: string
): Promise<
  Array<ScreenerResult & { alreadyTracked: boolean; inWatchlist: boolean }>
> {
  if (results.length === 0) return []

  const symbols = results.map((r) => r.symbol)

  const [assets, watchlistItems] = await Promise.all([
    prisma.asset.findMany({
      where: { symbol: { in: symbols } },
      select: { symbol: true },
    }),
    prisma.watchlistItem.findMany({
      where: {
        watchlist: { userId },
        asset: { symbol: { in: symbols } },
      },
      select: { asset: { select: { symbol: true } } },
    }),
  ])

  const trackedSymbols = new Set(assets.map((a) => a.symbol))
  const watchedSymbols = new Set(watchlistItems.map((w) => w.asset.symbol))

  return results.map((r) => ({
    ...r,
    alreadyTracked: trackedSymbols.has(r.symbol),
    inWatchlist: watchedSymbols.has(r.symbol),
  }))
}

/**
 * @swagger
 * /api/screener:
 *   get:
 *     summary: Search or filter stocks market-wide (via Financial Modeling Prep)
 *     tags: [Screener]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: symbol
 *         schema:
 *           type: string
 *         description: Free-text symbol/name search (mutually exclusive with the filter params below)
 *       - in: query
 *         name: marketCapMin
 *         schema:
 *           type: number
 *       - in: query
 *         name: marketCapMax
 *         schema:
 *           type: number
 *       - in: query
 *         name: dividendMin
 *         schema:
 *           type: number
 *       - in: query
 *         name: dividendMax
 *         schema:
 *           type: number
 *       - in: query
 *         name: sector
 *         schema:
 *           type: string
 *       - in: query
 *         name: industry
 *         schema:
 *           type: string
 *       - in: query
 *         name: exchange
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 0
 *     responses:
 *       200:
 *         description: Screener results
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       503:
 *         description: Screener provider unavailable
 */
router.get(
  '/',
  [
    query('symbol').optional().isString().trim().isLength({ min: 1, max: 40 }),
    query('marketCapMin').optional().isFloat({ min: 0 }).toFloat(),
    query('marketCapMax').optional().isFloat({ min: 0 }).toFloat(),
    query('dividendMin').optional().isFloat({ min: 0 }).toFloat(),
    query('dividendMax').optional().isFloat({ min: 0 }).toFloat(),
    query('sector').optional().isString().trim().isLength({ max: 60 }),
    query('industry').optional().isString().trim().isLength({ max: 60 }),
    query('exchange').optional().isString().trim().isLength({ max: 20 }),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('page').optional().isInt({ min: 0 }).toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const symbol = req.query.symbol ? String(req.query.symbol) : null
    const limit = Number(req.query.limit || 50)

    try {
      let results: ScreenerResult[]
      let mode: 'symbol' | 'filter'

      if (symbol) {
        mode = 'symbol'
        const matches = await searchSymbol(symbol, limit)
        results = matches.map((m) => ({
          symbol: m.symbol,
          name: m.name,
          exchange: m.exchange,
          sector: null,
          industry: null,
          marketCap: null,
          price: null,
          lastAnnualDividend: null,
          isEtf: false,
          country: null,
        }))
      } else {
        mode = 'filter'
        results = await screenStocks({
          marketCapMoreThan: req.query.marketCapMin
            ? Number(req.query.marketCapMin)
            : undefined,
          marketCapLowerThan: req.query.marketCapMax
            ? Number(req.query.marketCapMax)
            : undefined,
          dividendMoreThan: req.query.dividendMin
            ? Number(req.query.dividendMin)
            : undefined,
          dividendLowerThan: req.query.dividendMax
            ? Number(req.query.dividendMax)
            : undefined,
          sector: req.query.sector ? String(req.query.sector) : undefined,
          industry: req.query.industry ? String(req.query.industry) : undefined,
          exchange: req.query.exchange ? String(req.query.exchange) : undefined,
          limit,
          page: req.query.page ? Number(req.query.page) : undefined,
        })
      }

      const annotated = await annotateTracking(results, req.user!.userId)
      res.json({ success: true, mode, data: annotated })
    } catch (error) {
      if (error instanceof FmpUnavailableError) {
        return res.status(503).json({
          error: 'Upstream Unavailable',
          message: 'Screener temporarily unavailable',
        })
      }
      throw error
    }
  })
)

/**
 * @swagger
 * /api/screener/upcoming-dividends:
 *   get:
 *     summary: Upcoming ex-dividend dates in a date range, optionally filtered by symbol
 *     tags: [Screener]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: symbols
 *         schema:
 *           type: string
 *         description: Comma-separated symbol list to filter the calendar to
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Upcoming dividends
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       503:
 *         description: Screener provider unavailable
 */
router.get(
  '/upcoming-dividends',
  [
    query('symbols').optional().isString().trim(),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const today = new Date()
    const defaultTo = new Date(today)
    defaultTo.setDate(defaultTo.getDate() + 30)

    const from = req.query.from ? String(req.query.from) : toIsoDate(today)
    const to = req.query.to ? String(req.query.to) : toIsoDate(defaultTo)

    const rangeDays =
      (new Date(to).getTime() - new Date(from).getTime()) /
      (1000 * 60 * 60 * 24)
    if (rangeDays < 0 || rangeDays > MAX_DIVIDEND_CALENDAR_RANGE_DAYS) {
      return res.status(400).json({
        error: 'Validation Error',
        message: `Date range must be between 0 and ${MAX_DIVIDEND_CALENDAR_RANGE_DAYS} days`,
      })
    }

    const symbolFilter = req.query.symbols
      ? new Set(
          String(req.query.symbols)
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
        )
      : null

    try {
      const calendar = await getDividendsCalendar(from, to)
      const data = symbolFilter
        ? calendar.filter((d) => symbolFilter.has(d.symbol.toUpperCase()))
        : calendar

      res.json({ success: true, data })
    } catch (error) {
      if (error instanceof FmpUnavailableError) {
        return res.status(503).json({
          error: 'Upstream Unavailable',
          message: 'Dividend calendar temporarily unavailable',
        })
      }
      throw error
    }
  })
)

/**
 * @swagger
 * /api/screener/saved-screens:
 *   get:
 *     summary: List the authenticated user's saved screener filter presets
 *     tags: [Screener]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Saved screens
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/saved-screens',
  asyncHandler(async (req: Request, res: Response) => {
    const savedScreens = await prisma.savedScreen.findMany({
      where: { userId: req.user!.userId },
      orderBy: { name: 'asc' },
    })
    res.json({ success: true, data: savedScreens })
  })
)

/**
 * @swagger
 * /api/screener/saved-screens:
 *   post:
 *     summary: Save a named screener filter preset
 *     tags: [Screener]
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
 *               - filters
 *             properties:
 *               name:
 *                 type: string
 *               filters:
 *                 type: object
 *     responses:
 *       201:
 *         description: Saved screen created
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       409:
 *         description: A saved screen with this name already exists
 */
router.post(
  '/saved-screens',
  [
    body('name').isString().trim().isLength({ min: 1, max: 80 }),
    body('filters').isObject(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const created = await prisma.savedScreen.create({
      data: {
        userId: req.user!.userId,
        name: String(req.body.name).trim(),
        filters: req.body.filters,
      },
    })
    res.status(201).json({ success: true, data: created })
  })
)

/**
 * @swagger
 * /api/screener/saved-screens/{id}:
 *   delete:
 *     summary: Delete a saved screener filter preset
 *     tags: [Screener]
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
  '/saved-screens/:id',
  [param('id').isString().trim().isLength({ min: 1 }), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.savedScreen.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    })
    if (!existing) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Saved screen not found' })
    }
    await prisma.savedScreen.delete({ where: { id: existing.id } })
    res.json({ success: true })
  })
)

export default router
