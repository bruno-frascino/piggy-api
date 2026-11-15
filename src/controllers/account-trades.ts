import { Router, type Request, type Response } from 'express'
import { body, param, query } from 'express-validator'
import { authenticateToken } from '../middleware/auth.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import {
  correctLiveManualAcquisition,
  correctLiveManualSale,
  correctLiveImportedExecution,
  postAccountCapitalFlow,
  postAccountFxConversion,
  readLiveFxConversionReview,
  correctLiveFxConversion,
  postAccountIncomeReceipt,
  postAccountReinvestment,
  readLiveReinvestmentReview,
  correctLiveReinvestment,
  postAccountCashTransfer,
  readLiveCashTransferReview,
  correctLiveCashTransfer,
  correctLiveIncomeReceipt,
  correctLiveCapitalOperation,
  readLiveCapitalOperations,
  postAccountTrade,
  readAccountTradeCapability,
  voidLiveManualTrade,
  readLiveManualTradeVoids,
} from '../lib/draft-cash-ledger.js'

const router = Router()
router.use(authenticateToken)

/**
 * @swagger
 * /api/accounts/{id}/reinvestments/{operationId}/corrections:
 *   get:
 *     summary: Review a paired reinvestment and current account audit head
 *     description: Requires an owned fresh active real ledger. Either linked operation ID resolves both current revision heads, fixed statement identity and effective-sale restriction. Terminal reversal returns current null. Archived retained audits use cash-operations.
 *     tags: [Accounts]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Validated current paired review.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/LiveReinvestmentReview' }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned reinvestment not found. }
 *       409: { description: Unavailable, archived, stale or inconsistent ledger. }
 * components:
 *   schemas:
 *     ReinvestmentCorrectionInput:
 *       type: object
 *       additionalProperties: false
 *       required: [idempotencyKey, expectedIncomeRevisionId, expectedAcquisitionRevisionId, expectedAuditNumber, expectedSourceFingerprint, reason, replacement]
 *       properties:
 *         idempotencyKey: { type: string }
 *         expectedIncomeRevisionId: { type: string }
 *         expectedAcquisitionRevisionId: { type: string }
 *         expectedAuditNumber: { type: integer, minimum: 0 }
 *         expectedSourceFingerprint: { type: string }
 *         reason: { type: string, minLength: 1, maxLength: 1000 }
 *         replacement:
 *           type: object
 *           nullable: true
 *           additionalProperties: false
 *           required: [income, acquisition, residualAmount, residualDisposition, statementConfirmed]
 *           properties:
 *             income: { $ref: '#/components/schemas/AccountReinvestmentInput/properties/income' }
 *             acquisition: { $ref: '#/components/schemas/AccountReinvestmentInput/properties/acquisition' }
 *             residualAmount: { type: string }
 *             residualDisposition: { type: string, enum: [ACCOUNT_CASH] }
 *             statementConfirmed: { type: boolean, enum: [true] }
 *     LiveReinvestmentReview:
 *       type: object
 *       required: [accountId, incomeOperationId, acquisitionOperationId, positionId, expectedIncomeRevisionId, expectedAcquisitionRevisionId, expectedAuditNumber, expectedSourceFingerprint, current, hasEffectiveSales]
 *       properties:
 *         accountId: { type: string }
 *         incomeOperationId: { type: string }
 *         acquisitionOperationId: { type: string }
 *         positionId: { type: string }
 *         expectedIncomeRevisionId: { type: string }
 *         expectedAcquisitionRevisionId: { type: string }
 *         expectedAuditNumber: { type: integer }
 *         expectedSourceFingerprint: { type: string }
 *         current: { $ref: '#/components/schemas/ReinvestmentCorrectionInput/properties/replacement' }
 *         hasEffectiveSales: { type: boolean }
 *     ReinvestmentCorrectionResponse:
 *       type: object
 *       required: [success, data]
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           required: [incomeOperationId, acquisitionOperationId, incomeRevisionId, acquisitionRevisionId, created, replay]
 *           properties:
 *             incomeOperationId: { type: string }
 *             acquisitionOperationId: { type: string }
 *             incomeRevisionId: { type: string }
 *             acquisitionRevisionId: { type: string }
 *             created: { type: boolean }
 *             replay: { $ref: '#/components/schemas/DraftCashReplay' }
 */
router.get(
  '/:id/reinvestments/:operationId/corrections',
  [
    param('id').isString().notEmpty(),
    param('operationId').isString().notEmpty(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: await readLiveReinvestmentReview(
        req.user!.userId,
        req.params.id,
        req.params.operationId
      ),
    })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/reinvestments/{operationId}/corrections:
 *   post:
 *     summary: Correct or terminally reverse both reinvestment effects atomically
 *     description: Fixed account, asset, currency and statement reference. Requires both current revision heads, audit number, source fingerprint and reason. No effective SELL may remain on the new parcel. Corrections update statement tax figures and acquisition/date/order/residual together, retain all slots and require funded replay; reversal removes the effective income and parcel without a disposal. Issuer-held credits and one-sided changes remain blocked. Exact retained retries survive later activity.
 *     tags: [Accounts]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ReinvestmentCorrectionInput' }
 *     responses:
 *       201:
 *         description: Paired immutable revisions committed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ReinvestmentCorrectionResponse' }
 *       200:
 *         description: Identical retained retry.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ReinvestmentCorrectionResponse' }
 *       400: { description: Invalid, changed identity or unchanged replacement. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned reinvestment not found. }
 *       409: { description: Effective sales, stale heads, terminal state, reserved slots or unfunded replay. }
 *       422: { description: Unsupported entitlement or history bounds. }
 */
router.post(
  '/:id/reinvestments/:operationId/corrections',
  [
    param('id').isString().notEmpty(),
    param('operationId').isString().notEmpty(),
    body('idempotencyKey').isString().notEmpty(),
    body('expectedIncomeRevisionId').isString().notEmpty(),
    body('expectedAcquisitionRevisionId').isString().notEmpty(),
    body('expectedAuditNumber').isInt({ min: 0 }),
    body('expectedSourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    body('reason').isString().isLength({ min: 1, max: 1000 }),
    body('replacement').custom(
      (value) =>
        value === null || (typeof value === 'object' && !Array.isArray(value))
    ),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctLiveReinvestment(
      req.user!.userId,
      req.params.id,
      req.params.operationId,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/reinvestments:
 *   post:
 *     summary: Record statement-supported dividend reinvestment atomically
 *     description: Creates exactly one equity/ETF income receipt and a new BUY parcel in the same account/currency. Statement-confirmed entitlement and tax figures are authoritative; eligible historical holdings are required. Exact net income must equal acquisition consideration plus fees plus an explicit account-paid residual; issuer-held credits, extra funding, existing-receipt relinking and AMIT components are unsupported. Acquisition follows income in date/sequence order. Paired immutable links and full funded replay protect both records. Independent income revisions, acquisition corrections/voids and direct deletion are blocked; use the dedicated paired revision workflow. No activation or external capital is created.
 *     tags: [Accounts]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AccountReinvestmentInput' }
 *     responses:
 *       201:
 *         description: Income, new parcel and immutable linked postings committed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountReinvestmentResponse' }
 *       200:
 *         description: Identical retained retry; no new records.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountReinvestmentResponse' }
 *       400: { description: Invalid fields, precision, ordering or residual equation. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account not found. }
 *       409: { description: Unconfirmed, archived, stale, conflicting or unfunded ledger. }
 *       422: { description: Ineligible asset, currency, entitlement or unsupported history. }
 * components:
 *   schemas:
 *     AccountReinvestmentInput:
 *       type: object
 *       additionalProperties: false
 *       required: [idempotencyKey, income, acquisition, residualAmount, residualDisposition, statementConfirmed]
 *       properties:
 *         idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *         income:
 *           type: object
 *           additionalProperties: false
 *           required: [assetId, entitlementDate, paymentDate, sequence, currency, grossAmount, withholdingAmount, frankedAmount, unfrankedAmount, frankingCreditAud, sourceReference]
 *           properties:
 *             assetId: { type: string }
 *             entitlementDate: { type: string, format: date }
 *             paymentDate: { type: string, format: date }
 *             sequence: { type: integer, minimum: 1 }
 *             currency: { type: string }
 *             grossAmount: { type: string }
 *             withholdingAmount: { type: string }
 *             frankedAmount: { type: string }
 *             unfrankedAmount: { type: string }
 *             frankingCreditAud: { type: string }
 *             sourceReference: { type: string }
 *         acquisition:
 *           type: object
 *           additionalProperties: false
 *           required: [effectiveDate, sequence, quantity, price, fees]
 *           properties:
 *             effectiveDate: { type: string, format: date }
 *             sequence: { type: integer, minimum: 1 }
 *             quantity: { type: string, description: Exact positive units representable by the existing quantity storage. }
 *             price: { type: string, description: Exact unit price; total consideration must fit existing cent-precision storage without rounding. }
 *             fees: { type: string, description: Explicit fees paid from this net distribution in the same currency. }
 *         residualAmount: { type: string, description: Explicit non-negative cash paid into the account after acquisition and fees. }
 *         residualDisposition: { type: string, enum: [ACCOUNT_CASH] }
 *         statementConfirmed: { type: boolean, enum: [true] }
 *     AccountReinvestmentResponse:
 *       type: object
 *       required: [success, data]
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           required: [incomeOperationId, acquisitionOperationId, positionId, created, replay]
 *           properties:
 *             incomeOperationId: { type: string }
 *             acquisitionOperationId: { type: string }
 *             positionId: { type: string }
 *             created: { type: boolean }
 *             replay: { $ref: '#/components/schemas/DraftCashReplay' }
 */
router.post(
  '/:id/reinvestments',
  [
    param('id').isString().notEmpty(),
    body('idempotencyKey').isString().isLength({ min: 1, max: 200 }),
    body('income').isObject(),
    body('acquisition').isObject(),
    ...[
      'income.entitlementDate',
      'income.paymentDate',
      'acquisition.effectiveDate',
    ].map((field) => body(field).isString().isISO8601({ strict: true })),
    ...['income.sequence', 'acquisition.sequence'].map((field) =>
      body(field).isInt({ min: 1, max: Number.MAX_SAFE_INTEGER })
    ),
    ...[
      'income.assetId',
      'income.currency',
      'income.grossAmount',
      'income.withholdingAmount',
      'income.frankedAmount',
      'income.unfrankedAmount',
      'income.frankingCreditAud',
      'income.sourceReference',
      'acquisition.quantity',
      'acquisition.price',
      'acquisition.fees',
      'residualAmount',
    ].map((field) => body(field).isString().notEmpty()),
    body('residualDisposition').equals('ACCOUNT_CASH'),
    body('statementConfirmed').custom((value) => value === true),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await postAccountReinvestment(
      req.user!.userId,
      req.params.id,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/fx-conversions/{operationId}/corrections:
 *   get:
 *     summary: Review the current FX revision and live cash audit head
 *     description: Requires an owned FX operation and fresh active confirmed real ledger. Returns fixed currency direction/source, current amounts/fees and revision/audit/fingerprint. Terminal reversal has current null. Archived retained audits use cash-operations.
 *     tags: [Accounts]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Validated current FX review; no writes or activation.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/LiveFxConversionReview' }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned FX operation not found. }
 *       409: { description: Archived, stale, unavailable or inconsistent ledger history. }
 * components:
 *   schemas:
 *     FxRevisionReplacement:
 *       type: object
 *       nullable: true
 *       additionalProperties: false
 *       required: [effectiveDate, sequence, fromAmount, toAmount, fees]
 *       properties:
 *         effectiveDate: { type: string, format: date }
 *         sequence: { type: integer, minimum: 1 }
 *         fromAmount: { type: string, description: Exact positive exchanged amount before fees. }
 *         toAmount: { type: string, description: Exact positive received amount before fees. }
 *         fees:
 *           type: array
 *           maxItems: 2
 *           items:
 *             type: object
 *             additionalProperties: false
 *             required: [currency, amount]
 *             properties:
 *               currency: { type: string }
 *               amount: { type: string, description: Exact non-negative fee in either fixed exchanged currency. }
 *     AccountFxCorrectionInput:
 *       type: object
 *       additionalProperties: false
 *       required: [idempotencyKey, expectedRevisionId, expectedAuditNumber, expectedSourceFingerprint, reason, replacement]
 *       properties:
 *         idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *         expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *         expectedAuditNumber: { type: integer, minimum: 0 }
 *         expectedSourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *         reason: { type: string, minLength: 1, maxLength: 1000 }
 *         replacement: { $ref: '#/components/schemas/FxRevisionReplacement' }
 *     LiveFxConversionReview:
 *       type: object
 *       required: [operationId, accountId, fromCurrency, toCurrency, sourceReference, expectedRevisionId, auditNumber, sourceFingerprint, current]
 *       properties:
 *         operationId: { type: string }
 *         accountId: { type: string }
 *         fromCurrency: { type: string }
 *         toCurrency: { type: string }
 *         sourceReference: { type: string }
 *         expectedRevisionId: { type: string }
 *         auditNumber: { type: integer }
 *         sourceFingerprint: { type: string }
 *         current: { $ref: '#/components/schemas/FxRevisionReplacement' }
 *     AccountFxCorrectionResponse:
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
 *             replay: { $ref: '#/components/schemas/DraftCashReplay' }
 */
router.get(
  '/:id/fx-conversions/:operationId/corrections',
  [
    param('id').isString().notEmpty(),
    param('operationId').isString().notEmpty(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: await readLiveFxConversionReview(
        req.user!.userId,
        req.params.id,
        req.params.operationId
      ),
    })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/fx-conversions/{operationId}/corrections:
 *   post:
 *     summary: Audited fixed-identity FX correction or terminal reversal
 *     description: Changes exchanged amounts, fees, date or sequence, never account, currency pair/direction or source reference. Requires current revision/audit/fingerprint and reason. Atomic inverse/replacement legs restate effective history while preserving all original/replacement slots and funded replay in both currencies. Reversal removes original effects including fees, not a new reverse exchange. Identical retained retries remain valid after later activity; no generic funding revision or activation.
 *     tags: [Accounts]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AccountFxCorrectionInput' }
 *     responses:
 *       201:
 *         description: Immutable revision committed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountFxCorrectionResponse' }
 *       200:
 *         description: Identical retry; no new postings.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountFxCorrectionResponse' }
 *       400: { description: Invalid fields, changed identity or no economic/date/order change. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned FX operation not found. }
 *       409: { description: Stale heads/history, archived ledger, conflicting retry, reserved slots or terminal reversal. }
 *       422: { description: Unfunded dated currency timeline or precision/replay limits. }
 */
router.post(
  '/:id/fx-conversions/:operationId/corrections',
  [
    param('id').isString().notEmpty(),
    param('operationId').isString().notEmpty(),
    body('idempotencyKey').isString().notEmpty().isLength({ max: 200 }),
    body('expectedRevisionId').isString().notEmpty().isLength({ max: 200 }),
    body('expectedAuditNumber').isInt({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    body('expectedSourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    body('reason').isString().notEmpty().isLength({ max: 1000 }),
    body('replacement').custom(
      (value) =>
        value === null || (typeof value === 'object' && !Array.isArray(value))
    ),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctLiveFxConversion(
      req.user!.userId,
      req.params.id,
      req.params.operationId,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/fx-conversions:
 *   post:
 *     summary: Record an explicit same-account currency conversion
 *     description: Records an already executed broker conversion, never executes FX or implicitly funds a purchase. Requires an owned active confirmed real ledger, fresh sources and explicit openings in both currencies. Positive exchanged amounts are before separately recorded fees, which may be in either exchanged currency; no third currency. One date/sequence links both currency legs atomically. Full dated funding, immutable history and exact retries are enforced. Principal and fees are not external capital. Revisions use the dedicated audited correction endpoint; no direct edits, holdings changes or account activation.
 *     tags: [Accounts]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AccountFxConversionInput' }
 *     responses:
 *       201:
 *         description: Linked currency postings committed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountFxConversionResponse' }
 *       200:
 *         description: Identical retry; no new postings.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountFxConversionResponse' }
 *       400: { description: Invalid amounts, currencies, fees or command fields. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account not found. }
 *       409: { description: Unconfirmed/demo/archived/stale ledger, occupied sequence or conflicting retry/source. }
 *       422: { description: Missing currency opening, insufficient dated funding or precision/replay limits. }
 * components:
 *   schemas:
 *     AccountFxConversionInput:
 *       type: object
 *       additionalProperties: false
 *       required: [idempotencyKey, effectiveDate, sequence, from, to, fees, sourceReference]
 *       properties:
 *         idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *         effectiveDate: { type: string, format: date }
 *         sequence: { type: integer, minimum: 1 }
 *         sourceReference: { type: string, minLength: 1, maxLength: 200 }
 *         from:
 *           type: object
 *           additionalProperties: false
 *           required: [currency, amount]
 *           properties:
 *             currency: { type: string, description: Supported ISO currency, distinct from to.currency. }
 *             amount: { type: string, description: Exact positive amount exchanged before explicit fees. }
 *         to:
 *           type: object
 *           additionalProperties: false
 *           required: [currency, amount]
 *           properties:
 *             currency: { type: string }
 *             amount: { type: string, description: Exact positive gross amount received before explicit fees. }
 *         fees:
 *           type: array
 *           maxItems: 2
 *           description: Explicit fees aggregated per exchanged currency; empty list means no separately charged fee. Do not infer spread or a market rate.
 *           items:
 *             type: object
 *             additionalProperties: false
 *             required: [currency, amount]
 *             properties:
 *               currency: { type: string }
 *               amount: { type: string, description: Exact non-negative fee. }
 *     AccountFxConversionResponse:
 *       type: object
 *       required: [success, data]
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           required: [operationId, created, replay]
 *           properties:
 *             operationId: { type: string }
 *             created: { type: boolean }
 *             replay: { $ref: '#/components/schemas/DraftCashReplay' }
 */
router.post(
  '/:id/fx-conversions',
  [
    param('id').isString().notEmpty(),
    body('idempotencyKey').isString().notEmpty().isLength({ max: 200 }),
    body('effectiveDate').isString().notEmpty(),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('from.currency').isString().notEmpty(),
    body('from.amount').isString().notEmpty(),
    body('to.currency').isString().notEmpty(),
    body('to.amount').isString().notEmpty(),
    body('fees').isArray({ max: 2 }),
    body('sourceReference').isString().notEmpty().isLength({ max: 200 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await postAccountFxConversion(
      req.user!.userId,
      req.params.id,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/cash-transfers/{operationId}/corrections:
 *   get:
 *     summary: Review both current ledger heads before a paired transfer revision
 *     description: Requires an owned outgoing transfer and two active real ledgers with fresh, valid sources. Returns fixed identity, current effective amounts and both review heads. A terminal reversal has current null. Retained archived audits remain accessible via cash-operations instead.
 *     tags: [Accounts]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Validated paired review; does not write or activate accounts.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/LiveCashTransferReview' }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned outgoing transfer not found. }
 *       409: { description: Ledger unavailable, archived or source/audit history stale or inconsistent. }
 * components:
 *   schemas:
 *     TransferRevisionHead:
 *       type: object
 *       additionalProperties: false
 *       required: [revisionId, auditNumber, sourceFingerprint]
 *       properties:
 *         revisionId: { type: string }
 *         auditNumber: { type: integer, minimum: 0 }
 *         sourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *     TransferReplacement:
 *       type: object
 *       additionalProperties: false
 *       nullable: true
 *       required: [effectiveDate, sourceSequence, destinationSequence, amount, fee]
 *       properties:
 *         effectiveDate: { type: string, format: date }
 *         sourceSequence: { type: integer, minimum: 1 }
 *         destinationSequence: { type: integer, minimum: 1 }
 *         amount: { type: string, description: Exact positive same-currency principal. }
 *         fee: { type: string, description: Exact non-negative sender-paid fee. }
 *     AccountCashTransferCorrectionInput:
 *       type: object
 *       additionalProperties: false
 *       required: [idempotencyKey, reason, sourceHead, destinationHead, replacement]
 *       properties:
 *         idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *         reason: { type: string, minLength: 1, maxLength: 1000 }
 *         sourceHead: { $ref: '#/components/schemas/TransferRevisionHead' }
 *         destinationHead: { $ref: '#/components/schemas/TransferRevisionHead' }
 *         replacement: { $ref: '#/components/schemas/TransferReplacement' }
 *     LiveCashTransferReview:
 *       type: object
 *       required: [sourceAccountId, destinationAccountId, sourceOperationId, destinationOperationId, currency, sourceReference, sourceHead, destinationHead, current]
 *       properties:
 *         sourceAccountId: { type: string }
 *         destinationAccountId: { type: string }
 *         sourceOperationId: { type: string }
 *         destinationOperationId: { type: string }
 *         currency: { type: string }
 *         sourceReference: { type: string }
 *         sourceHead: { $ref: '#/components/schemas/TransferRevisionHead' }
 *         destinationHead: { $ref: '#/components/schemas/TransferRevisionHead' }
 *         current: { $ref: '#/components/schemas/TransferReplacement' }
 *     AccountCashTransferCorrectionResponse:
 *       type: object
 *       required: [success, data]
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           required: [sourceOperationId, destinationOperationId, sourceRevisionId, destinationRevisionId, created, sourceReplay, destinationReplay]
 *           properties:
 *             sourceOperationId: { type: string }
 *             destinationOperationId: { type: string }
 *             sourceRevisionId: { type: string }
 *             destinationRevisionId: { type: string }
 *             created: { type: boolean }
 *             sourceReplay: { $ref: '#/components/schemas/DraftCashReplay' }
 *             destinationReplay: { $ref: '#/components/schemas/DraftCashReplay' }
 */
router.get(
  '/:id/cash-transfers/:operationId/corrections',
  [
    param('id').isString().notEmpty(),
    param('operationId').isString().notEmpty(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: await readLiveCashTransferReview(
        req.user!.userId,
        req.params.id,
        req.params.operationId
      ),
    })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/cash-transfers/{operationId}/corrections:
 *   post:
 *     summary: Atomically correct or terminally reverse both cash-transfer legs
 *     description: Preserves both accounts, currency and statement source. Replacement may change principal, sender-paid fee, shared date and independent sequences; null is a terminal reversal. Both review heads must be current, both dated timelines remain funded, and both immutable revision chains commit or roll back together. Old date/sequence slots remain reserved. Same-key retries reuse the pair, even after later activity. No one-sided funding revision, holdings move or FX.
 *     tags: [Accounts]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: operationId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AccountCashTransferCorrectionInput' }
 *     responses:
 *       201:
 *         description: Both immutable reversal/replacement revisions committed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountCashTransferCorrectionResponse' }
 *       200:
 *         description: Identical paired revision retry; no new postings.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountCashTransferCorrectionResponse' }
 *       400: { description: Invalid revision or no economic/date/order change. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned outgoing transfer not found. }
 *       409: { description: Stale heads, reserved slots, terminal reversal, changed identity or conflicting retry. }
 *       422: { description: Either dated account timeline would become unfunded or exceed the supported replay limit. }
 */
router.post(
  '/:id/cash-transfers/:operationId/corrections',
  [
    param('id').isString().notEmpty(),
    param('operationId').isString().notEmpty(),
    body('idempotencyKey').isString().notEmpty().isLength({ max: 200 }),
    body('reason').isString().notEmpty().isLength({ max: 1000 }),
    body('sourceHead.revisionId').isString().notEmpty(),
    body('destinationHead.revisionId').isString().notEmpty(),
    body('sourceHead.auditNumber').isInt({
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    body('destinationHead.auditNumber').isInt({
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    body('sourceHead.sourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    body('destinationHead.sourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    body('replacement').custom(
      (value) =>
        value === null || (typeof value === 'object' && !Array.isArray(value))
    ),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctLiveCashTransfer(
      req.user!.userId,
      req.params.id,
      req.params.operationId,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/cash-transfers:
 *   post:
 *     summary: Atomically transfer same-currency cash between two owned live ledgers
 *     description: Both accounts must be active real accounts with confirmed ledgers, current source history and explicit opening cash in this currency. A shared dated transfer debits principal plus sender-paid fee and credits principal only. Principal is external to each account and cancels when both accounts are selected; fees remain costs. No holdings, FX, activation, direct edits or one-sided reversals; corrections use the dedicated paired audit workflow. Same-key retries reuse both operations.
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
 *             additionalProperties: false
 *             required: [toAccountId, idempotencyKey, effectiveDate, sourceSequence, destinationSequence, currency, amount, fee, sourceReference]
 *             properties:
 *               toAccountId: { type: string }
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               effectiveDate: { type: string, format: date }
 *               sourceSequence: { type: integer, minimum: 1 }
 *               destinationSequence: { type: integer, minimum: 1 }
 *               currency: { type: string }
 *               amount: { type: string, description: Exact positive principal in the same currency at both endpoints. }
 *               fee: { type: string, description: Exact non-negative sender-paid fee in the principal currency. }
 *               sourceReference: { type: string, minLength: 1, maxLength: 200 }
 *     responses:
 *       201:
 *         description: Both cash operations committed atomically.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountCashTransferResponse' }
 *       200:
 *         description: Identical retry; no new postings.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountCashTransferResponse' }
 *       400: { description: Invalid transfer command. }
 *       401: { description: Unauthorized. }
 *       404: { description: An owned account was not found. }
 *       409: { description: Ledger unavailable, stale source, occupied sequence or conflicting retry. }
 *       422: { description: Missing currency opening or insufficient dated cash. }
 * components:
 *   schemas:
 *     AccountCashTransferResponse:
 *       type: object
 *       required: [success, data]
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           required: [sourceOperationId, destinationOperationId, created, sourceReplay, destinationReplay]
 *           properties:
 *             sourceOperationId: { type: string }
 *             destinationOperationId: { type: string }
 *             created: { type: boolean }
 *             sourceReplay: { $ref: '#/components/schemas/DraftCashReplay' }
 *             destinationReplay: { $ref: '#/components/schemas/DraftCashReplay' }
 *     DraftCashReplay:
 *       type: object
 *       required: [accountId, openingDate, funded, balances, activity, fundingIssues]
 *       properties:
 *         accountId: { type: string }
 *         openingDate: { type: string, format: date }
 *         funded: { type: boolean }
 *         balances:
 *           type: array
 *           items:
 *             type: object
 *             required: [currency, openingAmount, endingAmount, minimumAmount, netExternalContribution]
 *             properties:
 *               currency: { type: string }
 *               openingAmount: { type: string }
 *               endingAmount: { type: string }
 *               minimumAmount: { type: string }
 *               netExternalContribution: { type: string, description: Includes transfer principal for this account, never the transfer fee. }
 *         activity:
 *           type: array
 *           items:
 *             type: object
 *             required: [idempotencyKey, effectiveDate, sequence, kind, changes]
 *             properties:
 *               idempotencyKey: { type: string }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer }
 *               kind: { type: string }
 *               changes:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [currency, amount, balanceAfter]
 *                   properties:
 *                     currency: { type: string }
 *                     amount: { type: string }
 *                     balanceAfter: { type: string }
 *         fundingIssues:
 *           type: array
 *           items:
 *             type: object
 *             required: [currency, idempotencyKey, effectiveDate, sequence, balance]
 *             properties:
 *               currency: { type: string }
 *               idempotencyKey: { type: string }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer }
 *               balance: { type: string }
 */
router.post(
  '/:id/cash-transfers',
  [
    param('id').isString().notEmpty(),
    body('toAccountId').isString().notEmpty(),
    body('idempotencyKey').isString().notEmpty().isLength({ max: 200 }),
    body('effectiveDate').isString().isISO8601({ strict: true }),
    body('sourceSequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('destinationSequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('currency').isString(),
    body('amount').isString(),
    body('fee').isString(),
    body('sourceReference').isString().notEmpty().isLength({ max: 200 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await postAccountCashTransfer(
      req.user!.userId,
      req.params.id,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

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
 *     AccountIncomeReceiptResponse:
 *       type: object
 *       required: [success, data]
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           required: [operationId, created, replay]
 *           properties:
 *             operationId: { type: string }
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
 * /api/accounts/{id}/trade-capability:
 *   get:
 *     summary: Resolve the server-owned trade-write capability for an account
 *     description: Distinguishes active confirmed ledgers from legacy, demo, archived and blocked accounts. This read never activates an account.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: effectiveDate
 *         required: true
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Capability and available same-day cash sequence.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [accountId, mode, reason, openingDate, effectiveDate, nextSequence]
 *                   properties:
 *                     accountId: { type: string }
 *                     mode: { type: string, enum: [LIVE_LEDGER, LEGACY, DEMO, ARCHIVED, BLOCKED] }
 *                     reason: { type: string, nullable: true }
 *                     openingDate: { type: string, format: date, nullable: true }
 *                     effectiveDate: { type: string, format: date }
 *                     nextSequence: { type: integer, nullable: true }
 *       400: { description: Invalid effective date. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account not found. }
 *       409: { description: Ledger state or audited history is inconsistent. }
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
 *               assetId: { type: string, description: Existing asset ID for BUY; alternatively provide symbol and exchangeCode. }
 *               symbol: { type: string, description: BUY instrument symbol when resolving an asset. }
 *               exchangeCode: { type: string, description: BUY exchange code when resolving an asset. }
 *               assetName: { type: string }
 *               assetType: { type: string, enum: [EQUITY, ETF, CRYPTO] }
 *               industry: { type: string }
 *               openReason: { type: string }
 *               stopLossPrice: { type: string, nullable: true }
 *               positionId: { type: string, description: Required for SELL only. }
 *               closeReason: { type: string, enum: [STOP_LOSS, TARGET, MANUAL, OTHER] }
 *               notes: { type: string, description: SELL notes. }
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
router.get(
  '/:id/trade-capability',
  [
    param('id').isString().trim().notEmpty(),
    query('effectiveDate').isString().isISO8601({ strict: true }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await readAccountTradeCapability(
      req.user!.userId,
      req.params.id,
      String(req.query.effectiveDate)
    )
    res.json({ success: true, data: result })
  })
)

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
    body('assetId').optional().isString(),
    body('symbol').optional().isString(),
    body('exchangeCode').optional().isString(),
    body('assetName').optional().isString(),
    body('assetType').optional().isIn(['EQUITY', 'ETF', 'CRYPTO']),
    body('industry').optional().isString(),
    body('openReason').optional().isString(),
    body('stopLossPrice').optional({ nullable: true }).isString(),
    body('positionId').optional().isString(),
    body('closeReason')
      .optional()
      .isIn(['STOP_LOSS', 'TARGET', 'MANUAL', 'OTHER']),
    body('notes').optional().isString(),
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
 * /api/accounts/{id}/cash-operations:
 *   post:
 *     summary: Record an explicit live deposit or withdrawal
 *     description: >
 *       Posts a cash-only capital flow for an explicitly confirmed active ledger.
 *       The operation does not create a trade or auto-balance cash. Dated replay
 *       rejects a withdrawal or backdated flow that leaves any point unfunded.
 *       No account is activated by this endpoint.
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
 *             additionalProperties: false
 *             required: [kind, idempotencyKey, effectiveDate, sequence, currency, amount, sourceReference]
 *             properties:
 *               kind: { type: string, enum: [DEPOSIT, WITHDRAWAL] }
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               effectiveDate: { type: string, format: date }
 *               sequence: { type: integer, minimum: 1 }
 *               currency: { type: string, description: Explicit supported ISO currency. }
 *               amount: { type: string, description: Exact positive decimal amount. }
 *               sourceReference: { type: string, minLength: 1, maxLength: 200, description: User-supplied bank, broker or statement reference. }
 *     responses:
 *       201:
 *         description: Cash-only operation and immutable postings were committed atomically.
 *       200:
 *         description: Idempotent retry of an already committed operation.
 *       400: { description: Invalid capital flow command. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account not found. }
 *       409: { description: Account has no active confirmed ledger, source history drifted, or date/sequence is reserved. }
 *       422: { description: Flow would leave a dated cash balance unfunded or history is unsupported. }
 */
router.post(
  '/:id/cash-operations',
  [
    param('id').isString().trim().notEmpty(),
    body('kind').isIn(['DEPOSIT', 'WITHDRAWAL']),
    body('idempotencyKey').isString().isLength({ min: 1, max: 200 }),
    body('effectiveDate').isString().isISO8601({ strict: true }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('currency').isString(),
    body('amount').isString(),
    body('sourceReference').isString().isLength({ min: 1, max: 200 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await postAccountCapitalFlow(
      req.user!.userId,
      req.params.id,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/income-receipts:
 *   post:
 *     summary: Record a manual dividend or distribution receipt
 *     description: Posts net cash to an active confirmed ledger while retaining gross income, withholding, franked/unfranked amounts, franking credits and the user-supplied statement reference. Only equity and ETF assets already held in the account are supported. Complex AMIT components and automated income are not supported.
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
 *             additionalProperties: false
 *             required: [idempotencyKey, assetId, entitlementDate, paymentDate, sequence, currency, grossAmount, withholdingAmount, frankedAmount, unfrankedAmount, frankingCreditAud, sourceReference]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               assetId: { type: string, minLength: 1, maxLength: 200 }
 *               entitlementDate: { type: string, format: date }
 *               paymentDate: { type: string, format: date, description: Effective date for the positive net-cash posting. }
 *               sequence: { type: integer, minimum: 1 }
 *               currency: { type: string, description: Explicit supported ISO currency; franking amounts and credits require AUD. }
 *               grossAmount: { type: string, description: Exact positive gross distribution amount. }
 *               withholdingAmount: { type: string, description: Exact non-negative withholding, not greater than gross. }
 *               frankedAmount: { type: string, description: Gross component classified as franked. }
 *               unfrankedAmount: { type: string, description: Gross component classified as unfranked; both components must sum to gross. }
 *               frankingCreditAud: { type: string, description: Non-cash franking credit in AUD. }
 *               sourceReference: { type: string, minLength: 1, maxLength: 200 }
 *     responses:
 *       201:
 *         description: Income audit record and net cash posting committed atomically.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountIncomeReceiptResponse' }
 *       200:
 *         description: Idempotent retry of an identical income receipt.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AccountIncomeReceiptResponse' }
 *       400: { description: Invalid income receipt. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account not found. }
 *       409: { description: Account has no active confirmed ledger, source history drifted, or date/sequence is reserved. }
 *       422: { description: Asset is not eligible or the dated cash history is unsupported. }
 */
router.post(
  '/:id/income-receipts',
  [
    param('id').isString().trim().notEmpty(),
    body('idempotencyKey').isString().isLength({ min: 1, max: 200 }),
    body('assetId').isString().trim().notEmpty(),
    body('entitlementDate').isString().isISO8601({ strict: true }),
    body('paymentDate').isString().isISO8601({ strict: true }),
    body('sequence').isInt({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    body('currency').isString(),
    body('grossAmount').isString(),
    body('withholdingAmount').isString(),
    body('frankedAmount').isString(),
    body('unfrankedAmount').isString(),
    body('frankingCreditAud').isString(),
    body('sourceReference').isString().isLength({ min: 1, max: 200 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await postAccountIncomeReceipt(
      req.user!.userId,
      req.params.id,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/income-receipts/{operationId}/corrections:
 *   post:
 *     summary: Correct or terminally reverse a live income receipt
 *     description: Appends an immutable income revision and cash postings. Replacement preserves asset, currency and source reference; reverse and record a new receipt to correct those identity fields. Dated replay must remain funded.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *             required: [idempotencyKey, expectedRevisionId, expectedAuditNumber, expectedSourceFingerprint, reason, replacement]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *               expectedAuditNumber: { type: integer, minimum: 0 }
 *               expectedSourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               replacement:
 *                 oneOf:
 *                   - type: 'null'
 *                   - type: object
 *                     additionalProperties: false
 *                     required: [entitlementDate, paymentDate, sequence, grossAmount, withholdingAmount, frankedAmount, unfrankedAmount, frankingCreditAud]
 *                     properties:
 *                       entitlementDate: { type: string, format: date }
 *                       paymentDate: { type: string, format: date }
 *                       sequence: { type: integer, minimum: 1 }
 *                       grossAmount: { type: string }
 *                       withholdingAmount: { type: string }
 *                       frankedAmount: { type: string }
 *                       unfrankedAmount: { type: string }
 *                       frankingCreditAud: { type: string }
 *     responses:
 *       201: { description: Immutable correction/reversal and cash postings committed. }
 *       200: { description: Idempotent retry of a prior correction/reversal. }
 *       400: { description: Invalid correction request. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account or live income receipt not found. }
 *       409: { description: Stale audit head, concurrent correction, or reserved date/sequence. }
 *       422: { description: Corrected or reversed income would leave a dated balance negative. }
 */
router.post(
  '/:id/income-receipts/:operationId/corrections',
  [
    param('id').isString().trim().notEmpty(),
    param('operationId').isString().trim().notEmpty(),
    body('idempotencyKey').isString().isLength({ min: 1, max: 200 }),
    body('expectedRevisionId').isString().isLength({ min: 1, max: 200 }),
    body('expectedAuditNumber').isInt({
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    body('expectedSourceFingerprint').matches(/^[a-f0-9]{64}$/),
    body('reason').isString().isLength({ min: 1, max: 1000 }),
    body('replacement').custom((value: unknown) => {
      if (value === null) return true
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false
      const replacement = value as Record<string, unknown>
      const fields = [
        'entitlementDate',
        'paymentDate',
        'sequence',
        'grossAmount',
        'withholdingAmount',
        'frankedAmount',
        'unfrankedAmount',
        'frankingCreditAud',
      ]
      return (
        Object.keys(replacement).length === fields.length &&
        Object.keys(replacement).every((key) => fields.includes(key)) &&
        typeof replacement.entitlementDate === 'string' &&
        typeof replacement.paymentDate === 'string' &&
        typeof replacement.sequence === 'number' &&
        Number.isSafeInteger(replacement.sequence) &&
        replacement.sequence > 0 &&
        fields
          .filter(
            (key) => key.endsWith('Amount') || key === 'frankingCreditAud'
          )
          .every((key) => typeof replacement[key] === 'string')
      )
    }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctLiveIncomeReceipt(
      req.user!.userId,
      req.params.id,
      req.params.operationId,
      req.body
    )
    res.status(result.created ? 201 : 200).json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/cash-operations:
 *   get:
 *     summary: Read live cash balances, activity and retained audits
 *     description: Returns exact ledger-replayed balances and effective-dated activity, the opening boundary, source freshness, unsupported events and attested statement evidence. Transfer audit command summaries include transfer.fromAccountId, transfer.toAccountId and fee (charged to this account only); the shared idempotency key and source reference identify the pair. Transfer principal contributes to account-level external capital and cancels across both endpoints; fees remain costs. Paired operation integrity is checked before returning balances. Active and archived real accounts are read-only here. Evidence is user-attested, not broker-verified; stale or unsupported source history is explicitly flagged.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *     responses:
 *       200:
 *         description: Read-only cash replay, effective activity, retained revisions and evidence comparisons.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [items, total, limit, offset, activity, activityTotal, auditOperations, auditTotal, accountStatus, ledgerState, openingBoundary, reviewedAsOfDate, checkedAt, sourceFreshness, cashCompleteness, unsupportedEvents, sourceReviewIssues, evidence, evidenceStatus, auditNumber, sourceFingerprint, replay]
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [operationId, kind, currency, sourceReference, expectedRevisionId, original, current, revisions]
 *                         properties:
 *                           operationId: { type: string }
 *                           kind: { type: string, enum: [DEPOSIT, WITHDRAWAL] }
 *                           currency: { type: string }
 *                           sourceReference: { type: string }
 *                           expectedRevisionId: { type: string }
 *                           original: { type: object }
 *                           current: { type: object, nullable: true }
 *                           revisions: { type: array, items: { type: object } }
 *                           reinvestment:
 *                             type: object
 *                             nullable: true
 *                             required: [request, incomeOperationId, acquisitionOperationId, positionId]
 *                             properties:
 *                               request: { $ref: '#/components/schemas/AccountReinvestmentInput' }
 *                               incomeOperationId: { type: string }
 *                               acquisitionOperationId: { type: string }
 *                               positionId: { type: string }
 *                     total: { type: integer }
 *                     limit: { type: integer }
 *                     offset: { type: integer }
 *                     activity:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [idempotencyKey, effectiveDate, sequence, kind, changes, operationId, auditNumber, recordedAt, sourceOrigin, sourceReference]
 *                         properties:
 *                           idempotencyKey: { type: string }
 *                           effectiveDate: { type: string, format: date }
 *                           sequence: { type: integer }
 *                           kind: { type: string }
 *                           changes: { type: array, items: { type: object } }
 *                           operationId: { type: string }
 *                           auditNumber: { type: integer, nullable: true }
 *                           recordedAt: { type: string, format: date-time }
 *                           sourceOrigin: { type: string, enum: [MANUAL, IMPORT] }
 *                           sourceReference: { type: string }
 *                     activityTotal: { type: integer }
 *                     auditOperations:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [operationId, auditNumber, recordedAt, original, current, revisions, incomeReceipt]
 *                         properties:
 *                           operationId: { type: string }
 *                           auditNumber: { type: integer }
 *                           recordedAt: { type: string, format: date-time }
 *                           original: { type: object }
 *                           current: { type: object, nullable: true }
 *                           revisions: { type: array, items: { type: object } }
 *                           incomeReceipt:
 *                             type: object
 *                             nullable: true
 *                             properties:
 *                               assetId: { type: string }
 *                               assetSymbol: { type: string }
 *                               entitlementDate: { type: string, format: date }
 *                               paymentDate: { type: string, format: date }
 *                               currency: { type: string }
 *                               grossAmount: { type: string }
 *                               withholdingAmount: { type: string }
 *                               netAmount: { type: string }
 *                               frankedAmount: { type: string }
 *                               unfrankedAmount: { type: string }
 *                               frankingCreditAud: { type: string }
 *                     auditTotal: { type: integer }
 *                     accountStatus: { type: string, enum: [ACTIVE, CLOSED] }
 *                     ledgerState: { type: string }
 *                     openingBoundary:
 *                       type: object
 *                       required: [date, timezone, type]
 *                       properties:
 *                         date: { type: string, format: date }
 *                         timezone: { type: string, enum: [Australia/Sydney] }
 *                         type: { type: string, enum: [END_OF_DAY] }
 *                     reviewedAsOfDate: { type: string, format: date }
 *                     checkedAt: { type: string, format: date-time }
 *                     sourceFreshness:
 *                       type: object
 *                       required: [status, acceptedFingerprint, currentFingerprint]
 *                       properties:
 *                         status: { type: string, enum: [CURRENT, STALE, NOT_REVALIDATED] }
 *                         acceptedFingerprint: { type: string }
 *                         currentFingerprint: { type: string, nullable: true }
 *                     cashCompleteness: { type: string, enum: [COMPLETE, INCOMPLETE] }
 *                     unsupportedEvents: { type: array, items: { type: object } }
 *                     sourceReviewIssues: { type: array, items: { type: object } }
 *                     evidence: { type: array, items: { type: object } }
 *                     evidenceStatus: { type: string, enum: [MATCHES_REPLAY, VARIANCE, NO_ATTESTATION] }
 *                     auditNumber: { type: integer }
 *                     sourceFingerprint: { type: string }
 *                     replay: { $ref: '#/components/schemas/AccountTradeResponse/properties/data/properties/replay' }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account not found. }
 *       409: { description: No confirmed cash ledger exists, or retained ledger/evidence audit data failed integrity validation. }
 */
router.get(
  '/:id/cash-operations',
  [
    param('id').isString().trim().notEmpty(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await readLiveCapitalOperations(
      req.user!.userId,
      req.params.id,
      req.query.limit ? Number(req.query.limit) : 100,
      req.query.offset ? Number(req.query.offset) : 0
    )
    res.json({ success: true, data: result })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/cash-operations/{operationId}/corrections:
 *   post:
 *     summary: Correct or reverse a live deposit or withdrawal
 *     description: Appends an immutable cash-only revision. Replacements retain operation kind, source reference and currency; reversal is terminal. Dated replay must remain funded.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *             required: [idempotencyKey, expectedRevisionId, expectedAuditNumber, expectedSourceFingerprint, reason, replacement]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *               expectedAuditNumber: { type: integer, minimum: 0 }
 *               expectedSourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               replacement:
 *                 oneOf:
 *                   - type: 'null'
 *                   - type: object
 *                     additionalProperties: false
 *                     required: [effectiveDate, sequence, amount]
 *                     properties:
 *                       effectiveDate: { type: string, format: date }
 *                       sequence: { type: integer, minimum: 1 }
 *                       amount: { type: string, description: Exact positive decimal amount. }
 *     responses:
 *       201:
 *         description: Immutable correction/reversal and its cash postings were committed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [operationId, revisionId, created, replay]
 *                   properties:
 *                     operationId: { type: string }
 *                     revisionId: { type: string }
 *                     created: { type: boolean }
 *                     replay: { $ref: '#/components/schemas/AccountTradeResponse/properties/data/properties/replay' }
 *       200:
 *         description: Idempotent retry of a prior correction/reversal.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data: { type: object }
 *       400: { description: Invalid correction request. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account or live funding operation not found. }
 *       409: { description: Stale audit head, concurrent correction, or reserved date/sequence. }
 *       422: { description: Corrected or reversed funding would leave a dated balance negative. }
 */
router.post(
  '/:id/cash-operations/:operationId/corrections',
  [
    param('id').isString().trim().notEmpty(),
    param('operationId').isString().trim().notEmpty(),
    body('idempotencyKey').isString().isLength({ min: 1, max: 200 }),
    body('expectedRevisionId').isString().isLength({ min: 1, max: 200 }),
    body('expectedAuditNumber').isInt({
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    body('expectedSourceFingerprint').matches(/^[a-f0-9]{64}$/),
    body('reason').isString().isLength({ min: 1, max: 1000 }),
    body('replacement').custom((value: unknown) => {
      if (value === null) return true
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false
      const replacement = value as Record<string, unknown>
      return (
        Object.keys(replacement).length === 3 &&
        Object.keys(replacement).every((key) =>
          ['effectiveDate', 'sequence', 'amount'].includes(key)
        ) &&
        typeof replacement.effectiveDate === 'string' &&
        Number.isSafeInteger(replacement.sequence) &&
        (replacement.sequence as number) > 0 &&
        typeof replacement.amount === 'string'
      )
    }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await correctLiveCapitalOperation(
      req.user!.userId,
      req.params.id,
      req.params.operationId,
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

/**
 * @swagger
 * /api/accounts/{id}/trades/{transactionId}/voids:
 *   post:
 *     summary: Void an audited live manual trade without deleting its records
 *     description: SELL voids restore parcel inventory and remove proceeds from cash replay. BUY voids require no effective sales. Only active real ledgers and manual parcels are supported. The terminal revision retains original trades, postings and date/sequence reservations. No account is activated.
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
 *             additionalProperties: false
 *             required: [idempotencyKey, expectedRevisionId, expectedSourceFingerprint, reason]
 *             properties:
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
 *               expectedRevisionId: { type: string, minLength: 1, maxLength: 200 }
 *               expectedSourceFingerprint: { type: string, pattern: '^[a-f0-9]{64}$' }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *     responses:
 *       201:
 *         description: Trade void, parcel update and cash reversal committed atomically.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LiveExecutionCorrectionResponse' }
 *       200:
 *         description: Idempotent retry of an already committed void.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LiveExecutionCorrectionResponse' }
 *       400: { description: Invalid void request. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned live manual trade not found. }
 *       409: { description: Stale source/revision, terminal trade or unsupported parcel. }
 *       422: { description: Removing the trade would leave insufficient cash or unsupported history. }
 */
router.post(
  '/:id/trades/:transactionId/voids',
  [
    param('id').isString().trim().notEmpty(),
    param('transactionId').isString().trim().notEmpty(),
    body('idempotencyKey').isString().notEmpty().isLength({ max: 200 }),
    body('expectedRevisionId').isString().notEmpty().isLength({ max: 200 }),
    body('expectedSourceFingerprint')
      .isString()
      .matches(/^[a-f0-9]{64}$/),
    body('reason').isString().notEmpty().isLength({ max: 1000 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await voidLiveManualTrade(
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
 * /api/accounts/{id}/trades/voids:
 *   get:
 *     summary: Read retained manual trade void audits for a confirmed real ledger
 *     description: Read-only audit access remains available on archived accounts. The stored operation, revision, posting and void-marker chain is validated; this is not a current cash reconciliation or source-freshness assertion.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *     responses:
 *       200:
 *         description: Retained voids sorted by void timestamp descending.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [items, total, limit, offset]
 *                   properties:
 *                     total: { type: integer }
 *                     limit: { type: integer }
 *                     offset: { type: integer }
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [operationId, revisionId, transactionId, positionId, kind, voidedAt, reason, before]
 *                         properties:
 *                           operationId: { type: string }
 *                           revisionId: { type: string }
 *                           transactionId: { type: string }
 *                           positionId: { type: string }
 *                           kind: { type: string, enum: [BUY, SELL] }
 *                           voidedAt: { type: string, format: date-time }
 *                           reason: { type: string }
 *                           before:
 *                             type: object
 *                             required: [transactionId, positionId, date, quantity, price, totalValue, fees, currency]
 *                             properties:
 *                               transactionId: { type: string }
 *                               positionId: { type: string }
 *                               date: { type: string, format: date-time }
 *                               quantity: { type: string }
 *                               price: { type: string }
 *                               totalValue: { type: string }
 *                               fees: { type: string }
 *                               currency: { type: string }
 *       400: { description: Invalid pagination. }
 *       401: { description: Unauthorized. }
 *       404: { description: Owned account not found. }
 *       409: { description: Account is not ledger-enabled or retained audit history is inconsistent. }
 */
router.get(
  '/:id/trades/voids',
  [
    param('id').isString().trim().notEmpty(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const result = await readLiveManualTradeVoids(
      req.user!.userId,
      req.params.id,
      req.query.limit === undefined ? 100 : Number(req.query.limit),
      req.query.offset === undefined ? 0 : Number(req.query.offset)
    )
    res.json({ success: true, data: result })
  })
)

export default router
