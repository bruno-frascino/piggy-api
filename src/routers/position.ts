import { router, publicProcedure } from '../lib/trpc.js'
import { z } from 'zod'
import {
  CreatePositionSchema,
  ClosePositionSchema,
  GetPositionsSchema,
  PositionStatusSchema,
} from '../types/index.js'

export const positionRouter = router({
  // Create a new position
  create: publicProcedure
    .input(CreatePositionSchema)
    .mutation(async ({ input, ctx }) => {
      const { quantity, entryPrice, buyFees } = input

      // Calculate derived values
      const totalBuyValue = quantity * entryPrice
      const capitalAllocated = totalBuyValue + buyFees

      const position = await ctx.prisma.position.create({
        data: {
          ...input,
          totalBuyValue,
          capitalAllocated,
          status: 'OPEN',
        },
        include: {
          stock: {
            include: {
              exchange: true,
            },
          },
          user: true,
        },
      })

      // Create the initial BUY transaction
      await ctx.prisma.transaction.create({
        data: {
          positionId: position.id,
          type: 'BUY',
          date: input.openDate,
          quantity: input.quantity,
          price: input.entryPrice,
          totalValue: totalBuyValue,
          fees: input.buyFees,
        },
      })

      return position
    }),

  // Close a position
  close: publicProcedure
    .input(ClosePositionSchema)
    .mutation(async ({ input, ctx }) => {
      const {
        positionId,
        closeDate,
        exitPrice,
        sellFees,
        tradeGrade,
        lessonsLearned,
      } = input

      // Get the position to calculate values
      const position = await ctx.prisma.position.findUnique({
        where: { id: positionId },
      })

      if (!position) {
        throw new Error('Position not found')
      }

      if (position.status !== 'OPEN') {
        throw new Error('Position is not open')
      }

      // Calculate exit values
      const totalSellValue = position.quantity * exitPrice
      const realizedPnL =
        totalSellValue -
        Number(position.totalBuyValue) -
        Number(position.buyFees) -
        sellFees
      const returnPercentage =
        (realizedPnL / Number(position.capitalAllocated)) * 100

      // Update the position
      const updatedPosition = await ctx.prisma.position.update({
        where: { id: positionId },
        data: {
          status: 'CLOSED',
          closeDate,
          exitPrice,
          totalSellValue,
          sellFees,
          realizedPnL,
          returnPercentage,
          tradeGrade,
          lessonsLearned,
        },
        include: {
          stock: {
            include: {
              exchange: true,
            },
          },
          user: true,
          transactions: true,
        },
      })

      // Create the SELL transaction
      await ctx.prisma.transaction.create({
        data: {
          positionId,
          type: 'SELL',
          date: closeDate,
          quantity: position.quantity,
          price: exitPrice,
          totalValue: totalSellValue,
          fees: sellFees,
        },
      })

      return updatedPosition
    }),

  // Get positions with filtering
  list: publicProcedure
    .input(GetPositionsSchema)
    .query(async ({ input, ctx }) => {
      const { userId, status, stockId, limit, offset } = input

      const where: any = { userId }
      if (status) where.status = status
      if (stockId) where.stockId = stockId

      const positions = await ctx.prisma.position.findMany({
        where,
        include: {
          stock: {
            include: {
              exchange: true,
            },
          },
          transactions: {
            orderBy: { date: 'asc' },
          },
        },
        orderBy: { openDate: 'desc' },
        take: limit,
        skip: offset,
      })

      const total = await ctx.prisma.position.count({ where })

      return {
        positions,
        total,
        hasMore: offset + limit < total,
      }
    }),

  // Get a single position by ID
  getById: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const position = await ctx.prisma.position.findUnique({
        where: { id: input.id },
        include: {
          stock: {
            include: {
              exchange: true,
            },
          },
          user: true,
          transactions: {
            orderBy: { date: 'asc' },
          },
        },
      })

      if (!position) {
        throw new Error('Position not found')
      }

      return position
    }),

  // Update position (for stop loss, take profit, notes, etc.)
  update: publicProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        stopLossPrice: z.number().positive().optional(),
        takeProfitPrice: z.number().positive().optional(),
        strategy: z.string().optional(),
        setupType: z.string().optional(),
        timeframe: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...updateData } = input

      const position = await ctx.prisma.position.update({
        where: { id },
        data: updateData,
        include: {
          stock: {
            include: {
              exchange: true,
            },
          },
          transactions: true,
        },
      })

      return position
    }),

  // Delete a position (only if no transactions exist)
  delete: publicProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ input, ctx }) => {
      // Check if position has transactions
      const transactionCount = await ctx.prisma.transaction.count({
        where: { positionId: input.id },
      })

      if (transactionCount > 0) {
        throw new Error('Cannot delete position with existing transactions')
      }

      await ctx.prisma.position.delete({
        where: { id: input.id },
      })

      return { success: true }
    }),

  // Get open positions summary
  openSummary: publicProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .query(async ({ input, ctx }) => {
      const positions = await ctx.prisma.position.findMany({
        where: {
          userId: input.userId,
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

      const summary = {
        totalPositions: positions.length,
        totalInvested: positions.reduce(
          (sum, p) => sum + Number(p.capitalAllocated),
          0
        ),
        totalValue: positions.reduce(
          (sum, p) => sum + Number(p.totalBuyValue),
          0
        ),
        positions: positions.map((p) => ({
          id: p.id,
          stock: p.stock,
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          capitalAllocated: p.capitalAllocated,
          openDate: p.openDate,
        })),
      }

      return summary
    }),
})
