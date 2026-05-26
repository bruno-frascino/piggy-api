import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import dotenv from 'dotenv'
import { execSync } from 'node:child_process'
import apiRoutes from './controllers/index.js'
import { errorHandler } from './middleware/validation.js'
import { specs, swaggerUi } from './lib/swagger.js'
import { prisma } from './lib/prisma.js'
import { seedExchangesIfEmpty } from './lib/exchange-sync.js'

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
    customSiteTitle: 'Truffles API Documentation',
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
      stocks: '/api/stocks',
      positions: '/api/positions',
    },
    features: [
      'User Management',
      'Stock Management with Price History',
      'Portfolio Position Tracking',
      'OpenAPI Documentation',
    ],
  })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    availableRoutes: ['/api', '/health', '/api/docs'],
  })
})

// Error handler
app.use(errorHandler)

async function verifyDatabaseConnection() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is missing. Add it to your environment or .env file before starting the API.'
    )
  }

  await prisma.$queryRaw`SELECT 1`
}

function shouldAutoMigrateOnStartup(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.DB_AUTO_MIGRATE !== 'false'
  )
}

async function applyMigrationsIfNeeded() {
  if (!shouldAutoMigrateOnStartup()) {
    console.log('Database auto-migration skipped on startup')
    return
  }

  console.log('Applying pending database migrations...')
  execSync('npx prisma migrate deploy', { stdio: 'inherit' })
}

async function bootstrapExchanges() {
  try {
    const status = await seedExchangesIfEmpty(prisma)

    if (status.attempted && status.result) {
      console.log(
        `Exchange bootstrap complete. Fetched: ${status.result.fetched}, Inserted: ${status.result.inserted}, Updated: ${status.result.updated}, Skipped: ${status.result.skipped}`
      )
    } else {
      console.log(`Exchange bootstrap skipped: ${status.reason}`)
    }

    const totalExchanges = await prisma.exchange.count()
    console.log(`Exchanges available at startup: ${totalExchanges}`)
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown exchange bootstrap error'
    console.error('Exchange bootstrap failed:', message)
  }
}

async function startServer() {
  try {
    await verifyDatabaseConnection()
    await applyMigrationsIfNeeded()
    await bootstrapExchanges()

    app.listen(port, () => {
      console.log(`Truffles API server running on port ${port}`)
      console.log(`API Documentation: http://localhost:${port}/api/docs`)
      console.log(`Health check: http://localhost:${port}/health`)
      console.log(`API info: http://localhost:${port}/api`)
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown startup error'

    console.error('Failed to start Truffles API:', message)
    process.exit(1)
  }
}

void startServer()

export { app }
