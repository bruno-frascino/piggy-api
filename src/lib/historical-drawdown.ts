import YahooFinance from 'yahoo-finance2'
import { getHistoricalPrices } from './fmp-client.js'
import { AccountingDecimal } from './accounting-values.js'

interface DailyBar {
  date?: string | Date | null
  high?: number | null
  low?: number | null
}

export interface HistoricalSplitAdjustment {
  effectiveDate: string | Date
  newUnits: string | number
  oldUnits: string | number
}

function splitDate(adjustment: HistoricalSplitAdjustment): string | null {
  const date =
    typeof adjustment.effectiveDate === 'string'
      ? adjustment.effectiveDate
      : adjustment.effectiveDate.toISOString()
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

export function splitRawOhlcProvider(): 'yahoo' | null {
  // Neither enabled provider has a verified raw-OHLC contract. Keep this
  // deliberately unavailable until a source returns verifiable unadjusted bars.
  return null
}

export function normalizeRawOhlcForSplits(
  bars: DailyBar[],
  adjustments: HistoricalSplitAdjustment[]
): DailyBar[] | null {
  const normalizedAdjustments = adjustments.map((adjustment) => {
    const effectiveDate = splitDate(adjustment)
    const ratio = new AccountingDecimal(String(adjustment.newUnits)).div(
      new AccountingDecimal(String(adjustment.oldUnits))
    )
    if (!effectiveDate || !ratio.isFinite() || ratio.lte(0)) return null
    return { effectiveDate, ratio }
  })
  if (normalizedAdjustments.some((adjustment) => adjustment === null))
    return null

  const normalizedBars: DailyBar[] = []
  for (const bar of bars) {
    if (!bar.date) return null
    const parsed = new Date(bar.date)
    if (Number.isNaN(parsed.getTime())) return null
    const barDate = parsed.toISOString().slice(0, 10)
    let factor = new AccountingDecimal(1)
    for (const adjustment of normalizedAdjustments) {
      if (!adjustment) continue
      if (adjustment.effectiveDate > barDate)
        factor = factor.mul(adjustment.ratio)
    }
    normalizedBars.push({
      ...bar,
      ...(typeof bar.high === 'number'
        ? { high: new AccountingDecimal(bar.high).div(factor).toNumber() }
        : {}),
      ...(typeof bar.low === 'number'
        ? { low: new AccountingDecimal(bar.low).div(factor).toNumber() }
        : {}),
    })
  }
  return normalizedBars
}

export function splitAdjustedEntryPrice(
  entryPrice: number,
  openDate: Date,
  adjustments: HistoricalSplitAdjustment[]
): number | null {
  const openDateKey = openDate.toISOString().slice(0, 10)
  let factor = new AccountingDecimal(1)
  for (const adjustment of adjustments) {
    const effectiveDate = splitDate(adjustment)
    const ratio = new AccountingDecimal(String(adjustment.newUnits)).div(
      new AccountingDecimal(String(adjustment.oldUnits))
    )
    if (!effectiveDate || !ratio.isFinite() || ratio.lte(0)) return null
    if (effectiveDate >= openDateKey) factor = factor.mul(ratio)
  }
  const adjusted = new AccountingDecimal(entryPrice).div(factor)
  return adjusted.isFinite() && adjusted.gt(0) ? adjusted.toNumber() : null
}

/**
 * Fetches daily OHLC bars between openDate and endDate (default: today).
 * Tries FMP first, then Yahoo Finance. Returns null when unavailable or when
 * there is nothing to scan (open date is on/after the end of the window).
 */
async function fetchDailyBars(
  symbol: string,
  openDate: Date,
  endDate?: Date,
  splitRawProvider: 'yahoo' | null = null
): Promise<DailyBar[] | null> {
  const to = new Date(endDate ?? new Date())
  const from = new Date(openDate)
  from.setHours(0, 0, 0, 0)
  to.setHours(23, 59, 59, 999)

  // Nothing to scan if open date is today or in the future
  if (from >= to) return null

  let bars: DailyBar[] | null = null
  if (splitRawProvider !== 'yahoo') {
    try {
      bars = await getHistoricalPrices(
        symbol,
        from.toISOString().slice(0, 10),
        to.toISOString().slice(0, 10)
      )
    } catch {
      bars = null
    }
  }

  if (!bars || bars.length === 0) {
    try {
      const yf = new YahooFinance()
      bars = await yf.historical(symbol, {
        period1: from,
        period2: to,
        interval: '1d',
        includeAdjustedClose: false,
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
  openDate: Date,
  splitAdjustments: HistoricalSplitAdjustment[] = []
): Promise<number | null> {
  if (splitAdjustments.length > 0) return null
  const splitRawProvider = null
  const bars = await fetchDailyBars(
    symbol,
    openDate,
    undefined,
    splitRawProvider
  )
  if (!bars) return null
  const normalizedBars =
    splitAdjustments.length > 0
      ? normalizeRawOhlcForSplits(bars, splitAdjustments)
      : bars
  if (!normalizedBars) return null
  const adjustedEntry =
    splitAdjustments.length > 0
      ? splitAdjustedEntryPrice(entryPrice, openDate, splitAdjustments)
      : entryPrice
  if (adjustedEntry === null) return null

  // Find the absolute lowest intraday low across all bars
  let minLow = Infinity
  for (const bar of normalizedBars) {
    if (typeof bar.low === 'number' && isFinite(bar.low) && bar.low < minLow) {
      minLow = bar.low
    }
  }

  // No drawdown if lowest low is at or above the entry price
  if (!isFinite(minLow) || minLow >= adjustedEntry) return null

  const drawdownPct = Math.abs(((minLow - adjustedEntry) / adjustedEntry) * 100)
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
  endDate?: Date,
  splitAdjustments: HistoricalSplitAdjustment[] = []
): Promise<number | null> {
  if (splitAdjustments.length > 0) return null
  const splitRawProvider = null
  const bars = await fetchDailyBars(symbol, openDate, endDate, splitRawProvider)
  if (!bars) return null
  const normalizedBars =
    splitAdjustments.length > 0
      ? normalizeRawOhlcForSplits(bars, splitAdjustments)
      : bars
  if (!normalizedBars) return null
  const adjustedEntry =
    splitAdjustments.length > 0
      ? splitAdjustedEntryPrice(entryPrice, openDate, splitAdjustments)
      : entryPrice
  if (adjustedEntry === null) return null

  let maxHigh = -Infinity
  for (const bar of normalizedBars) {
    if (
      typeof bar.high === 'number' &&
      isFinite(bar.high) &&
      bar.high > maxHigh
    ) {
      maxHigh = bar.high
    }
  }

  if (!isFinite(maxHigh) || maxHigh <= adjustedEntry) return null

  return ((maxHigh - adjustedEntry) / adjustedEntry) * 100
}

/**
 * Finds when a long position's stop loss was first reached: the earliest daily
 * bar since `since` whose intraday low is at or below `stopLossPrice`.
 *
 * Returns that bar's date, or null when history is unavailable or the stop was
 * never reached. Bars are daily, so the timestamp is day-granular.
 */
export async function fetchHistoricalStopLossHit(
  symbol: string,
  stopLossPrice: number,
  since: Date
): Promise<Date | null> {
  const bars = await fetchDailyBars(symbol, since)
  if (!bars) return null

  let earliest: Date | null = null
  for (const bar of bars) {
    if (
      typeof bar.low !== 'number' ||
      !isFinite(bar.low) ||
      bar.low > stopLossPrice ||
      !bar.date
    ) {
      continue
    }
    const barDate = new Date(bar.date)
    if (isNaN(barDate.getTime())) continue
    if (!earliest || barDate < earliest) earliest = barDate
  }
  return earliest
}
