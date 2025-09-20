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
const createExchangeValidation = [
  body('code').isString().trim().isLength({ min: 1, max: 10 }),
  body('name').isString().trim().isLength({ min: 1 }),
  body('country').isString().trim().isLength({ min: 1 }),
  body('timezone').isString().trim().isLength({ min: 1 }),
  body('currency').isString().trim().isLength({ min: 3, max: 3 }),
  body('isActive').optional().isBoolean(),
  handleValidationErrors,
]

const updateExchangeValidation = [
  param('id').isString(),
  body('name').optional().isString().trim().isLength({ min: 1 }),
  body('country').optional().isString().trim().isLength({ min: 1 }),
  body('timezone').optional().isString().trim().isLength({ min: 1 }),
  body('currency').optional().isString().trim().isLength({ min: 3, max: 3 }),
  body('isActive').optional().isBoolean(),
  handleValidationErrors,
]

const getExchangesValidation = [
  query('isActive').optional().isBoolean().toBoolean(),
  query('country').optional().isString(),
  query('currency').optional().isString(),
  handleValidationErrors,
]

// Routes

/**
 * @swagger
 * /api/exchanges:
 *   post:
 *     summary: Create a new exchange
 *     tags: [Exchanges]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *               - name
 *               - country
 *               - timezone
 *               - currency
 *             properties:
 *               code:
 *                 type: string
 *                 maxLength: 10
 *               name:
 *                 type: string
 *               country:
 *                 type: string
 *               timezone:
 *                 type: string
 *               currency:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 3
 *               isActive:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Exchange created successfully
 *       400:
 *         description: Validation error
 */
router.post(
  '/',
  createExchangeValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const {
      code,
      name,
      country,
      timezone,
      currency,
      isActive = true,
    } = req.body

    const exchange = await prisma.exchange.create({
      data: {
        code: code.toUpperCase(),
        name,
        country,
        timezone,
        currency,
        isActive,
      },
    })

    res.status(201).json({ success: true, data: exchange })
  })
)

/**
 * @swagger
 * /api/exchanges:
 *   get:
 *     summary: Get all exchanges
 *     tags: [Exchanges]
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: country
 *         schema:
 *           type: string
 *       - in: query
 *         name: currency
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of exchanges
 */
router.get(
  '/',
  getExchangesValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const { isActive, country, currency } = req.query

    const where: {
      isActive?: boolean
      country?: string
      currency?: string
    } = {}
    if (isActive !== undefined) where.isActive = Boolean(isActive)
    if (country) where.country = String(country)
    if (currency) where.currency = String(currency)

    const exchanges = await prisma.exchange.findMany({
      where,
      include: {
        _count: {
          select: {
            stocks: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    res.json({ success: true, data: exchanges })
  })
)

/**
 * @swagger
 * /api/exchanges/{id}:
 *   get:
 *     summary: Get exchange by ID
 *     tags: [Exchanges]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Exchange found
 *       404:
 *         description: Exchange not found
 */
router.get(
  '/:id',
  validateCuid('id'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params

    const exchange = await prisma.exchange.findUnique({
      where: { id },
      include: {
        stocks: {
          take: 10,
          orderBy: { symbol: 'asc' },
        },
        _count: {
          select: {
            stocks: true,
          },
        },
      },
    })

    if (!exchange) {
      return res.status(404).json({
        success: false,
        error: 'Exchange not found',
      })
    }

    res.json({ success: true, data: exchange })
  })
)

/**
 * @swagger
 * /api/exchanges/code/{code}:
 *   get:
 *     summary: Get exchange by code
 *     tags: [Exchanges]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Exchange found
 *       404:
 *         description: Exchange not found
 */
router.get(
  '/code/:code',
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = req.params

    const exchange = await prisma.exchange.findUnique({
      where: { code: code.toUpperCase() },
      include: {
        _count: {
          select: {
            stocks: true,
          },
        },
      },
    })

    if (!exchange) {
      return res.status(404).json({
        success: false,
        error: 'Exchange not found',
      })
    }

    res.json({ success: true, data: exchange })
  })
)

/**
 * @swagger
 * /api/exchanges/{id}:
 *   put:
 *     summary: Update exchange
 *     tags: [Exchanges]
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
 *               name:
 *                 type: string
 *               country:
 *                 type: string
 *               timezone:
 *                 type: string
 *               currency:
 *                 type: string
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Exchange updated successfully
 *       404:
 *         description: Exchange not found
 */
router.put(
  '/:id',
  validateCuid('id'),
  updateExchangeValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params
    const { name, country, timezone, currency, isActive } = req.body

    const updateData: {
      name?: string
      country?: string
      timezone?: string
      currency?: string
      isActive?: boolean
    } = {}
    if (name) updateData.name = name
    if (country) updateData.country = country
    if (timezone) updateData.timezone = timezone
    if (currency) updateData.currency = currency
    if (isActive !== undefined) updateData.isActive = isActive

    const exchange = await prisma.exchange.update({
      where: { id },
      data: updateData,
    })

    res.json({ success: true, data: exchange })
  })
)

/**
 * @swagger
 * /api/exchanges/{id}:
 *   delete:
 *     summary: Delete exchange
 *     tags: [Exchanges]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Exchange deleted successfully
 *       400:
 *         description: Cannot delete exchange with existing stocks
 *       404:
 *         description: Exchange not found
 */
router.delete(
  '/:id',
  validateCuid('id'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params

    // Check if exchange has any stocks
    const stockCount = await prisma.stock.count({
      where: { exchangeId: id },
    })

    if (stockCount > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete exchange with existing stocks',
      })
    }

    await prisma.exchange.delete({
      where: { id },
    })

    res.json({ success: true, message: 'Exchange deleted successfully' })
  })
)

export default router
