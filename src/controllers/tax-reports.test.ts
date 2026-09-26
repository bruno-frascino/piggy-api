import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  userFindUniqueMock,
  taxReportFindManyMock,
  taxReportFindFirstMock,
  taxReportCreateMock,
  taxReportUpdateMock,
  taxReportDeleteMock,
  positionFindManyMock,
  computeCapitalGainsReportMock,
  buildCapitalGainsPdfMock,
} = vi.hoisted(() => ({
  userFindUniqueMock: vi.fn(),
  taxReportFindManyMock: vi.fn(),
  taxReportFindFirstMock: vi.fn(),
  taxReportCreateMock: vi.fn(),
  taxReportUpdateMock: vi.fn(),
  taxReportDeleteMock: vi.fn(),
  positionFindManyMock: vi.fn(),
  computeCapitalGainsReportMock: vi.fn(),
  buildCapitalGainsPdfMock: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/prisma.js', () => {
  const prisma = {
    user: { findUnique: userFindUniqueMock },
    taxReport: {
      findMany: taxReportFindManyMock,
      findFirst: taxReportFindFirstMock,
      create: taxReportCreateMock,
      update: taxReportUpdateMock,
      delete: taxReportDeleteMock,
    },
    position: { findMany: positionFindManyMock },
    // The controller's transactions only need the same mocked delegates.
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
  }
  return { prisma }
})

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
  version: 1,
  supersededAt: null,
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
    taxReportFindFirstMock.mockResolvedValue(null)
    taxReportCreateMock.mockResolvedValue(SAMPLE_REPORT_ROW)
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
      expect(taxReportCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 1 }),
        })
      )
      expect(taxReportUpdateMock).not.toHaveBeenCalled()
    })

    it('supersedes the current revision and stores the next version', async () => {
      taxReportFindFirstMock.mockResolvedValue({
        id: 'r1',
        version: 2,
        contentHash: 'stale-hash',
      })
      taxReportCreateMock.mockResolvedValue({
        ...SAMPLE_REPORT_ROW,
        id: 'r2',
        version: 3,
      })

      const response = await request(createApp())
        .post('/api/tax-reports/generate')
        .send({ financialYearStartYear: 2025, accountIds: ['acc1'] })

      expect(response.status).toBe(200)
      expect(response.body.data.version).toBe(3)
      expect(taxReportUpdateMock).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { supersededAt: expect.any(Date) },
      })
      expect(taxReportCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 3 }),
        })
      )
    })

    it('returns the existing revision when regenerating unchanged content', async () => {
      // First generate to learn the hash the engine result produces.
      await request(createApp())
        .post('/api/tax-reports/generate')
        .send({ financialYearStartYear: 2025, accountIds: ['acc1'] })
      const storedHash = taxReportCreateMock.mock.calls[0]?.[0].data
        .contentHash as string
      vi.clearAllMocks()
      computeCapitalGainsReportMock.mockResolvedValue(SAMPLE_RESULT)
      userFindUniqueMock.mockResolvedValue({
        name: 'Bruno',
        email: 'bruno@example.com',
      })
      taxReportFindFirstMock.mockResolvedValue({
        ...SAMPLE_REPORT_ROW,
        contentHash: storedHash,
      })

      const response = await request(createApp())
        .post('/api/tax-reports/generate')
        .send({ financialYearStartYear: 2025, accountIds: ['acc1'] })

      expect(response.status).toBe(200)
      expect(response.body.data.id).toBe('r1')
      expect(taxReportCreateMock).not.toHaveBeenCalled()
      expect(taxReportUpdateMock).not.toHaveBeenCalled()
      // No PDF is rendered when nothing changed.
      expect(buildCapitalGainsPdfMock).not.toHaveBeenCalled()
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
    it('lists only current revisions by default', async () => {
      taxReportFindManyMock.mockResolvedValue([SAMPLE_REPORT_ROW])

      const response = await request(createApp()).get('/api/tax-reports')

      expect(response.status).toBe(200)
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0].pdfData).toBeUndefined()
      expect(response.body.data[0].isCurrent).toBe(true)
      expect(taxReportFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u_1', supersededAt: null },
          orderBy: [
            { financialYearStartYear: 'desc' },
            { accountsKey: 'asc' },
            { version: 'desc' },
          ],
        })
      )
    })

    it('includes superseded revisions when asked', async () => {
      taxReportFindManyMock.mockResolvedValue([SAMPLE_REPORT_ROW])

      const response = await request(createApp()).get(
        '/api/tax-reports?includeSuperseded=true'
      )

      expect(response.status).toBe(200)
      expect(taxReportFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u_1' } })
      )
    })
  })

  describe('GET /position-usage', () => {
    const REPORT_WITH_ITEMS = {
      id: 'r1',
      financialYearLabel: 'FY2025-26',
      generatedAt: new Date('2026-07-24T00:00:00.000Z'),
      lineItems: [
        { positionId: 'p_fresh' },
        { positionId: 'p_changed' },
        { positionId: 'p_changed' }, // two disposals of the same parcel
        { positionId: 'p_deleted' },
        { symbol: 'NO_POSITION_ID' },
      ],
    }

    it('flags a usage as stale when the parcel changed after the report ran', async () => {
      taxReportFindManyMock.mockResolvedValue([REPORT_WITH_ITEMS])
      positionFindManyMock.mockResolvedValue([
        {
          id: 'p_fresh',
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
          transactions: [{ updatedAt: new Date('2026-07-02T00:00:00.000Z') }],
        },
        {
          id: 'p_changed',
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
          // a later SELL edit is enough on its own
          transactions: [{ updatedAt: new Date('2026-08-30T00:00:00.000Z') }],
        },
      ])

      const response = await request(createApp()).get(
        '/api/tax-reports/position-usage'
      )

      expect(response.status).toBe(200)
      expect(response.body.data.p_fresh).toEqual([
        {
          reportId: 'r1',
          financialYearLabel: 'FY2025-26',
          generatedAt: '2026-07-24T00:00:00.000Z',
          stale: false,
        },
      ])
      expect(response.body.data.p_changed).toHaveLength(1)
      expect(response.body.data.p_changed[0].stale).toBe(true)
      // a position deleted after generation can never match the report again
      expect(response.body.data.p_deleted[0].stale).toBe(true)
      expect(positionFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: ['p_fresh', 'p_changed', 'p_deleted'] },
            userId: 'u_1',
          },
        })
      )
      expect(taxReportFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u_1', supersededAt: null },
        })
      )
    })

    it('returns an empty map and skips the position query when no reports exist', async () => {
      taxReportFindManyMock.mockResolvedValue([])

      const response = await request(createApp()).get(
        '/api/tax-reports/position-usage'
      )

      expect(response.status).toBe(200)
      expect(response.body.data).toEqual({})
      expect(positionFindManyMock).not.toHaveBeenCalled()
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
        version: 1,
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

    it('suffixes the filename for later revisions', async () => {
      taxReportFindFirstMock.mockResolvedValue({
        pdfData: Buffer.from('%PDF-fake'),
        financialYearLabel: 'FY2025-26',
        version: 3,
      })

      const response = await request(createApp()).get(
        '/api/tax-reports/r3/download'
      )

      expect(response.headers['content-disposition']).toContain(
        'capital-gains-FY2025-26-v3.pdf'
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
    it('deletes a superseded revision without promoting anything', async () => {
      taxReportFindFirstMock.mockResolvedValue({
        id: 'r1',
        userId: 'u_1',
        financialYearStartYear: 2025,
        accountsKey: 'acc1',
        supersededAt: new Date('2026-08-01'),
      })

      const response = await request(createApp()).delete('/api/tax-reports/r1')

      expect(response.status).toBe(200)
      expect(taxReportDeleteMock).toHaveBeenCalledWith({ where: { id: 'r1' } })
      expect(taxReportUpdateMock).not.toHaveBeenCalled()
    })

    it('promotes the previous revision when the current one is deleted', async () => {
      taxReportFindFirstMock
        .mockResolvedValueOnce({
          id: 'r2',
          userId: 'u_1',
          financialYearStartYear: 2025,
          accountsKey: 'acc1',
          supersededAt: null,
        })
        .mockResolvedValueOnce({ id: 'r1' })

      const response = await request(createApp()).delete('/api/tax-reports/r2')

      expect(response.status).toBe(200)
      expect(taxReportDeleteMock).toHaveBeenCalledWith({ where: { id: 'r2' } })
      expect(taxReportUpdateMock).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { supersededAt: null },
      })
    })

    it('deletes the only revision without promoting anything', async () => {
      taxReportFindFirstMock
        .mockResolvedValueOnce({
          id: 'r1',
          userId: 'u_1',
          financialYearStartYear: 2025,
          accountsKey: 'acc1',
          supersededAt: null,
        })
        .mockResolvedValueOnce(null)

      const response = await request(createApp()).delete('/api/tax-reports/r1')

      expect(response.status).toBe(200)
      expect(taxReportUpdateMock).not.toHaveBeenCalled()
    })

    it('returns 404 when report does not belong to user', async () => {
      taxReportFindFirstMock.mockResolvedValue(null)

      const response = await request(createApp()).delete('/api/tax-reports/r1')

      expect(response.status).toBe(404)
      expect(taxReportDeleteMock).not.toHaveBeenCalled()
    })
  })
})
