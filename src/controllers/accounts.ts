import { Router, Request, Response } from 'express'
import { body, query } from 'express-validator'
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
 *     parameters:
 *       - in: query
 *         name: exchangeCode
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional exchange code filter (e.g. ASX, NASDAQ)
 *     responses:
 *       200:
 *         description: Trading accounts
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  [
    query('exchangeCode').optional().isString().trim().toUpperCase(),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const exchangeCode =
      typeof req.query.exchangeCode === 'string'
        ? req.query.exchangeCode
        : undefined

    const accounts = await prisma.tradingAccount.findMany({
      where: {
        userId: req.user!.userId,
        ...(exchangeCode ? { exchange: { code: exchangeCode } } : {}),
      },
      include: { exchange: true },
      orderBy: [{ exchange: { code: 'asc' } }, { name: 'asc' }],
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
 *               - exchangeCode
 *               - name
 *             properties:
 *               exchangeCode:
 *                 type: string
 *                 example: ASX
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
    body('exchangeCode').isString().trim().toUpperCase(),
    body('name').isString().trim().isLength({ min: 1, max: 80 }),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const exchangeCode = String(req.body.exchangeCode).trim().toUpperCase()
    const name = String(req.body.name).trim()

    const exchange = await prisma.exchange.findUnique({
      where: { code: exchangeCode },
      select: { id: true },
    })

    if (!exchange) {
      return res
        .status(404)
        .json({
          error: 'Not Found',
          message: `Exchange '${exchangeCode}' not found`,
        })
    }

    const existing = await prisma.tradingAccount.findUnique({
      where: {
        userId_exchangeId_name: {
          userId: req.user!.userId,
          exchangeId: exchange.id,
          name,
        },
      },
      include: { exchange: true },
    })

    if (existing) {
      return res.status(200).json({ success: true, data: existing })
    }

    const created = await prisma.tradingAccount.create({
      data: {
        userId: req.user!.userId,
        exchangeId: exchange.id,
        name,
      },
      include: { exchange: true },
    })

    res.status(201).json({ success: true, data: created })
  })
)

export default router
