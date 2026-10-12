import 'dotenv/config'
import { pathToFileURL } from 'node:url'

export async function wipeDatabase(args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--confirm')) {
    throw new Error('Usage: yarn db:wipe [--confirm]')
  }

  console.log(
    'Wipe all users, auth tokens, trading accounts, positions, transactions, ' +
      'snapshots, tax reports, watchlists, saved screens, assets, price history, and FX cache.'
  )
  console.log(
    'Preserve exchanges, database schema, and Prisma migration history.'
  )

  if (args.length === 0) {
    console.log(
      'Preview only. Stop the API, back up the database, then run yarn db:wipe --confirm.'
    )
    return
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is missing. Set it in your environment or .env file.'
    )
  }

  const target = new URL(connectionString)
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    target.pathname.length <= 1
  ) {
    throw new Error(
      'DATABASE_URL must be a PostgreSQL URL with an explicit database name.'
    )
  }
  console.log(
    `Database: ${target.hostname}:${target.port || '5432'}${target.pathname}`
  )

  const { prisma } = await import('../src/lib/prisma.js')
  try {
    // One atomic statement; deliberately omit CASCADE so unexpected dependencies fail safely.
    await prisma.$executeRaw`
      TRUNCATE TABLE
        public."watchlist_items",
        public."watchlists",
        public."saved_screens",
        public."transactions",
        public."positions",
        public."portfolio_snapshots",
        public."tax_reports",
        public."refresh_tokens",
        public."password_reset_tokens",
        public."trading_accounts",
        public."users",
        public."price_history",
        public."assets",
        public."fx_rate_cache"
      RESTART IDENTITY RESTRICT
    `
    console.log(
      'Database wiped. Exchanges preserved. Register a new user to start again.'
    )
  } finally {
    await prisma.$disconnect()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  wipeDatabase(process.argv.slice(2)).catch((error: unknown) => {
    console.error('Database wipe failed:', error)
    process.exitCode = 1
  })
}
