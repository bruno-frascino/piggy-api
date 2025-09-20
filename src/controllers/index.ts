import { Router } from 'express'
import userRoutes from './users.js'
import exchangeRoutes from './exchanges.js'
// Import other controllers as we create them
// import stockRoutes from './stocks.js'
// import positionRoutes from './positions.js'
// import transactionRoutes from './transactions.js'
// import watchlistRoutes from './watchlist.js'

const router = Router()

// Mount route handlers
router.use('/users', userRoutes)
router.use('/exchanges', exchangeRoutes)
// router.use('/stocks', stockRoutes)
// router.use('/positions', positionRoutes)
// router.use('/transactions', transactionRoutes)
// router.use('/watchlist', watchlistRoutes)

export default router
