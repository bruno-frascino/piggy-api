import { z } from 'zod'

// Enums
export const PositionTypeSchema = z.enum(['LONG', 'SHORT'])
export const PositionStatusSchema = z.enum(['OPEN', 'CLOSED', 'PARTIAL'])
export const TransactionTypeSchema = z.enum([
  'BUY',
  'SELL',
  'DIVIDEND',
  'SPLIT',
  'BONUS',
])

// Input validation schemas
export const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
})

export const CreateExchangeSchema = z.object({
  code: z.string().min(1).max(10),
  name: z.string().min(1),
  country: z.string().min(1),
  timezone: z.string().min(1),
  currency: z.string().length(3),
  isActive: z.boolean().default(true),
})

export const CreateStockSchema = z.object({
  symbol: z.string().min(1).max(10),
  name: z.string().min(1),
  sector: z.string().optional(),
  industry: z.string().optional(),
  marketCap: z.number().positive().optional(),
  exchangeId: z.string().cuid(),
  isActive: z.boolean().default(true),
})

export const CreatePositionSchema = z.object({
  userId: z.string().cuid(),
  stockId: z.string().cuid(),
  openDate: z.date(),
  entryPrice: z.number().positive(),
  quantity: z.number().int().positive(),
  positionType: PositionTypeSchema.default('LONG'),
  buyFees: z.number().nonnegative().default(0),
  stopLossPrice: z.number().positive().optional(),
  takeProfitPrice: z.number().positive().optional(),
  riskAmount: z.number().positive().optional(),
  riskPercentage: z.number().positive().optional(),
  openReason: z.string().min(1),
  strategy: z.string().optional(),
  setupType: z.string().optional(),
  timeframe: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
})

export const ClosePositionSchema = z.object({
  positionId: z.string().cuid(),
  closeDate: z.date(),
  exitPrice: z.number().positive(),
  sellFees: z.number().nonnegative().default(0),
  tradeGrade: z.string().optional(),
  lessonsLearned: z.string().optional(),
})

export const CreateTransactionSchema = z.object({
  positionId: z.string().cuid(),
  type: TransactionTypeSchema,
  date: z.date(),
  quantity: z.number().int().positive(),
  price: z.number().positive(),
  fees: z.number().nonnegative().default(0),
  executionTime: z.date().optional(),
  brokerRef: z.string().optional(),
  orderType: z.string().optional(),
  notes: z.string().optional(),
})

export const CreateWatchlistSchema = z.object({
  userId: z.string().cuid(),
  stockId: z.string().cuid(),
  name: z.string().optional(),
  notes: z.string().optional(),
  targetPrice: z.number().positive().optional(),
})

export const PriceHistorySchema = z.object({
  stockId: z.string().cuid(),
  date: z.date(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  volume: z.number().nonnegative().optional(),
})

// Query schemas
export const GetPositionsSchema = z.object({
  userId: z.string().cuid(),
  status: PositionStatusSchema.optional(),
  stockId: z.string().cuid().optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
})

export const GetTransactionsSchema = z.object({
  positionId: z.string().cuid().optional(),
  userId: z.string().cuid().optional(),
  type: TransactionTypeSchema.optional(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
})

export const GetPriceHistorySchema = z.object({
  stockId: z.string().cuid(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  limit: z.number().int().positive().max(1000).default(100),
})

export const PortfolioAnalyticsSchema = z.object({
  userId: z.string().cuid(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
})
