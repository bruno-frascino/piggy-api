import { describe, expect, it } from 'vitest'
import { prepareReinvestmentCorrection } from './reinvestment-correction.js'
const now = new Date('2026-11-14T00:00:00Z')
const input = {
  idempotencyKey: 'correction',
  expectedIncomeRevisionId: 'income',
  expectedAcquisitionRevisionId: 'buy',
  expectedAuditNumber: 2,
  expectedSourceFingerprint: 'a'.repeat(64),
  reason: 'Correct issuer statement',
  replacement: null,
}
describe('paired reinvestment revision identity', () => {
  it('retains both review heads and canonical terminal reversal identity', () => {
    const prepared = prepareReinvestmentCorrection(input, 'account', now)
    expect(prepared.input).toEqual(input)
    expect(prepared.replacement).toBeNull()
    expect(
      prepareReinvestmentCorrection(
        { ...input, reason: 'Other statement' },
        'account',
        now
      ).payloadHash
    ).not.toBe(prepared.payloadHash)
  })
  it.each([
    { expectedAuditNumber: -1 },
    { expectedAcquisitionRevisionId: '' },
    { expectedIncomeRevisionId: ' income' },
    { expectedSourceFingerprint: 'bad' },
    { reason: '' },
    { ignored: true },
    { replacement: {} },
    { replacement: { idempotencyKey: 'other' } },
  ])('rejects malformed or mixed revision input %j', (patch) => {
    expect(() =>
      prepareReinvestmentCorrection({ ...input, ...patch }, 'account', now)
    ).toThrow()
  })
})
