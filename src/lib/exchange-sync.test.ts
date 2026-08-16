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

    expect(result).toMatchObject({ fetched: 10, inserted: 10 })
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
})
