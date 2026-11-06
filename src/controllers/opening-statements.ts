import { Router, type Request, type Response } from 'express'
import { body, param, query } from 'express-validator'
import { authenticateToken } from '../middleware/auth.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import {
  parseSaleCorrection,
  parseAcquisitionCorrection,
} from '../lib/execution-correction.js'
import {
  listOpeningStatements,
  saveOpeningStatement,
} from '../lib/opening-statements.js'
import {
  correctDraftReconciliationCashOperation,
  correctDraftImportedExecutionCash,
  reconcileDraftOpening,
  recordDraftCashEvidence,
  saveDraftReconciliationCashOperation,
  saveDraftImportedExecutionCash,
  saveDraftManualExecutionCash,
  correctDraftRecordedSale,
  correctDraftRecordedAcquisition,
  previewDraftCashEvidence,
} from '../lib/draft-cash-ledger.js'

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

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/reconciliation:
 *   get:
 *     summary: Read-only reconciliation report for an inactive opening draft
 *     description: Compares reviewed opening inventory, current live source records, proposed draft cash/trades, recorded cash evidence, linked execution identities and manual/Kraken cash-staging candidates. Statement balances are user-attested, not independently verified. This endpoint never activates accounting or changes financial records. Reconciliation is bounded to 10000 imported executions and 50000 transactions.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: statementId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Read-only draft reconciliation including cash evidence/variances, source savedFingerprint/acceptedFingerprint/currentFingerprint/correctionCount/changed, cash-operation currentRevisionId/capital cash/revisions (revisionId, reason, replacement boolean, nullable executionAudit containing number, previousFingerprint, nextFingerprint, reviewed input and before/after transaction snapshots; acquisition audits have kind BUY and input quantity, historical sale audits are untagged), effective or reversed sources, imported execution eligibility with duplicate transaction-link detection and cashManualExecutions (transactionId, positionId, kind, quantity, effectiveDate, occurredAt, currency, price, grossValue, fee, stageable, reason, operationId). Audit snapshots include transactionId, positionId, ISO date, quantity, price, totalValue, fees and currency. Manual eligibility excludes broker-linked allocations, imported/short parcels, unsupported money, boundary/future dates, stale snapshots, unavailable accounts and incompatible opening-sale proposals.' }
 *       401: { description: Authentication required. }
 *       404: { description: Account or opening statement not found. }
 *       409: { description: Stored draft audit history is inconsistent. }
 *       422: { description: Reconciliation exceeds bounded processing limits, including 10000 imported executions. }
 */
router.get(
  '/:id/opening-statements/:statementId/reconciliation',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await reconcileDraftOpening(
      req.user!.userId,
      String(req.params.statementId),
      String(req.params.id)
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/cash-evidence:
 *   post:
 *     summary: Record an immutable, user-attested statement cash snapshot
 *     description: Requires every tracked currency and a reasoned decision for each exact cash difference. Decisions record review only; they do not adjust cash or clear a variance. A later dated deposit/withdrawal must make replay match. Not external verification or accounting activation.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: statementId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idempotencyKey, asOfDate, source, reference, attested, cashBalances, decisions]
 *             properties:
 *               idempotencyKey: { type: string, maxLength: 200 }
 *               asOfDate: { type: string, format: date }
 *               source: { type: string, maxLength: 120, description: Bank/broker statement issuer. }
 *               reference: { type: string, maxLength: 200, description: Statement number or user-entered reference; never an uploaded document. }
 *               attested: { type: boolean, enum: [true] }
 *               cashBalances: { type: array, minItems: 1, maxItems: 20, items: { type: object, required: [currency, amount], properties: { currency: { type: string }, amount: { type: string } } } }
 *               decisions: { type: array, items: { type: object, required: [currency, reason, note], properties: { currency: { type: string }, reason: { type: string, enum: [UNRECORDED_OPERATION, TIMING_DIFFERENCE, SOURCE_CORRECTION_REQUIRED, OTHER] }, note: { type: string, maxLength: 1000 } } } }
 *     responses:
 *       200: { description: Immutable evidence snapshot and exact dated cash replay comparison. }
 *       400: { description: Invalid evidence, attestation or discrepancy decisions. }
 *       401: { description: Authentication required. }
 *       404: { description: Account or opening statement not found. }
 *       409: { description: Idempotency conflict or stale opening source. }
 */
router.post(
  '/:id/opening-statements/:statementId/cash-evidence',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    body().isObject(),
    body('idempotencyKey').isString().trim().isLength({ min: 1, max: 200 }),
    body('asOfDate').isString().isISO8601({ strict: true }),
    body('source').isString().trim().isLength({ min: 1, max: 120 }),
    body('reference').isString().trim().isLength({ min: 1, max: 200 }),
    body('attested').equals('true'),
    body('cashBalances').isArray({ min: 1, max: 20 }),
    body('decisions').isArray({ max: 20 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await recordDraftCashEvidence(
      req.user!.userId,
      String(req.params.statementId),
      req.body,
      String(req.params.id)
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/cash-evidence/preview:
 *   post:
 *     summary: Preview exact statement-date cash variances without saving evidence
 *     description: Calculates replay and signed per-currency differences. It creates no evidence, decisions, postings or other records. Statement balances remain user-entered and attested.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: statementId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [idempotencyKey, asOfDate, source, reference, attested, cashBalances, decisions] }
 *     responses:
 *       200: { description: Exact statement-date cash replay and variances. }
 *       400: { description: Invalid evidence or incomplete currency coverage. }
 *       401: { description: Authentication required. }
 *       404: { description: Account or statement not found. }
 *       422: { description: Replay exceeds supported limits. }
 */
router.post(
  '/:id/opening-statements/:statementId/cash-evidence/preview',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    body().isObject(),
    body('idempotencyKey').isString().trim().isLength({ min: 1, max: 200 }),
    body('asOfDate').isString().isISO8601({ strict: true }),
    body('source').isString().trim().isLength({ min: 1, max: 120 }),
    body('reference').isString().trim().isLength({ min: 1, max: 200 }),
    body('attested').equals('true'),
    body('cashBalances').isArray({ min: 1, max: 20 }),
    body('decisions').isArray({ max: 20 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await previewDraftCashEvidence(
      req.user!.userId,
      String(req.params.statementId),
      req.body,
      String(req.params.id)
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/cash-operations:
 *   post:
 *     summary: Stage a sourced dated deposit or withdrawal in an inactive draft
 *     description: A cash operation must describe an actual external cash movement and include an explicit effective date, stable sequence and source reference. It is not a balancing adjustment. Historical replay rejects spending before recorded funding. Draft postings never affect live cash or holdings.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: statementId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idempotencyKey, effectiveDate, sequence, kind, currency, amount, sourceReference]
 *             properties:
 *               idempotencyKey: { type: string, maxLength: 200 }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer, minimum: 1 }
 *               kind: { type: string, enum: [DEPOSIT, WITHDRAWAL] }
 *               currency: { type: string }
 *               amount: { type: string, description: Positive exact decimal amount. }
 *               sourceReference: { type: string, maxLength: 200, description: Bank/broker transfer reference. }
 *     responses:
 *       200: { description: Dated inactive cash operation and replay. }
 *       400: { description: Invalid cash operation. }
 *       401: { description: Authentication required. }
 *       404: { description: Account or opening statement not found. }
 *       409: { description: Duplicate source, order or stale account state. }
 *       422: { description: Insufficient dated cash or replay limit exceeded. }
 */
router.post(
  '/:id/opening-statements/:statementId/cash-operations',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    body().isObject(),
    body('idempotencyKey').isString().trim().isLength({ min: 1, max: 200 }),
    body('effectiveDate').isString().isISO8601({ strict: true }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }).toInt(),
    body('kind').isIn(['DEPOSIT', 'WITHDRAWAL']),
    body('currency')
      .isString()
      .matches(/^[A-Z]{3}$/),
    body('amount').isString(),
    body('sourceReference').isString().trim().isLength({ min: 1, max: 200 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await saveDraftReconciliationCashOperation(
      req.user!.userId,
      String(req.params.statementId),
      req.body,
      String(req.params.id)
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/import-events/{eventId}/cash-operation:
 *   post:
 *     summary: Stage cash from an applied Kraken execution in an inactive draft
 *     description: Uses execution amounts and transaction links from the persisted applied import event; callers can supply only its stable sequence for the execution date. The event must belong to this account and match its recorded transaction links. Draft postings never affect live cash or holdings.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: statementId
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
 *             required: [sequence]
 *             properties:
 *               sequence: { type: integer, minimum: 1, description: Explicit stable order among operations on the same date; no ordering is inferred. }
 *     responses:
 *       200: { description: Imported execution cash staged in the inactive draft with replay. }
 *       400: { description: Invalid sequence or unsupported execution currency. }
 *       401: { description: Authentication required. }
 *       404: { description: Account, statement or applied execution not found. }
 *       409: { description: Duplicate source, inconsistent transaction link, or stale account state. }
 *       422: { description: Insufficient dated cash or replay limit exceeded. }
 */
router.post(
  '/:id/opening-statements/:statementId/import-events/:eventId/cash-operation',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    param('eventId').isString().trim().isLength({ min: 1, max: 100 }),
    body().isObject(),
    body().custom((value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => key !== 'sequence')
      )
        throw new Error('Only sequence is accepted for imported cash staging')
      return true
    }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }).toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await saveDraftImportedExecutionCash(
      req.user!.userId,
      String(req.params.id),
      String(req.params.statementId),
      String(req.params.eventId),
      req.body.sequence
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/cash-operations/{operationId}/corrections:
 *   post:
 *     summary: Correct or reverse an inactive manual deposit or withdrawal
 *     description: Appends immutable reversal/replacement history with a required audit reason. Currency, kind and source identity are retained from the original entry. Supply replacement null for a terminal reversal. The expected revision prevents lost updates; identical retries return the saved correction. Dated replay rejects downstream funding gaps. No live balances or holdings change.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: statementId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: operationId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [idempotencyKey, expectedRevisionId, reason, replacement]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200, description: Current revision ID from reconciliation, or original operation ID if never corrected. }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               replacement:
 *                 type: object
 *                 nullable: true
 *                 additionalProperties: false
 *                 required: [effectiveDate, sequence, amount]
 *                 properties:
 *                   effectiveDate: { type: string, format: date }
 *                   sequence: { type: integer, minimum: 1, maximum: 9007199254740991 }
 *                   amount: { type: string, description: Positive exact decimal amount in the original currency. }
 *     responses:
 *       200: { description: Inactive correction with operationId, revisionId, state DRAFT, created, replay and proposed parcels. }
 *       400: { description: Invalid correction fields. }
 *       401: { description: Authentication required. }
 *       404: { description: Account, opening statement or operation not found. }
 *       409: { description: Stale revision/source, incompatible operation, or duplicate retry content. }
 *       422: { description: Historical funding deficit or replay limit exceeded. }
 */
router.post(
  '/:id/opening-statements/:statementId/cash-operations/:operationId/corrections',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    param('operationId').isString().trim().isLength({ min: 1, max: 100 }),
    body().isObject(),
    body('idempotencyKey').isString().isLength({ min: 1, max: 200 }),
    body('expectedRevisionId').isString().isLength({ min: 1, max: 200 }),
    body('reason').isString().isLength({ min: 1, max: 1000 }),
    body('replacement').custom((value: unknown) => {
      if (
        value !== null &&
        (!value || typeof value !== 'object' || Array.isArray(value))
      )
        throw new Error('Supply replacement fields or null for reversal')
      return true
    }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctDraftReconciliationCashOperation(
      req.user!.userId,
      String(req.params.id),
      String(req.params.statementId),
      String(req.params.operationId),
      req.body
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/imported-cash-operations/{operationId}/corrections:
 *   post:
 *     summary: Correct the stable intraday sequence of staged Kraken execution cash
 *     description: Appends an audited sequence-only revision after revalidating the persisted applied execution and all transaction links under the account lock. Date, amounts, fees, source and transaction identities cannot change. Cash-only reversals are not supported. Expected revision and idempotency protect concurrent edits and retries. Full dated replay must remain funded. No live holdings or balances change.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: statementId, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [idempotencyKey, expectedRevisionId, reason, sequence]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               sequence: { type: integer, minimum: 1, maximum: 9007199254740991 }
 *     responses:
 *       200: { description: Inactive correction with operationId, revisionId, state DRAFT, created, replay and proposed parcels. }
 *       400: { description: Invalid sequence or unsupported correction fields. }
 *       401: { description: Authentication required. }
 *       404: { description: Owned account, statement or operation not found. }
 *       409: { description: Changed execution/source/revision, occupied sequence, incompatible operation or retry content. }
 *       422: { description: Dated funding deficit or replay limit exceeded. }
 */
router.post(
  '/:id/opening-statements/:statementId/imported-cash-operations/:operationId/corrections',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    param('operationId').isString().trim().isLength({ min: 1, max: 100 }),
    body().isObject(),
    body().custom((value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) =>
            ![
              'idempotencyKey',
              'expectedRevisionId',
              'reason',
              'sequence',
            ].includes(key)
        )
      )
        throw new Error('Only sequence and audit fields are accepted')
      return true
    }),
    body('idempotencyKey').isString().isLength({ min: 1, max: 200 }),
    body('expectedRevisionId').isString().isLength({ min: 1, max: 200 }),
    body('reason').isString().isLength({ min: 1, max: 1000 }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }).toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctDraftImportedExecutionCash(
      req.user!.userId,
      String(req.params.id),
      String(req.params.statementId),
      String(req.params.operationId),
      req.body
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/transactions/{transactionId}/cash-operation:
 *   post:
 *     summary: Stage cash from a recorded manual BUY or SELL in an inactive draft
 *     description: Accepts only an explicit intraday sequence. Date, currency, gross amount and fees come from the owned manual long parcel transaction and are revalidated under the account lock. Broker-linked allocations and imported parcels require their source-aware workflow. No live trades, balances or tax records change.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: statementId, required: true, schema: { type: string } }
 *       - { in: path, name: transactionId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [sequence]
 *             properties:
 *               sequence: { type: integer, minimum: 1, maximum: 9007199254740991 }
 *     responses:
 *       200: { description: Draft operationId, state DRAFT, created flag and dated cash replay. Identical retries reuse the stored identity. }
 *       400: { description: Invalid sequence or unsupported execution values. }
 *       401: { description: Authentication required. }
 *       404: { description: Owned manual transaction or opening statement not found. }
 *       409: { description: Changed source, duplicate transaction/source, occupied order or incompatible scenario. }
 *       422: { description: Dated funding deficit, boundary violation or replay limit exceeded. }
 */
router.post(
  '/:id/opening-statements/:statementId/transactions/:transactionId/cash-operation',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    param('transactionId').isString().trim().isLength({ min: 1, max: 100 }),
    body().isObject(),
    body().custom((value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => key !== 'sequence')
      )
        throw new Error(
          'Only sequence is accepted for manual execution cash staging'
        )
      return true
    }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }).toInt(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await saveDraftManualExecutionCash(
      req.user!.userId,
      String(req.params.id),
      String(req.params.statementId),
      String(req.params.transactionId),
      req.body.sequence
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/cash-operations/{operationId}/sale-corrections:
 *   post:
 *     summary: Correct a recorded manual sale and its draft cash atomically
 *     description: >
 *       Explicitly changes the live manual SELL date, price and fees, recomputes parcel
 *       totals, and appends exact cash reversal/replacement postings with immutable before/after
 *       trade snapshots and source fingerprint continuation. Quantity, parcel, instrument,
 *       currency and source identity cannot change. Imported sources and cash-only reversal
 *       are unsupported. Gross consideration is quantity times price rounded half-up to the
 *       transaction's two decimal places. A same-Sydney-date correction preserves the original
 *       timestamp; changing date records the new calendar date at 01:00 UTC. Dates must remain
 *       after opening, on/after acquisition and within the original observation date.
 *       Same-day sales must follow effective acquisition cash in explicit sequence order.
 *       The original opening snapshot and statement evidence never change; other drafts
 *       become stale. Expected revision/source and idempotency checks serialize edits.
 *       This changes live trade history and can make existing tax reports stale, but does
 *       not activate accounting or post spendable cash.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: statementId, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
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
 *               price: { type: string, description: Positive exact decimal with at most 12 integer and 12 fractional digits }
 *               fees: { type: string, description: Non-negative exact decimal with at most 10 integer and 8 fractional digits }
 *     responses:
 *       200: { description: Draft operationId, revisionId, state DRAFT, created flag and current dated cash replay. Identical retries do not rewrite the live sale. }
 *       400: { description: Unsupported fields, amount precision or unchanged correction. }
 *       401: { description: Authentication required. }
 *       404: { description: Owned manual sale, statement or operation not found. }
 *       409: { description: Stale source/head, invalid boundary, unsupported parcel or conflicting idempotency key. }
 *       422: { description: Dated funding deficit, occupied ordering slot or audit limit. }
 */
router.post(
  '/:id/opening-statements/:statementId/cash-operations/:operationId/sale-corrections',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    param('operationId').isString().trim().isLength({ min: 1, max: 100 }),
    body().custom((raw: unknown) => {
      parseSaleCorrection(raw)
      return true
    }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctDraftRecordedSale(
      req.user!.userId,
      String(req.params.id),
      String(req.params.statementId),
      String(req.params.operationId),
      req.body
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/opening-statements/{statementId}/cash-operations/{operationId}/acquisition-corrections:
 *   post:
 *     summary: Correct a recorded manual acquisition and its draft cash atomically
 *     description: >
 *       Changes the live manual long BUY date, quantity, price and fees, recomputes parcel
 *       cost basis, remaining inventory and realized results, and appends an immutable cash
 *       revision with before/after source snapshots and fingerprint continuation. Sale
 *       quantities and allocations never change. The parcel must have exactly one BUY, cover
 *       all sales and precede their dates. Same-day sales require effective draft cash ordered
 *       after the acquisition. Imported parcels and broker-linked sales are excluded.
 *       Account, instrument, currency and source identity cannot change. The acquisition must
 *       stay after opening and within the original observation date. Quantity is an exact
 *       decimal string with at most 12 fractional digits, at most 9007199254740991, and must
 *       round-trip through the existing Float storage without changing decimal value.
 *       Gross consideration is quantity times price rounded half-up to 2 decimal places.
 *       Same-Sydney-date edits retain timestamps; changed dates use 01:00 UTC. The original
 *       opening and statement evidence remain unchanged; unrelated drafts and tax reports
 *       can become stale. No spendable cash or accounting activation is enabled.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: statementId, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [idempotencyKey, expectedRevisionId, expectedSourceFingerprint, reason, effectiveDate, sequence, price, fees, quantity]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *               expectedSourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer, minimum: 1, maximum: 9007199254740991 }
 *               price: { type: string, description: Positive exact decimal with at most 12 integer and 12 fractional digits }
 *               fees: { type: string, description: Non-negative exact decimal with at most 10 integer and 8 fractional digits }
 *               quantity: { type: string, description: Positive representable decimal quantity covering all existing sales }
 *     responses:
 *       200: { description: Draft operationId, revisionId, state DRAFT, created flag and current dated cash replay. Identical retries never rewrite the live acquisition. }
 *       400: { description: Invalid fields, precision, quantity, storage overflow or unchanged correction. }
 *       401: { description: Authentication required. }
 *       404: { description: Owned manual acquisition, statement or operation not found. }
 *       409: { description: Stale source/head, invalid boundary, unsupported parcel, insufficient inventory, imported sale allocation or conflicting idempotency key. }
 *       422: { description: Dated funding deficit, occupied ordering slot or audit limit. }
 */
router.post(
  '/:id/opening-statements/:statementId/cash-operations/:operationId/acquisition-corrections',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    param('statementId').isString().trim().isLength({ min: 1, max: 100 }),
    param('operationId').isString().trim().isLength({ min: 1, max: 100 }),
    body().custom((raw: unknown) => {
      parseAcquisitionCorrection(raw)
      return true
    }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctDraftRecordedAcquisition(
      req.user!.userId,
      String(req.params.id),
      String(req.params.statementId),
      String(req.params.operationId),
      req.body
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: result })
  })
)

export default router
