import { describe, expect, it } from 'vitest'
import {
  prepareAccountSplitReversal,
  prepareStoredAccountSplitReversal,
} from './account-split-reversal.js'

const request = {
  idempotencyKey: 'reverse-key',
  actionId: 'split-action',
  expectedAuditNumber: 4,
  expectedSourceFingerprint: 'a'.repeat(64),
  reason: 'Corrected statement evidence',
  reversalConfirmed: true,
}

describe('account split reversal command', () => {
  it('prepares an exact terminal reversal request', () => {
    const prepared = prepareAccountSplitReversal(request, 'account')
    expect(prepared).toMatchObject({
      accountId: 'account',
      request,
    })
    expect(prepared.payloadHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    [{ ...request, expectedAuditNumber: 0 }],
    [{ ...request, expectedSourceFingerprint: 'invalid' }],
    [{ ...request, reason: ' ' }],
    [{ ...request, reversalConfirmed: false }],
    [{ ...request, extra: true }],
  ])('rejects invalid reversal input %j', (input) => {
    expect(() => prepareAccountSplitReversal(input, 'account')).toThrow()
  })

  it('validates the immutable reversal audit record against its stored request', () => {
    const prepared = prepareAccountSplitReversal(request, 'account')
    const reversal = {
      id: 'reversal',
      accountId: 'account',
      actionId: 'split-action',
      idempotencyKey: request.idempotencyKey,
      payloadHash: prepared.payloadHash,
      reason: request.reason,
      request,
      auditNumber: 5,
      previousFingerprint: 'a'.repeat(64),
      nextFingerprint: 'c'.repeat(64),
      recordedAt: new Date('2026-01-01T00:00:00Z'),
    }
    expect(
      prepareStoredAccountSplitReversal(reversal, 'account', 'split-action')
    ).toEqual(prepared)
    expect(() =>
      prepareStoredAccountSplitReversal(
        { ...reversal, nextFingerprint: reversal.previousFingerprint },
        'account',
        'split-action'
      )
    ).toThrow('Invalid split reversal audit continuation')
  })
})
