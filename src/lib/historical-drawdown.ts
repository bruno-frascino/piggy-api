import YahooFinance from 'yahoo-finance2'
import { getHistoricalPrices } from './fmp-client.js'

interface DailyBar {
  high?: number | null
  low?: number | null
}

/**
 * Fetches daily OHLC bars between openDate and endDate (default: today).
 * Tries FMP first, then Yahoo Finance. Returns null when unavailable or when
 * there is nothing to scan (open date is on/after the end of the window).
 */
async function fetchDailyBars(
  symbol: string,
  openDate: Date,
  endDate?: Date
): Promise<DailyBar[] | null> {
  const to = new Date(endDate ?? new Date())
  const from = new Date(openDate)
  from.setHours(0, 0, 0, 0)
  to.setHours(23, 59, 59, 999)

  // Nothing to scan if open date is today or in the future
  if (from >= to) return null

  let bars: DailyBar[] | null
  try {
    bars = await getHistoricalPrices(
      symbol,
      from.toISOString().slice(0, 10),
      to.toISOString().slice(0, 10)
    )
  } catch {
    bars = null
  }

  if (!bars || bars.length === 0) {
    try {
      const yf = new YahooFinance()
      bars = await yf.historical(symbol, {
        period1: from,
        period2: to,
        interval: '1d',
      })
    } catch {
      return null
    }
  }

  return Array.isArray(bars) && bars.length > 0 ? bars : null
}

/**
 * Returns the worst intra-period low as a max-drawdown percentage relative
 * to the entry price.
 *
 * The returned value is always positive (e.g. 6.4 means a 6.4% drawdown).
 * Returns null when history is unavailable or there was no drawdown at all.
 */
export async function fetchHistoricalMaxDrawdown(
  symbol: string,
  entryPrice: number,
  openDate: Date
): Promise<number | null> {
  const bars = await fetchDailyBars(symbol, openDate)
  if (!bars) return null

  // Find the absolute lowest intraday low across all bars
  let minLow = Infinity
  for (const bar of bars) {
    if (typeof bar.low === 'number' && isFinite(bar.low) && bar.low < minLow) {
      minLow = bar.low
    }
  }

  // No drawdown if lowest low is at or above the entry price
  if (!isFinite(minLow) || minLow >= entryPrice) return null

  const drawdownPct = Math.abs(((minLow - entryPrice) / entryPrice) * 100)
  return drawdownPct
}

/**
 * Opposite of max drawdown: the best intra-period high as a max run-up
 * (peak unrealized gain) percentage relative to the entry price. Pass
 * `endDate` (the close date) for closed positions so the peak is only
 * searched while the position was actually held.
 *
 * The returned value is always positive (e.g. 15 means the price peaked 15%
 * above entry). Returns null when history is unavailable or the price never
 * traded above the entry price.
 */
export async function fetchHistoricalMaxRunUp(
  symbol: string,
  entryPrice: number,
  openDate: Date,
  endDate?: Date
): Promise<number | null> {
  const bars = await fetchDailyBars(symbol, openDate, endDate)
  if (!bars) return null

  let maxHigh = -Infinity
  for (const bar of bars) {
    if (
      typeof bar.high === 'number' &&
      isFinite(bar.high) &&
      bar.high > maxHigh
    ) {
      maxHigh = bar.high
    }
  }

  if (!isFinite(maxHigh) || maxHigh <= entryPrice) return null

  return ((maxHigh - entryPrice) / entryPrice) * 100
}
