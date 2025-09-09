import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { createExpressMiddleware } from '@trpc/server/adapters/express'
import { appRouter } from './routers/index.js'
import { createTRPCContext } from './lib/trpc.js'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

const app = express()
const port = process.env.PORT || 3000

// Middleware
app.use(helmet())
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  })
)
app.use(morgan('combined'))
app.use(express.json())

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// tRPC API routes
app.use(
  '/api/trpc',
  createExpressMiddleware({
    router: appRouter,
    createContext: createTRPCContext,
    onError: ({ error, type, path, input, ctx, req }) => {
      console.error(
        `❌ tRPC failed on ${path ?? '<no-path>'}: ${error.message}`
      )
      if (process.env.NODE_ENV === 'development') {
        console.error(error.stack)
      }
    },
  })
)

// API info endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'Piggy API',
    version: '1.0.0',
    description: 'Stock Portfolio Management API built with tRPC',
    endpoints: {
      trpc: '/api/trpc',
      health: '/health',
    },
    routers: [
      'user',
      'exchange',
      'stock',
      'position',
      'transaction',
      'watchlist',
    ],
  })
})

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    availableRoutes: ['/api', '/health', '/api/trpc'],
  })
})

// Error handler
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error('❌ Unhandled error:', err)
    res.status(500).json({
      error: 'Internal Server Error',
      message:
        process.env.NODE_ENV === 'development'
          ? err.message
          : 'Something went wrong',
    })
  }
)

// Start server
app.listen(port, () => {
  console.log(`🚀 Piggy API server running on port ${port}`)
  console.log(`📊 tRPC endpoint: http://localhost:${port}/api/trpc`)
  console.log(`🏥 Health check: http://localhost:${port}/health`)
  console.log(`📖 API info: http://localhost:${port}/api`)
})

export { app }
