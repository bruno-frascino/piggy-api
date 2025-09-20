import { Router, Request, Response } from 'express'
import { body, param, query } from 'express-validator'
import { prisma } from '../lib/prisma.js'
import {
  asyncHandler,
  handleValidationErrors,
  validateCuid,
} from '../middleware/validation.js'

const router = Router()

// Validation rules
const createUserValidation = [
  body('email').isEmail().withMessage('Must be a valid email'),
  body('name').optional().isString().trim().isLength({ min: 1 }),
  handleValidationErrors,
]

const updateUserValidation = [
  param('id').isString(),
  body('email').optional().isEmail().withMessage('Must be a valid email'),
  body('name').optional().isString().trim().isLength({ min: 1 }),
  handleValidationErrors,
]

const getUsersValidation = [
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('offset').optional().isInt({ min: 0 }).toInt(),
  handleValidationErrors,
]

// Routes

/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Create a new user
 *     tags: [Users]
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
 *               name:
 *                 type: string
 *     responses:
 *       201:
 *         description: User created successfully
 *       400:
 *         description: Validation error
 */
router.post(
  '/',
  createUserValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, name } = req.body

    const user = await prisma.user.create({
      data: { email, name },
    })

    res.status(201).json({ success: true, data: user })
  })
)

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users
 *     tags: [Users]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *     responses:
 *       200:
 *         description: List of users
 */
router.get(
  '/',
  getUsersValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 50
    const offset = Number(req.query.offset) || 0

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        include: {
          _count: {
            select: {
              positions: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.user.count(),
    ])

    res.json({
      success: true,
      data: {
        users,
        total,
        hasMore: offset + limit < total,
        pagination: {
          limit,
          offset,
          total,
        },
      },
    })
  })
)

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Get user by ID
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User found
 *       404:
 *         description: User not found
 */
router.get(
  '/:id',
  validateCuid('id'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            positions: true,
          },
        },
      },
    })

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      })
    }

    res.json({ success: true, data: user })
  })
)

/**
 * @swagger
 * /api/users/email/{email}:
 *   get:
 *     summary: Get user by email
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *           format: email
 *     responses:
 *       200:
 *         description: User found
 *       404:
 *         description: User not found
 */
router.get(
  '/email/:email',
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.params

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        _count: {
          select: {
            positions: true,
          },
        },
      },
    })

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      })
    }

    res.json({ success: true, data: user })
  })
)

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update user
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: User updated successfully
 *       404:
 *         description: User not found
 */
router.put(
  '/:id',
  validateCuid('id'),
  updateUserValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params
    const { email, name } = req.body

    const updateData: { email?: string; name?: string } = {}
    if (email) updateData.email = email
    if (name !== undefined) updateData.name = name

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
    })

    res.json({ success: true, data: user })
  })
)

/**
 * @swagger
 * /api/users/{id}/portfolio:
 *   get:
 *     summary: Get user portfolio summary
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Portfolio summary
 *       404:
 *         description: User not found
 */
router.get(
  '/:id/portfolio',
  validateCuid('id'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id: userId } = req.params

    // Get open positions
    const openPositions = await prisma.position.findMany({
      where: {
        userId,
        status: 'OPEN',
      },
      include: {
        stock: {
          include: {
            exchange: true,
          },
        },
      },
    })

    // Get closed positions for performance calculation
    const closedPositions = await prisma.position.findMany({
      where: {
        userId,
        status: 'CLOSED',
      },
      select: {
        realizedPnL: true,
        capitalAllocated: true,
        returnPercentage: true,
      },
    })

    // Calculate summary metrics
    const totalOpenPositions = openPositions.length
    const totalInvested = openPositions.reduce(
      (sum, p) => sum + Number(p.capitalAllocated),
      0
    )
    const totalValue = openPositions.reduce(
      (sum, p) => sum + Number(p.totalBuyValue),
      0
    )

    const totalRealizedPnL = closedPositions.reduce(
      (sum, p) => sum + Number(p.realizedPnL || 0),
      0
    )
    const avgReturn =
      closedPositions.length > 0
        ? closedPositions.reduce(
            (sum, p) => sum + Number(p.returnPercentage || 0),
            0
          ) / closedPositions.length
        : 0

    const user = await prisma.user.findUnique({ where: { id: userId } })

    res.json({
      success: true,
      data: {
        user,
        summary: {
          totalOpenPositions,
          totalInvested,
          totalValue,
          totalRealizedPnL,
          avgReturn,
          totalClosedPositions: closedPositions.length,
        },
        openPositions,
        recentPositions: openPositions.slice(0, 5),
      },
    })
  })
)

/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Delete user
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User deleted successfully
 *       400:
 *         description: Cannot delete user with existing positions
 *       404:
 *         description: User not found
 */
router.delete(
  '/:id',
  validateCuid('id'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params

    // Check if user has any positions
    const positionCount = await prisma.position.count({
      where: { userId: id },
    })

    if (positionCount > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete user with existing positions',
      })
    }

    await prisma.user.delete({
      where: { id },
    })

    res.json({ success: true, message: 'User deleted successfully' })
  })
)

export default router
