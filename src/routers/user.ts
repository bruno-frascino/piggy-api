import { router, publicProcedure } from '../lib/trpc.js'
import { z } from 'zod'
import { CreateUserSchema } from '../types/index.js'

export const userRouter = router({
  // Create a new user
  create: publicProcedure
    .input(CreateUserSchema)
    .mutation(async ({ input, ctx }) => {
      const user = await ctx.prisma.user.create({
        data: input,
      })
      return user
    }),

  // Get all users
  list: publicProcedure
    .input(
      z.object({
        limit: z.number().int().positive().max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const { limit, offset } = input

      const users = await ctx.prisma.user.findMany({
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
      })

      const total = await ctx.prisma.user.count()

      return {
        users,
        total,
        hasMore: offset + limit < total,
      }
    }),

  // Get a single user by ID
  getById: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.id },
        include: {
          _count: {
            select: {
              positions: true,
            },
          },
        },
      })

      if (!user) {
        throw new Error('User not found')
      }

      return user
    }),

  // Get user by email
  getByEmail: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .query(async ({ input, ctx }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { email: input.email },
        include: {
          _count: {
            select: {
              positions: true,
            },
          },
        },
      })

      if (!user) {
        throw new Error('User not found')
      }

      return user
    }),

  // Update user
  update: publicProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().optional(),
        email: z.string().email().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...updateData } = input

      const user = await ctx.prisma.user.update({
        where: { id },
        data: updateData,
      })

      return user
    }),

  // Get user portfolio summary
  getPortfolioSummary: publicProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const { userId } = input

      // Get open positions
      const openPositions = await ctx.prisma.position.findMany({
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
      const closedPositions = await ctx.prisma.position.findMany({
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

      // Group positions by stock
      const positionsByStock = openPositions.reduce(
        (acc, position) => {
          const key = position.stock.symbol
          if (!acc[key]) {
            acc[key] = {
              stock: position.stock,
              totalQuantity: 0,
              totalInvested: 0,
              positions: [],
            }
          }
          acc[key].totalQuantity += position.quantity
          acc[key].totalInvested += Number(position.capitalAllocated)
          acc[key].positions.push(position)
          return acc
        },
        {} as Record<string, any>
      )

      return {
        user: await ctx.prisma.user.findUnique({ where: { id: userId } }),
        summary: {
          totalOpenPositions,
          totalInvested,
          totalValue,
          totalRealizedPnL,
          avgReturn,
          totalClosedPositions: closedPositions.length,
        },
        openPositions: Object.values(positionsByStock),
        recentPositions: openPositions.slice(0, 5),
      }
    }),

  // Get user activity/stats
  getStats: publicProcedure
    .input(
      z.object({
        userId: z.string().cuid(),
        days: z.number().int().positive().max(365).default(30),
      })
    )
    .query(async ({ input, ctx }) => {
      const { userId, days } = input
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

      const [recentPositions, totalPositions, recentTransactions] =
        await Promise.all([
          // Recent positions
          ctx.prisma.position.count({
            where: {
              userId,
              createdAt: { gte: startDate },
            },
          }),
          // Total positions
          ctx.prisma.position.count({
            where: { userId },
          }),
          // Recent transactions
          ctx.prisma.transaction.count({
            where: {
              position: { userId },
              createdAt: { gte: startDate },
            },
          }),
        ])

      // Get performance metrics
      const performanceMetrics = await ctx.prisma.position.aggregate({
        where: {
          userId,
          status: 'CLOSED',
        },
        _avg: {
          returnPercentage: true,
        },
        _sum: {
          realizedPnL: true,
        },
        _count: true,
      })

      return {
        recentActivity: {
          recentPositions,
          recentTransactions,
          days,
        },
        totalStats: {
          totalPositions,
          totalClosedTrades: performanceMetrics._count,
          avgReturn: performanceMetrics._avg.returnPercentage || 0,
          totalRealizedPnL: performanceMetrics._sum.realizedPnL || 0,
        },
      }
    }),

  // Delete user (only if no positions exist)
  delete: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ input, ctx }) => {
      // Check if user has any positions
      const positionCount = await ctx.prisma.position.count({
        where: { userId: input.id },
      })

      if (positionCount > 0) {
        throw new Error('Cannot delete user with existing positions')
      }

      await ctx.prisma.user.delete({
        where: { id: input.id },
      })

      return { success: true }
    }),
})
