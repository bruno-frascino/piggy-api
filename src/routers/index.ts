import { router } from '../lib/trpc.js'
import { userRouter } from './user.js'
import { exchangeRouter } from './exchange.js'
import { stockRouter } from './stock.js'
import { positionRouter } from './position.js'
import { transactionRouter } from './transaction.js'
import { watchlistRouter } from './watchlist.js'

export const appRouter = router({
  user: userRouter,
  exchange: exchangeRouter,
  stock: stockRouter,
  position: positionRouter,
  transaction: transactionRouter,
  watchlist: watchlistRouter,
})

export type AppRouter = typeof appRouter
