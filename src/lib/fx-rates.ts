import YahooFinance from 'yahoo-finance2'
import { prisma } from './prisma.js'

const RBA_CSV_URL =
  'https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv'
const MAX_LOOKBACK_DAYS = 10
const RBA_TABLE_TTL_MS = 60 * 60 * 1000 // 1 hour

const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
}

interface RbaRateTable {
  // currency code -> index into each data row's value array (date column excluded)
  currencyToColumnIndex: Map<string, number>
  // ISO date (YYYY-MM-DD) -> raw string values for that row (date column excluded)
  ratesByDate: Map<string, string[]>
}

let cachedRbaTable: { table: RbaRateTable; fetchedAt: number } | null = null

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function toDateOnlyUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Parses an RBA date token like "03-Jan-2023" into an ISO date string. */
function parseRbaDate(token: string): string | null {
  const match = token.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/)
  if (!match) return null
  const [, day, mon, year] = match
  const month = MONTHS[mon]
  if (!month) return null
  return `${year}-${month}-${day}`
}

/**
 * Downloads and parses RBA's "F11.1 Exchange Rates" daily CSV (covers 2023
 * onward). Rates are published as "A$1 = X <currency>" (i.e. foreign currency
 * units per 1 AUD). Result is cached in-process for an hour to avoid repeat
 * downloads across many disposal line items in the same report generation.
 */
async function fetchRbaTable(): Promise<RbaRateTable | null> {
  if (
    cachedRbaTable &&
    Date.now() - cachedRbaTable.fetchedAt < RBA_TABLE_TTL_MS
  ) {
    return cachedRbaTable.table
  }

  let text: string
  try {
    const response = await fetch(RBA_CSV_URL)
    if (!response.ok) return null
    text = await response.text()
  } catch {
    return null
  }

  const lines = text.split('\n')
  const unitsLine = lines.find((l) => l.startsWith('Units,'))
  const seriesIdLineIndex = lines.findIndex((l) => l.startsWith('Series ID,'))
  if (!unitsLine || seriesIdLineIndex === -1) return null

  const units = unitsLine.split(',').map((u) => u.trim())
  const currencyToColumnIndex = new Map<string, number>()
  for (let i = 1; i < units.length; i++) {
    const code = units[i]
    if (code && code !== 'Index') {
      currencyToColumnIndex.set(code.toUpperCase(), i - 1)
    }
  }

  const ratesByDate = new Map<string, string[]>()
  for (let i = seriesIdLineIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cells = line.split(',')
    const iso = parseRbaDate(cells[0])
    if (!iso) continue
    ratesByDate.set(iso, cells.slice(1))
  }

  const table: RbaRateTable = { currencyToColumnIndex, ratesByDate }
  cachedRbaTable = { table, fetchedAt: Date.now() }
  return table
}

/**
 * Finds the RBA rate (AUD1 = X <currency>) on `date`, or the nearest earlier
 * published day within MAX_LOOKBACK_DAYS (handles weekends/NSW public holidays
 * and currencies published less frequently, e.g. AED/PGK).
 */
function findNearestRbaRate(
  table: RbaRateTable,
  currency: string,
  date: Date
): number | null {
  const colIndex = table.currencyToColumnIndex.get(currency)
  if (colIndex === undefined) return null

  const cursor = new Date(date)
  for (let attempt = 0; attempt <= MAX_LOOKBACK_DAYS; attempt++) {
    const row = table.ratesByDate.get(toIsoDate(cursor))
    if (row) {
      const raw = row[colIndex]
      const value = raw ? Number(raw) : NaN
      if (Number.isFinite(value) && value > 0) return value
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return null
}

/**
 * Fallback when RBA doesn't cover the requested date (pre-2023) or currency.
 * Returns the same "AUD1 = X <currency>" convention as RBA for a consistent
 * inversion step in the caller.
 */
async function fetchYahooFallbackRate(
  currency: string,
  date: Date
): Promise<number | null> {
  try {
    const yf = new YahooFinance()
    const from = new Date(date)
    from.setUTCDate(from.getUTCDate() - 7)
    const to = new Date(date)
    to.setUTCDate(to.getUTCDate() + 1)
    const bars = await yf.historical(`AUD${currency}=X`, {
      period1: from,
      period2: to,
      interval: '1d',
    })
    if (!Array.isArray(bars) || bars.length === 0) return null

    const target = date.getTime()
    let best: { time: number; close: number } | null = null
    for (const bar of bars) {
      const barDate =
        bar.date instanceof Date
          ? bar.date
          : new Date(bar.date as unknown as string)
      const time = barDate.getTime()
      if (
        typeof bar.close === 'number' &&
        isFinite(bar.close) &&
        bar.close > 0 &&
        time <= target &&
        (!best || time > best.time)
      ) {
        best = { time, close: bar.close }
      }
    }
    return best?.close ?? null
  } catch {
    return null
  }
}

export interface FxRateResult {
  /** Multiply a foreign-currency amount by this to get AUD. */
  rate: number
  source: 'RBA' | 'YAHOO_FALLBACK'
}

/**
 * Returns the historical rate to convert 1 unit of `currency` into AUD on
 * `date` (amountAud = amountForeign * rate). Checks the `FxRateCache` table
 * first; on a cache miss, tries RBA's official daily rates first, falling
 * back to Yahoo Finance only if RBA doesn't cover the date/currency. Always
 * returns `{ rate: 1, source: 'RBA' }` for AUD without hitting the network.
 */
export async function getHistoricalFxRateToAud(
  currency: string,
  date: Date
): Promise<FxRateResult> {
  const normalizedCurrency = currency.trim().toUpperCase()
  const dateOnly = toDateOnlyUtc(date)

  if (normalizedCurrency === 'AUD') {
    return { rate: 1, source: 'RBA' }
  }

  const cached = await prisma.fxRateCache.findUnique({
    where: {
      currency_date: { currency: normalizedCurrency, date: dateOnly },
    },
  })
  if (cached) {
    return {
      rate: Number(cached.rateToAud),
      source: cached.source as 'RBA' | 'YAHOO_FALLBACK',
    }
  }

  let rawRate: number | null = null
  let source: 'RBA' | 'YAHOO_FALLBACK' = 'RBA'

  const table = await fetchRbaTable()
  if (table) {
    rawRate = findNearestRbaRate(table, normalizedCurrency, dateOnly)
  }

  if (rawRate === null) {
    rawRate = await fetchYahooFallbackRate(normalizedCurrency, dateOnly)
    source = 'YAHOO_FALLBACK'
  }

  if (rawRate === null) {
    throw new Error(
      `Unable to resolve historical FX rate for ${normalizedCurrency} on ${toIsoDate(dateOnly)}`
    )
  }

  // Both sources publish "AUD1 = X <currency>" — invert to get AUD per unit.
  const rate = 1 / rawRate

  await prisma.fxRateCache.upsert({
    where: {
      currency_date: { currency: normalizedCurrency, date: dateOnly },
    },
    create: {
      currency: normalizedCurrency,
      date: dateOnly,
      rateToAud: rate,
      source,
    },
    update: { rateToAud: rate, source },
  })

  return { rate, source }
}
