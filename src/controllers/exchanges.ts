import { Router, Request, Response } from 'express'
import { query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import { venueOfExchangeCode } from '../lib/crypto/venues.js'
import {
  KrakenMarketsUnavailable,
  searchKrakenMarkets,
} from '../lib/crypto/kraken-markets.js'

const router = Router()

/**
 * @swagger
 * /api/exchanges/kraken/assets:
 *   get:
 *     summary: Search Kraken spot assets by symbol, alias or common coin name
 *     description: >
 *       Uses Kraken's public pair catalogue (cached for ten minutes). Only AUD and USD
 *       quote currencies are supported. Names are provided for common coins; other coins
 *       are searchable by ticker. Results describe recorded spot markets, not regional
 *       trading eligibility. An empty result means no matching pair, not a provider failure.
 *     tags: [Exchanges]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *           maxLength: 80
 *       - in: query
 *         name: quote
 *         required: true
 *         schema:
 *           type: string
 *           enum: [AUD, USD]
 *     responses:
 *       200:
 *         description: Up to 30 matching Kraken markets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [base, name, quote, symbol, exchangeCode]
 *                     properties:
 *                       base:
 *                         type: string
 *                       name:
 *                         type: string
 *                       quote:
 *                         type: string
 *                         enum: [AUD, USD]
 *                       symbol:
 *                         type: string
 *                       exchangeCode:
 *                         type: string
 *       400:
 *         description: Unsupported quote currency or invalid query
 *       401:
 *         description: Unauthorized
 *       503:
 *         description: Kraken market catalogue temporarily unavailable
 */
router.get(
  '/kraken/assets',
  authenticateToken,
  [
    query('q').optional().isString().trim().isLength({ max: 80 }),
    query('quote').isIn(['AUD', 'USD']),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const data = await searchKrakenMarkets(
        req.query.quote as 'AUD' | 'USD',
        String(req.query.q ?? '')
      )
      res.json({ success: true, data })
    } catch (error) {
      if (!(error instanceof KrakenMarketsUnavailable)) throw error
      console.error('Kraken market search failed:', error.message)
      res.status(503).json({
        error: 'Upstream Unavailable',
        message:
          'Kraken coin search is temporarily unavailable. Please try again.',
      })
    }
  })
)

/**
 * @swagger
 * /api/exchanges:
 *   get:
 *     summary: List exchanges, optionally filtered by asset class
 *     tags: [Exchanges]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: assetClass
 *         schema:
 *           type: string
 *           enum: [crypto, equity]
 *         description: Only crypto venues (one row per quote currency) or only equity exchanges
 *     responses:
 *       200:
 *         description: Exchanges ordered by code
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       code:
 *                         type: string
 *                       name:
 *                         type: string
 *                       currency:
 *                         type: string
 *                       isCrypto:
 *                         type: boolean
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  authenticateToken,
  [
    query('assetClass').optional().isIn(['crypto', 'equity']),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const assetClass = req.query.assetClass as 'crypto' | 'equity' | undefined

    const exchanges = await prisma.exchange.findMany({
      select: { code: true, name: true, currency: true },
      orderBy: { code: 'asc' },
    })

    const data = exchanges
      .map((exchange) => ({
        ...exchange,
        isCrypto: venueOfExchangeCode(exchange.code) !== null,
      }))
      .filter((exchange) => {
        if (assetClass === 'crypto') return exchange.isCrypto
        if (assetClass === 'equity') return !exchange.isCrypto
        return true
      })

    res.json({ success: true, data })
  })
)

export default router
