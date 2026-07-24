import { Router, Request, Response } from 'express'
import { body, param } from 'express-validator'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import { computeCapitalGainsReport } from '../lib/cgt-engine.js'
import { buildCapitalGainsPdf } from '../lib/pdf-report.js'

const router = Router()
router.use(authenticateToken)

function serializeReport(report: {
  id: string
  financialYearStartYear: number
  financialYearLabel: string
  accountIds: unknown
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
 *       renders a PDF, and upserts the persisted TaxReport for that
 *       (financial year, account selection) combination.
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

    const pdfBuffer = await buildCapitalGainsPdf(result, {
      name: user?.name,
      email: user?.email ?? '',
    })
    const pdfBytes = new Uint8Array(pdfBuffer)
    const lineItemsJson = result.lineItems as unknown as Prisma.InputJsonValue

    const report = await prisma.taxReport.upsert({
      where: {
        userId_financialYearStartYear_accountsKey: {
          userId,
          financialYearStartYear,
          accountsKey: result.accountsKey,
        },
      },
      create: {
        userId,
        financialYearStartYear,
        financialYearLabel: result.financialYearLabel,
        accountIds,
        accountsKey: result.accountsKey,
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
      update: {
        generatedAt: new Date(),
        accountIds,
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
 *     responses:
 *       200:
 *         description: Report metadata (no PDF bytes/line items), newest financial year first
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const reports = await prisma.taxReport.findMany({
      where: { userId: req.user!.userId },
      orderBy: [{ financialYearStartYear: 'desc' }, { generatedAt: 'desc' }],
      select: {
        id: true,
        financialYearStartYear: true,
        financialYearLabel: true,
        accountIds: true,
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
      select: { pdfData: true, financialYearLabel: true },
    })
    if (!report) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Tax report not found' })
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="capital-gains-${report.financialYearLabel}.pdf"`
    )
    res.send(Buffer.from(report.pdfData))
  })
)

// ─── DELETE /api/tax-reports/:id ─────────────────────────────────────────────

/**
 * @swagger
 * /api/tax-reports/{id}:
 *   delete:
 *     summary: Delete a persisted tax report
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
      select: { id: true },
    })
    if (!report) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Tax report not found' })
    }

    await prisma.taxReport.delete({ where: { id: report.id } })

    res.json({ success: true, message: 'Tax report deleted' })
  })
)

export default router
