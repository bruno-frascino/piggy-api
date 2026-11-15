import { describe, expect, it } from 'vitest'
import { prepareAccountReinvestment } from './account-reinvestment-command.js'

const now = new Date('2026-11-14T00:00:00Z')
const input = {
  idempotencyKey: 'drp-1',
  income: {
    assetId: 'asset-1',
    entitlementDate: '2026-10-01',
    paymentDate: '2026-10-15',
    sequence: 1,
    currency: 'AUD',
    grossAmount: '100',
    withholdingAmount: '15',
    frankedAmount: '60',
    unfrankedAmount: '40',
    frankingCreditAud: '25',
    sourceReference: 'issuer-statement',
  },
  acquisition: {
    effectiveDate: '2026-10-15',
    sequence: 2,
    quantity: '4',
    price: '20',
    fees: '1',
  },
  residualAmount: '4',
  residualDisposition: 'ACCOUNT_CASH',
  statementConfirmed: true,
}

describe('statement-supported reinvestment commands', () => {
  it('links one net income receipt to an exact new acquisition and cash residual', () => {
    const prepared = prepareAccountReinvestment(input, 'account', now)
    expect(prepared.income.cash.legs).toEqual([
      { currency: 'AUD', amount: '85', role: 'INCOME_RECEIPT' },
    ])
    expect(prepared.trade).toMatchObject({
      kind: 'BUY',
      assetId: 'asset-1',
      quantity: '4',
      price: '20',
      fees: '1',
    })
    expect(prepared.trade.idempotencyKey).not.toBe(input.idempotencyKey)
    expect(
      prepareAccountReinvestment(
        {
          ...input,
          residualAmount: '4.000',
          acquisition: { ...input.acquisition, price: '20.00' },
        },
        'account',
        now
      ).payloadHash
    ).toBe(prepared.payloadHash)
    expect(
      prepareAccountReinvestment(
        {
          ...input,
          acquisition: { ...input.acquisition, effectiveDate: '2026-10-16' },
        },
        'account',
        now
      ).payloadHash
    ).not.toBe(prepared.payloadHash)
  })

  it('allows zero residual and later allotment without inferring an extra distribution', () => {
    expect(
      prepareAccountReinvestment(
        {
          ...input,
          acquisition: {
            ...input.acquisition,
            effectiveDate: '2026-10-16',
            price: '21',
          },
          residualAmount: '0',
        },
        'account',
        now
      ).request.residualAmount
    ).toBe('0')
  })

  it('rejects unsupported funding, rounding, identity, ordering and statement policies', () => {
    for (const patch of [
      { residualDisposition: 'ISSUER_CARRY_FORWARD' },
      { statementConfirmed: false },
      { ignored: true },
      { residualAmount: '3.99' },
      { residualAmount: '-1' },
      { acquisition: { ...input.acquisition, price: '22' } },
      {
        acquisition: {
          ...input.acquisition,
          price: '20.0001',
          quantity: '1',
          fees: '0',
        },
        residualAmount: '64.9999',
      },
      { acquisition: { ...input.acquisition, sequence: 1 } },
      { acquisition: { ...input.acquisition, effectiveDate: '2026-10-14' } },
      { acquisition: { ...input.acquisition, effectiveDate: '2026-12-01' } },
      { acquisition: { ...input.acquisition, positionId: 'existing' } },
      { income: { ...input.income, idempotencyKey: 'other' } },
      { income: { ...input.income, entitlementDate: '2026-10-16' } },
      { acquisition: { ...input.acquisition, quantity: '1.0000000000011' } },
    ])
      expect(() =>
        prepareAccountReinvestment({ ...input, ...patch }, 'account', now)
      ).toThrow()
  })
})
