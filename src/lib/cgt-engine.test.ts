import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  tradingAccountFindManyMock,
  transactionFindManyMock,
  taxReportFindFirstMock,
  getFxRateMock,
} = vi.hoisted(() => ({
  tradingAccountFindManyMock: vi.fn(),
  transactionFindManyMock: vi.fn(),
  taxReportFindFirstMock: vi.fn(),
  getFxRateMock: vi.fn(),
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    tradingAccount: { findMany: tradingAccountFindManyMock },
    transaction: { findMany: transactionFindManyMock },
    taxReport: { findFirst: taxReportFindFirstMock },
  },
}))

vi.mock('../lib/fx-rates.js', () => ({
  getHistoricalFxRateToAud: getFxRateMock,
}))

import {
  computeAccountsKey,
  computeCapitalGainsReport,
  getFinancialYearRange,
} from './cgt-engine.js'

function makeDisposal({
  id,
  quantity,
  totalValue,
  fees,
  date,
  entryPrice,
  buyFees,
  totalBuyValue,
  openDate,
  currency = 'AUD',
  accountId = 'acc1',
  accountName = 'Main',
}: {
  id: string
  quantity: number
  totalValue: number
  fees: number
  date: string
  entryPrice: number
  buyFees: number
  totalBuyValue: number
  openDate: string
  currency?: string
  accountId?: string
  accountName?: string
}) {
  return {
    id,
    type: 'SELL',
    date: new Date(date),
    quantity,
    totalValue,
    fees,
    position: {
      id: `pos-${id}`,
      accountId,
      openDate: new Date(openDate),
      entryPrice,
      buyFees,
      totalBuyValue,
      asset: {
        symbol: 'CBA',
        assetType: 'EQUITY',
        exchange: { code: 'ASX', currency },
      },
      account: { name: accountName },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  tradingAccountFindManyMock.mockResolvedValue([{ id: 'acc1' }])
  taxReportFindFirstMock.mockResolvedValue(null)
  getFxRateMock.mockResolvedValue({ rate: 1, source: 'RBA' })
})

describe('getFinancialYearRange', () => {
  it('returns 1 Jul - 30 Jun UTC range and a FYyyyy-yy label', () => {
    const { start, end, label } = getFinancialYearRange(2025)
    expect(start.toISOString()).toBe('2025-07-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(label).toBe('FY2025-26')
  })
})

describe('computeAccountsKey', () => {
  it('sorts account ids so order does not matter', () => {
    expect(computeAccountsKey(['b', 'a'])).toBe('a,b')
    expect(computeAccountsKey(['a', 'b'])).toBe('a,b')
  })
})

describe('computeCapitalGainsReport', () => {
  it('rejects when accountIds is empty', async () => {
    await expect(computeCapitalGainsReport('u1', 2025, [])).rejects.toThrow(
      'At least one trading account must be selected'
    )
  })

  it('rejects when an account does not belong to the user', async () => {
    tradingAccountFindManyMock.mockResolvedValue([]) // none owned
    await expect(
      computeCapitalGainsReport('u1', 2025, ['acc1'])
    ).rejects.toThrow('One or more selected accounts were not found')
  })

  it('computes a long-term discount-eligible gain correctly (AUD only)', async () => {
    transactionFindManyMock.mockResolvedValue([
      makeDisposal({
        id: 't1',
        quantity: 100,
        totalValue: 1500, // proceeds gross
        fees: 10,
        date: '2026-03-01', // disposed in FY2025-26
        entryPrice: 10, // cost = 100*10 = 1000
        buyFees: 20,
        totalBuyValue: 1000,
        openDate: '2024-01-01', // held > 12 months
      }),
    ])

    const result = await computeCapitalGainsReport('u1', 2025, ['acc1'])

    // proceeds = 1500 - 10 = 1490; cost = 1000 + 20 = 1020; gain = 470
    expect(result.lineItems).toHaveLength(1)
    expect(result.lineItems[0].discountEligible).toBe(true)
    expect(result.lineItems[0].capitalGainAud).toBeCloseTo(470)
    expect(result.totalCapitalGainGrossAud).toBeCloseTo(470)
    // 50% discount applied since no losses to offset
    expect(result.discountAppliedAud).toBeCloseTo(235)
    expect(result.netCapitalGainAud).toBeCloseTo(235)
    expect(result.carriedForwardLossClosingAud).toBe(0)
  })

  it('does not apply the discount for a short-term (<=12mo) gain', async () => {
    transactionFindManyMock.mockResolvedValue([
      makeDisposal({
        id: 't1',
        quantity: 100,
        totalValue: 1500,
        fees: 0,
        date: '2026-01-01',
        entryPrice: 10,
        buyFees: 0,
        totalBuyValue: 1000,
        openDate: '2025-07-15', // held < 12 months
      }),
    ])

    const result = await computeCapitalGainsReport('u1', 2025, ['acc1'])

    expect(result.lineItems[0].discountEligible).toBe(false)
    expect(result.discountAppliedAud).toBe(0)
    expect(result.netCapitalGainAud).toBeCloseTo(500)
  })

  it('applies losses to non-discount gains first, then discount-eligible gains, before discounting', async () => {
    transactionFindManyMock.mockResolvedValue([
      // Short-term (non-discount) gain of 100
      makeDisposal({
        id: 't1',
        quantity: 10,
        totalValue: 1100,
        fees: 0,
        date: '2026-01-01',
        entryPrice: 100,
        buyFees: 0,
        totalBuyValue: 1000,
        openDate: '2025-08-01',
      }),
      // Long-term (discount-eligible) gain of 1000
      makeDisposal({
        id: 't2',
        quantity: 10,
        totalValue: 2000,
        fees: 0,
        date: '2026-01-01',
        entryPrice: 100,
        buyFees: 0,
        totalBuyValue: 1000,
        openDate: '2020-01-01',
      }),
      // Loss of 300
      makeDisposal({
        id: 't3',
        quantity: 10,
        totalValue: 700,
        fees: 0,
        date: '2026-01-01',
        entryPrice: 100,
        buyFees: 0,
        totalBuyValue: 1000,
        openDate: '2025-08-01',
      }),
    ])

    const result = await computeCapitalGainsReport('u1', 2025, ['acc1'])

    // Loss (300) fully absorbed by the non-discount gain (100) -> remaining
    // non-discount gain = 0, remaining loss = 200 applied to discount gain.
    // Remaining discount-eligible gain = 1000 - 200 = 800, 50% discount = 400.
    expect(result.totalCapitalLossAud).toBeCloseTo(300)
    expect(result.discountAppliedAud).toBeCloseTo(400)
    expect(result.netCapitalGainAud).toBeCloseTo(400)
    expect(result.carriedForwardLossClosingAud).toBe(0)
  })

  it('carries forward a net capital loss when losses exceed gains', async () => {
    transactionFindManyMock.mockResolvedValue([
      makeDisposal({
        id: 't1',
        quantity: 10,
        totalValue: 500, // loss of 500
        fees: 0,
        date: '2026-01-01',
        entryPrice: 100,
        buyFees: 0,
        totalBuyValue: 1000,
        openDate: '2025-08-01',
      }),
    ])

    const result = await computeCapitalGainsReport('u1', 2025, ['acc1'])

    expect(result.netCapitalGainAud).toBe(0)
    expect(result.carriedForwardLossClosingAud).toBeCloseTo(500)
  })

  it('uses the prior report with the same accountsKey as the opening carried-forward loss', async () => {
    taxReportFindFirstMock.mockResolvedValue({
      carriedForwardLossClosingAud: 200,
    })
    transactionFindManyMock.mockResolvedValue([
      makeDisposal({
        id: 't1',
        quantity: 10,
        totalValue: 1300, // gain of 300 (short-term)
        fees: 0,
        date: '2026-01-01',
        entryPrice: 100,
        buyFees: 0,
        totalBuyValue: 1000,
        openDate: '2025-08-01',
      }),
    ])

    const result = await computeCapitalGainsReport('u1', 2025, ['acc1'])

    expect(result.carriedForwardLossOpeningAud).toBe(200)
    // 300 gain - 200 carried-forward loss = 100 net gain (no discount, short-term)
    expect(result.netCapitalGainAud).toBeCloseTo(100)
    expect(taxReportFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          accountsKey: 'acc1',
          financialYearStartYear: { lt: 2025 },
        }),
      })
    )
  })

  it('converts foreign-currency disposals to AUD using the resolved FX rate', async () => {
    getFxRateMock.mockResolvedValue({ rate: 1.5, source: 'RBA' })
    transactionFindManyMock.mockResolvedValue([
      makeDisposal({
        id: 't1',
        quantity: 10,
        totalValue: 200, // USD proceeds
        fees: 0,
        date: '2026-01-01',
        entryPrice: 10, // USD cost = 100
        buyFees: 0,
        totalBuyValue: 100,
        openDate: '2025-08-01',
        currency: 'USD',
      }),
    ])

    const result = await computeCapitalGainsReport('u1', 2025, ['acc1'])

    // proceedsAud = 200 * 1.5 = 300; costBaseAud = 100 * 1.5 = 150; gain = 150
    expect(result.lineItems[0].proceedsAud).toBeCloseTo(300)
    expect(result.lineItems[0].costBaseAud).toBeCloseTo(150)
    expect(result.lineItems[0].capitalGainAud).toBeCloseTo(150)
  })
})
