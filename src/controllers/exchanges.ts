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
  body('countryName').isString().trim().isLength({ min: 1 }),
  body('countryCode').isString().trim().isLength({ min: 2, max: 2 }),
  body('symbolSuffix').optional().isString().trim(),
  body('delay').optional().isString().trim(),
  handleValidationErrors,
]

const updateExchangeValidation = [
  param('id').isString(),
  body('name').optional().isString().trim().isLength({ min: 1 }),
  body('countryName').optional().isString().trim().isLength({ min: 1 }),
  body('countryCode').optional().isString().trim().isLength({ min: 2, max: 2 }),
  body('symbolSuffix').optional().isString().trim(),
  body('delay').optional().isString().trim(),
  handleValidationErrors,
]

const getExchangesValidation = [
  query('countryCode').optional().isString(),
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
 *               - countryName
 *               - countryCode
 *             properties:
 *               code:
 *                 type: string
 *                 maxLength: 10
 *               name:
 *                 type: string
 *               currency:
 *                 type: string
 *                 description: ISO 4217 currency code (e.g. USD, AUD, GBP)
 *               countryName:
 *                 type: string
 *               countryCode:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 2
 *               symbolSuffix:
 *                 type: string
 *               delay:
 *                 type: string
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
      currency,
      countryName,
      countryCode,
      symbolSuffix,
      delay,
    } = req.body

    const exchange = await prisma.exchange.create({
      data: {
        code: code.toUpperCase(),
        name,
        currency: currency ? String(currency).toUpperCase() : 'USD',
        countryName,
        countryCode: countryCode.toUpperCase(),
        symbolSuffix: symbolSuffix ?? null,
        delay: delay ?? null,
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
 *         name: countryCode
 *         schema:
 *           type: string
 *         description: Filter by ISO country code (e.g. US, GB)
 *     responses:
 *       200:
 *         description: List of exchanges
 */
router.get(
  '/',
  getExchangesValidation,
  asyncHandler(async (req: Request, res: Response) => {
    const { countryCode } = req.query

    const where: {
      countryCode?: string
    } = {}
    if (countryCode) where.countryCode = String(countryCode).toUpperCase()

    const exchanges = await prisma.exchange.findMany({
      where,
      include: {
        _count: {
          select: {
            assets: true,
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
        assets: {
          take: 10,
          orderBy: { symbol: 'asc' },
        },
        _count: {
          select: {
            assets: true,
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
            assets: true,
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
 *               currency:
 *                 type: string
 *                 description: ISO 4217 currency code (e.g. USD, AUD, GBP)
 *               countryName:
 *                 type: string
 *               countryCode:
 *                 type: string
 *               symbolSuffix:
 *                 type: string
 *               delay:
 *                 type: string
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
    const { name, currency, countryName, countryCode, symbolSuffix, delay } =
      req.body

    const updateData: {
      name?: string
      currency?: string
      countryName?: string
      countryCode?: string
      symbolSuffix?: string | null
      delay?: string | null
    } = {}
    if (name) updateData.name = name
    if (currency) updateData.currency = String(currency).toUpperCase()
    if (countryName) updateData.countryName = countryName
    if (countryCode) updateData.countryCode = countryCode.toUpperCase()
    if (symbolSuffix !== undefined)
      updateData.symbolSuffix = symbolSuffix || null
    if (delay !== undefined) updateData.delay = delay || null

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
    const assetCount = await prisma.asset.count({
      where: { exchangeId: id },
    })

    if (assetCount > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete exchange with existing assets',
      })
    }

    await prisma.exchange.delete({
      where: { id },
    })

    res.json({ success: true, message: 'Exchange deleted successfully' })
  })
)

export default router
