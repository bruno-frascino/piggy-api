import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  userFindUniqueMock,
  taxReportFindManyMock,
  taxReportFindFirstMock,
  taxReportUpsertMock,
  taxReportDeleteMock,
  computeCapitalGainsReportMock,
  buildCapitalGainsPdfMock,
} = vi.hoisted(() => ({
  userFindUniqueMock: vi.fn(),
  taxReportFindManyMock: vi.fn(),
  taxReportFindFirstMock: vi.fn(),
  taxReportUpsertMock: vi.fn(),
  taxReportDeleteMock: vi.fn(),
  computeCapitalGainsReportMock: vi.fn(),
  buildCapitalGainsPdfMock: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    taxReport: {
      findMany: taxReportFindManyMock,
      findFirst: taxReportFindFirstMock,
      upsert: taxReportUpsertMock,
      delete: taxReportDeleteMock,
    },
  },
}))

vi.mock('../lib/cgt-engine.js', () => ({
  computeCapitalGainsReport: computeCapitalGainsReportMock,
}))

vi.mock('../lib/pdf-report.js', () => ({
  buildCapitalGainsPdf: buildCapitalGainsPdfMock,
}))

import taxReportsRouter from './tax-reports.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tax-reports', taxReportsRouter)
  return app
}

const SAMPLE_RESULT = {
  financialYearStartYear: 2025,
  financialYearLabel: 'FY2025-26',
  accountsKey: 'acc1',
  lineItems: [{ symbol: 'CBA' }],
  totalProceedsAud: 1490,
  totalCostBaseAud: 1020,
  totalCapitalGainGrossAud: 470,
  totalCapitalLossAud: 0,
  carriedForwardLossOpeningAud: 0,
  discountAppliedAud: 235,
  netCapitalGainAud: 235,
  carriedForwardLossClosingAud: 0,
}

const SAMPLE_REPORT_ROW = {
  id: 'r1',
  financialYearStartYear: 2025,
  financialYearLabel: 'FY2025-26',
  accountIds: ['acc1'],
  generatedAt: new Date('2026-07-24'),
  totalProceedsAud: 1490,
  totalCostBaseAud: 1020,
  totalCapitalGainGrossAud: 470,
  totalCapitalLossAud: 0,
  carriedForwardLossOpeningAud: 0,
  discountAppliedAud: 235,
  netCapitalGainAud: 235,
  carriedForwardLossClosingAud: 0,
  lineItems: [{ symbol: 'CBA' }],
  pdfData: Buffer.from('%PDF-fake'),
  pdfSizeBytes: 9,
}

describe('tax-reports controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userFindUniqueMock.mockResolvedValue({
      name: 'Bruno',
      email: 'bruno@example.com',
    })
    computeCapitalGainsReportMock.mockResolvedValue(SAMPLE_RESULT)
    buildCapitalGainsPdfMock.mockResolvedValue(Buffer.from('%PDF-fake'))
    taxReportUpsertMock.mockResolvedValue(SAMPLE_REPORT_ROW)
  })

  describe('POST /generate', () => {
    it('generates a report and returns serialized metadata', async () => {
      const response = await request(createApp())
        .post('/api/tax-reports/generate')
        .send({ financialYearStartYear: 2025, accountIds: ['acc1'] })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data.financialYearLabel).toBe('FY2025-26')
      expect(response.body.data.netCapitalGainAud).toBe(235)
      expect(response.body.data.pdfData).toBeUndefined()
      expect(computeCapitalGainsReportMock).toHaveBeenCalledWith('u_1', 2025, [
        'acc1',
      ])
    })

    it('returns 400 when validation fails (missing accountIds)', async () => {
      const response = await request(createApp())
        .post('/api/tax-reports/generate')
        .send({ financialYearStartYear: 2025 })

      expect(response.status).toBe(400)
    })

    it('returns 400 when the engine throws (e.g. unauthorized account)', async () => {
      computeCapitalGainsReportMock.mockRejectedValue(
        new Error('One or more selected accounts were not found')
      )

      const response = await request(createApp())
        .post('/api/tax-reports/generate')
        .send({ financialYearStartYear: 2025, accountIds: ['not-mine'] })

      expect(response.status).toBe(400)
      expect(response.body.message).toContain('not found')
    })
  })

  describe('GET /', () => {
    it('lists report metadata ordered newest-first', async () => {
      taxReportFindManyMock.mockResolvedValue([SAMPLE_REPORT_ROW])

      const response = await request(createApp()).get('/api/tax-reports')

      expect(response.status).toBe(200)
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0].pdfData).toBeUndefined()
      expect(taxReportFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u_1' },
          orderBy: [
            { financialYearStartYear: 'desc' },
            { generatedAt: 'desc' },
          ],
        })
      )
    })
  })

  describe('GET /:id', () => {
    it('returns report detail including lineItems', async () => {
      taxReportFindFirstMock.mockResolvedValue(SAMPLE_REPORT_ROW)

      const response = await request(createApp()).get('/api/tax-reports/r1')

      expect(response.status).toBe(200)
      expect(response.body.data.lineItems).toEqual([{ symbol: 'CBA' }])
    })

    it('returns 404 when not found', async () => {
      taxReportFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp()).get(
        '/api/tax-reports/missing'
      )

      expect(response.status).toBe(404)
    })
  })

  describe('GET /:id/download', () => {
    it('streams the PDF with attachment headers', async () => {
      taxReportFindFirstMock.mockResolvedValue({
        pdfData: Buffer.from('%PDF-fake'),
        financialYearLabel: 'FY2025-26',
      })

      const response = await request(createApp()).get(
        '/api/tax-reports/r1/download'
      )

      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toContain('application/pdf')
      expect(response.headers['content-disposition']).toContain(
        'capital-gains-FY2025-26.pdf'
      )
    })

    it('returns 404 when report does not exist', async () => {
      taxReportFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp()).get(
        '/api/tax-reports/missing/download'
      )

      expect(response.status).toBe(404)
    })
  })

  describe('DELETE /:id', () => {
    it('deletes an owned report', async () => {
      taxReportFindFirstMock.mockResolvedValue({ id: 'r1' })

      const response = await request(createApp()).delete('/api/tax-reports/r1')

      expect(response.status).toBe(200)
      expect(taxReportDeleteMock).toHaveBeenCalledWith({ where: { id: 'r1' } })
    })

    it('returns 404 when report does not belong to user', async () => {
      taxReportFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp()).delete('/api/tax-reports/r1')

      expect(response.status).toBe(404)
      expect(taxReportDeleteMock).not.toHaveBeenCalled()
    })
  })
})
