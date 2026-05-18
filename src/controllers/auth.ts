import { Router, Request, Response } from 'express'
import { body } from 'express-validator'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { prisma } from '../lib/prisma.js'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  refreshTokenExpiresAt,
} from '../lib/jwt.js'
import {
  asyncHandler,
  handleValidationErrors,
} from '../middleware/validation.js'
import { authenticateToken } from '../middleware/auth.js'

const router = Router()

const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Must be a valid email'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
  body('name').optional().isString().trim().isLength({ min: 1 }),
  handleValidationErrors,
]

const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
  handleValidationErrors,
]

// POST /api/auth/register
router.post(
  '/register',
  registerValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password, name } = req.body

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return res
        .status(409)
        .json({ error: 'Conflict', message: 'Email already registered' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await prisma.user.create({
      data: { email, name, passwordHash },
      select: {
        id: true,
        email: true,
        name: true,
        baseCurrency: true,
        createdAt: true,
      },
    })

    const payload = { userId: user.id, email: user.email }
    const accessToken = signAccessToken(payload)
    const refreshToken = signRefreshToken(payload)

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: refreshTokenExpiresAt(),
      },
    })

    res
      .status(201)
      .json({ success: true, data: { user, accessToken, refreshToken } })
  })
)

// POST /api/auth/login
router.post(
  '/login',
  loginValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        baseCurrency: true,
        passwordHash: true,
        createdAt: true,
      },
    })

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res
        .status(401)
        .json({ error: 'Unauthorized', message: 'Invalid credentials' })
    }

    const payload = { userId: user.id, email: user.email }
    const accessToken = signAccessToken(payload)
    const refreshToken = signRefreshToken(payload)

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: refreshTokenExpiresAt(),
      },
    })

    const { passwordHash: _, ...safeUser } = user
    res.json({
      success: true,
      data: { user: safeUser, accessToken, refreshToken },
    })
  })
)

// POST /api/auth/refresh
router.post(
  '/refresh',
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body
    if (!refreshToken) {
      return res
        .status(400)
        .json({ error: 'Bad Request', message: 'refreshToken is required' })
    }

    let payload
    try {
      payload = verifyRefreshToken(refreshToken)
    } catch {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired refresh token',
      })
    }

    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    })
    if (!stored || stored.expiresAt < new Date()) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Refresh token revoked or expired',
      })
    }

    // Rotate: delete old, issue new pair
    await prisma.refreshToken.delete({ where: { token: refreshToken } })

    const newPayload = { userId: payload.userId, email: payload.email }
    const newAccessToken = signAccessToken(newPayload)
    const newRefreshToken = signRefreshToken(newPayload)

    await prisma.refreshToken.create({
      data: {
        userId: payload.userId,
        token: newRefreshToken,
        expiresAt: refreshTokenExpiresAt(),
      },
    })

    res.json({
      success: true,
      data: { accessToken: newAccessToken, refreshToken: newRefreshToken },
    })
  })
)

// POST /api/auth/logout
router.post(
  '/logout',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body
    if (refreshToken) {
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } })
    }
    res.json({ success: true, message: 'Logged out successfully' })
  })
)

// POST /api/auth/forgot-password
router.post(
  '/forgot-password',
  [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Must be a valid email'),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body

    const user = await prisma.user.findUnique({ where: { email } })

    // Always respond with 200 to avoid leaking whether email is registered
    if (!user) {
      return res.json({
        success: true,
        message: 'If that email is registered you will receive a reset link.',
      })
    }

    // Invalidate any existing reset tokens for this user
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } })

    const rawToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

    await prisma.passwordResetToken.create({
      data: { userId: user.id, token: rawToken, expiresAt },
    })

    // TODO: send email with reset link containing `rawToken`
    // For development the token is returned directly in the response.
    res.json({
      success: true,
      message: 'If that email is registered you will receive a reset link.',
      ...(process.env.NODE_ENV !== 'production' && { resetToken: rawToken }),
    })
  })
)

// POST /api/auth/reset-password
router.post(
  '/reset-password',
  [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters'),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const { token, password } = req.body

    const stored = await prisma.passwordResetToken.findUnique({
      where: { token },
    })

    if (!stored || stored.expiresAt < new Date()) {
      return res
        .status(400)
        .json({
          error: 'Bad Request',
          message: 'Invalid or expired reset token',
        })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    await prisma.user.update({
      where: { id: stored.userId },
      data: { passwordHash },
    })

    // Invalidate the used token and all refresh tokens for this user
    await prisma.passwordResetToken.delete({ where: { token } })
    await prisma.refreshToken.deleteMany({ where: { userId: stored.userId } })

    res.json({ success: true, message: 'Password updated successfully' })
  })
)

export default router
