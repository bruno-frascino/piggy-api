import { Router, Request, Response } from 'express'
import { query } from 'express-validator'
import YahooFinance from 'yahoo-finance2'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'

const yahooFinance = new YahooFinance()

const router = Router()

type YahooQuoteResult = {
  symbol?: string
  shortname?: string
  longname?: string
  exchDisp?: string
  exchange?: string
  typeDisp?: string
  quoteType?: string
  region?: string
}

type YahooSearchResponse = {
  quotes?: YahooQuoteResult[]
}

const YAHOO_SEARCH_HOSTS = [
  'https://query1.finance.yahoo.com/v1/finance/search',
  'https://query2.finance.yahoo.com/v1/finance/search',
]

const searchStocksValidation = [
  query('q').isString().trim().isLength({ min: 1, max: 80 }),
  query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  handleValidationErrors,
]

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}

function toCountryCode(region?: string): string | null {
  if (!region) {
    return null
  }

  const normalized = region.trim().toUpperCase()

  // Yahoo region values are not strict ISO country codes in all cases.
  const map: Record<string, string> = {
    US: 'US',
    BR: 'BR',
    AU: 'AU',
    GB: 'GB',
    CA: 'CA',
    DE: 'DE',
    FR: 'FR',
    IT: 'IT',
    ES: 'ES',
    NL: 'NL',
    SE: 'SE',
    NO: 'NO',
    DK: 'DK',
    FI: 'FI',
    CH: 'CH',
    JP: 'JP',
    HK: 'HK',
    SG: 'SG',
    IN: 'IN',
  }

  return map[normalized] ?? null
}

// Maps Yahoo Finance exchDisp display names to our exchange codes
const YAHOO_EXCHANGE_MAP: Record<string, string> = {
  Australian: 'ASX',
  NasdaqGS: 'NASDAQ',
  NasdaqCM: 'NASDAQ',
  NasdaqGM: 'NASDAQ',
  Nasdaq: 'NASDAQ',
  NYSE: 'NYSE',
  'NYSE MKT': 'NYSE',
  'NYSE American': 'NYSE',
  'NYSE Arca': 'NYSE',
  'São Paulo': 'B3',
  'Sao Paulo': 'B3',
  London: 'LSE',
  Toronto: 'TSX',
  TSX: 'TSX',
  TSXV: 'TSX',
}

function mapQuote(quote: YahooQuoteResult) {
  const symbol = quote.symbol?.trim()
  if (!symbol) {
    return null
  }

  const rawExchange =
    quote.exchDisp?.trim() || quote.exchange?.trim() || 'Unknown'
  const exchange = YAHOO_EXCHANGE_MAP[rawExchange] ?? rawExchange

  return {
    symbol: normalizeSymbol(symbol),
    name: quote.longname?.trim() || quote.shortname?.trim() || symbol,
    exchange,
    type: quote.typeDisp?.trim() || quote.quoteType?.trim() || 'Unknown',
    countryCode: toCountryCode(quote.region),
  }
}

/**
 * @swagger
 * /api/stocks/search:
 *   get:
 *     summary: Search stock symbols globally
 *     tags: [Stocks]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Symbol or company name
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 20
 *     responses:
 *       200:
 *         description: Matching symbols
 *       400:
 *         description: Validation error
 */
router.get(
  '/search',
  searchStocksValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim()
    const limit = Number(req.query.limit || 20)

    let payload: YahooSearchResponse | null = null
    let lastProviderError: string | null = null

    for (const host of YAHOO_SEARCH_HOSTS) {
      const url = new URL(host)
      url.searchParams.set('q', q)
      url.searchParams.set('quotesCount', String(Math.max(limit * 2, 20)))
      url.searchParams.set('newsCount', '0')

      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          // A minimal UA has been more reliable than full browser strings.
          'User-Agent': 'Mozilla/5.0',
        },
      })

      if (response.ok) {
        payload = (await response.json()) as YahooSearchResponse
        break
      }

      const body = await response.text()
      lastProviderError = `${response.status} ${response.statusText}: ${body.slice(0, 180)}`

      // If current host is rate-limited, try the next host immediately.
      if (response.status === 429) {
        continue
      }
    }

    if (!payload) {
      return res.status(502).json({
        success: false,
        error: 'Symbol search provider failed',
        details: lastProviderError || 'No provider response',
      })
    }

    const results = (payload.quotes || [])
      .map(mapQuote)
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, limit)

    res.json({
      success: true,
      data: results,
      meta: {
        query: q,
        count: results.length,
        provider: 'yahoo-finance-search',
      },
    })
  })
)

// ─── GET /api/stocks/quotes ───────────────────────────────────────────────────

/**
 * @swagger
 * /api/stocks/quotes:
 *   get:
 *     summary: Fetch live quotes for a list of symbols
 *     description: |
 *       Returns the current market price, day change and day change % for each
 *       symbol via Yahoo Finance (no API key required). Symbols must use the
 *       Yahoo Finance format — include exchange suffix where applicable
 *       (e.g. BHP.AX for ASX, VOD.L for LSE). Maximum 50 symbols per request.
 *     tags: [Stocks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: symbols
 *         required: true
 *         schema:
 *           type: string
 *         description: Comma-separated list of symbols (e.g. AAPL,BHP.AX,BTC-USD)
 *     responses:
 *       200:
 *         description: Quote data — symbols that could not be resolved are omitted
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
 *                       symbol:
 *                         type: string
 *                       price:
 *                         type: number
 *                         nullable: true
 *                       change:
 *                         type: number
 *                         nullable: true
 *                       changePercent:
 *                         type: number
 *                         nullable: true
 *                       currency:
 *                         type: string
 *                         nullable: true
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/quotes',
  [
    authenticateToken,
    query('symbols').isString().trim().isLength({ min: 1, max: 500 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const rawSymbols = String(req.query.symbols || '').trim()
    const symbols = rawSymbols
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 50)

    if (!symbols.length) {
      return res.json({ success: true, data: [] })
    }

    const results = await Promise.allSettled(
      symbols.map((s) => yahooFinance.quote(s))
    )

    const data = results
      .map((r, i) => {
        if (r.status === 'rejected') return null
        const q = r.value as Record<string, unknown>
        const price =
          typeof q['regularMarketPrice'] === 'number'
            ? (q['regularMarketPrice'] as number)
            : null
        if (price === null) return null
        return {
          symbol: symbols[i],
          price,
          change:
            typeof q['regularMarketChange'] === 'number'
              ? (q['regularMarketChange'] as number)
              : null,
          changePercent:
            typeof q['regularMarketChangePercent'] === 'number'
              ? (q['regularMarketChangePercent'] as number)
              : null,
          currency:
            typeof q['currency'] === 'string'
              ? (q['currency'] as string)
              : null,
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    res.json({ success: true, data })
  })
)

export default router
