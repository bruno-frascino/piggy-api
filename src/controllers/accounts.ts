import { Router, Request, Response } from 'express'
import { body, param, query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'

const router = Router()
router.use(authenticateToken)

/**
 * @swagger
 * /api/accounts:
 *   get:
 *     summary: List trading accounts for the authenticated user
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
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const name = String(req.body.name).trim()

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
        const reopened = await prisma.tradingAccount.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            closedAt: null,
          },
        })
        return res.status(200).json({ success: true, data: reopened })
      }

      return res.status(200).json({ success: true, data: existing })
    }

    const created = await prisma.tradingAccount.create({
      data: {
        userId: req.user!.userId,
        name,
      },
    })

    res.status(201).json({ success: true, data: created })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/close:
 *   post:
 *     summary: Close a trading account while preserving history
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

    const account = await prisma.tradingAccount.findFirst({
      where: { id, userId },
      select: { id: true, name: true, status: true },
    })

    if (!account) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trading account not found',
      })
    }

    if (account.status === 'CLOSED') {
      return res.json({ success: true, data: account })
    }

    const openPositionsCount = await prisma.position.count({
      where: {
        accountId: id,
        userId,
        status: { in: ['OPEN', 'PARTIAL'] },
      },
    })

    if (openPositionsCount > 0) {
      return res.status(409).json({
        error: 'Conflict',
        message:
          'Account still has open positions. Close them before archiving this account.',
      })
    }

    const closed = await prisma.tradingAccount.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
      },
    })

    res.json({ success: true, data: closed })
  })
)

/**
 * @swagger
 * /api/accounts/{id}/reopen:
 *   post:
 *     summary: Reopen a closed trading account
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

    const account = await prisma.tradingAccount.findFirst({
      where: { id, userId },
      select: { id: true },
    })

    if (!account) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trading account not found',
      })
    }

    const reopened = await prisma.tradingAccount.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        closedAt: null,
      },
    })

    res.json({ success: true, data: reopened })
  })
)

/**
 * @swagger
 * /api/accounts/{id}:
 *   patch:
 *     summary: Update a trading account
 *     description: Rename a trading account
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

    const account = await prisma.tradingAccount.findFirst({
      where: { id, userId },
      select: { id: true, name: true },
    })

    if (!account) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trading account not found',
      })
    }

    // Check if the new name conflicts with another account
    const existingWithName = await prisma.tradingAccount.findFirst({
      where: { userId, name, id: { not: id } },
      select: { id: true },
    })

    if (existingWithName) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'An account with this name already exists',
      })
    }

    const updated = await prisma.tradingAccount.update({
      where: { id },
      data: { name },
    })

    res.json({ success: true, data: updated })
  })
)

/**
 * @swagger
 * /api/accounts/{id}:
 *   delete:
 *     summary: Delete a trading account
 *     description: Deletes an empty trading account owned by the authenticated user.
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
 *         description: Account has related data and cannot be deleted
 */
router.delete(
  '/:id',
  [param('id').isString().trim().isLength({ min: 1 }), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id)
    const userId = req.user!.userId

    const account = await prisma.tradingAccount.findFirst({
      where: { id, userId },
      select: { id: true, name: true },
    })

    if (!account) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trading account not found',
      })
    }

    const [positionsCount, snapshotsCount] = await Promise.all([
      prisma.position.count({ where: { accountId: id, userId } }),
      prisma.portfolioSnapshot.count({ where: { accountId: id, userId } }),
    ])

    if (positionsCount > 0 || snapshotsCount > 0) {
      return res.status(409).json({
        error: 'Conflict',
        message:
          'Account cannot be deleted while it still has positions or snapshots',
      })
    }

    await prisma.tradingAccount.delete({ where: { id } })

    res.json({ success: true, message: `Account '${account.name}' deleted` })
  })
)

export default router
