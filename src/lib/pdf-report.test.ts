import { afterEach, describe, expect, it, vi } from 'vitest'
import PDFDocument from 'pdfkit'
import { buildCapitalGainsPdf } from './pdf-report.js'
import type { CgtReportResult } from './cgt-engine.js'

function makeResult(overrides: Partial<CgtReportResult> = {}): CgtReportResult {
  return {
    financialYearStartYear: 2025,
    financialYearLabel: 'FY2025-26',
    accountsKey: 'acc1',
    lineItems: [
      {
        positionId: 'pos1',
        symbol: 'CBA',
        assetType: 'EQUITY',
        exchangeCode: 'ASX',
        currency: 'AUD',
        accountId: 'acc1',
        accountName: 'Main',
        quantity: 100,
        acquireDate: '2024-01-01',
        disposeDate: '2026-03-01',
        holdingDays: 790,
        discountEligible: true,
        proceedsForeign: 1490,
        costBaseForeign: 1020,
        proceedsAud: 1490,
        costBaseAud: 1020,
        capitalGainAud: 470,
        fxRateAcquire: 1,
        fxRateAcquireSource: 'RBA',
        fxRateDispose: 1,
        fxRateDisposeSource: 'RBA',
      },
    ],
    totalProceedsAud: 1490,
    totalCostBaseAud: 1020,
    totalCapitalGainGrossAud: 470,
    totalCapitalLossAud: 0,
    carriedForwardLossOpeningAud: 0,
    discountAppliedAud: 235,
    netCapitalGainAud: 235,
    carriedForwardLossClosingAud: 0,
    ...overrides,
  }
}

describe('buildCapitalGainsPdf', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders all report dates as dd/MM/yyyy without changing the report data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 0, 5, 12))
    const text = vi.spyOn(PDFDocument.prototype, 'text')
    const result = makeResult()
    await buildCapitalGainsPdf(result, { email: 'test@example.com' })

    const labels = text.mock.calls.map(([label]) => label)
    expect(labels).toContain('01/01/2024')
    expect(labels).toContain('01/03/2026')
    expect(labels).toContain('FY2025-26 (01/07/2025 – 30/06/2026)')
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Generated: 05\/01\/2026/),
      ])
    )
    expect(labels).not.toContain('2024-01-01')
    expect(labels).not.toContain('2026-03-01')
    expect(result.lineItems[0].acquireDate).toBe('2024-01-01')
    expect(result.lineItems[0].disposeDate).toBe('2026-03-01')
  })

  it('produces a valid, non-trivial PDF buffer', async () => {
    const buffer = await buildCapitalGainsPdf(makeResult(), {
      name: 'Bruno',
      email: 'bruno@example.com',
    })

    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.byteLength).toBeGreaterThan(500)
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-')
  })

  it('still produces a valid PDF when there are no disposals', async () => {
    const buffer = await buildCapitalGainsPdf(
      makeResult({ lineItems: [], totalProceedsAud: 0, totalCostBaseAud: 0 }),
      { name: null, email: 'bruno@example.com' }
    )

    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-')
  })
})
