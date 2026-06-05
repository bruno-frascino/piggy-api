import YahooFinance from 'yahoo-finance2'

/**
 * Fetches daily OHLC history from Yahoo Finance for a symbol between
 * openDate and today, then returns the worst intra-period low as a
 * max-drawdown percentage relative to the entry price.
 *
 * The returned value is always positive (e.g. 6.4 means a 6.4% drawdown).
 * Returns null when history is unavailable or there was no drawdown at all.
 */
export async function fetchHistoricalMaxDrawdown(
  symbol: string,
  entryPrice: number,
  openDate: Date
): Promise<number | null> {
  const today = new Date()
  const from = new Date(openDate)
  from.setHours(0, 0, 0, 0)
  today.setHours(23, 59, 59, 999)

  // Nothing to scan if open date is today or in the future
  if (from >= today) return null

  let bars: { low?: number | null }[]
  try {
    const yf = new YahooFinance()
    bars = await yf.historical(symbol, {
      period1: from,
      period2: today,
      interval: '1d',
    })
  } catch {
    // Yahoo Finance unavailable or symbol unrecognised — fail silently
    return null
  }

  if (!Array.isArray(bars) || bars.length === 0) return null

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
