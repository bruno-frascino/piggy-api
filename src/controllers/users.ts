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
        return res
          .status(400)
          .json({
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
        return res
          .status(401)
          .json({
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
