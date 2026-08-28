import { Router, Request, Response } from 'express'
import { query } from 'express-validator'
import YahooFinance from 'yahoo-finance2'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import {
  FmpUnavailableError,
  getQuotes as getFmpQuotes,
  searchSymbol as searchFmpSymbols,
} from '../lib/fmp-client.js'

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

function normalizeExchange(exchange?: string | null): string {
  const normalized = exchange?.trim()
  if (!normalized) return 'Unknown'
  const map: Record<string, string> = {
    NASDAQ: 'NASDAQ',
    NYSE: 'NYSE',
    AMEX: 'NYSE',
    ASX: 'ASX',
    B3: 'B3',
    LSE: 'LSE',
    TSX: 'TSX',
  }
  return map[normalized.toUpperCase()] ?? normalized
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
 *     summary: Search stock symbols globally via FMP with Yahoo fallback
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

    let results!: ReturnType<typeof mapQuote>[]
    let provider = 'fmp'

    try {
      const matches = await searchFmpSymbols(q, limit)
      results = matches.map((match) => ({
        symbol: normalizeSymbol(match.symbol),
        name: match.name?.trim() || match.symbol,
        exchange: normalizeExchange(match.exchange),
        type: 'Unknown',
        countryCode: null,
      }))
    } catch (error) {
      if (!(error instanceof FmpUnavailableError)) throw error
      provider = 'yahoo-fallback'
      console.warn(
        `FMP symbol search unavailable, falling back to Yahoo: ${error.message}`
      )

      let payload: YahooSearchResponse | null = null
      let lastProviderError: string | null = null
      for (const host of YAHOO_SEARCH_HOSTS) {
        const url = new URL(host)
        url.searchParams.set('q', q)
        url.searchParams.set('quotesCount', String(Math.max(limit * 2, 20)))
        url.searchParams.set('newsCount', '0')
        const response = await fetch(url.toString(), {
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        })
        if (response.ok) {
          payload = (await response.json()) as YahooSearchResponse
          break
        }
        const body = await response.text()
        lastProviderError = `${response.status} ${response.statusText}: ${body.slice(0, 180)}`
        if (response.status === 429) continue
      }
      if (!payload) {
        console.error(
          `Symbol search failed on both providers (query="${q}"): ${lastProviderError || 'No provider response'}`
        )
        return res.status(503).json({
          error: 'Upstream Unavailable',
          message: 'Symbol search temporarily unavailable',
          details: lastProviderError || 'No provider response',
        })
      }
      results = (payload.quotes || [])
        .map(mapQuote)
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .slice(0, limit)
    }

    res.json({
      success: true,
      data: results,
      meta: {
        query: q,
        count: results.length,
        provider,
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
 *       symbol via FMP, with Yahoo Finance as a fallback. Maximum 50 symbols
 *       per request.
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

    const dataBySymbol = new Map<string, (typeof symbols)[number]>()
    let fmpData: Awaited<ReturnType<typeof getFmpQuotes>> = []
    try {
      fmpData = await getFmpQuotes(symbols)
    } catch (error) {
      if (!(error instanceof FmpUnavailableError)) throw error
      console.warn(
        `FMP quotes unavailable, falling back to Yahoo for all symbols: ${error.message}`
      )
    }
    const data = fmpData.map((quote) => ({
      symbol: quote.symbol,
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      currency: quote.currency,
    }))
    fmpData.forEach((quote) =>
      dataBySymbol.set(quote.symbol.toUpperCase(), quote.symbol)
    )

    const missingSymbols = symbols.filter((symbol) => !dataBySymbol.has(symbol))
    const yahooResults = await Promise.allSettled(
      missingSymbols.map((symbol) => yahooFinance.quote(symbol))
    )
    yahooResults.forEach((result, index) => {
      if (result.status === 'rejected') return
      const quote = result.value as Record<string, unknown>
      const price =
        typeof quote['regularMarketPrice'] === 'number'
          ? quote['regularMarketPrice']
          : null
      if (price === null) return
      data.push({
        symbol: missingSymbols[index],
        price,
        change:
          typeof quote['regularMarketChange'] === 'number'
            ? quote['regularMarketChange']
            : null,
        changePercent:
          typeof quote['regularMarketChangePercent'] === 'number'
            ? quote['regularMarketChangePercent']
            : null,
        currency:
          typeof quote['currency'] === 'string' ? quote['currency'] : null,
      })
    })

    res.json({ success: true, data })
  })
)

export default router
