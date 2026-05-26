import { Router } from 'express'
import authRoutes from './auth.js'
import userRoutes from './users.js'
import stockRoutes from './stocks.js'
import positionRoutes from './positions.js'
import portfolioRoutes from './portfolio.js'
import accountRoutes from './accounts.js'

const router = Router()

router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/stocks', stockRoutes)
router.use('/positions', positionRoutes)
router.use('/portfolio', portfolioRoutes)
router.use('/accounts', accountRoutes)

export default router
