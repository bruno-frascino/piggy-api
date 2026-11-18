import { createHash } from 'node:crypto'

export interface AccountSplitReversalInput {
  idempotencyKey: string
  actionId: string
  expectedAuditNumber: number
  expectedSourceFingerprint: string
  reason: string
  reversalConfirmed: true
}

function invalid(message = 'Invalid terminal stock split reversal'): never {
  throw Object.assign(new Error(message), {
    status: 400,
    name: 'Validation Error',
  })
}

function text(value: unknown, maximumLength = 200): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.trim() !== value ||
    value.length > maximumLength ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    invalid()
  return value
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid()
  return value
}

export function prepareAccountSplitReversal(
  raw: unknown,
  accountId: string
): {
  accountId: string
  request: AccountSplitReversalInput
  payloadHash: string
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  const keys = [
    'idempotencyKey',
    'actionId',
    'expectedAuditNumber',
    'expectedSourceFingerprint',
    'reason',
    'reversalConfirmed',
  ]
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    !Number.isSafeInteger(row.expectedAuditNumber) ||
    Number(row.expectedAuditNumber) < 1 ||
    row.reversalConfirmed !== true
  )
    invalid()
  const request: AccountSplitReversalInput = {
    idempotencyKey: text(row.idempotencyKey),
    actionId: text(row.actionId),
    expectedAuditNumber: Number(row.expectedAuditNumber),
    expectedSourceFingerprint: fingerprint(row.expectedSourceFingerprint),
    reason: text(row.reason, 500),
    reversalConfirmed: true,
  }
  const normalizedAccountId = text(accountId)
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify({
        methodology: 'account-split-reversal-v1',
        accountId: normalizedAccountId,
        request,
      })
    )
    .digest('hex')
  return { accountId: normalizedAccountId, request, payloadHash }
}

export interface StoredAccountSplitReversal {
  id: string
  accountId: string
  actionId: string
  idempotencyKey: string
  payloadHash: string
  reason: string
  request: unknown
  auditNumber: number
  previousFingerprint: string
  nextFingerprint: string
  recordedAt: Date
}

export function prepareStoredAccountSplitReversal(
  reversal: StoredAccountSplitReversal,
  accountId: string,
  actionId: string
) {
  const prepared = prepareAccountSplitReversal(reversal.request, accountId)
  if (
    reversal.accountId !== accountId ||
    reversal.actionId !== actionId ||
    prepared.request.actionId !== actionId ||
    prepared.payloadHash !== reversal.payloadHash ||
    reversal.idempotencyKey !== prepared.request.idempotencyKey ||
    reversal.reason !== prepared.request.reason ||
    prepared.request.expectedAuditNumber !== reversal.auditNumber - 1 ||
    prepared.request.expectedSourceFingerprint !==
      reversal.previousFingerprint ||
    !Number.isSafeInteger(reversal.auditNumber) ||
    reversal.auditNumber < 1 ||
    !/^[a-f0-9]{64}$/.test(reversal.previousFingerprint) ||
    !/^[a-f0-9]{64}$/.test(reversal.nextFingerprint) ||
    reversal.previousFingerprint === reversal.nextFingerprint
  )
    throw new Error('Invalid split reversal audit continuation')
  return prepared
}
