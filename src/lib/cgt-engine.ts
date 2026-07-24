import { prisma } from './prisma.js'
import { getHistoricalFxRateToAud } from './fx-rates.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
// ATO: an asset must be held for MORE than 12 months to qualify for the 50%
// CGT discount. This uses a simple day-count approximation (no leap-year or
// exact calendar-month handling) — flagged in the generated report footnote.
const DISCOUNT_HOLDING_DAYS = 365

export interface CgtLineItem {
  positionId: string
  symbol: string
  assetType: string
  exchangeCode: string
  currency: string
  accountId: string
  accountName: string
  quantity: number
  acquireDate: string
  disposeDate: string
  holdingDays: number
  discountEligible: boolean
  proceedsForeign: number
  costBaseForeign: number
  proceedsAud: number
  costBaseAud: number
  capitalGainAud: number
  fxRateAcquire: number
  fxRateAcquireSource: 'RBA' | 'YAHOO_FALLBACK'
  fxRateDispose: number
  fxRateDisposeSource: 'RBA' | 'YAHOO_FALLBACK'
}

export interface CgtReportResult {
  financialYearStartYear: number
  financialYearLabel: string
  accountsKey: string
  lineItems: CgtLineItem[]
  totalProceedsAud: number
  totalCostBaseAud: number
  totalCapitalGainGrossAud: number
  totalCapitalLossAud: number
  carriedForwardLossOpeningAud: number
  discountAppliedAud: number
  netCapitalGainAud: number
  carriedForwardLossClosingAud: number
}

/** Derives the stable "declaration identity" key used for upserts and for
 * matching the correct year-to-year carried-forward loss chain. */
export function computeAccountsKey(accountIds: string[]): string {
  return [...accountIds].sort().join(',')
}

/** Australian financial year: 1 Jul (startYear) – 30 Jun (startYear + 1). */
export function getFinancialYearRange(financialYearStartYear: number): {
  start: Date
  end: Date
  label: string
} {
  const start = new Date(Date.UTC(financialYearStartYear, 6, 1))
  const end = new Date(Date.UTC(financialYearStartYear + 1, 6, 1))
  const label = `FY${financialYearStartYear}-${String((financialYearStartYear + 1) % 100).padStart(2, '0')}`
  return { start, end, label }
}

/**
 * Computes an ATO-style capital gains report for a user, financial year, and
 * an explicit set of Trading Accounts (a "declaration" — e.g. the user's own
 * accounts vs a spouse's accounts tracked under the same login).
 *
 * Each `Position` is created with exactly one BUY transaction and is never
 * appended to (see positions.ts `POST /`), so every Position IS already a
 * discrete CGT parcel — no FIFO lot reconstruction is required. Every SELL
 * transaction against it (full or partial close) is an unambiguous disposal
 * of that specific parcel.
 */
export async function computeCapitalGainsReport(
  userId: string,
  financialYearStartYear: number,
  accountIds: string[]
): Promise<CgtReportResult> {
  if (accountIds.length === 0) {
    throw new Error('At least one trading account must be selected')
  }

  const accountsKey = computeAccountsKey(accountIds)
  const ownedAccounts = await prisma.tradingAccount.findMany({
    where: { id: { in: accountIds }, userId },
    select: { id: true },
  })
  if (ownedAccounts.length !== new Set(accountIds).size) {
    throw new Error('One or more selected accounts were not found')
  }

  const { start, end, label } = getFinancialYearRange(financialYearStartYear)

  const disposals = await prisma.transaction.findMany({
    where: {
      type: 'SELL',
      date: { gte: start, lt: end },
      position: {
        userId,
        accountId: { in: accountIds },
      },
    },
    include: {
      position: {
        include: {
          asset: { include: { exchange: true } },
          account: true,
        },
      },
    },
    orderBy: { date: 'asc' },
  })

  const lineItems: CgtLineItem[] = []

  for (const tx of disposals) {
    const position = tx.position
    const currency = position.asset.exchange.currency
    const acquireDate = new Date(position.openDate)
    const disposeDate = new Date(tx.date)

    const originalBuyQty =
      Number(position.entryPrice) > 0
        ? Number(position.totalBuyValue) / Number(position.entryPrice)
        : 0
    const quantity = Number(tx.quantity)
    const proratedBuyFee =
      originalBuyQty > 0
        ? Number(position.buyFees) * (quantity / originalBuyQty)
        : 0

    const proceedsForeign = Number(tx.totalValue) - Number(tx.fees)
    const costBaseForeign =
      Number(position.entryPrice) * quantity + proratedBuyFee

    const [fxAcquire, fxDispose] = await Promise.all([
      getHistoricalFxRateToAud(currency, acquireDate),
      getHistoricalFxRateToAud(currency, disposeDate),
    ])

    const proceedsAud = proceedsForeign * fxDispose.rate
    const costBaseAud = costBaseForeign * fxAcquire.rate
    const capitalGainAud = proceedsAud - costBaseAud
    const holdingDays = Math.round(
      (disposeDate.getTime() - acquireDate.getTime()) / MS_PER_DAY
    )

    lineItems.push({
      positionId: position.id,
      symbol: position.asset.symbol,
      assetType: position.asset.assetType,
      exchangeCode: position.asset.exchange.code,
      currency,
      accountId: position.accountId,
      accountName: position.account.name,
      quantity,
      acquireDate: acquireDate.toISOString().slice(0, 10),
      disposeDate: disposeDate.toISOString().slice(0, 10),
      holdingDays,
      discountEligible: holdingDays > DISCOUNT_HOLDING_DAYS,
      proceedsForeign,
      costBaseForeign,
      proceedsAud,
      costBaseAud,
      capitalGainAud,
      fxRateAcquire: fxAcquire.rate,
      fxRateAcquireSource: fxAcquire.source,
      fxRateDispose: fxDispose.rate,
      fxRateDisposeSource: fxDispose.source,
    })
  }

  const totalProceedsAud = sum(lineItems.map((l) => l.proceedsAud))
  const totalCostBaseAud = sum(lineItems.map((l) => l.costBaseAud))

  const discountEligibleGains = sum(
    lineItems
      .filter((l) => l.capitalGainAud > 0 && l.discountEligible)
      .map((l) => l.capitalGainAud)
  )
  const nonDiscountGains = sum(
    lineItems
      .filter((l) => l.capitalGainAud > 0 && !l.discountEligible)
      .map((l) => l.capitalGainAud)
  )
  const totalCapitalLossAud = Math.abs(
    sum(
      lineItems.filter((l) => l.capitalGainAud < 0).map((l) => l.capitalGainAud)
    )
  )
  const totalCapitalGainGrossAud = discountEligibleGains + nonDiscountGains

  const priorReport = await prisma.taxReport.findFirst({
    where: {
      userId,
      accountsKey,
      financialYearStartYear: { lt: financialYearStartYear },
    },
    orderBy: { financialYearStartYear: 'desc' },
    select: { carriedForwardLossClosingAud: true },
  })
  const carriedForwardLossOpeningAud = priorReport
    ? Number(priorReport.carriedForwardLossClosingAud)
    : 0

  // ATO ordering: apply available losses to non-discount gains first, then to
  // discount-eligible gains, THEN apply the 50% discount to what remains —
  // this maximises the discount benefit for the taxpayer.
  let availableLosses = totalCapitalLossAud + carriedForwardLossOpeningAud

  const offsetNonDiscount = Math.min(availableLosses, nonDiscountGains)
  const remainingNonDiscountGain = nonDiscountGains - offsetNonDiscount
  availableLosses -= offsetNonDiscount

  const offsetDiscountEligible = Math.min(
    availableLosses,
    discountEligibleGains
  )
  const remainingDiscountEligibleGain =
    discountEligibleGains - offsetDiscountEligible
  availableLosses -= offsetDiscountEligible

  const discountAppliedAud = remainingDiscountEligibleGain * 0.5
  const netCapitalGainAud =
    remainingNonDiscountGain +
    (remainingDiscountEligibleGain - discountAppliedAud)
  const carriedForwardLossClosingAud = availableLosses

  return {
    financialYearStartYear,
    financialYearLabel: label,
    accountsKey,
    lineItems,
    totalProceedsAud,
    totalCostBaseAud,
    totalCapitalGainGrossAud,
    totalCapitalLossAud,
    carriedForwardLossOpeningAud,
    discountAppliedAud,
    netCapitalGainAud,
    carriedForwardLossClosingAud,
  }
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0)
}
