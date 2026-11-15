import { createHash } from 'node:crypto'

export interface OpeningConfirmationAcknowledgements {
  openingBalancesReviewed: true
  cashEvidenceUserAttested: true
  priorDraftActivityExcluded: true
  returnsUnavailableWithoutValuations: true
}

export interface OpeningConfirmationInput {
  idempotencyKey: string
  expectedSourceFingerprint: string
  acknowledgements: OpeningConfirmationAcknowledgements
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), {
    status: 400,
    name: 'Validation Error',
  })
}

export function prepareOpeningConfirmation(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    invalid('Opening confirmation must be an object')
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'idempotencyKey',
          'expectedSourceFingerprint',
          'acknowledgements',
        ].includes(key)
    )
  )
    invalid('Unsupported opening confirmation fields must not be ignored')
  if (
    typeof row.idempotencyKey !== 'string' ||
    !row.idempotencyKey.trim() ||
    row.idempotencyKey !== row.idempotencyKey.trim() ||
    row.idempotencyKey.length > 200
  )
    invalid('A bounded opening confirmation idempotency key is required')
  if (
    typeof row.expectedSourceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.expectedSourceFingerprint)
  )
    invalid('A reviewed opening source fingerprint is required')
  if (
    !row.acknowledgements ||
    typeof row.acknowledgements !== 'object' ||
    Array.isArray(row.acknowledgements)
  )
    invalid('All opening confirmation acknowledgements are required')
  const acknowledgements = row.acknowledgements as Record<string, unknown>
  const expectedAcknowledgements = [
    'openingBalancesReviewed',
    'cashEvidenceUserAttested',
    'priorDraftActivityExcluded',
    'returnsUnavailableWithoutValuations',
  ] as const
  if (
    Object.keys(acknowledgements).length !== expectedAcknowledgements.length ||
    expectedAcknowledgements.some((key) => acknowledgements[key] !== true)
  )
    invalid('Review and acknowledge every opening confirmation statement')

  const request: OpeningConfirmationInput = {
    idempotencyKey: row.idempotencyKey,
    expectedSourceFingerprint: row.expectedSourceFingerprint,
    acknowledgements: {
      openingBalancesReviewed: true,
      cashEvidenceUserAttested: true,
      priorDraftActivityExcluded: true,
      returnsUnavailableWithoutValuations: true,
    },
  }
  return {
    request,
    payloadHash: createHash('sha256')
      .update(
        JSON.stringify({
          methodology: 'opening-confirmation-v1',
          expectedSourceFingerprint: request.expectedSourceFingerprint,
          acknowledgements: request.acknowledgements,
        })
      )
      .digest('hex'),
  }
}
