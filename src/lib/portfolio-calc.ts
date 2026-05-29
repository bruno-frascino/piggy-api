export interface OpenPositionForSnapshot {
  capitalAllocated: number
  unrealizedPnL: number | null
}

export interface ClosedPositionForSnapshot {
  realizedPnL: number | null
}

/**
 * Computes the values stored in a PortfolioSnapshot row.
 *
 * totalValue intentionally includes totalRealizedPnL so that the equity
 * curve remains meaningful even when no positions are open — the chart
 * reflects cumulative wealth (invested capital + unrealised gains +
 * realised gains) rather than just money currently at work in the market.
 */
export function computeSnapshotValues(
  openPositions: OpenPositionForSnapshot[],
  closedPositions: ClosedPositionForSnapshot[]
): {
  totalInvested: number
  totalPnL: number
  totalValue: number
  totalReturnPct: number
} {
  const totalInvested = openPositions.reduce(
    (sum, p) => sum + p.capitalAllocated,
    0
  )
  const totalUnrealizedPnL = openPositions.reduce(
    (sum, p) => sum + (p.unrealizedPnL ?? 0),
    0
  )
  const totalRealizedPnL = closedPositions.reduce(
    (sum, p) => sum + (p.realizedPnL ?? 0),
    0
  )
  const totalPnL = totalUnrealizedPnL + totalRealizedPnL
  const totalValue = totalInvested + totalUnrealizedPnL + totalRealizedPnL
  const totalReturnPct =
    totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0

  return { totalInvested, totalPnL, totalValue, totalReturnPct }
}
