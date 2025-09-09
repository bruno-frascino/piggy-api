import { router, publicProcedure } from '../lib/trpc.js'
import { z } from 'zod'
import {
  CreateTransactionSchema,
  GetTransactionsSchema,
} from '../types/index.js'

export const transactionRouter = router({
  // Create a new transaction
  create: publicProcedure
    .input(CreateTransactionSchema)
    .mutation(async ({ input, ctx }) => {
      const { quantity, price, fees } = input
      const totalValue = quantity * price

      const transaction = await ctx.prisma.transaction.create({
        data: {
          ...input,
          totalValue,
        },
        include: {
          position: {
            include: {
              stock: {
                include: {
                  exchange: true,
                },
              },
            },
          },
        },
      })

      return transaction
    }),

  // Get transactions with filtering
  list: publicProcedure
    .input(GetTransactionsSchema)
    .query(async ({ input, ctx }) => {
      const { positionId, userId, type, startDate, endDate, limit, offset } =
        input

      const where: any = {}
      if (positionId) where.positionId = positionId
      if (userId) where.position = { userId }
      if (type) where.type = type
      if (startDate || endDate) {
        where.date = {}
        if (startDate) where.date.gte = startDate
        if (endDate) where.date.lte = endDate
      }

      const transactions = await ctx.prisma.transaction.findMany({
        where,
        include: {
          position: {
            include: {
              stock: {
                include: {
                  exchange: true,
                },
              },
            },
          },
        },
        orderBy: { date: 'desc' },
        take: limit,
        skip: offset,
      })

      const total = await ctx.prisma.transaction.count({ where })

      return {
        transactions,
        total,
        hasMore: offset + limit < total,
      }
    }),

  // Get a single transaction by ID
  getById: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const transaction = await ctx.prisma.transaction.findUnique({
        where: { id: input.id },
        include: {
          position: {
            include: {
              stock: {
                include: {
                  exchange: true,
                },
              },
              user: true,
            },
          },
        },
      })

      if (!transaction) {
        throw new Error('Transaction not found')
      }

      return transaction
    }),

  // Get transactions for a specific position
  getByPosition: publicProcedure
    .input(z.object({ positionId: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const transactions = await ctx.prisma.transaction.findMany({
        where: { positionId: input.positionId },
        orderBy: { date: 'asc' },
        include: {
          position: {
            include: {
              stock: {
                include: {
                  exchange: true,
                },
              },
            },
          },
        },
      })

      return transactions
    }),

  // Update transaction
  update: publicProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        date: z.date().optional(),
        quantity: z.number().int().positive().optional(),
        price: z.number().positive().optional(),
        fees: z.number().nonnegative().optional(),
        executionTime: z.date().optional(),
        brokerRef: z.string().optional(),
        orderType: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, quantity, price, ...otherUpdates } = input

      // Calculate new total value if quantity or price changed
      let updateData: any = otherUpdates
      if (quantity !== undefined || price !== undefined) {
        const currentTransaction = await ctx.prisma.transaction.findUnique({
          where: { id },
        })

        if (!currentTransaction) {
          throw new Error('Transaction not found')
        }

        const newQuantity = quantity ?? currentTransaction.quantity
        const newPrice = price ?? Number(currentTransaction.price)
        const totalValue = newQuantity * newPrice

        updateData = {
          ...updateData,
          ...(quantity !== undefined && { quantity }),
          ...(price !== undefined && { price }),
          totalValue,
        }
      }

      const transaction = await ctx.prisma.transaction.update({
        where: { id },
        data: updateData,
        include: {
          position: {
            include: {
              stock: {
                include: {
                  exchange: true,
                },
              },
            },
          },
        },
      })

      return transaction
    }),

  // Get transaction summary/analytics
  getSummary: publicProcedure
    .input(
      z.object({
        userId: z.string().cuid().optional(),
        positionId: z.string().cuid().optional(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { userId, positionId, startDate, endDate } = input

      const where: any = {}
      if (positionId) where.positionId = positionId
      if (userId) where.position = { userId }
      if (startDate || endDate) {
        where.date = {}
        if (startDate) where.date.gte = startDate
        if (endDate) where.date.lte = endDate
      }

      // Get transaction counts by type
      const transactionCounts = await ctx.prisma.transaction.groupBy({
        by: ['type'],
        where,
        _count: true,
        _sum: {
          totalValue: true,
          fees: true,
        },
      })

      // Get total volume and fees
      const totals = await ctx.prisma.transaction.aggregate({
        where,
        _sum: {
          totalValue: true,
          fees: true,
          quantity: true,
        },
        _count: true,
      })

      // Get recent activity
      const recentTransactions = await ctx.prisma.transaction.findMany({
        where,
        include: {
          position: {
            include: {
              stock: true,
            },
          },
        },
        orderBy: { date: 'desc' },
        take: 10,
      })

      return {
        summary: {
          totalTransactions: totals._count,
          totalVolume: totals._sum.totalValue || 0,
          totalFees: totals._sum.fees || 0,
          totalShares: totals._sum.quantity || 0,
        },
        byType: transactionCounts.map((tc) => ({
          type: tc.type,
          count: tc._count,
          totalValue: tc._sum.totalValue || 0,
          totalFees: tc._sum.fees || 0,
        })),
        recentTransactions,
      }
    }),

  // Delete transaction
  delete: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.prisma.transaction.delete({
        where: { id: input.id },
      })

      return { success: true }
    }),

  // Bulk create transactions (useful for importing data)
  createBulk: publicProcedure
    .input(
      z.object({
        transactions: z.array(CreateTransactionSchema),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const transactionsWithTotalValue = input.transactions.map((t) => ({
        ...t,
        totalValue: t.quantity * t.price,
      }))

      const result = await ctx.prisma.transaction.createMany({
        data: transactionsWithTotalValue,
        skipDuplicates: true,
      })

      return { created: result.count }
    }),
})
