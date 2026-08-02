type TradeEventInput = {
  quantity: number
  price: number
  fees: number | null
  date: Date | string
  position: {
    id: string
    openDate: Date | string
    entryPrice: number
    buyFees: number | null
    quantity: number
    accountId: string
    asset: {
      symbol: string
      exchange: { code: string; currency: string }
    }
  }
}

export type StatisticsTradeRow = {
  id: string
  positionId: string
  symbol: string
  accountId: string
  exchangeCode: string
  currency: string
  openDate: string
  closeDate: string
  unitsClosed: number
  pnl: number
  returnPct: number
  holdingDays: number
}

export type TimeSeriesPoint = {
  bucketStart: string
  bucketEnd: string
  value: number
}

export type HistogramBucket = {
  min: number
  max: number
  count: number
}

export type StatisticsRisk = {
  volatilityAnnualized: number | null
  sharpeRatio: number | null
  maxDrawdownPct: number | null
  methodology: 'SNAPSHOT_RETURNS_V1'
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  sampleSize: number
  fallbackReason?: string
}

export type BreakdownRow = {
  key: string
  label: string
  value: number
  weight: number
}

type SummaryInput = {
  trades: StatisticsTradeRow[]
  unrealizedPnL: number
}

export type SummaryOutput = {
  totalTrades: number
  winRate: number
  avgWin: number
  avgLoss: number
  profitFactor: number | null
  expectancyPerTrade: number
  avgHoldingDays: number | null
  realizedPnL: number
  unrealizedPnL: number
  totalPnL: number
}

export function mapTradeRows(events: TradeEventInput[]): StatisticsTradeRow[] {
  return events.map((event) => {
    const quantity = Number(event.quantity)
    const sellPrice = Number(event.price)
    const sellFees = Number(event.fees ?? 0)

    const entryPrice = Number(event.position.entryPrice)
    const positionBuyFees = Number(event.position.buyFees ?? 0)
    const positionQty = Math.max(Number(event.position.quantity), 0)
    const allocatedBuyFees =
      positionQty > 0 ? positionBuyFees * (quantity / positionQty) : 0

    const proceeds = quantity * sellPrice - sellFees
    const cost = quantity * entryPrice + allocatedBuyFees
    const pnl = proceeds - cost
    const returnPct = cost > 0 ? (pnl / cost) * 100 : 0

    const openDate = toIsoDate(event.position.openDate)
    const closeDate = toIsoDate(event.date)
    const holdingDays = dayDiff(openDate, closeDate)

    return {
      id: String((event as { id?: string }).id ?? ''),
      positionId: String(event.position.id),
      symbol: event.position.asset.symbol,
      accountId: event.position.accountId,
      exchangeCode: event.position.asset.exchange.code,
      currency: event.position.asset.exchange.currency,
      openDate,
      closeDate,
      unitsClosed: quantity,
      pnl: round2(pnl),
      returnPct: round4(returnPct),
      holdingDays,
    }
  })
}

export function computeSummary({
  trades,
  unrealizedPnL,
}: SummaryInput): SummaryOutput {
  const totalTrades = trades.length
  const wins = trades.filter((trade) => trade.pnl > 0)
  const losses = trades.filter((trade) => trade.pnl < 0)

  const realizedPnL = trades.reduce((acc, trade) => acc + trade.pnl, 0)
  const winPnL = wins.reduce((acc, trade) => acc + trade.pnl, 0)
  const lossAbs = Math.abs(losses.reduce((acc, trade) => acc + trade.pnl, 0))
  const avgWin = wins.length > 0 ? winPnL / wins.length : 0
  const avgLoss =
    losses.length > 0
      ? losses.reduce((acc, trade) => acc + trade.pnl, 0) / losses.length
      : 0
  const expectancyPerTrade = totalTrades > 0 ? realizedPnL / totalTrades : 0
  const avgHoldingDays =
    totalTrades > 0
      ? trades.reduce((acc, trade) => acc + trade.holdingDays, 0) / totalTrades
      : null

  return {
    totalTrades,
    winRate: totalTrades > 0 ? wins.length / totalTrades : 0,
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    profitFactor: lossAbs > 0 ? round4(winPnL / lossAbs) : null,
    expectancyPerTrade: round2(expectancyPerTrade),
    avgHoldingDays: avgHoldingDays === null ? null : round2(avgHoldingDays),
    realizedPnL: round2(realizedPnL),
    unrealizedPnL: round2(unrealizedPnL),
    totalPnL: round2(realizedPnL + unrealizedPnL),
  }
}

export function bucketSnapshotSeries(
  snapshots: Array<{
    date: Date | string
    totalValue: number
    totalPnL: number
  }>,
  metric: 'equity' | 'totalPnL',
  granularity: 'day' | 'week' | 'month'
): TimeSeriesPoint[] {
  const sorted = [...snapshots].sort(
    (a, b) => dateValue(a.date) - dateValue(b.date)
  )
  const groups = new Map<string, TimeSeriesPoint>()

  for (const snapshot of sorted) {
    const d = dateOnly(snapshot.date)
    const key = bucketKey(d, granularity)
    const existing = groups.get(key)
    const nextValue =
      metric === 'equity' ? snapshot.totalValue : snapshot.totalPnL
    const next: TimeSeriesPoint = {
      bucketStart: bucketStart(d, granularity),
      bucketEnd: bucketEnd(d, granularity),
      value: round2(nextValue),
    }

    // Keep the latest point in each bucket to avoid sawtooth artifacts.
    if (!existing || existing.bucketEnd <= next.bucketEnd) {
      groups.set(key, next)
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => Date.parse(a.bucketStart) - Date.parse(b.bucketStart)
  )
}

export function bucketRealizedSeries(
  trades: StatisticsTradeRow[],
  granularity: 'day' | 'week' | 'month'
): TimeSeriesPoint[] {
  const grouped = new Map<
    string,
    { start: string; end: string; value: number }
  >()

  for (const trade of trades) {
    const d = trade.closeDate
    const key = bucketKey(d, granularity)
    const current = grouped.get(key)
    if (!current) {
      grouped.set(key, {
        start: bucketStart(d, granularity),
        end: bucketEnd(d, granularity),
        value: trade.pnl,
      })
      continue
    }
    current.value += trade.pnl
  }

  return Array.from(grouped.values())
    .map((bucket) => ({
      bucketStart: bucket.start,
      bucketEnd: bucket.end,
      value: round2(bucket.value),
    }))
    .sort((a, b) => Date.parse(a.bucketStart) - Date.parse(b.bucketStart))
}

export function buildHistogram(
  values: number[],
  bins: number
): HistogramBucket[] {
  if (values.length === 0 || bins <= 0) return []
  const minVal = Math.min(...values)
  const maxVal = Math.max(...values)

  if (minVal === maxVal) {
    return [{ min: round2(minVal), max: round2(maxVal), count: values.length }]
  }

  const width = (maxVal - minVal) / bins
  const counts = new Array<number>(bins).fill(0)

  for (const value of values) {
    const rawIndex = Math.floor((value - minVal) / width)
    const index = Math.min(Math.max(rawIndex, 0), bins - 1)
    counts[index] += 1
  }

  return counts.map((count, idx) => ({
    min: round2(minVal + idx * width),
    max: round2(minVal + (idx + 1) * width),
    count,
  }))
}

export function computeRiskFromEquitySeries(
  points: Array<{ date: Date | string; equity: number }>
): StatisticsRisk {
  if (points.length < 2) {
    return {
      volatilityAnnualized: null,
      sharpeRatio: null,
      maxDrawdownPct: null,
      methodology: 'SNAPSHOT_RETURNS_V1',
      confidence: 'LOW',
      sampleSize: points.length,
      fallbackReason: 'Insufficient samples',
    }
  }

  const sorted = [...points].sort(
    (a, b) => dateValue(a.date) - dateValue(b.date)
  )
  const returns: number[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1].equity
    const curr = sorted[i].equity
    if (prev > 0) returns.push((curr - prev) / prev)
  }

  if (returns.length < 2) {
    return {
      volatilityAnnualized: null,
      sharpeRatio: null,
      maxDrawdownPct: computeMaxDrawdownPct(sorted.map((p) => p.equity)),
      methodology: 'SNAPSHOT_RETURNS_V1',
      confidence: 'LOW',
      sampleSize: sorted.length,
      fallbackReason: 'Insufficient return samples',
    }
  }

  const mean = returns.reduce((acc, r) => acc + r, 0) / returns.length
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1)
  const std = Math.sqrt(Math.max(variance, 0))
  const annualFactor = Math.sqrt(252)
  const volatilityAnnualized = std * annualFactor
  const sharpeRatio = std > 0 ? (mean / std) * annualFactor : null
  const sampleSize = sorted.length

  return {
    volatilityAnnualized: round4(volatilityAnnualized),
    sharpeRatio: sharpeRatio === null ? null : round4(sharpeRatio),
    maxDrawdownPct: computeMaxDrawdownPct(sorted.map((p) => p.equity)),
    methodology: 'SNAPSHOT_RETURNS_V1',
    confidence:
      sampleSize >= 252 ? 'HIGH' : sampleSize >= 90 ? 'MEDIUM' : 'LOW',
    sampleSize,
  }
}

export function computeBreakdowns(
  rows: Array<{
    accountId: string
    exchangeCode: string
    assetType: string
    industry: string | null
    marketValue: number
    realizedPnL: number
    totalPnL: number
  }>,
  by: 'account' | 'exchange' | 'assetType' | 'industry',
  metric: 'marketValue' | 'realizedPnL' | 'totalPnL'
): { rows: BreakdownRow[]; total: number } {
  const grouped = new Map<string, number>()

  for (const row of rows) {
    const key =
      by === 'account'
        ? row.accountId
        : by === 'exchange'
          ? row.exchangeCode
          : by === 'assetType'
            ? row.assetType
            : (row.industry ?? 'UNSPECIFIED')
    const value =
      metric === 'marketValue'
        ? row.marketValue
        : metric === 'realizedPnL'
          ? row.realizedPnL
          : row.totalPnL
    grouped.set(key, (grouped.get(key) ?? 0) + value)
  }

  const total = Array.from(grouped.values()).reduce((acc, v) => acc + v, 0)
  const absTotal = Math.abs(total)
  const outRows = Array.from(grouped.entries())
    .map(([key, value]) => ({
      key,
      label: key,
      value: round2(value),
      weight: absTotal > 0 ? round4(value / total) : 0,
    }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))

  return { rows: outRows, total: round2(total) }
}

function toIsoDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value)
  return d.toISOString().slice(0, 10)
}

function dayDiff(openDate: string, closeDate: string): number {
  const ms = Date.parse(closeDate) - Date.parse(openDate)
  return Math.max(Math.round(ms / 86_400_000), 0)
}

function round2(n: number): number {
  return Number(n.toFixed(2))
}

function round4(n: number): number {
  return Number(n.toFixed(4))
}

function computeMaxDrawdownPct(equitySeries: number[]): number | null {
  if (equitySeries.length < 2) return null
  let peak = equitySeries[0]
  let maxDrawdown = 0
  for (const equity of equitySeries) {
    if (equity > peak) peak = equity
    if (peak <= 0) continue
    const dd = (peak - equity) / peak
    if (dd > maxDrawdown) maxDrawdown = dd
  }
  return round4(maxDrawdown * 100)
}

function dateOnly(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value))
    .toISOString()
    .slice(0, 10)
}

function dateValue(value: Date | string): number {
  return Date.parse(value instanceof Date ? value.toISOString() : value)
}

function bucketKey(
  isoDay: string,
  granularity: 'day' | 'week' | 'month'
): string {
  if (granularity === 'day') return isoDay
  if (granularity === 'month') return isoDay.slice(0, 7)

  const d = new Date(`${isoDay}T00:00:00.000Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - day + 1)
  return d.toISOString().slice(0, 10)
}

function bucketStart(
  isoDay: string,
  granularity: 'day' | 'week' | 'month'
): string {
  if (granularity === 'day') return isoDay
  if (granularity === 'month') return `${isoDay.slice(0, 7)}-01`

  const d = new Date(`${isoDay}T00:00:00.000Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - day + 1)
  return d.toISOString().slice(0, 10)
}

function bucketEnd(
  isoDay: string,
  granularity: 'day' | 'week' | 'month'
): string {
  if (granularity === 'day') return isoDay
  if (granularity === 'month') {
    const [year, month] = isoDay.slice(0, 7).split('-').map(Number)
    const d = new Date(Date.UTC(year, month, 0))
    return d.toISOString().slice(0, 10)
  }

  const start = new Date(`${bucketStart(isoDay, 'week')}T00:00:00.000Z`)
  start.setUTCDate(start.getUTCDate() + 6)
  return start.toISOString().slice(0, 10)
}
