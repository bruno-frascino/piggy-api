import { Router, type Request, type Response } from 'express'
import { body, param } from 'express-validator'
import { authenticateToken } from '../middleware/auth.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import {
  correctLiveManualAcquisition,
  correctLiveManualSale,
  correctLiveImportedExecution,
  postAccountTrade,
} from '../lib/draft-cash-ledger.js'

const router = Router()
router.use(authenticateToken)

/**
 * @swagger
 * components:
 *   schemas:
 *     AccountTradeResponse:
 *       type: object
 *       required: [success, data]
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           required: [operationId, transactionId, created, replay]
 *           properties:
 *             operationId: { type: string }
 *             transactionId: { type: string }
 *             created: { type: boolean }
 *             replay:
 *               type: object
 *               required: [accountId, openingDate, funded, balances, activity, fundingIssues]
 *               properties:
 *                 accountId: { type: string }
 *                 openingDate: { type: string, format: date }
 *                 funded: { type: boolean }
 *                 balances: { type: array, items: { type: object } }
 *                 activity: { type: array, items: { type: object } }
 *                 fundingIssues: { type: array, items: { type: object } }
 * /api/accounts/{id}/trades:
 *   post:
 *     summary: Atomically post a BUY or SELL with account cash
 *     description: Available only to accounts with an explicitly confirmed opening statement and active cash ledger. Legacy account posting remains unchanged; no account is activated by this endpoint.
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
 *             required: [kind, idempotencyKey, effectiveDate, sequence, quantity, price, fees]
 *             properties:
 *               kind: { type: string, enum: [BUY, SELL] }
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer, minimum: 1 }
 *               quantity: { type: string, description: Exact positive decimal quantity. }
 *               price: { type: string, description: Exact positive decimal price. }
 *               fees: { type: string, description: Exact non-negative decimal fee. }
 *               assetId: { type: string, description: Required for BUY only. }
 *               positionId: { type: string, description: Required for SELL only. }
 *     responses:
 *       201:
 *         description: Trade, cash postings and source audit were committed atomically.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountTradeResponse' }
 *       200:
 *         description: Idempotent retry of an already committed trade.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountTradeResponse' }
 *       400:
 *         description: Invalid trade command.
 *       409:
 *         description: Account is not ledger-enabled, source history drifted, or cash sequence conflicts.
 *       422:
 *         description: Insufficient cash or unsupported account history.
 */
router.post(
  '/:id/trades',
  [
    param('id').isString().trim().notEmpty(),
    body('kind').isIn(['BUY', 'SELL']),
    body('idempotencyKey').isString().trim().notEmpty().isLength({ max: 200 }),
    body('effectiveDate').isString().isISO8601({ strict: true }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('quantity').isString(),
    body('price').isString(),
    body('fees').isString(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await postAccountTrade(
      req.user!.userId,
      req.params.id,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/trades/{transactionId}/corrections:
 *   post:
 *     summary: Correct an audited live manual sale
 *     description: >
 *       Appends an immutable correction revision for a cash-linked manual SELL.
 *       Only date, stable cash sequence, price and fees may change; quantity,
 *       source identity and imported executions are immutable. Reversal is not supported.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: transactionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idempotencyKey, expectedRevisionId, expectedSourceFingerprint, reason, effectiveDate, sequence, price, fees]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *               expectedSourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer, minimum: 1 }
 *               price: { type: string, description: Exact positive decimal sale price. }
 *               fees: { type: string, description: Exact non-negative decimal fee. }
 *     responses:
 *       201:
 *         description: Correction, audit revision and cash postings were committed atomically.
 *       200:
 *         description: Idempotent retry of an already committed correction.
 *       400:
 *         description: Invalid correction.
 *       401:
 *         description: Unauthorized.
 *       404:
 *         description: Live manual sale not found.
 *       409:
 *         description: Stale revision, source drift, reserved sequence or inconsistent cash history.
 *       422:
 *         description: Correction would leave an unsupported or insufficiently funded cash ledger.
 */
router.post(
  '/:id/trades/:transactionId/corrections',
  [
    param('id').isString().trim().notEmpty(),
    param('transactionId').isString().trim().notEmpty(),
    body('idempotencyKey').isString().trim().notEmpty().isLength({ max: 200 }),
    body('expectedRevisionId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 200 }),
    body('expectedSourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    body('reason').isString().trim().notEmpty().isLength({ max: 1000 }),
    body('effectiveDate').isISO8601({ strict: true }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('price').isString(),
    body('fees').isString(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctLiveManualSale(
      req.user!.userId,
      req.params.id,
      req.params.transactionId,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * components:
 *   schemas:
 *     LiveExecutionCorrectionResponse:
 *       type: object
 *       required: [success, data]
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           required: [operationId, revisionId, created, replay]
 *           properties:
 *             operationId: { type: string }
 *             revisionId: { type: string }
 *             created: { type: boolean }
 *             replay:
 *               type: object
 *               required: [accountId, openingDate, funded, balances, activity, fundingIssues]
 *               properties:
 *                 accountId: { type: string }
 *                 openingDate: { type: string, format: date }
 *                 funded: { type: boolean }
 *                 balances: { type: array, items: { type: object } }
 *                 activity: { type: array, items: { type: object } }
 *                 fundingIssues: { type: array, items: { type: object } }
 * /api/accounts/{id}/trades/{transactionId}/acquisition-corrections:
 *   post:
 *     summary: Correct an audited live manual acquisition
 *     description: >
 *       Appends an immutable BUY revision and reversal/replacement cash postings.
 *       Date, stable cash sequence, exact bought quantity, price and fees may change.
 *       All existing sales are preserved; the corrected acquisition must cover them
 *       and precede their dates and cash ordering. Imported executions, moves and
 *       reversal remain unsupported. No account is activated.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: transactionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idempotencyKey, expectedRevisionId, expectedSourceFingerprint, reason, effectiveDate, sequence, quantity, price, fees]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *               expectedSourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer, minimum: 1 }
 *               quantity: { type: string, description: Exact positive bought quantity, not remaining units. }
 *               price: { type: string, description: Exact positive decimal purchase price. }
 *               fees: { type: string, description: Exact non-negative decimal purchase fee. }
 *     responses:
 *       201:
 *         description: Acquisition, parcel results, audit revision and cash postings committed atomically.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LiveExecutionCorrectionResponse' }
 *       200:
 *         description: Idempotent retry of an already committed correction.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LiveExecutionCorrectionResponse' }
 *       400:
 *         description: Invalid correction or unrepresentable amount or quantity.
 *       401:
 *         description: Unauthorized.
 *       404:
 *         description: Owned live manual acquisition not found.
 *       409:
 *         description: Stale revision, source drift, reserved sequence, imported allocation or invalid acquisition/sale ordering.
 *       422:
 *         description: Correction would leave an unsupported or insufficiently funded ledger.
 */
router.post(
  '/:id/trades/:transactionId/acquisition-corrections',
  [
    param('id').isString().trim().notEmpty(),
    param('transactionId').isString().trim().notEmpty(),
    body('idempotencyKey').isString().trim().notEmpty().isLength({ max: 200 }),
    body('expectedRevisionId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 200 }),
    body('expectedSourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    body('reason').isString().trim().notEmpty().isLength({ max: 1000 }),
    body('effectiveDate').isISO8601({ strict: true }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('quantity').isString(),
    body('price').isString(),
    body('fees').isString(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctLiveManualAcquisition(
      req.user!.userId,
      req.params.id,
      req.params.transactionId,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/imported-executions/{eventId}/corrections:
 *   post:
 *     summary: Correct an audited live imported Kraken execution
 *     description: >
 *       Appends an immutable correction overlay while preserving the original Kraken
 *       event, execution quantity and existing parcel allocations. Effective date,
 *       stable cash sequence, price and fees may change. The correction is supported
 *       only when consideration, fees and all allocated parcel transactions use one
 *       currency. Cash replay, parcel recomputation, postings and the source fingerprint
 *       update commit atomically. Reversal and quantity/allocation changes are not supported.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [idempotencyKey, expectedRevisionId, expectedSourceFingerprint, reason, effectiveDate, sequence, price, fees]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *               expectedSourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer, minimum: 1, maximum: 9007199254740991 }
 *               price: { type: string, description: Exact positive execution price in the existing quote currency. }
 *               fees: { type: string, description: Exact non-negative total fees in the existing fee currency. }
 *     responses:
 *       201: { description: Imported execution, parcel results, audit revision and cash postings committed atomically. }
 *       200: { description: Idempotent retry of an already committed correction. }
 *       400: { description: Invalid correction or a date outside the confirmed review period. }
 *       401: { description: Unauthorized. }
 *       404: { description: Applied imported execution not found. }
 *       409: { description: Stale revision/source, unsupported currency allocation, or reserved cash sequence. }
 *       422: { description: Correction would leave an unsupported or insufficiently funded ledger. }
 */
router.post(
  '/:id/imported-executions/:eventId/corrections',
  [
    param('id').isString().trim().notEmpty(),
    param('eventId').isString().trim().notEmpty(),
    body('idempotencyKey').isString().trim().notEmpty().isLength({ max: 200 }),
    body('expectedRevisionId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 200 }),
    body('expectedSourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    body('reason').isString().trim().notEmpty().isLength({ max: 1000 }),
    body('effectiveDate').isISO8601({ strict: true }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('price').isString(),
    body('fees').isString(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctLiveImportedExecution(
      req.user!.userId,
      req.params.id,
      req.params.eventId,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

export default router
