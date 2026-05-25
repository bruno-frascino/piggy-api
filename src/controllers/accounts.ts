import { Router, Request, Response } from 'express'
import { body } from 'express-validator'
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
  asyncHandler(async (req: Request, res: Response) => {
    const accounts = await prisma.tradingAccount.findMany({
      where: {
        userId: req.user!.userId,
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

export default router
