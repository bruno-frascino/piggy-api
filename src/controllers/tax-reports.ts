import { Router, Request, Response } from 'express'
import { body, param, query } from 'express-validator'
import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import {
  computeCapitalGainsReport,
  type CgtReportResult,
} from '../lib/cgt-engine.js'
import { buildCapitalGainsPdf } from '../lib/pdf-report.js'

const router = Router()
router.use(authenticateToken)

/** Stable fingerprint of a report's *content*, so regenerating an unchanged
 * report returns the existing revision instead of storing another PDF copy. */
function computeContentHash(result: CgtReportResult): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        totalProceedsAud: result.totalProceedsAud,
        totalCostBaseAud: result.totalCostBaseAud,
        totalCapitalGainGrossAud: result.totalCapitalGainGrossAud,
        totalCapitalLossAud: result.totalCapitalLossAud,
        carriedForwardLossOpeningAud: result.carriedForwardLossOpeningAud,
        discountAppliedAud: result.discountAppliedAud,
        netCapitalGainAud: result.netCapitalGainAud,
        carriedForwardLossClosingAud: result.carriedForwardLossClosingAud,
        lineItems: result.lineItems,
      })
    )
    .digest('hex')
}

function serializeReport(report: {
  id: string
  financialYearStartYear: number
  financialYearLabel: string
  accountIds: unknown
  version: number
  supersededAt: Date | null
  generatedAt: Date
  totalProceedsAud: unknown
  totalCostBaseAud: unknown
  totalCapitalGainGrossAud: unknown
  totalCapitalLossAud: unknown
  carriedForwardLossOpeningAud: unknown
  discountAppliedAud: unknown
  netCapitalGainAud: unknown
  carriedForwardLossClosingAud: unknown
  pdfSizeBytes: number
}) {
  return {
    id: report.id,
    financialYearStartYear: report.financialYearStartYear,
    financialYearLabel: report.financialYearLabel,
    accountIds: report.accountIds,
    version: report.version,
    supersededAt: report.supersededAt,
    isCurrent: report.supersededAt === null,
    generatedAt: report.generatedAt,
    totalProceedsAud: Number(report.totalProceedsAud),
    totalCostBaseAud: Number(report.totalCostBaseAud),
    totalCapitalGainGrossAud: Number(report.totalCapitalGainGrossAud),
    totalCapitalLossAud: Number(report.totalCapitalLossAud),
    carriedForwardLossOpeningAud: Number(report.carriedForwardLossOpeningAud),
    discountAppliedAud: Number(report.discountAppliedAud),
    netCapitalGainAud: Number(report.netCapitalGainAud),
    carriedForwardLossClosingAud: Number(report.carriedForwardLossClosingAud),
    pdfSizeBytes: report.pdfSizeBytes,
  }
}

// ─── POST /api/tax-reports/generate ──────────────────────────────────────────

/**
 * @swagger
 * /api/tax-reports/generate:
 *   post:
 *     summary: Generate (or regenerate) an ATO capital gains tax report
 *     description: >
 *       Computes a capital gains summary for the given Australian financial
 *       year across an explicit set of Trading Accounts (a "declaration"),
 *       renders a PDF, and stores it as a new revision for that
 *       (financial year, account selection) combination. Previous revisions are
 *       retained and stay downloadable so an already-lodged report is never
 *       overwritten. Regenerating with unchanged content returns the existing
 *       current revision instead of creating a new one.
 *     tags: [TaxReports]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - financialYearStartYear
 *               - accountIds
 *             properties:
 *               financialYearStartYear:
 *                 type: integer
 *                 description: e.g. 2025 for FY2025-26 (1 Jul 2025 - 30 Jun 2026)
 *               accountIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Report generated
 *       400:
 *         description: Invalid input or no accounts selected
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/generate',
  [
    body('financialYearStartYear').isInt({ min: 2000, max: 2100 }).toInt(),
    body('accountIds').isArray({ min: 1 }),
    body('accountIds.*').isString().trim(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const financialYearStartYear = Number(req.body.financialYearStartYear)
    const accountIds = (req.body.accountIds as string[]).map((id) => id.trim())

    let result
    try {
      result = await computeCapitalGainsReport(
        userId,
        financialYearStartYear,
        accountIds
      )
    } catch (err) {
      return res.status(400).json({
        error: 'Bad Request',
        message:
          err instanceof Error ? err.message : 'Failed to compute report',
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    })

    const contentHash = computeContentHash(result)

    // Unchanged regeneration must not pile up another multi-megabyte PDF.
    const current = await prisma.taxReport.findFirst({
      where: {
        userId,
        financialYearStartYear,
        accountsKey: result.accountsKey,
        supersededAt: null,
      },
      select: {
        id: true,
        version: true,
        contentHash: true,
        financialYearStartYear: true,
        financialYearLabel: true,
        accountIds: true,
        supersededAt: true,
        generatedAt: true,
        totalProceedsAud: true,
        totalCostBaseAud: true,
        totalCapitalGainGrossAud: true,
        totalCapitalLossAud: true,
        carriedForwardLossOpeningAud: true,
        discountAppliedAud: true,
        netCapitalGainAud: true,
        carriedForwardLossClosingAud: true,
        pdfSizeBytes: true,
      },
    })

    if (current && current.contentHash === contentHash) {
      return res.json({ success: true, data: serializeReport(current) })
    }

    const pdfBuffer = await buildCapitalGainsPdf(result, {
      name: user?.name,
      email: user?.email ?? '',
    })
    const pdfBytes = new Uint8Array(pdfBuffer)
    const lineItemsJson = result.lineItems as unknown as Prisma.InputJsonValue

    // Append-only: the previous revision is retained (and still downloadable)
    // so a report that was already lodged is never overwritten.
    const report = await prisma.$transaction(async (tx) => {
      if (current) {
        await tx.taxReport.update({
          where: { id: current.id },
          data: { supersededAt: new Date() },
        })
      }

      return tx.taxReport.create({
        data: {
          userId,
          financialYearStartYear,
          financialYearLabel: result.financialYearLabel,
          accountIds,
          accountsKey: result.accountsKey,
          version: (current?.version ?? 0) + 1,
          contentHash,
          totalProceedsAud: result.totalProceedsAud,
          totalCostBaseAud: result.totalCostBaseAud,
          totalCapitalGainGrossAud: result.totalCapitalGainGrossAud,
          totalCapitalLossAud: result.totalCapitalLossAud,
          carriedForwardLossOpeningAud: result.carriedForwardLossOpeningAud,
          discountAppliedAud: result.discountAppliedAud,
          netCapitalGainAud: result.netCapitalGainAud,
          carriedForwardLossClosingAud: result.carriedForwardLossClosingAud,
          lineItems: lineItemsJson,
          pdfData: pdfBytes,
          pdfSizeBytes: pdfBuffer.byteLength,
        },
      })
    })

    res.json({ success: true, data: serializeReport(report) })
  })
)

// ─── GET /api/tax-reports ─────────────────────────────────────────────────────

/**
 * @swagger
 * /api/tax-reports:
 *   get:
 *     summary: List generated capital gains tax reports for the authenticated user
 *     tags: [TaxReports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: includeSuperseded
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *         description: Include earlier revisions that have been superseded by a regeneration
 *     responses:
 *       200:
 *         description: Report metadata (no PDF bytes/line items), newest financial year first
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  [
    query('includeSuperseded').optional().isIn(['true', 'false']),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const includeSuperseded = req.query.includeSuperseded === 'true'
    const reports = await prisma.taxReport.findMany({
      where: {
        userId: req.user!.userId,
        ...(includeSuperseded ? {} : { supersededAt: null }),
      },
      orderBy: [
        { financialYearStartYear: 'desc' },
        { accountsKey: 'asc' },
        { version: 'desc' },
      ],
      select: {
        id: true,
        financialYearStartYear: true,
        financialYearLabel: true,
        accountIds: true,
        version: true,
        supersededAt: true,
        generatedAt: true,
        totalProceedsAud: true,
        totalCostBaseAud: true,
        totalCapitalGainGrossAud: true,
        totalCapitalLossAud: true,
        carriedForwardLossOpeningAud: true,
        discountAppliedAud: true,
        netCapitalGainAud: true,
        carriedForwardLossClosingAud: true,
        pdfSizeBytes: true,
      },
    })

    res.json({ success: true, data: reports.map(serializeReport) })
  })
)

// ─── GET /api/tax-reports/position-usage ─────────────────────────────────────

/**
 * @swagger
 * /api/tax-reports/position-usage:
 *   get:
 *     summary: Map each position to the generated tax reports that already include it
 *     description: >
 *       Derived from each report's stored line items — no denormalised flag is kept.
 *       A usage entry is `stale` when the position or any of its transactions was
 *       modified after the report was generated, meaning the PDF no longer matches
 *       the underlying data and should be regenerated.
 *     tags: [TaxReports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Position id keyed map of report usages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   additionalProperties:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         reportId:
 *                           type: string
 *                         financialYearLabel:
 *                           type: string
 *                         generatedAt:
 *                           type: string
 *                           format: date-time
 *                         stale:
 *                           type: boolean
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/position-usage',
  asyncHandler(async (req: Request, res: Response) => {
    const reports = await prisma.taxReport.findMany({
      // Superseded revisions describe a report the user already replaced, so
      // flagging their line items as stale would be noise.
      where: { userId: req.user!.userId, supersededAt: null },
      orderBy: [{ financialYearStartYear: 'desc' }],
      // Never select pdfData here — it is a multi-megabyte Bytes column.
      select: {
        id: true,
        financialYearLabel: true,
        generatedAt: true,
        lineItems: true,
      },
    })

    const positionIdsByReport = reports.map((report) => {
      const items = Array.isArray(report.lineItems) ? report.lineItems : []
      const positionIds = new Set<string>()
      for (const item of items) {
        if (
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          typeof item.positionId === 'string'
        ) {
          positionIds.add(item.positionId)
        }
      }
      return { report, positionIds }
    })

    const allPositionIds = [
      ...new Set(
        positionIdsByReport.flatMap(({ positionIds }) => [...positionIds])
      ),
    ]

    const positions =
      allPositionIds.length > 0
        ? await prisma.position.findMany({
            where: { id: { in: allPositionIds }, userId: req.user!.userId },
            select: {
              id: true,
              updatedAt: true,
              transactions: { select: { updatedAt: true } },
            },
          })
        : []

    const lastChangedAt = new Map<string, number>(
      positions.map((position) => [
        position.id,
        Math.max(
          position.updatedAt.getTime(),
          ...position.transactions.map((tx) => tx.updatedAt.getTime())
        ),
      ])
    )

    const usage: Record<
      string,
      {
        reportId: string
        financialYearLabel: string
        generatedAt: Date
        stale: boolean
      }[]
    > = {}

    for (const { report, positionIds } of positionIdsByReport) {
      for (const positionId of positionIds) {
        const changedAt = lastChangedAt.get(positionId)
        usage[positionId] ??= []
        usage[positionId].push({
          reportId: report.id,
          financialYearLabel: report.financialYearLabel,
          generatedAt: report.generatedAt,
          // A position missing from the lookup was deleted after the report ran.
          stale:
            changedAt === undefined || changedAt > report.generatedAt.getTime(),
        })
      }
    }

    res.json({ success: true, data: usage })
  })
)

// ─── GET /api/tax-reports/:id ─────────────────────────────────────────────────

/**
 * @swagger
 * /api/tax-reports/{id}:
 *   get:
 *     summary: Get a single tax report's metadata and per-disposal line items
 *     tags: [TaxReports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Report detail including lineItems
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Report not found
 */
router.get(
  '/:id',
  [param('id').isString(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const report = await prisma.taxReport.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    })
    if (!report) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Tax report not found' })
    }

    res.json({
      success: true,
      data: { ...serializeReport(report), lineItems: report.lineItems },
    })
  })
)

// ─── GET /api/tax-reports/:id/download ───────────────────────────────────────

/**
 * @swagger
 * /api/tax-reports/{id}/download:
 *   get:
 *     summary: Download the persisted PDF for a tax report
 *     tags: [TaxReports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: PDF file stream
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Report not found
 */
router.get(
  '/:id/download',
  [param('id').isString(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const report = await prisma.taxReport.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: { pdfData: true, financialYearLabel: true, version: true },
    })
    if (!report) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Tax report not found' })
    }

    const suffix = report.version > 1 ? `-v${report.version}` : ''
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="capital-gains-${report.financialYearLabel}${suffix}.pdf"`
    )
    res.send(Buffer.from(report.pdfData))
  })
)

// ─── DELETE /api/tax-reports/:id ─────────────────────────────────────────────

/**
 * @swagger
 * /api/tax-reports/{id}:
 *   delete:
 *     summary: Delete a persisted tax report revision
 *     description: >
 *       Deleting the current revision promotes the most recent remaining
 *       revision back to current, so the carried-forward loss chain stays intact.
 *     tags: [TaxReports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Report deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Report not found
 */
router.delete(
  '/:id',
  [param('id').isString(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const report = await prisma.taxReport.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: {
        id: true,
        userId: true,
        financialYearStartYear: true,
        accountsKey: true,
        supersededAt: true,
      },
    })
    if (!report) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Tax report not found' })
    }

    await prisma.$transaction(async (tx) => {
      await tx.taxReport.delete({ where: { id: report.id } })

      if (report.supersededAt !== null) return

      const previous = await tx.taxReport.findFirst({
        where: {
          userId: report.userId,
          financialYearStartYear: report.financialYearStartYear,
          accountsKey: report.accountsKey,
        },
        orderBy: { version: 'desc' },
        select: { id: true },
      })

      if (previous) {
        await tx.taxReport.update({
          where: { id: previous.id },
          data: { supersededAt: null },
        })
      }
    })

    res.json({ success: true, message: 'Tax report deleted' })
  })
)

export default router
