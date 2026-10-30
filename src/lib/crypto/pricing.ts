import YahooFinance from 'yahoo-finance2'
import { getHistoricalPrices, getQuotes } from '../fmp-client.js'
import { getHistoricalFxRateToAud } from '../fx-rates.js'
import { toCanonicalSymbol } from './symbols.js'

const yahooFinance = new YahooFinance()

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

async function fetchSpot(base: string, quote: string): Promise<number | null> {
  try {
    const [fmp] = await getQuotes([`${base}${quote}`])
    if (
      fmp &&
      typeof fmp.price === 'number' &&
      Number.isFinite(fmp.price) &&
      fmp.price > 0 &&
      (!fmp.currency || fmp.currency.toUpperCase() === quote)
    )
      return fmp.price
  } catch (error) {
    console.warn(`FMP crypto quote unavailable for ${base}-${quote}`, error)
  }
  try {
    const result = await yahooFinance.quote(toCanonicalSymbol(base, quote))
    const price = result?.regularMarketPrice
    return typeof price === 'number' &&
      Number.isFinite(price) &&
      price > 0 &&
      (!result.currency || result.currency.toUpperCase() === quote)
      ? price
      : null
  } catch (error) {
    console.warn(`Yahoo crypto quote unavailable for ${base}-${quote}`, error)
    return null
  }
}

async function fetchCloses(
  base: string,
  quote: string,
  from: Date,
  to: Date
): Promise<Map<string, number>> {
  const closes = new Map<string, number>()
  try {
    const bars = await getHistoricalPrices(
      `${base}${quote}`,
      toDateKey(from),
      toDateKey(to)
    )
    for (const bar of bars) {
      if (bar.date && typeof bar.close === 'number' && bar.close > 0) {
        closes.set(bar.date.slice(0, 10), bar.close)
      }
    }
  } catch {
    // fall through to Yahoo
  }
  if (closes.size > 0) return closes

  try {
    const bars = await yahooFinance.historical(toCanonicalSymbol(base, quote), {
      period1: from,
      period2: to,
      interval: '1d',
    })
    for (const bar of bars) {
      if (typeof bar.close === 'number' && bar.close > 0) {
        closes.set(toDateKey(new Date(bar.date)), bar.close)
      }
    }
  } catch {
    // no data
  }
  return closes
}

/**
 * Latest price of `base` in `quote` (AUD or USD). When the AUD pair isn't
 * listed, falls back to the USD pair converted at the current USD->AUD rate.
 */
export async function getCryptoQuote(
  base: string,
  quote: string
): Promise<number | null> {
  const normalizedBase = base.trim().toUpperCase()
  const normalizedQuote = quote.trim().toUpperCase()

  const direct = await fetchSpot(normalizedBase, normalizedQuote)
  if (direct !== null || normalizedQuote !== 'AUD') return direct

  const usd = await fetchSpot(normalizedBase, 'USD')
  if (usd === null) return null
  const { rate } = await getHistoricalFxRateToAud('USD', new Date())
  return usd * rate
}

/**
 * Daily closes keyed by UTC `YYYY-MM-DD`. When the AUD pair has no history,
 * the USD closes are converted with the RBA-first rate of each day.
 */
export async function getCryptoDailyCloses(
  base: string,
  quote: string,
  from: Date,
  to: Date
): Promise<Map<string, number>> {
  const normalizedBase = base.trim().toUpperCase()
  const normalizedQuote = quote.trim().toUpperCase()

  const direct = await fetchCloses(normalizedBase, normalizedQuote, from, to)
  if (direct.size > 0 || normalizedQuote !== 'AUD') return direct

  const usd = await fetchCloses(normalizedBase, 'USD', from, to)
  const converted = new Map<string, number>()
  for (const [day, close] of usd) {
    const { rate } = await getHistoricalFxRateToAud(
      'USD',
      new Date(`${day}T00:00:00Z`)
    )
    converted.set(day, close * rate)
  }
  return converted
}
