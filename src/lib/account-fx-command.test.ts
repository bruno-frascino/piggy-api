import { describe, expect, it } from 'vitest'
import { prepareAccountFxConversion } from './account-fx-command.js'
import { replayCashLedger } from './cash-ledger.js'
import {
  prepareRevisionLegs,
  prepareLiveFxCashRevision,
  prepareFxRevisionLegs,
  prepareCashRevision,
} from './cash-revisions.js'

const now = new Date('2026-11-14T00:00:00Z')
const input = {
  idempotencyKey: 'fx-1',
  effectiveDate: '2026-11-12',
  sequence: 1,
  from: { currency: 'AUD', amount: '1500.000000000001' },
  to: { currency: 'USD', amount: '975' },
  fees: [
    { currency: 'USD', amount: '2' },
    { currency: 'AUD', amount: '5' },
  ],
  sourceReference: 'broker-fx-statement',
}
const opening = {
  openingDate: '2026-11-01',
  cashBalances: [
    { currency: 'AUD', amount: '2000' },
    { currency: 'USD', amount: '0' },
  ],
}

describe('explicit same-account FX', () => {
  it('prepares fixed-identity FX corrections and terminal reversals with exact inverse/replacement legs', () => {
    const original = prepareAccountFxConversion(input, 'a1', now).cash.command
    const correction = {
      idempotencyKey: 'fx-fix',
      expectedRevisionId: 'fx-op',
      expectedAuditNumber: 1,
      expectedSourceFingerprint: 'a'.repeat(64),
      reason: 'Statement correction',
      replacement: {
        effectiveDate: '2026-11-13',
        sequence: 2,
        fromAmount: '1400',
        toAmount: '900',
        fees: [{ currency: 'USD', amount: '3' }],
      },
    }
    const prepared = prepareLiveFxCashRevision(correction, original, now)
    expect(prepared.request.replacement).toMatchObject({
      kind: 'FX_CONVERSION',
      accountId: 'a1',
      from: { currency: 'AUD', amount: '1400' },
      to: { currency: 'USD', amount: '900' },
      source: original.source,
    })
    expect(
      prepareFxRevisionLegs(original, prepared.request.replacement, now)
    ).toMatchObject([
      { currency: 'AUD', amount: '1500.000000000001', phase: 'REVERSAL' },
      { currency: 'USD', amount: '-975', phase: 'REVERSAL' },
      { currency: 'AUD', amount: '5', phase: 'REVERSAL' },
      { currency: 'USD', amount: '2', phase: 'REVERSAL' },
      { currency: 'AUD', amount: '-1400', phase: 'REPLACEMENT' },
      { currency: 'USD', amount: '900', phase: 'REPLACEMENT' },
      { currency: 'USD', amount: '-3', phase: 'REPLACEMENT' },
    ])
    const audited = prepareCashRevision(
      {
        ...prepared.request,
        fxAudit: {
          number: 2,
          previousFingerprint: 'a'.repeat(64),
          nextFingerprint: 'a'.repeat(64),
          before: original,
          after: prepared.request.replacement,
        },
      },
      now
    )
    expect(audited.payloadHash).toBe(prepared.payloadHash)
    expect(
      prepareLiveFxCashRevision(
        { ...correction, replacement: null },
        original,
        now
      ).request.replacement
    ).toBeNull()
    for (const replacement of [
      { ...correction.replacement, fromCurrency: 'EUR' },
      { ...correction.replacement, fees: [{ currency: 'EUR', amount: '1' }] },
      { ...correction.replacement, sourceReference: 'different' },
    ])
      expect(() =>
        prepareLiveFxCashRevision({ ...correction, replacement }, original, now)
      ).toThrow()
    expect(() =>
      prepareLiveFxCashRevision(
        { ...correction, expectedSourceFingerprint: undefined },
        original,
        now
      )
    ).toThrow()
    expect(() =>
      prepareCashRevision({ ...audited.request, proposedTrade: null }, now)
    ).toThrow(/mix audit/)
  })
  it('posts exact linked currency legs and fees without external capital or parcel transactions', () => {
    const { cash } = prepareAccountFxConversion(input, 'a1', now)
    expect(cash.legs).toEqual([
      { currency: 'AUD', amount: '-1500.000000000001', role: 'FX_PRINCIPAL' },
      { currency: 'USD', amount: '975', role: 'FX_PRINCIPAL' },
      { currency: 'AUD', amount: '-5', role: 'CASH_FEE' },
      { currency: 'USD', amount: '-2', role: 'CASH_FEE' },
    ])
    const replay = replayCashLedger('a1', opening, [cash.command], now)
    expect(replay.balances).toMatchObject([
      { endingAmount: '494.999999999999', netExternalContribution: '0' },
      { endingAmount: '973', netExternalContribution: '0' },
    ])
    expect(() => prepareRevisionLegs(cash.command, null, now)).toThrow(
      /FX corrections/
    )
  })

  it('normalizes decimal strings and fee order for exact retries', () => {
    expect(
      prepareAccountFxConversion(
        {
          ...input,
          to: { ...input.to, amount: '975.0000' },
          fees: input.fees.slice().reverse(),
        },
        'a1',
        now
      ).cash.payloadHash
    ).toBe(prepareAccountFxConversion(input, 'a1', now).cash.payloadHash)
  })

  it.each([
    { to: { currency: 'AUD', amount: '975' } },
    { from: { currency: 'AUD', amount: '0' } },
    { to: { currency: 'USD', amount: 975 } },
    { fees: [{ currency: 'EUR', amount: '1' }] },
    {
      fees: [
        { currency: 'AUD', amount: '1' },
        { currency: 'AUD', amount: '2' },
      ],
    },
    { fees: [{ currency: 'USD', amount: '-1' }] },
    { fees: [{ currency: 'USD', amount: '0.0000000000001' }] },
    { exchangeRate: '0.65' },
    { effectiveDate: '2026-11-15' },
  ])('rejects ambiguous or unsupported FX input %j', (override) => {
    expect(() =>
      prepareAccountFxConversion({ ...input, ...override }, 'a1', now)
    ).toThrow()
  })

  it('requires both explicit openings and checks all dated balances including received-currency fees', () => {
    const { cash } = prepareAccountFxConversion(input, 'a1', now)
    expect(() =>
      replayCashLedger(
        'a1',
        { ...opening, cashBalances: [opening.cashBalances[0]] },
        [cash.command],
        now
      )
    ).toThrow(/Missing explicit opening/)
    expect(
      replayCashLedger(
        'a1',
        {
          ...opening,
          cashBalances: [
            { currency: 'AUD', amount: '1505' },
            { currency: 'USD', amount: '0' },
          ],
        },
        [cash.command],
        now
      ).funded
    ).toBe(false)
    const expensive = prepareAccountFxConversion(
      {
        ...input,
        fees: [{ currency: 'USD', amount: '976' }],
      },
      'a1',
      now
    ).cash.command
    expect(
      replayCashLedger('a1', opening, [expensive], now).fundingIssues
    ).toMatchObject([{ currency: 'USD', balance: '-1' }])
  })
})
