import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import dotenv from 'dotenv'
import apiRoutes from './controllers/index.js'
import { errorHandler } from './middleware/validation.js'
import { specs, swaggerUi } from './lib/swagger.js'

// Load environment variables
dotenv.config()

const app = express()
const port = process.env.PORT || 4000

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
app.use(express.urlencoded({ extended: true }))

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  })
})

// API documentation
app.use(
  '/api/docs',
  swaggerUi.serve,
  swaggerUi.setup(specs, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Piggy API Documentation',
  })
)

// API routes
app.use('/api', apiRoutes)

// API info endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'Piggy API',
    version: '1.0.0',
    description:
      'Stock Portfolio Management REST API built with Express and Prisma',
    documentation: '/api/docs',
    endpoints: {
      health: '/health',
      users: '/api/users',
      exchanges: '/api/exchanges',
      stocks: '/api/stocks',
      positions: '/api/positions',
      transactions: '/api/transactions',
      watchlist: '/api/watchlist',
    },
    features: [
      'User Management',
      'Exchange Management',
      'Stock Management with Price History',
      'Portfolio Position Tracking',
      'Transaction Logging',
      'Watchlist with Price Alerts',
      'OpenAPI Documentation',
    ],
  })
})

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    availableRoutes: ['/api', '/health', '/api/docs'],
  })
})

// Error handler
app.use(errorHandler)

// Start server
app.listen(port, () => {
  console.log(`🚀 Piggy API server running on port ${port}`)
  console.log(`� API Documentation: http://localhost:${port}/api/docs`)
  console.log(`🏥 Health check: http://localhost:${port}/health`)
  console.log(`� API info: http://localhost:${port}/api`)
})

export { app }
