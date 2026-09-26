import { Router, Request, Response } from 'express'
import { body } from 'express-validator'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
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
import { buildPasswordResetUrl, sendPasswordResetEmail } from '../lib/mailer.js'

const router = Router()

const sanitizeEmail = (value: unknown) => {
  if (typeof value !== 'string') return value
  return value.trim().toLowerCase()
}

// Only the hash is persisted, so a leaked database cannot be replayed as a reset link.
const hashResetToken = (rawToken: string) =>
  crypto.createHash('sha256').update(rawToken).digest('hex')

// Throttled per IP *and* per target address so neither an attacker nor a mail-bomb
// against one user can burn the provider quota.
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: Request) => {
    const email = sanitizeEmail(req.body?.email)
    return `${ipKeyGenerator(req.ip ?? '')}:${typeof email === 'string' ? email : ''}`
  },
  message: {
    error: 'Too Many Requests',
    message: 'Too many password reset requests. Please try again later.',
  },
})

const registerValidation = [
  body('email')
    .customSanitizer(sanitizeEmail)
    .isEmail()
    .withMessage('Must be a valid email'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
  body('name').optional().isString().trim().isLength({ min: 1 }),
  handleValidationErrors,
]

const loginValidation = [
  body('email').customSanitizer(sanitizeEmail).isEmail(),
  body('password').notEmpty().withMessage('Password is required'),
  handleValidationErrors,
]

// POST /api/auth/register
/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user account
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *               name:
 *                 type: string
 *     responses:
 *       201:
 *         description: User created — returns user object + accessToken + refreshToken
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
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *       409:
 *         description: Email already registered
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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
/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Sign in with email and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Authenticated — returns user object + accessToken + refreshToken
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
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Account is scheduled for deletion — restore it to sign in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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
        deletedAt: true,
        purgeAfter: true,
        createdAt: true,
      },
    })

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res
        .status(401)
        .json({ error: 'Unauthorized', message: 'Invalid credentials' })
    }

    // Only revealed after the password checks out, so this cannot be used to
    // probe which addresses have accounts.
    if (user.deletedAt) {
      return res.status(403).json({
        error: 'Forbidden',
        code: 'accountPendingDeletion',
        message: 'This account is scheduled for deletion.',
        purgeAfter: user.purgeAfter,
      })
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

    const {
      passwordHash: _,
      deletedAt: __,
      purgeAfter: ___,
      ...safeUser
    } = user
    res.json({
      success: true,
      data: { user: safeUser, accessToken, refreshToken },
    })
  })
)

// POST /api/auth/restore
/**
 * @swagger
 * /api/auth/restore:
 *   post:
 *     summary: Cancel a pending account deletion and sign in
 *     description: >
 *       Valid only while the account is inside its deletion grace period.
 *       Requires the account password, so a deletion cannot be undone by
 *       anyone who merely knows the email address.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account restored — returns user object + accessToken + refreshToken
 *       401:
 *         description: Invalid credentials
 *       409:
 *         description: Account is not pending deletion
 */
router.post(
  '/restore',
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
        deletedAt: true,
        createdAt: true,
      },
    })

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res
        .status(401)
        .json({ error: 'Unauthorized', message: 'Invalid credentials' })
    }

    if (!user.deletedAt) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'This account is not scheduled for deletion.',
      })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { deletedAt: null, purgeAfter: null },
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

    const { passwordHash: _, deletedAt: __, ...safeUser } = user
    res.json({
      success: true,
      data: { user: safeUser, accessToken, refreshToken },
    })
  })
)

// POST /api/auth/refresh
/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Exchange a refresh token for a new access + refresh token pair (rotation)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New token pair issued
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
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *       401:
 *         description: Invalid or expired refresh token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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
/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Revoke the current refresh token and sign out
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: The refresh token to revoke
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         description: Missing or invalid access token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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
/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Request a password reset link
 *     description: >
 *       Emails a reset link to the address if it is registered. Always responds
 *       with 200 regardless of whether the email exists or whether delivery
 *       succeeded (prevents user enumeration). In non-production environments
 *       the `resetToken` field is also included in the response for testing.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Request accepted (same response whether email exists or not)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 resetToken:
 *                   type: string
 *                   description: Included only in non-production environments
 *       429:
 *         description: Too many reset requests for this IP/email
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post(
  '/forgot-password',
  [
    forgotPasswordLimiter,
    body('email')
      .customSanitizer(sanitizeEmail)
      .isEmail()
      .withMessage('Must be a valid email'),
    handleValidationErrors,
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body

    const user = await prisma.user.findUnique({ where: { email } })

    // Always respond with 200 to avoid leaking whether email is registered.
    // An account pending deletion is treated the same way — it is restored via
    // /auth/restore, not by resetting the password.
    if (!user || user.deletedAt) {
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
      data: {
        userId: user.id,
        token: hashResetToken(rawToken),
        expiresAt,
      },
    })

    try {
      await sendPasswordResetEmail(user.email, buildPasswordResetUrl(rawToken))
    } catch (error) {
      // Never surface delivery failures — that would leak which emails are registered.
      console.error('Failed to send password reset email', error)
    }

    res.json({
      success: true,
      message: 'If that email is registered you will receive a reset link.',
      ...(process.env.NODE_ENV !== 'production' && { resetToken: rawToken }),
    })
  })
)

// POST /api/auth/reset-password
/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Set a new password using a reset token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - password
 *             properties:
 *               token:
 *                 type: string
 *                 description: The reset token from the forgot-password response / email link
 *               password:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       200:
 *         description: Password updated successfully
 *       400:
 *         description: Invalid or expired reset token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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
    const tokenHash = hashResetToken(token)

    const stored = await prisma.passwordResetToken.findUnique({
      where: { token: tokenHash },
    })

    if (!stored || stored.expiresAt < new Date()) {
      return res.status(400).json({
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
    await prisma.passwordResetToken.delete({ where: { token: tokenHash } })
    await prisma.refreshToken.deleteMany({ where: { userId: stored.userId } })

    res.json({ success: true, message: 'Password updated successfully' })
  })
)

export default router
