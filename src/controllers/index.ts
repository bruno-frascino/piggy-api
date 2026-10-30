import { Router } from 'express'
import authRoutes from './auth.js'
import userRoutes from './users.js'
import stockRoutes from './stocks.js'
import positionRoutes from './positions.js'
import portfolioRoutes from './portfolio.js'
import accountRoutes from './accounts.js'
import taxReportRoutes from './tax-reports.js'
import statisticsRoutes from './statistics.js'
import screenerRoutes from './screener.js'
import watchlistRoutes from './watchlists.js'
import exchangeRoutes from './exchanges.js'
import importRoutes from './imports.js'

const router = Router()

router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/stocks', stockRoutes)
router.use('/positions', positionRoutes)
router.use('/portfolio', portfolioRoutes)
router.use('/accounts', accountRoutes)
router.use('/tax-reports', taxReportRoutes)
router.use('/statistics', statisticsRoutes)
router.use('/screener', screenerRoutes)
router.use('/watchlists', watchlistRoutes)
router.use('/exchanges', exchangeRoutes)
router.use('/imports', importRoutes)

export default router
