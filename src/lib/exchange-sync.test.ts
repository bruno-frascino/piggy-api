import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { ensureCoreExchanges } from './exchange-sync.js'

describe('ensureCoreExchanges', () => {
  it('seeds Cboe Australia using Yahoo Finance CXA metadata', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = {
      exchange: { findUnique, upsert },
    } as unknown as PrismaClient

    const result = await ensureCoreExchanges(prisma)

    expect(result).toMatchObject({ fetched: 13, inserted: 13 })
    expect(upsert).toHaveBeenCalledWith({
      where: { code: 'CXA' },
      create: {
        code: 'CXA',
        name: 'Cboe Australia',
        currency: 'AUD',
        countryName: 'Australia',
        countryCode: 'AU',
        symbolSuffix: '.XA',
        delay: '20 min',
      },
      update: {
        name: 'Cboe Australia',
        currency: 'AUD',
        countryName: 'Australia',
        countryCode: 'AU',
        symbolSuffix: '.XA',
        delay: '20 min',
      },
    })
  })

  it('seeds one crypto exchange row per venue and quote currency without truncating codes', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = {
      exchange: { findUnique, upsert },
    } as unknown as PrismaClient

    await ensureCoreExchanges(prisma)

    const rows = Object.fromEntries(
      upsert.mock.calls.map(([arg]) => [arg.create.code, arg.create])
    )
    expect(rows.KRAKEN).toMatchObject({ name: 'Kraken (AUD)', currency: 'AUD' })
    expect(rows.KRAKEN_USD).toMatchObject({
      name: 'Kraken (USD)',
      currency: 'USD',
      countryCode: 'XX',
    })
    expect(rows.BINANCE).toMatchObject({ currency: 'USD' })
    expect(rows.BINANCE_AUD).toMatchObject({ currency: 'AUD' })
    expect(rows.COINBASE).toMatchObject({ currency: 'USD' })
    expect(rows.COINBASE_AUD).toMatchObject({ currency: 'AUD' })
  })
})
