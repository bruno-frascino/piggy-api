import { describe, expect, it } from 'vitest'
import { prepareAccountCapitalFlow } from './account-capital-command.js'

const now = new Date('2026-10-10T12:00:00Z')
const deposit = {
  kind: 'DEPOSIT',
  idempotencyKey: 'deposit-1',
  effectiveDate: '2026-10-03',
  sequence: 1,
  currency: 'AUD',
  amount: '100.00',
  sourceReference: 'bank-transfer-123',
}

describe('prepareAccountCapitalFlow', () => {
  it('normalizes exact cash commands and produces a manual cash-only posting', () => {
    const prepared = prepareAccountCapitalFlow(deposit, 'account-1', now)
    expect(prepared.request).toEqual({ ...deposit, amount: '100' })
    expect(prepared.cash.command).toEqual({
      accountId: 'account-1',
      idempotencyKey: 'deposit-1',
      source: { origin: 'MANUAL', reference: 'bank-transfer-123' },
      effectiveDate: '2026-10-03',
      sequence: 1,
      kind: 'DEPOSIT',
      cash: { currency: 'AUD', amount: '100' },
    })
    expect(prepared.cash.legs).toEqual([
      { currency: 'AUD', amount: '100', role: 'EXTERNAL_CAPITAL' },
    ])
    expect(prepared.cash.payloadHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('makes withdrawals negative cash legs without changing the positive input amount', () => {
    const prepared = prepareAccountCapitalFlow(
      { ...deposit, kind: 'WITHDRAWAL' },
      'account-1',
      now
    )
    expect(prepared.request.amount).toBe('100')
    expect(prepared.cash.legs).toEqual([
      { currency: 'AUD', amount: '-100', role: 'EXTERNAL_CAPITAL' },
    ])
  })

  it.each([
    { ...deposit, amount: '0' },
    { ...deposit, amount: 100 },
    { ...deposit, sourceReference: ' bank' },
    { ...deposit, effectiveDate: '2026-10-11' },
    { ...deposit, unexpected: true },
    { ...deposit, kind: 'BUY' },
  ])('rejects invalid live capital command %#', (input) => {
    expect(() => prepareAccountCapitalFlow(input, 'account-1', now)).toThrow()
  })
})
