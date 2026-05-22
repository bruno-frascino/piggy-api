import { PrismaClient } from '@prisma/client'

type SeedExchange = {
  code: string
  name: string
  currency: string
  countryName: string
  countryCode: string
  symbolSuffix?: string | null
  delay?: string | null
}

type SyncResult = {
  fetched: number
  inserted: number
  updated: number
  skipped: number
}

const CORE_EXCHANGES: SeedExchange[] = [
  // ─── Equity / ETF Exchanges ───────────────────────────────────────────────
  {
    code: 'NASDAQ',
    name: 'NASDAQ Stock Market',
    currency: 'USD',
    countryName: 'United States of America',
    countryCode: 'US',
    symbolSuffix: null,
    delay: 'Real-time',
  },
  {
    code: 'NYSE',
    name: 'New York Stock Exchange',
    currency: 'USD',
    countryName: 'United States of America',
    countryCode: 'US',
    symbolSuffix: null,
    delay: 'Real-time',
  },
  {
    code: 'ASX',
    name: 'Australian Securities Exchange',
    currency: 'AUD',
    countryName: 'Australia',
    countryCode: 'AU',
    symbolSuffix: '.AX',
    delay: '20 min',
  },
  {
    code: 'B3',
    name: 'B3 - Brasil Bolsa Balcao',
    currency: 'BRL',
    countryName: 'Brazil',
    countryCode: 'BR',
    symbolSuffix: '.SA',
    delay: '15 min',
  },
  {
    code: 'LSE',
    name: 'London Stock Exchange',
    currency: 'GBP',
    countryName: 'United Kingdom',
    countryCode: 'GB',
    symbolSuffix: '.L',
    delay: '15 min',
  },
  {
    code: 'TSX',
    name: 'Toronto Stock Exchange',
    currency: 'CAD',
    countryName: 'Canada',
    countryCode: 'CA',
    symbolSuffix: '.TO',
    delay: '15 min',
  },
  // ─── Crypto Exchanges ─────────────────────────────────────────────────────
  {
    code: 'BINANCE',
    name: 'Binance',
    currency: 'USD',
    countryName: 'Global',
    countryCode: 'XX',
    symbolSuffix: null,
    delay: 'Real-time',
  },
  {
    code: 'COINBASE',
    name: 'Coinbase Exchange',
    currency: 'USD',
    countryName: 'United States of America',
    countryCode: 'US',
    symbolSuffix: null,
    delay: 'Real-time',
  },
  {
    code: 'KRAKEN',
    name: 'Kraken',
    currency: 'AUD',
    countryName: 'United States of America',
    countryCode: 'US',
    symbolSuffix: null,
    delay: 'Real-time',
  },
]

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().slice(0, 10)
}

async function upsertExchange(
  prisma: PrismaClient,
  exchange: SeedExchange
): Promise<'inserted' | 'updated' | 'skipped'> {
  const normalizedCode = normalizeCode(exchange.code)

  if (!normalizedCode || !exchange.name.trim()) {
    return 'skipped'
  }

  const existing = await prisma.exchange.findUnique({
    where: { code: normalizedCode },
    select: { id: true },
  })

  await prisma.exchange.upsert({
    where: { code: normalizedCode },
    create: {
      code: normalizedCode,
      name: exchange.name.trim(),
      currency: exchange.currency.trim().toUpperCase(),
      countryName: exchange.countryName.trim(),
      countryCode: exchange.countryCode.trim().toUpperCase(),
      symbolSuffix: exchange.symbolSuffix?.trim() || null,
      delay: exchange.delay?.trim() || null,
    },
    update: {
      name: exchange.name.trim(),
      currency: exchange.currency.trim().toUpperCase(),
      countryName: exchange.countryName.trim(),
      countryCode: exchange.countryCode.trim().toUpperCase(),
      symbolSuffix: exchange.symbolSuffix?.trim() || null,
      delay: exchange.delay?.trim() || null,
    },
  })

  return existing ? 'updated' : 'inserted'
}

export async function ensureCoreExchanges(
  prisma: PrismaClient
): Promise<SyncResult> {
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const exchange of CORE_EXCHANGES) {
    const result = await upsertExchange(prisma, exchange)
    if (result === 'inserted') inserted += 1
    if (result === 'updated') updated += 1
    if (result === 'skipped') skipped += 1
  }

  return {
    fetched: CORE_EXCHANGES.length,
    inserted,
    updated,
    skipped,
  }
}

export async function seedExchangesIfEmpty(prisma: PrismaClient): Promise<{
  attempted: boolean
  seeded: boolean
  reason: string
  result?: SyncResult
}> {
  const coreResult = await ensureCoreExchanges(prisma)

  return {
    attempted: true,
    seeded: coreResult.inserted > 0 || coreResult.updated > 0,
    reason: 'Seeded curated core exchanges',
    result: coreResult,
  }
}
