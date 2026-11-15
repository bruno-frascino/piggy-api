import { createHash } from 'node:crypto'
import {
  prepareAccountReinvestment,
  type AccountReinvestmentInput,
} from './account-reinvestment-command.js'
import { parseManualTradeVoidInput } from './manual-trade-void.js'

export interface ReinvestmentCorrectionInput {
  idempotencyKey: string
  expectedIncomeRevisionId: string
  expectedAcquisitionRevisionId: string
  expectedAuditNumber: number
  expectedSourceFingerprint: string
  reason: string
  replacement: Omit<AccountReinvestmentInput, 'idempotencyKey'> | null
}

export function prepareReinvestmentCorrection(
  raw: unknown,
  accountId: string,
  now = new Date()
) {
  function invalid(): never {
    throw Object.assign(new Error('Invalid paired reinvestment correction'), {
      status: 400,
      name: 'Validation Error',
    })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const row = raw as Record<string, unknown>
  const keys = [
    'idempotencyKey',
    'expectedIncomeRevisionId',
    'expectedAcquisitionRevisionId',
    'expectedAuditNumber',
    'expectedSourceFingerprint',
    'reason',
    'replacement',
  ]
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    typeof row.expectedAuditNumber !== 'number' ||
    !Number.isSafeInteger(row.expectedAuditNumber) ||
    row.expectedAuditNumber < 0
  )
    invalid()
  const head = (expectedRevisionId: unknown) =>
    parseManualTradeVoidInput({
      idempotencyKey: row.idempotencyKey,
      expectedRevisionId,
      expectedSourceFingerprint: row.expectedSourceFingerprint,
      reason: row.reason,
    })
  const income = head(row.expectedIncomeRevisionId)
  const acquisition = head(row.expectedAcquisitionRevisionId)
  let replacement = null
  if (row.replacement !== null) {
    if (
      !row.replacement ||
      typeof row.replacement !== 'object' ||
      Array.isArray(row.replacement) ||
      'idempotencyKey' in row.replacement
    )
      invalid()
    replacement = prepareAccountReinvestment(
      { ...row.replacement, idempotencyKey: income.idempotencyKey },
      accountId,
      now
    )
  }
  const input: ReinvestmentCorrectionInput = {
    idempotencyKey: income.idempotencyKey,
    expectedIncomeRevisionId: income.expectedRevisionId,
    expectedAcquisitionRevisionId: acquisition.expectedRevisionId,
    expectedAuditNumber: row.expectedAuditNumber,
    expectedSourceFingerprint: income.expectedSourceFingerprint,
    reason: income.reason,
    replacement: replacement
      ? {
          income: replacement.request.income,
          acquisition: replacement.request.acquisition,
          residualAmount: replacement.request.residualAmount,
          residualDisposition: replacement.request.residualDisposition,
          statementConfirmed: true,
        }
      : null,
  }
  return {
    input,
    replacement,
    payloadHash: createHash('sha256')
      .update(JSON.stringify({ accountId, input }))
      .digest('hex'),
  }
}
