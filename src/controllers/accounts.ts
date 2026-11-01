import { Router, Request, Response } from 'express'
import { body, param, query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import { lockActiveUser } from '../lib/user-lock.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import { previewAccountOpening } from '../lib/accounting-preview-service.js'
import {
  closeTradingAccount,
  reopenTradingAccount,
  renameTradingAccount,
  deleteTradingAccount,
} from '../lib/trading-account-mutations.js'

const router = Router()
router.use(authenticateToken)

/**
 * @swagger
 * /api/accounts/{id}/opening-preview:
 *   post:
 *     summary: Preview opening inventory and trade-only cash without saving financial data
 *     description: Read-only end-of-day Australia/Sydney reconciliation. It cannot confirm or enable accounting. Missing funding is never invented. Limited to 5000 parcels, 500 import batches, 50000 transactions and 10000 relevant import events; exceeding any limit returns 422.
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
 *             required: [openingDate, cashBalances]
 *             properties:
 *               openingDate:
 *                 type: string
 *                 format: date
 *                 description: Valid calendar date no later than today in Australia/Sydney.
 *               cashBalances:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   required: [currency, amount]
 *                   properties:
 *                     currency: { type: string, pattern: '^[A-Z]{3}$', description: Supported ISO currency; unique within request. }
 *                     amount: { type: string, pattern: '^(?:0|[1-9]\d{0,25})(?:\.\d{1,12})?$', description: Explicit non-negative decimal balance. }
 *     responses:
 *       200:
 *         description: Preview only, including blockers and incomplete-cash-history warning.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   required: [accountId, openingDate, timezone, boundary, asOfDate, mode, sourceFingerprint, parcels, cashBalances, issues, counts]
 *                   properties:
 *                     accountId: { type: string }
 *                     openingDate: { type: string, format: date }
 *                     timezone: { type: string, enum: [Australia/Sydney] }
 *                     boundary: { type: string, enum: [END_OF_DAY] }
 *                     asOfDate: { type: string, format: date }
 *                     mode: { type: string, enum: [PREVIEW_ONLY] }
 *                     sourceFingerprint: { type: string, description: Snapshot fingerprint, not an authorisation or confirmation token. }
 *                     parcels:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [positionId, symbol, currency, openingQuantity, expectedCurrentQuantity, recordedCurrentQuantity]
 *                         properties:
 *                           positionId: { type: string }
 *                           symbol: { type: string }
 *                           currency: { type: string }
 *                           openingQuantity: { type: string }
 *                           expectedCurrentQuantity: { type: string }
 *                           recordedCurrentQuantity: { type: string }
 *                     cashBalances:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [currency, openingAmount, tradeOnlyEndingAmount, minimumTradeOnlyAmount]
 *                         properties:
 *                           currency: { type: string }
 *                           openingAmount: { type: string }
 *                           tradeOnlyEndingAmount: { type: string }
 *                           minimumTradeOnlyAmount: { type: string }
 *                     issues:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [code, severity, message, sourceId]
 *                         properties:
 *                           code: { type: string }
 *                           severity: { type: string, enum: [BLOCKING, WARNING] }
 *                           message: { type: string }
 *                           sourceId: { type: string, nullable: true }
 *                     counts:
 *                       type: object
 *                       required: [parcels, postBoundaryTrades, blockingIssues]
 *                       properties:
 *                         parcels: { type: integer }
 *                         postBoundaryTrades: { type: integer }
 *                         blockingIssues: { type: integer }
 *       400:
 *         description: Invalid date, currency or decimal balance.
 *       401:
 *         description: Authentication required.
 *       404:
 *         description: Account not owned by the authenticated user or not found.
 *       422:
 *         description: Account exceeds the interactive preview limit.
 */
router.post(
  '/:id/opening-preview',
  [
    param('id').isString().trim().isLength({ min: 1, max: 100 }),
    body('openingDate').isString(),
    body('cashBalances').isArray({ min: 1, max: 20 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const preview = await previewAccountOpening(
      req.user!.userId,
      String(req.params.id),
      req.body
    )
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, data: preview })
  })
)

/**
 * @swagger
 * /api/accounts:
 *   get:
 *     summary: List trading accounts for the authenticated user
 *     description: Each account includes an immutable `isDemo` flag. Demo accounts are listed here but excluded from tax reports and "All accounts" aggregates.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Trading accounts
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  [
    query('includeClosed').optional().isIn(['true', 'false']),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const includeClosed = req.query.includeClosed === 'true'
    const accounts = await prisma.tradingAccount.findMany({
      where: {
        userId: req.user!.userId,
        ...(includeClosed ? {} : { status: 'ACTIVE' }),
      },
      orderBy: [{ name: 'asc' }],
    })

    res.json({ success: true, data: accounts })
  })
)

/**
 * @swagger
 * /api/accounts:
 *   post:
 *     summary: Create (or return existing) trading account for an exchange
 *     description: An existing closed account with the same name is explicitly reopened under its account lock. New account creation takes the shared user barrier and refuses users deleted during the request.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: Main
 *               isDemo:
 *                 type: boolean
 *                 default: false
 *                 description: >
 *                   Practice account. Chosen at creation only and immutable afterwards.
 *                   Demo accounts are excluded from ATO tax reports and from "All accounts"
 *                   aggregates. Ignored when an account with this name already exists.
 *     responses:
 *       200:
 *         description: Existing account returned
 *       201:
 *         description: Account created
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Exchange not found
 */
router.post(
  '/',
  [
    body('name').isString().trim().isLength({ min: 1, max: 80 }),
    body('isDemo')
      .optional()
      .isBoolean()
      .withMessage('isDemo must be a boolean'),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const name = String(req.body.name).trim()
    const isDemo = req.body.isDemo === true

    const existing = await prisma.tradingAccount.findUnique({
      where: {
        userId_name: {
          userId: req.user!.userId,
          name,
        },
      },
    })

    if (existing) {
      if (existing.status === 'CLOSED') {
        const reopened = await reopenTradingAccount(
          req.user!.userId,
          existing.id
        )
        return res.status(200).json({ success: true, data: reopened })
      }

      return res.status(200).json({ success: true, data: existing })
    }

    const created = await prisma.$transaction(async (db) => {
      await lockActiveUser(db, req.user!.userId)
      return db.tradingAccount.create({
        data: { userId: req.user!.userId, name, isDemo },
      })
    })

    res.status(201).json({ success: true, data: created })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/close:
 *   post:
 *     summary: Close a trading account while preserving history
 *     description: Locks the owned account and checks current open/partial parcels in the same transaction. Reopen before adding new open holdings; historical corrections that leave parcels closed remain allowed. Inactive opening drafts are preserved and never activated.
 *     tags: [Accounts]
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
 *         description: Account closed
 *       404:
 *         description: Account not found
 *       409:
 *         description: Account still has open positions
 */
router.post(
  '/:id/close',
  [param('id').isString().trim().isLength({ min: 1 }), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id)
    const userId = req.user!.userId

    const closed = await closeTradingAccount(userId, id)

    res.json({ success: true, data: closed })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/reopen:
 *   post:
 *     summary: Reopen a closed trading account
 *     description: Serializes reopening with account lifecycle and participating trade/import writes.
 *     tags: [Accounts]
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
 *         description: Account reopened
 *       404:
 *         description: Account not found
 */
router.post(
  '/:id/reopen',
  [param('id').isString().trim().isLength({ min: 1 }), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id)
    const userId = req.user!.userId

    const reopened = await reopenTradingAccount(userId, id)

    res.json({ success: true, data: reopened })
  })
)

/**
 * @swagger
 * /api/accounts/{id}:
 *   patch:
 *     summary: Update a trading account
 *     description: >
 *       Rename a trading account. The `isDemo` flag is immutable; sending it returns 400.
 *       Ownership, name conflict checks and update execute under the account lock.
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: Updated Account Name
 *     responses:
 *       200:
 *         description: Account updated
 *       400:
 *         description: Validation error, or an attempt to change the immutable isDemo flag
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Account not found
 *       409:
 *         description: Account name already exists for this user
 */
router.patch(
  '/:id',
  [
    param('id').isString().trim().isLength({ min: 1 }),
    body('name').isString().trim().isLength({ min: 1, max: 80 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id)
    const userId = req.user!.userId
    const { name } = req.body

    if (req.body.isDemo !== undefined) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'The demo flag cannot be changed after an account is created',
      })
    }

    const updated = await renameTradingAccount(userId, id, name)

    res.json({ success: true, data: updated })
  })
)

/**
 * @swagger
 * /api/accounts/{id}:
 *   delete:
 *     summary: Delete a trading account
 *     description: >
 *       Permanently deletes a trading account owned by the authenticated user, along with
 *       its derived performance history (portfolio snapshots). Demo accounts are deleted
 *       together with everything that belongs to them (positions, transactions, snapshots).
 *       For non-demo accounts, refuses to delete an account that still has positions, or one
 *       that is referenced by a generated tax report — close the account instead to preserve
 *       that history.
 *       Ownership and retention checks run under the same account lock as participating
 *       trade/import writes and new tax-report references. Deletion cascades inactive opening
 *       drafts, draft cash operations and import batches; it does not confirm or activate accounting.
 *     tags: [Accounts]
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
 *         description: Account deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Account not found
 *       409:
 *         description: Non-demo account has positions or is used by a tax report
 */
router.delete(
  '/:id',
  [param('id').isString().trim().isLength({ min: 1 }), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id)
    const userId = req.user!.userId

    const message = await deleteTradingAccount(userId, id)
    res.json({ success: true, message })
  })
)

export default router
