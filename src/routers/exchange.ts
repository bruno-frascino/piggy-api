import { router, publicProcedure } from '../lib/trpc.js'
import { z } from 'zod'
import { CreateExchangeSchema } from '../types/index.js'

export const exchangeRouter = router({
  // Create a new exchange
  create: publicProcedure
    .input(CreateExchangeSchema)
    .mutation(async ({ input, ctx }) => {
      const exchange = await ctx.prisma.exchange.create({
        data: input,
      })
      return exchange
    }),

  // Get all exchanges
  list: publicProcedure
    .input(
      z.object({
        isActive: z.boolean().optional(),
        country: z.string().optional(),
        currency: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { isActive, country, currency } = input

      const where: any = {}
      if (isActive !== undefined) where.isActive = isActive
      if (country) where.country = country
      if (currency) where.currency = currency

      const exchanges = await ctx.prisma.exchange.findMany({
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

      return exchanges
    }),

  // Get a single exchange by ID
  getById: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const exchange = await ctx.prisma.exchange.findUnique({
        where: { id: input.id },
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
        throw new Error('Exchange not found')
      }

      return exchange
    }),

  // Get exchange by code
  getByCode: publicProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ input, ctx }) => {
      const exchange = await ctx.prisma.exchange.findUnique({
        where: { code: input.code.toUpperCase() },
        include: {
          _count: {
            select: {
              stocks: true,
            },
          },
        },
      })

      if (!exchange) {
        throw new Error('Exchange not found')
      }

      return exchange
    }),

  // Update exchange
  update: publicProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().optional(),
        country: z.string().optional(),
        timezone: z.string().optional(),
        currency: z.string().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...updateData } = input

      const exchange = await ctx.prisma.exchange.update({
        where: { id },
        data: updateData,
      })

      return exchange
    }),

  // Get exchange statistics
  getStats: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const exchange = await ctx.prisma.exchange.findUnique({
        where: { id: input.id },
        include: {
          stocks: {
            include: {
              _count: {
                select: {
                  positions: true,
                },
              },
            },
          },
        },
      })

      if (!exchange) {
        throw new Error('Exchange not found')
      }

      const stats = {
        totalStocks: exchange.stocks.length,
        activeStocks: exchange.stocks.filter((s) => s.isActive).length,
        totalPositions: exchange.stocks.reduce(
          (sum, stock) => sum + stock._count.positions,
          0
        ),
        sectors: [
          ...new Set(exchange.stocks.map((s) => s.sector).filter(Boolean)),
        ],
        topStocks: exchange.stocks
          .sort((a, b) => b._count.positions - a._count.positions)
          .slice(0, 10)
          .map((s) => ({
            id: s.id,
            symbol: s.symbol,
            name: s.name,
            positionCount: s._count.positions,
          })),
      }

      return { exchange, stats }
    }),

  // Delete exchange (only if no stocks exist)
  delete: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ input, ctx }) => {
      // Check if exchange has any stocks
      const stockCount = await ctx.prisma.stock.count({
        where: { exchangeId: input.id },
      })

      if (stockCount > 0) {
        throw new Error('Cannot delete exchange with existing stocks')
      }

      await ctx.prisma.exchange.delete({
        where: { id: input.id },
      })

      return { success: true }
    }),
})
