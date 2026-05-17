import { Router, Request, Response } from 'express'
import { query } from 'express-validator'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'

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

function mapQuote(quote: YahooQuoteResult) {
  const symbol = quote.symbol?.trim()
  if (!symbol) {
    return null
  }

  return {
    symbol: normalizeSymbol(symbol),
    name: quote.longname?.trim() || quote.shortname?.trim() || symbol,
    exchange: quote.exchDisp?.trim() || quote.exchange?.trim() || 'Unknown',
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

export default router
