import { describe, expect, it } from 'vitest'
import { prepareAccountIncomeReceipt } from './account-income-command.js'

const now = new Date('2026-11-12T00:00:00.000Z')
const validInput = {
  idempotencyKey: 'income-1',
  assetId: 'asset-1',
  entitlementDate: '2026-10-01',
  paymentDate: '2026-10-15',
  sequence: 1,
  currency: 'AUD',
  grossAmount: '100',
  withholdingAmount: '15',
  frankedAmount: '60',
  unfrankedAmount: '40',
  frankingCreditAud: '25.714285714286',
  sourceReference: 'Dividend statement October',
}

describe('prepareAccountIncomeReceipt', () => {
  it('creates a normalized income command with net cash and a stable identity', () => {
    const prepared = prepareAccountIncomeReceipt(validInput, 'account-1', now)

    expect(prepared.request).toEqual(validInput)
    expect(prepared.cash.command).toMatchObject({
      kind: 'INCOME',
      effectiveDate: validInput.paymentDate,
      sequence: 1,
      cash: { currency: 'AUD', amount: '85' },
      income: {
        assetId: 'asset-1',
        entitlementDate: '2026-10-01',
        grossAmount: '100',
        withholdingAmount: '15',
        frankedAmount: '60',
        unfrankedAmount: '40',
        frankingCreditAud: '25.714285714286',
      },
    })
    expect(prepared.cash.legs).toEqual([
      { currency: 'AUD', amount: '85', role: 'INCOME_RECEIPT' },
    ])
    expect(prepared.cash.payloadHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('allows fully withheld income with zero cash, without inventing a cash leg', () => {
    const prepared = prepareAccountIncomeReceipt(
      {
        ...validInput,
        grossAmount: '100',
        withholdingAmount: '100',
        frankedAmount: '0',
        unfrankedAmount: '100',
        frankingCreditAud: '0',
      },
      'account-1',
      now
    )
    expect(prepared.cash.command.cash.amount).toBe('0')
    expect(prepared.cash.legs[0]?.amount).toBe('0')
  })

  it.each([
    ['future payment date', { paymentDate: '2026-11-13' }],
    ['entitlement after payment', { entitlementDate: '2026-10-16' }],
    ['withholding exceeds gross', { withholdingAmount: '101' }],
    ['tax components do not equal gross', { frankedAmount: '59' }],
    [
      'franking credits outside AUD',
      { currency: 'USD', frankingCreditAud: '1' },
    ],
    ['unknown field', { ignored: true }],
  ])('rejects %s', (_label, patch) => {
    expect(() =>
      prepareAccountIncomeReceipt({ ...validInput, ...patch }, 'account-1', now)
    ).toThrow()
  })
})
