import { router, publicProcedure } from '../lib/trpc.js'
import { z } from 'zod'
import {
  CreateStockSchema,
  GetPriceHistorySchema,
  PriceHistorySchema,
} from '../types/index.js'

export const stockRouter = router({
  // Create a new stock
  create: publicProcedure
    .input(CreateStockSchema)
    .mutation(async ({ input, ctx }) => {
      const stock = await ctx.prisma.stock.create({
        data: input,
        include: {
          exchange: true,
        },
      })
      return stock
    }),

  // Get all stocks with optional filtering
  list: publicProcedure
    .input(
      z.object({
        exchangeId: z.string().cuid().optional(),
        sector: z.string().optional(),
        search: z.string().optional(),
        isActive: z.boolean().optional(),
        limit: z.number().int().positive().max(200).default(50),
        offset: z.number().int().nonnegative().default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const { exchangeId, sector, search, isActive, limit, offset } = input

      const where: any = {}
      if (exchangeId) where.exchangeId = exchangeId
      if (sector) where.sector = sector
      if (isActive !== undefined) where.isActive = isActive
      if (search) {
        where.OR = [
          { symbol: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ]
      }

      const stocks = await ctx.prisma.stock.findMany({
        where,
        include: {
          exchange: true,
          _count: {
            select: {
              positions: true,
              priceHistory: true,
            },
          },
        },
        orderBy: { symbol: 'asc' },
        take: limit,
        skip: offset,
      })

      const total = await ctx.prisma.stock.count({ where })

      return {
        stocks,
        total,
        hasMore: offset + limit < total,
      }
    }),

  // Get a single stock by ID
  getById: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const stock = await ctx.prisma.stock.findUnique({
        where: { id: input.id },
        include: {
          exchange: true,
          _count: {
            select: {
              positions: true,
              priceHistory: true,
            },
          },
        },
      })

      if (!stock) {
        throw new Error('Stock not found')
      }

      return stock
    }),

  // Get stock by symbol and exchange
  getBySymbol: publicProcedure
    .input(
      z.object({
        symbol: z.string(),
        exchangeCode: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { symbol, exchangeCode } = input

      const where: any = { symbol: symbol.toUpperCase() }
      if (exchangeCode) {
        where.exchange = { code: exchangeCode }
      }

      const stock = await ctx.prisma.stock.findFirst({
        where,
        include: {
          exchange: true,
        },
      })

      if (!stock) {
        throw new Error('Stock not found')
      }

      return stock
    }),

  // Update stock information
  update: publicProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().optional(),
        sector: z.string().optional(),
        industry: z.string().optional(),
        marketCap: z.number().positive().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...updateData } = input

      const stock = await ctx.prisma.stock.update({
        where: { id },
        data: updateData,
        include: {
          exchange: true,
        },
      })

      return stock
    }),

  // Get price history for a stock
  getPriceHistory: publicProcedure
    .input(GetPriceHistorySchema)
    .query(async ({ input, ctx }) => {
      const { stockId, startDate, endDate, limit } = input

      const where: any = { stockId }
      if (startDate || endDate) {
        where.date = {}
        if (startDate) where.date.gte = startDate
        if (endDate) where.date.lte = endDate
      }

      const priceHistory = await ctx.prisma.priceHistory.findMany({
        where,
        orderBy: { date: 'desc' },
        take: limit,
      })

      return priceHistory
    }),

  // Add price history data
  addPriceHistory: publicProcedure
    .input(PriceHistorySchema)
    .mutation(async ({ input, ctx }) => {
      const priceHistory = await ctx.prisma.priceHistory.upsert({
        where: {
          stockId_date: {
            stockId: input.stockId,
            date: input.date,
          },
        },
        update: {
          open: input.open,
          high: input.high,
          low: input.low,
          close: input.close,
          volume: input.volume,
        },
        create: input,
      })

      return priceHistory
    }),

  // Bulk add price history
  addBulkPriceHistory: publicProcedure
    .input(
      z.object({
        stockId: z.string().cuid(),
        data: z.array(
          z.object({
            date: z.date(),
            open: z.number().positive(),
            high: z.number().positive(),
            low: z.number().positive(),
            close: z.number().positive(),
            volume: z.number().nonnegative().optional(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { stockId, data } = input

      const priceHistoryData = data.map((item) => ({
        ...item,
        stockId,
      }))

      // Use createMany for bulk insert (will skip duplicates)
      const result = await ctx.prisma.priceHistory.createMany({
        data: priceHistoryData,
        skipDuplicates: true,
      })

      return { created: result.count }
    }),

  // Get latest price for a stock
  getLatestPrice: publicProcedure
    .input(z.object({ stockId: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const latestPrice = await ctx.prisma.priceHistory.findFirst({
        where: { stockId: input.stockId },
        orderBy: { date: 'desc' },
      })

      return latestPrice
    }),

  // Get stocks with recent activity
  getPopularStocks: publicProcedure
    .input(
      z.object({
        limit: z.number().int().positive().max(50).default(10),
      })
    )
    .query(async ({ input, ctx }) => {
      const stocks = await ctx.prisma.stock.findMany({
        include: {
          exchange: true,
          _count: {
            select: {
              positions: {
                where: {
                  createdAt: {
                    gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
                  },
                },
              },
            },
          },
        },
        orderBy: {
          positions: {
            _count: 'desc',
          },
        },
        take: input.limit,
      })

      return stocks
    }),

  // Delete a stock (only if no positions exist)
  delete: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ input, ctx }) => {
      // Check if stock has any positions
      const positionCount = await ctx.prisma.position.count({
        where: { stockId: input.id },
      })

      if (positionCount > 0) {
        throw new Error('Cannot delete stock with existing positions')
      }

      // Delete price history first (cascade should handle this, but being explicit)
      await ctx.prisma.priceHistory.deleteMany({
        where: { stockId: input.id },
      })

      await ctx.prisma.stock.delete({
        where: { id: input.id },
      })

      return { success: true }
    }),
})
