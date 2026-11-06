import { describe, expect, it } from 'vitest'
import {
  continuedSourceFingerprint,
  parseExecutionAudit,
  parseSaleCorrection,
  saleCorrectionHash,
  parseAcquisitionCorrection,
  executionCorrectionHash,
} from './execution-correction.js'
import { prepareCashRevision } from './cash-revisions.js'

const input = {
  idempotencyKey: 'fix-1',
  expectedRevisionId: 'op1',
  expectedSourceFingerprint: 'a'.repeat(64),
  reason: 'Correct broker statement transcription',
  effectiveDate: '2026-10-03',
  sequence: 2,
  price: '12.5',
  fees: '1',
}
const before = {
  transactionId: 't1',
  positionId: 'p1',
  date: '2026-10-03T00:00:00.000Z',
  quantity: '2',
  price: '12',
  totalValue: '24',
  fees: '1',
  currency: 'AUD',
}
const audit = {
  number: 1,
  previousFingerprint: 'a'.repeat(64),
  nextFingerprint: 'b'.repeat(64),
  input,
  before,
  after: { ...before, price: '12.5', totalValue: '25' },
}
const revision = {
  idempotencyKey: input.idempotencyKey,
  expectedRevisionId: input.expectedRevisionId,
  reason: input.reason,
  replacement: {
    accountId: 'a1',
    kind: 'SELL',
    idempotencyKey: input.idempotencyKey,
    source: { origin: 'MANUAL', reference: 'manual-transaction:t1' },
    effectiveDate: input.effectiveDate,
    sequence: 2,
    consideration: { currency: 'AUD', amount: '25' },
    fees: [{ currency: 'AUD', amount: '1' }],
    transactionIds: ['t1'],
  },
  executionAudit: audit,
}

describe('recorded manual sale correction contract', () => {
  const purchaseInput = { ...input, quantity: '2' }
  const purchaseAudit = {
    ...audit,
    kind: 'BUY',
    input: purchaseInput,
    after: { ...audit.after, quantity: '2' },
  }
  it('normalizes acquisition quantities and binds their retry identity', () => {
    expect(
      parseAcquisitionCorrection({ ...purchaseInput, quantity: '2.000' })
    ).toEqual(purchaseInput)
    expect(executionCorrectionHash(purchaseInput)).toBe(
      executionCorrectionHash({ ...purchaseInput, quantity: '2.000' })
    )
    expect(
      executionCorrectionHash({ ...purchaseInput, quantity: '3' })
    ).not.toBe(executionCorrectionHash(purchaseInput))
    expect(executionCorrectionHash(input)).toBe(saleCorrectionHash(input))
    expect(parseExecutionAudit(purchaseAudit)).toEqual(purchaseAudit)
  })
  it.each([
    undefined,
    2,
    '0',
    '-1',
    '1e2',
    'NaN',
    '0.0000000000001',
    '9007199254740992',
    '123456789.123456789',
    '10000000000000000',
  ])(
    'rejects unrepresentable or invalid acquisition quantity %s',
    (quantity) => {
      expect(() =>
        parseAcquisitionCorrection({ ...purchaseInput, quantity })
      ).toThrow()
    }
  )
  it('accepts acquisition quantity changes but never sale quantity changes or mismatched audit kind', () => {
    const changed = {
      ...purchaseAudit,
      input: { ...purchaseInput, quantity: '3' },
      after: { ...purchaseAudit.after, quantity: '3', totalValue: '37.5' },
    }
    expect(parseExecutionAudit(changed)).toEqual(changed)
    expect(() => parseExecutionAudit({ ...changed, kind: 'SELL' })).toThrow()
    expect(() =>
      parseExecutionAudit({ ...changed, input: purchaseInput })
    ).toThrow()
    expect(() =>
      parseExecutionAudit({ ...audit, after: changed.after })
    ).toThrow()
    expect(() =>
      prepareCashRevision({
        ...revision,
        replacement: { ...revision.replacement, kind: 'BUY' },
        executionAudit: purchaseAudit,
      })
    ).not.toThrow()
    expect(() =>
      prepareCashRevision({
        ...revision,
        executionAudit: purchaseAudit,
      })
    ).toThrow()
  })
  it('normalizes exact representable decimals and binds retry identity to all reviewed inputs', () => {
    expect(
      parseSaleCorrection({ ...input, price: '12.5000', fees: '1.00000000' })
    ).toEqual(input)
    expect(saleCorrectionHash({ ...input, price: '12.500' })).toBe(
      saleCorrectionHash(input)
    )
    expect(
      saleCorrectionHash({ ...input, reason: 'Other correction' })
    ).not.toBe(saleCorrectionHash(input))
  })
  it.each([
    null,
    [],
    {},
    { ...input, amount: '25' },
    { ...input, price: 12.5 },
    { ...input, price: '0' },
    { ...input, price: '1000000000000' },
    { ...input, price: '1.0000000000001' },
    { ...input, fees: '-1' },
    { ...input, fees: '10000000000' },
    { ...input, fees: '0.000000001' },
    { ...input, effectiveDate: '2026-02-30' },
    { ...input, sequence: '2' },
    { ...input, sequence: 0 },
    { ...input, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, expectedSourceFingerprint: 'bad' },
    { ...input, reason: ' reason ' },
    { ...input, idempotencyKey: 'bad\nkey' },
    { ...input, reason: 'a'.repeat(1001) },
  ])('rejects invalid or caller-supplied unsupported fields %#', (raw) => {
    expect(() => parseSaleCorrection(raw)).toThrow()
  })
  it('validates immutable source snapshots and their economic cash replacement', () => {
    expect(parseExecutionAudit(audit)).toEqual(audit)
    expect(prepareCashRevision(revision).request.executionAudit).toEqual(audit)
    expect(continuedSourceFingerprint('a'.repeat(64), [audit])).toBe(
      'b'.repeat(64)
    )
  })
  it.each([
    { ...audit, after: { ...audit.after, transactionId: 'other' } },
    { ...audit, after: { ...audit.after, positionId: 'other' } },
    { ...audit, after: { ...audit.after, quantity: '3' } },
    { ...audit, after: { ...audit.after, currency: 'USD' } },
    { ...audit, after: { ...audit.after, totalValue: '26' } },
    { ...audit, after: { ...audit.after, date: 'not-a-date' } },
    { ...audit, after: { ...audit.after, currency: 'BTC' } },
    {
      ...audit,
      input: { ...input, expectedSourceFingerprint: 'c'.repeat(64) },
    },
    { ...audit, number: 0 },
    { ...audit, nextFingerprint: 'invalid' },
    { ...audit, before: { ...before, quantity: '0' } },
    { ...audit, before: { ...before, totalValue: '10000000000' } },
  ])('rejects malformed or identity-changing source audits %#', (raw) => {
    expect(() => parseExecutionAudit(raw)).toThrow()
  })
  it('retains the original fingerprint and validates globally ordered continuation across operations', () => {
    const second = {
      ...audit,
      number: 2,
      previousFingerprint: audit.nextFingerprint,
      nextFingerprint: 'c'.repeat(64),
      before: audit.after,
      after: { ...audit.after, fees: '2' },
      input: {
        ...input,
        expectedSourceFingerprint: audit.nextFingerprint,
        fees: '2',
      },
    }
    expect(continuedSourceFingerprint('a'.repeat(64), [])).toBe('a'.repeat(64))
    expect(continuedSourceFingerprint('a'.repeat(64), [second, audit])).toBe(
      'c'.repeat(64)
    )
    for (const bad of [
      [audit, audit],
      [second],
      [{ ...audit, previousFingerprint: 'c'.repeat(64) }],
      [audit, { ...second, before }],
    ]) {
      expect(() => continuedSourceFingerprint('a'.repeat(64), bad)).toThrow(
        /chain/
      )
    }
  })
  it.each([
    { ...revision, replacement: null },
    { ...revision, replacement: { ...revision.replacement, kind: 'BUY' } },
    {
      ...revision,
      replacement: { ...revision.replacement, transactionIds: ['other'] },
    },
    {
      ...revision,
      replacement: { ...revision.replacement, effectiveDate: '2026-10-04' },
    },
    { ...revision, replacement: { ...revision.replacement, sequence: 3 } },
    { ...revision, reason: 'Different audit reason' },
    { ...revision, replacement: { ...revision.replacement, fees: [] } },
    {
      ...revision,
      replacement: {
        ...revision.replacement,
        consideration: { currency: 'USD', amount: '25' },
      },
    },
  ])(
    'rejects cash revisions detached from their atomic sale snapshot %#',
    (raw) => {
      expect(() => prepareCashRevision(raw)).toThrow()
    }
  )
})
