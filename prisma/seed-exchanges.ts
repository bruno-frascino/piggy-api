import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { seedExchangesIfEmpty } from '../src/lib/exchange-sync.js'

async function main(): Promise<void> {
  const result = await seedExchangesIfEmpty(prisma)
  console.log(
    `Exchange seed complete. Fetched: ${result.result?.fetched ?? 0}, Inserted: ${result.result?.inserted ?? 0}, Updated: ${result.result?.updated ?? 0}, Skipped: ${result.result?.skipped ?? 0}`
  )
}

main()
  .catch((error) => {
    console.error('Exchange seed failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
