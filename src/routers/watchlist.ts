import { router, publicProcedure } from '../lib/trpc.js'
import { z } from 'zod'
import { CreateWatchlistSchema } from '../types/index.js'

export const watchlistRouter = router({
  // Add stock to watchlist
  add: publicProcedure
    .input(CreateWatchlistSchema)
    .mutation(async ({ input, ctx }) => {
      const watchlistItem = await ctx.prisma.watchlist.create({
        data: input,
      })
      return watchlistItem
    }),

  // Get user's watchlist
  list: publicProcedure
    .input(
      z.object({
        userId: z.string().cuid(),
        limit: z.number().int().positive().max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const { userId, limit, offset } = input

      const watchlistItems = await ctx.prisma.watchlist.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      })

      const total = await ctx.prisma.watchlist.count({
        where: { userId },
      })

      return {
        watchlist: watchlistItems,
        total,
        hasMore: offset + limit < total,
      }
    }),

  // Get single watchlist item with stock details
  getById: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const watchlistItem = await ctx.prisma.watchlist.findUnique({
        where: { id: input.id },
      })

      if (!watchlistItem) {
        throw new Error('Watchlist item not found')
      }

      const stock = await ctx.prisma.stock.findUnique({
        where: { id: watchlistItem.stockId },
      })

      const exchange = stock
        ? await ctx.prisma.exchange.findUnique({
            where: { id: stock.exchangeId },
          })
        : null

      return {
        ...watchlistItem,
        stock: stock ? { ...stock, exchange } : null,
      }
    }),

  // Update watchlist item
  update: publicProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().optional(),
        notes: z.string().optional(),
        targetPrice: z.number().positive().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...updateData } = input

      const watchlistItem = await ctx.prisma.watchlist.update({
        where: { id },
        data: updateData,
      })

      return watchlistItem
    }),

  // Remove from watchlist
  remove: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.prisma.watchlist.delete({
        where: { id: input.id },
      })

      return { success: true }
    }),

  // Remove stock from user's watchlist
  removeByStock: publicProcedure
    .input(
      z.object({
        userId: z.string().cuid(),
        stockId: z.string().cuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await ctx.prisma.watchlist.delete({
        where: {
          userId_stockId: {
            userId: input.userId,
            stockId: input.stockId,
          },
        },
      })

      return { success: true }
    }),

  // Check if stock is in user's watchlist
  isWatched: publicProcedure
    .input(
      z.object({
        userId: z.string().cuid(),
        stockId: z.string().cuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const watchlistItem = await ctx.prisma.watchlist.findUnique({
        where: {
          userId_stockId: {
            userId: input.userId,
            stockId: input.stockId,
          },
        },
      })

      return { isWatched: !!watchlistItem, watchlistItem }
    }),

  // Get watchlist with price alerts
  getPriceAlerts: publicProcedure
    .input(
      z.object({
        userId: z.string().cuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const watchlistItems = await ctx.prisma.watchlist.findMany({
        where: {
          userId: input.userId,
          targetPrice: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      })

      // Get stock details and latest prices separately
      const itemsWithDetails = await Promise.all(
        watchlistItems.map(async (item) => {
          const stock = await ctx.prisma.stock.findUnique({
            where: { id: item.stockId },
          })

          const latestPrice = await ctx.prisma.priceHistory.findFirst({
            where: { stockId: item.stockId },
            orderBy: { date: 'desc' },
          })

          const triggered =
            latestPrice && item.targetPrice
              ? Number(latestPrice.close) >= Number(item.targetPrice)
              : false

          return {
            ...item,
            stock,
            currentPrice: latestPrice?.close,
            triggered,
          }
        })
      )

      const triggeredAlerts = itemsWithDetails.filter((item) => item.triggered)

      return {
        watchlistWithAlerts: itemsWithDetails,
        triggeredAlerts,
      }
    }),

  // Get watchlist summary
  getSummary: publicProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const [totalItems, itemsWithAlerts, recentItems] = await Promise.all([
        // Total watchlist items
        ctx.prisma.watchlist.count({
          where: { userId: input.userId },
        }),
        // Items with price alerts
        ctx.prisma.watchlist.count({
          where: {
            userId: input.userId,
            targetPrice: { not: null },
          },
        }),
        // Recent additions
        ctx.prisma.watchlist.findMany({
          where: { userId: input.userId },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
      ])

      return {
        totalItems,
        itemsWithAlerts,
        recentItems,
      }
    }),

  // Bulk add to watchlist
  bulkAdd: publicProcedure
    .input(
      z.object({
        userId: z.string().cuid(),
        stockIds: z.array(z.string().cuid()),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { userId, stockIds, notes } = input

      const data = stockIds.map((stockId) => ({
        userId,
        stockId,
        notes,
      }))

      const result = await ctx.prisma.watchlist.createMany({
        data,
        skipDuplicates: true,
      })

      return { added: result.count }
    }),
})
