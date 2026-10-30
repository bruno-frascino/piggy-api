import { afterEach, describe, expect, it, vi } from 'vitest'

const pairs = {
  XXBTZAUD: { aclass_base: 'currency', base: 'XXBT', quote: 'ZAUD' },
  XXBTZUSD: { aclass_base: 'currency', base: 'XXBT', quote: 'ZUSD' },
  SOLAUD: { aclass_base: 'currency', base: 'SOL', quote: 'ZAUD' },
  SOLEUR: { aclass_base: 'currency', base: 'SOL', quote: 'ZEUR' },
  TOKEN: { aclass_base: 'tokenized_asset', base: 'ABC', quote: 'ZUSD' },
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('Kraken market catalogue', () => {
  it('normalizes aliases, searches names and separates quote currencies', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: [], result: pairs }),
    })
    vi.stubGlobal('fetch', fetch)
    const { searchKrakenMarkets } = await import('./kraken-markets.js')
    expect(await searchKrakenMarkets('AUD', 'bitcoin')).toEqual([
      {
        base: 'BTC',
        name: 'Bitcoin',
        symbol: 'BTC-AUD',
        quote: 'AUD',
        exchangeCode: 'KRAKEN',
      },
    ])
    expect((await searchKrakenMarkets('USD', 'XBT'))[0].symbol).toBe('BTC-USD')
    expect(await searchKrakenMarkets('AUD', 'not-listed')).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ok: false, status: 429 },
    { ok: true, json: async () => ({ error: ['Unavailable'] }) },
    { ok: true, json: async () => ({ error: [], result: {} }) },
  ])(
    'surfaces provider failures instead of returning an empty search',
    async (response) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      const { searchKrakenMarkets, KrakenMarketsUnavailable } =
        await import('./kraken-markets.js')
      await expect(searchKrakenMarkets('AUD', 'BTC')).rejects.toBeInstanceOf(
        KrakenMarketsUnavailable
      )
    }
  )

  it('retries failed requests and refreshes an expired catalogue', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ error: [], result: pairs }),
      })
    vi.stubGlobal('fetch', fetch)
    const { getKrakenMarkets } = await import('./kraken-markets.js')
    await expect(getKrakenMarkets()).rejects.toThrow('timeout')
    await Promise.all([getKrakenMarkets(), getKrakenMarkets()])
    expect(fetch).toHaveBeenCalledTimes(2)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)
    await getKrakenMarkets()
    now.mockRestore()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
