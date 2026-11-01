import { Router, type Request, type Response } from 'express'
import { body, param, query } from 'express-validator'
import { authenticateToken } from '../middleware/auth.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import {
  listOpeningStatements,
  saveOpeningStatement,
} from '../lib/opening-statements.js'

const router = Router()
router.use(authenticateToken)

/**
 * @swagger
 * components:
 *   schemas:
 *     OpeningStatement:
 *       type: object
 *       required: [id, accountId, version, openingDate, timezone, state, sourceFingerprint, createdAt, cashBalances, parcelCount]
 *       properties:
 *         id: { type: string }
 *         accountId: { type: string }
 *         version: { type: integer, minimum: 1 }
 *         openingDate: { type: string, format: date }
 *         timezone: { type: string, enum: [Australia/Sydney] }
 *         state: { type: string, enum: [DRAFT], description: Inactive statement; never spendable cash or confirmed accounting. }
 *         sourceFingerprint: { type: string }
 *         createdAt: { type: string, format: date-time }
 *         parcelCount: { type: integer }
 *         cashBalances:
 *           type: array
 *           items:
 *             type: object
 *             required: [currency, amount]
 *             properties:
 *               currency: { type: string }
 *               amount: { type: string, description: Explicit opening cash as a decimal string. }
 * /api/accounts/{id}/opening-statements:
 *   post:
 *     summary: Save a reviewed opening preview as an immutable inactive draft
 *     description: Saves a new revision only if the fingerprint matches the current snapshot and inputs. Same fingerprint and normalized inputs returns the existing revision. Drafts may retain reconciliation blockers; saving never creates cash postings, enables accounting or modifies trades. Negative or unrepresentable opening inventory is rejected.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [openingDate, cashBalances, sourceFingerprint]
 *             properties:
 *               openingDate: { type: string, format: date, description: End-of-day Sydney calendar date no later than today. }
 *               sourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *               cashBalances:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   required: [currency, amount]
 *                   properties:
 *                     currency: { type: string, pattern: '^[A-Z]{3}$', description: Supported unique ISO currency. }
 *                     amount: { type: string, pattern: '^(?:0|[1-9]\d{0,25})(?:\.\d{1,12})?$' }
 *     responses:
 *       200:
 *         description: New or existing inactive draft.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [created, statement]
 *                   properties:
 *                     created: { type: boolean }
 *                     statement: { $ref: '#/components/schemas/OpeningStatement' }
 *       400: { description: Invalid date, balance or fingerprint. }
 *       401: { description: Authentication required. }
 *       404: { description: Account not found or not owned. }
 *       409: { description: Stale preview, changed inputs, inactive/demo account or concurrency conflict. }
 *       422: { description: Preview exceeds limits or opening inventory cannot be saved precisely. }
 */
router.post(
  '/:id/opening-statements',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    body('openingDate').isString(),
    body('cashBalances').isArray({ min: 1, max: 20 }),
    body('sourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await saveOpeningStatement(
      req.user!.userId,
      String(req.params.id),
      req.body
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements:
 *   get:
 *     summary: List inactive opening draft revisions newest first
 *     description: Returns up to 20 revisions with explicit cash balances and parcel counts. Saved snapshots are not current account valuations. Closed accounts retain access; drafts are removed with account/user deletion.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: beforeVersion
 *         schema: { type: integer, minimum: 1 }
 *         description: Exclusive cursor from nextBeforeVersion.
 *     responses:
 *       200:
 *         description: Inactive statement revision page.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [statements, nextBeforeVersion]
 *                   properties:
 *                     statements:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/OpeningStatement' }
 *                     nextBeforeVersion: { type: integer, nullable: true }
 *       400: { description: Invalid account ID or cursor. }
 *       401: { description: Authentication required. }
 *       404: { description: Account not found or not owned. }
 */
router.get(
  '/:id/opening-statements',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    query('beforeVersion')
      .optional()
      .isInt({ min: 1, max: 2147483647 })
      .toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await listOpeningStatements(
      req.user!.userId,
      String(req.params.id),
      req.query.beforeVersion === undefined
        ? undefined
        : Number(req.query.beforeVersion)
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

export default router
