// Thin client for Financial Modeling Prep (FMP) — used for market-wide stock
// screening and dividend-calendar data that Yahoo Finance (src/controllers/stocks.ts)
// does not provide. See docs/adr for the provider decision.

const FMP_BASE_URL =
  process.env.FMP_BASE_URL || 'https://financialmodelingprep.com/stable'
const REQUEST_TIMEOUT_MS = 5000

export class FmpUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FmpUnavailableError'
  }
}

export interface ScreenerCriteria {
  marketCapMoreThan?: number
  marketCapLowerThan?: number
  dividendMoreThan?: number
  dividendLowerThan?: number
  sector?: string
  industry?: string
  exchange?: string
  isEtf?: boolean
  isActivelyTrading?: boolean
  limit?: number
  page?: number
}

export interface ScreenerResult {
  symbol: string
  name: string
  exchange: string | null
  sector: string | null
  industry: string | null
  marketCap: number | null
  price: number | null
  lastAnnualDividend: number | null
  isEtf: boolean
  country: string | null
}

export interface SymbolSearchResult {
  symbol: string
  name: string
  exchange: string | null
  currency: string | null
}

export interface UpcomingDividend {
  symbol: string
  exDate: string
  paymentDate: string | null
  dividend: number
  yield: number | null
  frequency: string | null
}

interface RawScreenerItem {
  symbol: string
  companyName: string
  marketCap: number | null
  sector: string | null
  industry: string | null
  price: number | null
  lastAnnualDividend: number | null
  exchangeShortName: string | null
  country: string | null
  isEtf: boolean
}

interface RawSymbolSearchItem {
  symbol: string
  name: string
  exchange: string | null
  currency: string | null
}

interface RawDividendCalendarItem {
  symbol: string
  date: string
  paymentDate: string | null
  dividend: number
  yield: number | null
  frequency: string | null
}

function requireApiKey(): string {
  const apiKey = process.env.FMP_API_KEY
  if (!apiKey) {
    throw new FmpUnavailableError('FMP_API_KEY is not configured')
  }
  return apiKey
}

async function fetchJson<T>(
  path: string,
  params: Record<string, string>
): Promise<T> {
  const url = new URL(`${FMP_BASE_URL}${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('apikey', requireApiKey())

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      throw new FmpUnavailableError(
        `FMP request failed with ${response.status}`
      )
    }
    return (await response.json()) as T
  } catch (error) {
    if (error instanceof FmpUnavailableError) throw error
    throw new FmpUnavailableError('FMP request failed or timed out')
  } finally {
    clearTimeout(timeout)
  }
}

function mapScreenerItem(item: RawScreenerItem): ScreenerResult {
  return {
    symbol: item.symbol,
    name: item.companyName,
    exchange: item.exchangeShortName ?? null,
    sector: item.sector ?? null,
    industry: item.industry ?? null,
    marketCap: item.marketCap ?? null,
    price: item.price ?? null,
    lastAnnualDividend: item.lastAnnualDividend ?? null,
    isEtf: Boolean(item.isEtf),
    country: item.country ?? null,
  }
}

export async function screenStocks(
  criteria: ScreenerCriteria
): Promise<ScreenerResult[]> {
  const params: Record<string, string> = {}
  if (criteria.marketCapMoreThan !== undefined) {
    params.marketCapMoreThan = String(criteria.marketCapMoreThan)
  }
  if (criteria.marketCapLowerThan !== undefined) {
    params.marketCapLowerThan = String(criteria.marketCapLowerThan)
  }
  if (criteria.dividendMoreThan !== undefined) {
    params.dividendMoreThan = String(criteria.dividendMoreThan)
  }
  if (criteria.dividendLowerThan !== undefined) {
    params.dividendLowerThan = String(criteria.dividendLowerThan)
  }
  if (criteria.sector) params.sector = criteria.sector
  if (criteria.industry) params.industry = criteria.industry
  if (criteria.exchange) params.exchange = criteria.exchange
  if (criteria.isEtf !== undefined) params.isEtf = String(criteria.isEtf)
  if (criteria.isActivelyTrading !== undefined) {
    params.isActivelyTrading = String(criteria.isActivelyTrading)
  }
  params.limit = String(criteria.limit ?? 50)
  params.page = String(criteria.page ?? 0)

  const raw = await fetchJson<RawScreenerItem[]>('/company-screener', params)
  return raw.map(mapScreenerItem)
}

export async function searchSymbol(
  q: string,
  limit = 20
): Promise<SymbolSearchResult[]> {
  const raw = await fetchJson<RawSymbolSearchItem[]>('/search-symbol', {
    query: q,
    limit: String(limit),
  })
  return raw.map((item) => ({
    symbol: item.symbol,
    name: item.name,
    exchange: item.exchange ?? null,
    currency: item.currency ?? null,
  }))
}

/** Fetches all dividend ex-dates in [from, to] (max 90-day range per FMP), unfiltered by symbol. */
export async function getDividendsCalendar(
  from: string,
  to: string
): Promise<UpcomingDividend[]> {
  const raw = await fetchJson<RawDividendCalendarItem[]>(
    '/dividends-calendar',
    {
      from,
      to,
    }
  )
  return raw.map((item) => ({
    symbol: item.symbol,
    exDate: item.date,
    paymentDate: item.paymentDate ?? null,
    dividend: item.dividend,
    yield: item.yield ?? null,
    frequency: item.frequency ?? null,
  }))
}
