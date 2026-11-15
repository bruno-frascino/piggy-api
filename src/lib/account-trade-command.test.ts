import { describe, expect, it } from 'vitest'
import {
  accountTradePayloadHash,
  parseAccountTradeInput,
} from './account-trade-command.js'

const buy = {
  kind: 'BUY',
  assetId: 'asset-1',
  idempotencyKey: 'buy-1',
  effectiveDate: '2026-10-02',
  sequence: 1,
  quantity: '0.125',
  price: '12.345678901234',
  fees: '0.25',
}

describe('account trade command', () => {
  it('normalizes exact decimal strings and hashes the complete command', () => {
    const parsed = parseAccountTradeInput(buy)
    expect(parsed).toMatchObject({
      quantity: '0.125',
      price: '12.345678901234',
      fees: '0.25',
    })
    expect(accountTradePayloadHash(parsed)).toBe(
      accountTradePayloadHash(
        parseAccountTradeInput({ ...buy, quantity: '0.1250' })
      )
    )
  })

  it.each([
    { ...buy, quantity: 0.125 },
    { ...buy, quantity: '9007199254740992' },
    { ...buy, fees: '-1' },
    { ...buy, sequence: 0 },
    { ...buy, effectiveDate: '2026-02-30' },
    { ...buy, positionId: 'unexpected' },
    { ...buy, kind: 'SELL' },
    { ...buy, assetId: undefined, symbol: 'AAPL' },
    {
      ...buy,
      assetId: 'asset-1',
      openReason: 'Unexpected metadata with asset ID',
    },
  ])('rejects malformed or ambiguous commands %#', (input) => {
    expect(() => parseAccountTradeInput(input)).toThrow()
  })

  it('preserves symbol-based acquisition metadata and sale close metadata', () => {
    expect(
      parseAccountTradeInput({
        ...buy,
        assetId: undefined,
        symbol: 'aapl',
        exchangeCode: 'nasdaq',
        assetName: 'Apple',
        assetType: 'EQUITY',
        industry: 'Technology',
        openReason: 'Long-term holding',
        stopLossPrice: '150',
      })
    ).toMatchObject({
      kind: 'BUY',
      symbol: 'AAPL',
      exchangeCode: 'NASDAQ',
      assetName: 'Apple',
      industry: 'Technology',
      openReason: 'Long-term holding',
      stopLossPrice: '150',
    })
    expect(
      parseAccountTradeInput({
        kind: 'SELL',
        positionId: 'position-1',
        idempotencyKey: 'sell-1',
        effectiveDate: '2026-10-02',
        sequence: 2,
        quantity: '1',
        price: '12',
        fees: '0',
        closeReason: 'TARGET',
        notes: 'Target reached',
      })
    ).toMatchObject({ closeReason: 'TARGET', notes: 'Target reached' })
  })
})
