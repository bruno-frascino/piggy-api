import { Router } from 'express'
import authRoutes from './auth.js'
import userRoutes from './users.js'
import exchangeRoutes from './exchanges.js'
import stockRoutes from './stocks.js'
import positionRoutes from './positions.js'
import portfolioRoutes from './portfolio.js'
import watchlistRoutes from './watchlist.js'

const router = Router()

router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/exchanges', exchangeRoutes)
router.use('/stocks', stockRoutes)
router.use('/positions', positionRoutes)
router.use('/portfolio', portfolioRoutes)
router.use('/watchlist', watchlistRoutes)

export default router
