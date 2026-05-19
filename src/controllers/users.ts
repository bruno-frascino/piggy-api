import { Router, Request, Response } from 'express'
import { body } from 'express-validator'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'

const router = Router()

// All user routes require authentication
router.use(authenticateToken)

// GET /api/users/me
/**
 * @swagger
 * /api/users/me:
 *   get:
 *     summary: Get the authenticated user's profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        baseCurrency: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    if (!user) {
      return res
        .status(404)
        .json({ error: 'Not Found', message: 'User not found' })
    }
    res.json({ success: true, data: user })
  })
)

// PATCH /api/users/me
/**
 * @swagger
 * /api/users/me:
 *   patch:
 *     summary: Update the authenticated user's profile or password
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               baseCurrency:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 3
 *                 example: USD
 *               currentPassword:
 *                 type: string
 *                 description: Required when changing password
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 *                 description: Must be at least 8 characters
 *     responses:
 *       200:
 *         description: Profile updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: currentPassword is required when setting a new password
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Current password incorrect or not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.patch(
  '/me',
  [
    body('name').optional().isString().trim().isLength({ min: 1 }),
    body('baseCurrency').optional().isString().isLength({ min: 3, max: 3 }),
    body('currentPassword').optional().isString(),
    body('newPassword')
      .optional()
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters'),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const { name, baseCurrency, currentPassword, newPassword } = req.body
    const updateData: Record<string, unknown> = {}

    if (name !== undefined) updateData.name = name
    if (baseCurrency !== undefined)
      updateData.baseCurrency = baseCurrency.toUpperCase()

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'currentPassword is required to set a new password',
        })
      }
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
      })
      if (
        !user ||
        !(await bcrypt.compare(currentPassword, user.passwordHash))
      ) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Current password is incorrect',
        })
      }
      updateData.passwordHash = await bcrypt.hash(newPassword, 12)
    }

    const updated = await prisma.user.update({
      where: { id: req.user!.userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        baseCurrency: true,
        updatedAt: true,
      },
    })
    res.json({ success: true, data: updated })
  })
)

export default router
