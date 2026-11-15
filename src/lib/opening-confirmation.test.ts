import { describe, expect, it } from 'vitest'
import { prepareOpeningConfirmation } from './opening-confirmation.js'

const request = {
  idempotencyKey: 'confirm-1',
  expectedSourceFingerprint: 'a'.repeat(64),
  acknowledgements: {
    openingBalancesReviewed: true,
    cashEvidenceUserAttested: true,
    priorDraftActivityExcluded: true,
    returnsUnavailableWithoutValuations: true,
  },
}

describe('prepareOpeningConfirmation', () => {
  it('normalizes a fully acknowledged confirmation and hashes its immutable intent', () => {
    const first = prepareOpeningConfirmation(request)
    const retry = prepareOpeningConfirmation({
      ...request,
      idempotencyKey: 'confirm-2',
    })
    expect(first.request).toEqual(request)
    expect(first.payloadHash).toMatch(/^[a-f0-9]{64}$/)
    expect(retry.payloadHash).toBe(first.payloadHash)
  })

  it.each([
    null,
    { ...request, unexpected: true },
    { ...request, idempotencyKey: ' ' },
    { ...request, expectedSourceFingerprint: 'invalid' },
    {
      ...request,
      acknowledgements: {
        ...request.acknowledgements,
        openingBalancesReviewed: false,
      },
    },
    {
      ...request,
      acknowledgements: { ...request.acknowledgements, extra: true },
    },
  ])('rejects invalid confirmation input %#', (input) => {
    expect(() => prepareOpeningConfirmation(input)).toThrow()
  })
})
