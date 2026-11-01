import express, { Router, Request, Response } from 'express'
import { body, param, query } from 'express-validator'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import {
  ImportError,
  commitBatch,
  createImportBatch,
  discardBatch,
  planBatch,
  saveResolution,
} from '../lib/imports/service.js'
import type { EventResolution } from '../lib/imports/types.js'

const router = Router()
router.use(authenticateToken)

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: Request) =>
    req.user?.userId ?? ipKeyGenerator(req.ip ?? ''),
  message: {
    error: 'Too Many Requests',
    message: 'Too many imports. Please try again later.',
  },
})

/** Exchange CSVs routinely exceed the global 100 kb JSON limit. */
const largeJson = express.json({ limit: '10mb' })

function sendImportError(res: Response, error: unknown): boolean {
  if (error instanceof ImportError) {
    res.status(error.status).json({
      error: error.name,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    })
    return true
  }
  return false
}

/**
 * @swagger
 * /api/imports:
 *   post:
 *     summary: Upload exchange CSV exports and build an import plan
 *     description: >
 *       Kraken only for now — both `trades` and `ledgers` CSVs are required. Events already
 *       uploaded (same exchange id, including pending review) are counted as duplicates and
 *       not stored again. `existingBatches` identifies the previous imports, their status,
 *       target account and matching event count so users can resume review. Nothing
 *       touches positions until the batch is committed. The target account must be an
 *       active, non-demo account owned by the user. Deferred reward reattachment is
 *       account-locked and fails with 409 if the event was processed meanwhile.
 *       Rate limited to 10 uploads per hour.
 *     tags: [Imports]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source, accountId, files]
 *             properties:
 *               source:
 *                 type: string
 *                 enum: [KRAKEN]
 *               accountId:
 *                 type: string
 *               files:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [kind, fileName, content]
 *                   properties:
 *                     kind:
 *                       type: string
 *                       enum: [trades, ledgers]
 *                     fileName:
 *                       type: string
 *                     content:
 *                       type: string
 *                       description: Raw CSV text
 *     responses:
 *       201:
 *         description: >
 *           Batch created. `data.batch` is null when no new events need storing.
 *           Duplicate events may still need review and commit; they do not prove positions exist.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     batch:
 *                       type: object
 *                       nullable: true
 *                       additionalProperties: true
 *                     plan:
 *                       type: object
 *                       nullable: true
 *                       additionalProperties: true
 *                     duplicates:
 *                       type: integer
 *                     warnings:
 *                       type: array
 *                       items:
 *                         type: string
 *                     eventCounts:
 *                       type: object
 *                       additionalProperties:
 *                         type: integer
 *                     existingBatches:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [id, accountId, accountName, status, eventCount]
 *                         properties:
 *                           id:
 *                             type: string
 *                           accountId:
 *                             type: string
 *                           accountName:
 *                             type: string
 *                           status:
 *                             type: string
 *                             enum: [PENDING_REVIEW, PARTIALLY_APPLIED, COMMITTED, DISCARDED, FAILED]
 *                           eventCount:
 *                             type: integer
 *       400:
 *         description: Validation error, missing file or unrecognised CSV format
 *       404:
 *         description: Account not found
 *       413:
 *         description: Upload larger than 10 MB
 *       409:
 *         description: Deferred events changed during upload; refresh the existing import
 *       429:
 *         description: Too many uploads
 */
router.post(
  '/',
  uploadLimiter,
  largeJson,
  [
    body('source').isIn(['KRAKEN']),
    body('accountId').isString().trim().notEmpty(),
    body('files').isArray({ min: 1, max: 4 }),
    body('files.*.kind').isIn(['trades', 'ledgers']),
    body('files.*.fileName').isString().trim().isLength({ min: 1, max: 255 }),
    body('files.*.content').isString().notEmpty(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const { source, accountId, files } = req.body

    const account = await prisma.tradingAccount.findFirst({
      where: { id: accountId, userId },
    })
    if (!account) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'Trading account not found' })
    }
    if (account.isDemo || account.status !== 'ACTIVE') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Imports need an active, non-demo trading account',
      })
    }

    try {
      const result = await createImportBatch({
        userId,
        accountId,
        source,
        files,
      })
      if (!result.batchId) {
        return res.status(201).json({
          success: true,
          data: {
            batch: null,
            plan: null,
            duplicates: result.duplicates,
            existingBatches: result.existingBatches,
            warnings: result.warnings,
          },
        })
      }
      const planned = await planBatch(result.batchId, userId)
      return res.status(201).json({
        success: true,
        data: {
          batch: planned.batch,
          plan: planned.plan,
          eventCounts: planned.eventCounts,
          duplicates: result.duplicates,
          existingBatches: result.existingBatches,
          warnings: result.warnings,
        },
      })
    } catch (error) {
      if (sendImportError(res, error)) return
      throw error
    }
  })
)

/**
 * @swagger
 * /api/imports:
 *   get:
 *     summary: List the user's import batches
 *     tags: [Imports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Batches (newest first) with event counts by status
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId
    const page = Number(req.query.page ?? 1)
    const limit = Number(req.query.limit ?? 20)

    const [batches, total] = await Promise.all([
      prisma.importBatch.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.importBatch.count({ where: { userId } }),
    ])
    const grouped = await prisma.importedEvent.groupBy({
      by: ['batchId', 'status'],
      where: { userId, batchId: { in: batches.map((b) => b.id) } },
      _count: { _all: true },
    })

    const data = batches.map((batch) => ({
      ...batch,
      eventCounts: Object.fromEntries(
        grouped
          .filter((g) => g.batchId === batch.id)
          .map((g) => [g.status, g._count._all])
      ),
    }))
    res.json({ success: true, data, pagination: { page, limit, total } })
  })
)

/**
 * @swagger
 * /api/imports/{id}:
 *   get:
 *     summary: Get a batch with its full, freshly computed plan
 *     description: >
 *       The plan lists new positions, sells with suggested (FIFO) allocations and eligible
 *       parcels, staking months (applied, dust, deferred), unsupported events, blocking
 *       issues and the ledger reconciliation.
 *     tags: [Imports]
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
 *         description: Batch and plan
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Batch not found
 */
router.get(
  '/:id',
  [param('id').isString().trim().notEmpty(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const planned = await planBatch(req.params.id as string, req.user!.userId)
    res.json({
      success: true,
      data: {
        batch: planned.batch,
        plan: planned.plan,
        eventCounts: planned.eventCounts,
      },
    })
  })
)

/**
 * @swagger
 * /api/imports/{id}/events/{eventId}:
 *   patch:
 *     summary: Save the user's resolution for one event
 *     description: >
 *       Skip the event, replace a sell's allocation (specific identification), override the
 *       close reason, or enter the AUD value of a staking reward. Returns the updated plan.
 *     tags: [Imports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               skip:
 *                 type: boolean
 *               allocations:
 *                 type: array
 *                 nullable: true
 *                 description: Send null to clear the override and restore the FIFO suggestion
 *                 items:
 *                   type: object
 *                   required: [positionRef, quantity]
 *                   properties:
 *                     positionRef:
 *                       type: string
 *                     quantity:
 *                       type: string
 *               closeReason:
 *                 type: string
 *                 nullable: true
 *                 enum: [STOP_LOSS, TARGET, MANUAL, OTHER]
 *               fmvAud:
 *                 type: string
 *     responses:
 *       200:
 *         description: Updated plan
 *       400:
 *         description: Validation error
 *       404:
 *         description: Batch or event not found
 *       409:
 *         description: Event already processed or batch discarded while waiting for the account lock
 */
router.patch(
  '/:id/events/:eventId',
  [
    param('id').isString().trim().notEmpty(),
    param('eventId').isString().trim().notEmpty(),
    body('skip').optional().isBoolean().toBoolean(),
    body('allocations').optional({ nullable: true }).isArray({ min: 1 }),
    body('allocations.*.positionRef').isString().trim().notEmpty(),
    body('allocations.*.quantity').isDecimal({ decimal_digits: '0,12' }),
    body('closeReason')
      .optional({ nullable: true })
      .isIn(['STOP_LOSS', 'TARGET', 'MANUAL', 'OTHER']),
    body('fmvAud').optional().isDecimal({ decimal_digits: '0,8' }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const resolution: EventResolution = {}
    if (req.body.skip !== undefined) resolution.skip = req.body.skip
    // null clears a previous override, restoring the FIFO suggestion
    if ('allocations' in req.body) {
      resolution.allocations = req.body.allocations ?? undefined
    }
    if ('closeReason' in req.body) resolution.closeReason = req.body.closeReason
    if (req.body.fmvAud !== undefined) resolution.fmvAud = req.body.fmvAud

    try {
      const planned = await saveResolution(
        req.params.id as string,
        req.params.eventId as string,
        req.user!.userId,
        resolution
      )
      res.json({
        success: true,
        data: {
          batch: planned.batch,
          plan: planned.plan,
          eventCounts: planned.eventCounts,
        },
      })
    } catch (error) {
      if (sendImportError(res, error)) return
      throw error
    }
  })
)

/**
 * @swagger
 * /api/imports/{id}/commit:
 *   post:
 *     summary: Apply the plan — create positions and SELL transactions
 *     description: >
 *       Without `eventIds`, applies the whole plan and returns 409 while blocking issues
 *       remain. With `eventIds`, applies only those events and returns 409 if an earlier
 *       event of the same asset is unresolved or not included. Runs in one database
 *       transaction, in chronological order. Locks the owned account, rechecks that it is
 *       active and non-demo, and verifies that events and eligible holdings still match
 *       the prepared plan before any trade writes. Concurrent changes return 409 and
 *       require reviewing a refreshed plan; the import is not silently reallocated.
 *       Parcel creation, allocated SELLs, recomputed results and event links commit
 *       or roll back together. No live cash postings or opening activation are performed.
 *     tags: [Imports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               eventIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Created position ids and applied event count
 *       400:
 *         description: Validation error or target account is no longer active and non-demo
 *       404:
 *         description: Batch not found
 *       409:
 *         description: Blocking issues, chronology violation, discarded batch or concurrent event/holdings changes
 */
router.post(
  '/:id/commit',
  [
    param('id').isString().trim().notEmpty(),
    body('eventIds').optional().isArray({ min: 1 }),
    body('eventIds.*').isString().trim().notEmpty(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await commitBatch(
        req.params.id as string,
        req.user!.userId,
        req.body?.eventIds
      )
      res.json({ success: true, data: result })
    } catch (error) {
      if (sendImportError(res, error)) return
      throw error
    }
  })
)

/**
 * @swagger
 * /api/imports/{id}:
 *   delete:
 *     summary: Discard a batch and its unapplied events
 *     description: Positions already created by the batch are kept.
 *     tags: [Imports]
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
 *         description: Batch discarded
 *       404:
 *         description: Batch not found
 */
router.delete(
  '/:id',
  [param('id').isString().trim().notEmpty(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    await discardBatch(req.params.id as string, req.user!.userId)
    res.json({ success: true })
  })
)

export default router
