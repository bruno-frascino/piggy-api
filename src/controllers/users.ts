import { Router, Request, Response } from 'express'
import { body } from 'express-validator'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'
import { scheduleUserDeletion } from '../lib/account-deletion.js'
import { lockUserLifecycle } from '../lib/user-lock.js'

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
 *     description: Rechecks active user state and any verified password under an exclusive user lock before updating. An in-flight deletion or password change requires authentication again.
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
    let verifiedPasswordHash: string | undefined

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
      verifiedPasswordHash = user.passwordHash
      updateData.passwordHash = await bcrypt.hash(newPassword, 12)
    }

    const updated = await prisma.$transaction(
      async (db) => {
        const userId = req.user!.userId
        await lockUserLifecycle(db, userId)
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { deletedAt: true, passwordHash: true },
        })
        if (
          !user ||
          user.deletedAt ||
          (verifiedPasswordHash !== undefined &&
            user.passwordHash !== verifiedPasswordHash)
        )
          throw Object.assign(
            new Error(
              'Session or password changed. Please authenticate again.'
            ),
            {
              status: 401,
              name: 'Unauthorized',
            }
          )
        return db.user.update({
          where: { id: userId },
          data: updateData,
          select: {
            id: true,
            email: true,
            name: true,
            baseCurrency: true,
            updatedAt: true,
          },
        })
      },
      { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
    )
    res.json({ success: true, data: updated })
  })
)

// DELETE /api/users/me
/**
 * @swagger
 * /api/users/me:
 *   delete:
 *     summary: Schedule the authenticated user's account for deletion
 *     description: >
 *       Marks the account deleted and revokes every session immediately. The
 *       data is retained until the grace period expires, during which signing in
 *       returns 403 with `accountPendingDeletion` and the account can be restored
 *       via POST /api/auth/restore. After that a scheduled purge removes the user
 *       and all their positions, accounts, snapshots, tax reports and watchlists.
 *       An exclusive user lock waits for participating financial writes before marking
 *       deletion and revoking sessions together. In-flight writes waiting behind deletion
 *       are refused even if their initial authentication check already succeeded.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account scheduled for deletion
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     deletedAt:
 *                       type: string
 *                       format: date-time
 *                     purgeAfter:
 *                       type: string
 *                       format: date-time
 *       401:
 *         description: Current password incorrect or not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete(
  '/me',
  [body('currentPassword').isString().notEmpty(), handleValidationErrors],
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    })

    if (
      !user ||
      !(await bcrypt.compare(
        String(req.body.currentPassword),
        user.passwordHash
      ))
    ) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Current password is incorrect',
      })
    }

    const { deletedAt, purgeAfter } = await scheduleUserDeletion(
      userId,
      user.passwordHash
    )

    res.json({ success: true, data: { deletedAt, purgeAfter } })
  })
)

export default router
