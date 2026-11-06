import { Router, type Request, type Response } from 'express'
import { body, param } from 'express-validator'
import { authenticateToken } from '../middleware/auth.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { postAccountTrade } from '../lib/draft-cash-ledger.js'

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

export default router
