import { createHash } from 'node:crypto'
import {
  parseManualTradeVoidAudit,
  type ManualTradeVoidAudit,
} from './manual-trade-void.js'
import { AccountingDecimal } from './accounting-values.js'
import {
  parseExecutionAudit,
  type ExecutionAudit,
} from './execution-correction.js'
import { sydneyCalendarDate } from './accounting-preview.js'
import {
  prepareCashCommand,
  type CashCommand,
  type CashLeg,
} from './cash-ledger.js'
import {
  prepareDraftTradeRequest,
  prepareDraftTradeCash,
  type DraftTradeRequest,
} from './draft-trade-command.js'
import {
  parseImportedExecutionAudit,
  type ImportedExecutionAudit,
} from './import-execution-correction.js'
import {
  prepareAccountIncomeReceipt,
  type AccountIncomeReceiptInput,
} from './account-income-command.js'
import {
  parseAccountCashTransferCorrection,
  type AccountCashTransferCorrectionInput,
} from './account-cash-transfer.js'
import { prepareAccountFxConversion } from './account-fx-command.js'
import {
  prepareReinvestmentCorrection,
  type ReinvestmentCorrectionInput,
} from './reinvestment-correction.js'

export interface CashRevisionRequest {
  idempotencyKey: string
  expectedRevisionId: string
  reason: string
  replacement: CashCommand | null
  expectedAuditNumber?: number
  expectedSourceFingerprint?: string
  proposedTrade?: DraftTradeRequest | null
  executionAudit?: ExecutionAudit
  importedExecutionAudit?: ImportedExecutionAudit
  voidAudit?: ManualTradeVoidAudit
  capitalAudit?: CapitalCashAudit
  incomeAudit?: IncomeCashAudit
  transferAudit?: TransferCashAudit
  fxAudit?: FxCashAudit
  reinvestmentAudit?: { accountId: string; input: ReinvestmentCorrectionInput }
}

export interface TransferCashAudit {
  number: number
  previousFingerprint: string
  nextFingerprint: string
  before: CashCommand
  after: CashCommand | null
  correction: AccountCashTransferCorrectionInput
}

function transferReplacement(
  before: CashCommand,
  correction: AccountCashTransferCorrectionInput,
  now: Date
): CashCommand | null {
  if (before.kind !== 'TRANSFER_OUT' && before.kind !== 'TRANSFER_IN')
    cashRevisionConflict('Transfer revisions require a paired transfer command')
  const next = correction.replacement
  return next
    ? prepareCashCommand(
        {
          ...before,
          idempotencyKey: correction.idempotencyKey,
          effectiveDate: next.effectiveDate,
          sequence:
            before.kind === 'TRANSFER_OUT'
              ? next.sourceSequence
              : next.destinationSequence,
          cash: { currency: before.cash.currency, amount: next.amount },
          fee: before.kind === 'TRANSFER_OUT' ? next.fee : '0',
        },
        now
      ).command
    : null
}

export function prepareLiveTransferCashRevision(
  raw: unknown,
  before: CashCommand,
  now = new Date()
) {
  const correction = parseAccountCashTransferCorrection(raw, now)
  if (before.kind !== 'TRANSFER_OUT' && before.kind !== 'TRANSFER_IN')
    cashRevisionConflict(
      'Only paired cash transfers can use this revision workflow'
    )
  const head =
    before.kind === 'TRANSFER_OUT'
      ? correction.sourceHead
      : correction.destinationHead
  const after = transferReplacement(before, correction, now)
  return prepareCashRevision(
    {
      idempotencyKey: correction.idempotencyKey,
      expectedRevisionId: head.revisionId,
      expectedAuditNumber: head.auditNumber,
      expectedSourceFingerprint: head.sourceFingerprint,
      reason: correction.reason,
      replacement: after,
      transferAudit: {
        number: head.auditNumber + 1,
        previousFingerprint: head.sourceFingerprint,
        nextFingerprint: head.sourceFingerprint,
        before,
        after,
        correction,
      },
    },
    now
  )
}

function parseTransferCashAudit(
  raw: unknown,
  request: CashRevisionRequest,
  now: Date
): TransferCashAudit {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Transfer correction requires its paired audit', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).length !== 6 ||
    Object.keys(row).some(
      (key) =>
        ![
          'number',
          'previousFingerprint',
          'nextFingerprint',
          'before',
          'after',
          'correction',
        ].includes(key)
    )
  )
    cashRevisionConflict('Invalid paired transfer audit', 400)
  const before = prepareCashCommand(row.before, now).command
  if (before.kind !== 'TRANSFER_OUT' && before.kind !== 'TRANSFER_IN')
    cashRevisionConflict('Transfer audit requires the original paired identity')
  const correction = parseAccountCashTransferCorrection(row.correction, now)
  const head =
    before.kind === 'TRANSFER_OUT'
      ? correction.sourceHead
      : correction.destinationHead
  const after = transferReplacement(before, correction, now)
  const actualAfter =
    row.after === null ? null : prepareCashCommand(row.after, now).command
  if (
    request.expectedRevisionId !== head.revisionId ||
    request.expectedAuditNumber !== head.auditNumber ||
    request.expectedSourceFingerprint !== head.sourceFingerprint ||
    request.idempotencyKey !== correction.idempotencyKey ||
    request.reason !== correction.reason ||
    row.number !== head.auditNumber + 1 ||
    row.previousFingerprint !== head.sourceFingerprint ||
    row.nextFingerprint !== head.sourceFingerprint ||
    JSON.stringify(actualAfter) !== JSON.stringify(after) ||
    JSON.stringify(request.replacement) !== JSON.stringify(after)
  )
    cashRevisionConflict(
      'Transfer audit must preserve both accounts, currency and source and match the reviewed correction'
    )
  return {
    number: head.auditNumber + 1,
    previousFingerprint: head.sourceFingerprint,
    nextFingerprint: head.sourceFingerprint,
    before,
    after,
    correction,
  }
}

export interface CapitalCashAudit {
  number: number
  previousFingerprint: string
  nextFingerprint: string
  before: CashCommand
  after: CashCommand | null
}

export type FxCashAudit = CapitalCashAudit

export interface IncomeCashAudit {
  number: number
  previousFingerprint: string
  nextFingerprint: string
  before: CashCommand
  after: CashCommand | null
}

export interface PreparedCashRevision {
  request: CashRevisionRequest
  payloadHash: string
}

function cashRevisionConflict(message: string, status = 409): never {
  throw Object.assign(new Error(message), {
    status,
    name: status === 400 ? 'Validation Error' : 'Accounting Conflict',
  })
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    cashRevisionConflict(
      'Correction requires bounded identifiers and an audit reason without control characters',
      400
    )
  return value
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    cashRevisionConflict('Source fingerprint must be a SHA-256 digest', 400)
  return value
}

function parseCashOnlyAudit(
  raw: unknown,
  request: CashRevisionRequest,
  now: Date,
  isFx = false
): CapitalCashAudit {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Capital revision audit must be an object', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).length !== 5 ||
    Object.keys(row).some(
      (key) =>
        ![
          'number',
          'previousFingerprint',
          'nextFingerprint',
          'before',
          'after',
        ].includes(key)
    ) ||
    !Number.isSafeInteger(row.number) ||
    (row.number as number) < 1
  )
    cashRevisionConflict('Capital revision audit is invalid', 400)
  const before = prepareCashCommand(row.before, now).command
  const after =
    row.after === null ? null : prepareCashCommand(row.after, now).command
  if (
    request.expectedAuditNumber === undefined ||
    request.expectedSourceFingerprint === undefined ||
    row.number !== request.expectedAuditNumber + 1 ||
    row.previousFingerprint !== request.expectedSourceFingerprint ||
    row.nextFingerprint !== request.expectedSourceFingerprint ||
    (isFx
      ? before.kind !== 'FX_CONVERSION'
      : before.kind !== 'DEPOSIT' && before.kind !== 'WITHDRAWAL') ||
    before.source.origin !== 'MANUAL' ||
    (after &&
      (after.accountId !== before.accountId ||
        after.kind !== before.kind ||
        after.source.origin !== before.source.origin ||
        after.source.reference !== before.source.reference ||
        (before.kind === 'FX_CONVERSION' && after.kind === 'FX_CONVERSION'
          ? after.from.currency !== before.from.currency ||
            after.to.currency !== before.to.currency
          : !('cash' in before) ||
            !('cash' in after) ||
            after.cash.currency !== before.cash.currency))) ||
    JSON.stringify(after) !== JSON.stringify(request.replacement)
  )
    cashRevisionConflict(
      `${isFx ? 'FX' : 'Capital'} revision audit must preserve identity and match its replacement`
    )
  return {
    number: row.number as number,
    previousFingerprint: fingerprint(row.previousFingerprint),
    nextFingerprint: fingerprint(row.nextFingerprint),
    before,
    after,
  }
}

function parseIncomeCashAudit(
  raw: unknown,
  request: CashRevisionRequest,
  now: Date
): IncomeCashAudit {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Income revision audit must be an object', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).length !== 5 ||
    Object.keys(row).some(
      (key) =>
        ![
          'number',
          'previousFingerprint',
          'nextFingerprint',
          'before',
          'after',
        ].includes(key)
    ) ||
    !Number.isSafeInteger(row.number) ||
    (row.number as number) < 1
  )
    cashRevisionConflict('Income revision audit is invalid', 400)
  const before = prepareCashCommand(row.before, now).command
  const after =
    row.after === null ? null : prepareCashCommand(row.after, now).command
  if (
    request.expectedAuditNumber === undefined ||
    request.expectedSourceFingerprint === undefined ||
    row.number !== request.expectedAuditNumber + 1 ||
    row.previousFingerprint !== request.expectedSourceFingerprint ||
    row.nextFingerprint !== request.expectedSourceFingerprint ||
    before.kind !== 'INCOME' ||
    before.source.origin !== 'MANUAL' ||
    (after &&
      (after.kind !== 'INCOME' ||
        after.accountId !== before.accountId ||
        after.source.origin !== before.source.origin ||
        after.source.reference !== before.source.reference ||
        after.cash.currency !== before.cash.currency ||
        after.income.assetId !== before.income.assetId)) ||
    JSON.stringify(after) !== JSON.stringify(request.replacement)
  )
    cashRevisionConflict(
      'Income revision audit must preserve the receipt identity and match its replacement'
    )
  return {
    number: row.number as number,
    previousFingerprint: fingerprint(row.previousFingerprint),
    nextFingerprint: fingerprint(row.nextFingerprint),
    before,
    after,
  }
}

export function prepareCashRevision(
  raw: unknown,
  now = new Date()
): PreparedCashRevision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Cash correction must be an object', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'idempotencyKey',
          'expectedRevisionId',
          'reason',
          'replacement',
          'proposedTrade',
          'executionAudit',
          'importedExecutionAudit',
          'voidAudit',
          'expectedAuditNumber',
          'expectedSourceFingerprint',
          'capitalAudit',
          'incomeAudit',
          'transferAudit',
          'fxAudit',
          'reinvestmentAudit',
        ].includes(key)
    )
  )
    cashRevisionConflict(
      'Correction requires bounded identifiers, an audit reason and no unsupported fields',
      400
    )
  const request: CashRevisionRequest = {
    idempotencyKey: text(row.idempotencyKey, 200),
    expectedRevisionId: text(row.expectedRevisionId, 200),
    reason: text(row.reason, 1000),
    replacement:
      row.replacement === null
        ? null
        : prepareCashCommand(row.replacement, now).command,
    ...('expectedAuditNumber' in row
      ? {
          expectedAuditNumber:
            Number.isSafeInteger(row.expectedAuditNumber) &&
            (row.expectedAuditNumber as number) >= 0
              ? (row.expectedAuditNumber as number)
              : (() => {
                  cashRevisionConflict(
                    'Expected live audit number must be a non-negative integer',
                    400
                  )
                })(),
        }
      : {}),
    ...('expectedSourceFingerprint' in row
      ? {
          expectedSourceFingerprint: fingerprint(row.expectedSourceFingerprint),
        }
      : {}),
    ...('proposedTrade' in row
      ? {
          proposedTrade:
            row.proposedTrade === null
              ? null
              : prepareDraftTradeRequest(row.proposedTrade, now).request,
        }
      : {}),
    ...('executionAudit' in row
      ? { executionAudit: parseExecutionAudit(row.executionAudit) }
      : {}),
    ...('importedExecutionAudit' in row
      ? {
          importedExecutionAudit: parseImportedExecutionAudit(
            row.importedExecutionAudit
          ),
        }
      : {}),
    ...('voidAudit' in row
      ? { voidAudit: parseManualTradeVoidAudit(row.voidAudit) }
      : {}),
  }
  if (
    'expectedAuditNumber' in request !==
    'expectedSourceFingerprint' in request
  )
    cashRevisionConflict(
      'Live capital revisions require both an expected audit number and source fingerprint',
      400
    )
  if ('capitalAudit' in row)
    request.capitalAudit = parseCashOnlyAudit(row.capitalAudit, request, now)
  if ('fxAudit' in row) {
    if (
      [
        'capitalAudit',
        'incomeAudit',
        'transferAudit',
        'executionAudit',
        'importedExecutionAudit',
        'voidAudit',
        'proposedTrade',
      ].some((key) => key in row)
    )
      cashRevisionConflict('FX revisions cannot mix audit workflows')
    request.fxAudit = parseCashOnlyAudit(row.fxAudit, request, now, true)
  }
  if ('incomeAudit' in row)
    request.incomeAudit = parseIncomeCashAudit(row.incomeAudit, request, now)
  if ('transferAudit' in row) {
    if (
      [
        'capitalAudit',
        'incomeAudit',
        'voidAudit',
        'executionAudit',
        'importedExecutionAudit',
        'proposedTrade',
        'fxAudit',
      ].some((key) => key in row)
    )
      cashRevisionConflict('Transfer revisions cannot mix audit workflows')
    request.transferAudit = parseTransferCashAudit(
      row.transferAudit,
      request,
      now
    )
  }
  if (
    request.replacement &&
    request.replacement.idempotencyKey !== request.idempotencyKey
  )
    cashRevisionConflict(
      'Replacement command must use the correction idempotency key',
      400
    )
  if ('proposedTrade' in request) {
    const trade = request.proposedTrade
    const cash = request.replacement
    if (trade === null) {
      if (cash !== null)
        cashRevisionConflict('Trade reversal must also reverse its cash', 400)
    } else {
      if (
        !trade ||
        !cash ||
        (cash.kind !== 'BUY' && cash.kind !== 'SELL') ||
        cash.transactionIds.length !== 1 ||
        prepareDraftTradeCash(trade, cash.transactionIds[0], now)
          .payloadHash !== prepareCashCommand(cash, now).payloadHash
      )
        cashRevisionConflict(
          'Proposed trade correction must exactly match its cash replacement',
          400
        )
    }
  }
  if (request.executionAudit) {
    const audit = request.executionAudit
    const cash = request.replacement
    if (
      request.proposedTrade !== undefined ||
      !cash ||
      cash.kind !== (audit.kind ?? 'SELL') ||
      cash.source.origin !== 'MANUAL' ||
      cash.transactionIds.length !== 1 ||
      cash.transactionIds[0] !== audit.after.transactionId ||
      cash.consideration.currency !== audit.after.currency ||
      cash.consideration.amount !== audit.after.totalValue ||
      (cash.fees[0]?.amount ?? '0') !== audit.after.fees ||
      cash.fees.some((fee) => fee.currency !== audit.after.currency) ||
      cash.effectiveDate !== sydneyCalendarDate(new Date(audit.after.date)) ||
      cash.effectiveDate !== audit.input.effectiveDate ||
      cash.sequence !== audit.input.sequence ||
      request.idempotencyKey !== audit.input.idempotencyKey ||
      request.expectedRevisionId !== audit.input.expectedRevisionId ||
      request.reason !== audit.input.reason
    )
      cashRevisionConflict(
        'Source audit must exactly match the manual execution cash revision',
        400
      )
  }
  if (request.importedExecutionAudit) {
    const audit = request.importedExecutionAudit
    const cash = request.replacement
    const snapshots = audit.after
    const currency = snapshots[0]?.currency
    const gross = snapshots.reduce(
      (sum, snapshot) => sum.plus(snapshot.totalValue),
      new AccountingDecimal(0)
    )
    const fees = snapshots.reduce(
      (sum, snapshot) => sum.plus(snapshot.fees),
      new AccountingDecimal(0)
    )
    const transactionIds = snapshots
      .map((snapshot) => snapshot.transactionId)
      .sort()
    if (
      request.executionAudit ||
      request.proposedTrade !== undefined ||
      !cash ||
      cash.source.origin !== 'IMPORT' ||
      (cash.kind !== 'BUY' && cash.kind !== 'SELL') ||
      cash.transactionIds.length !== transactionIds.length ||
      JSON.stringify([...cash.transactionIds].sort()) !==
        JSON.stringify(transactionIds) ||
      audit.before.length !== audit.after.length ||
      audit.before.some((before, index) => {
        const after = audit.after[index]
        return (
          !after ||
          before.transactionId !== after.transactionId ||
          before.positionId !== after.positionId ||
          before.quantity !== after.quantity ||
          before.currency !== after.currency
        )
      }) ||
      snapshots.some(
        (snapshot) =>
          snapshot.currency !== currency ||
          snapshot.date.slice(0, 10) !== audit.input.effectiveDate ||
          snapshot.price !== audit.input.price ||
          snapshot.totalValue !==
            new AccountingDecimal(snapshot.quantity)
              .mul(snapshot.price)
              .toDecimalPlaces(8, AccountingDecimal.ROUND_HALF_UP)
              .toFixed()
      ) ||
      fees.toFixed() !== audit.input.fees ||
      audit.input.expectedSourceFingerprint !== audit.previousFingerprint ||
      cash.consideration.currency !== currency ||
      cash.consideration.amount !== gross.toFixed() ||
      (cash.fees[0]?.amount ?? '0') !== fees.toFixed() ||
      cash.fees.some((fee) => fee.currency !== currency) ||
      cash.effectiveDate !== audit.input.effectiveDate ||
      cash.sequence !== audit.input.sequence ||
      request.idempotencyKey !== audit.input.idempotencyKey ||
      request.expectedRevisionId !== audit.input.expectedRevisionId ||
      request.reason !== audit.input.reason
    )
      cashRevisionConflict(
        'Imported execution audit must exactly match its cash correction',
        400
      )
  }
  if (request.voidAudit) {
    const audit = request.voidAudit
    if (
      request.replacement !== null ||
      request.executionAudit ||
      request.importedExecutionAudit ||
      request.proposedTrade !== undefined ||
      request.idempotencyKey !== audit.input.idempotencyKey ||
      request.expectedRevisionId !== audit.input.expectedRevisionId ||
      request.reason !== audit.input.reason
    )
      cashRevisionConflict(
        'A manual trade void requires a terminal reversal and matching source audit',
        400
      )
  }
  if ('reinvestmentAudit' in row) {
    const audit = row.reinvestmentAudit
    if (!audit || typeof audit !== 'object' || Array.isArray(audit))
      cashRevisionConflict('Missing paired reinvestment audit', 400)
    const value = audit as Record<string, unknown>
    if (
      Object.keys(value).length !== 2 ||
      typeof value.accountId !== 'string' ||
      !value.accountId.length ||
      !('input' in value) ||
      (!request.incomeAudit && !request.executionAudit && !request.voidAudit)
    )
      cashRevisionConflict('Invalid paired reinvestment audit', 400)
    const paired = prepareReinvestmentCorrection(
      value.input,
      value.accountId,
      now
    )
    if (
      request.reason !== paired.input.reason ||
      request.expectedRevisionId !==
        (request.incomeAudit
          ? paired.input.expectedIncomeRevisionId
          : paired.input.expectedAcquisitionRevisionId)
    )
      cashRevisionConflict(
        'Reinvestment revision does not match its paired review',
        400
      )
    request.reinvestmentAudit = {
      accountId: value.accountId,
      input: paired.input,
    }
  }
  const {
    capitalAudit: _capitalAudit,
    incomeAudit: _incomeAudit,
    fxAudit: _fxAudit,
    ...hashRequest
  } = request
  return {
    request,
    payloadHash: createHash('sha256')
      .update(
        JSON.stringify({
          methodology: 'cash-revisions-v1',
          request: hashRequest,
        })
      )
      .digest('hex'),
  }
}

export function prepareDraftTradeRevision(
  raw: unknown,
  tradeId: string,
  now = new Date()
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Trade correction must be an object', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'idempotencyKey',
          'expectedRevisionId',
          'reason',
          'replacement',
        ].includes(key)
    )
  )
    cashRevisionConflict('Unsupported proposed trade correction fields', 400)
  const trade =
    row.replacement === null
      ? null
      : prepareDraftTradeRequest(row.replacement, now).request
  return prepareCashRevision(
    {
      idempotencyKey: row.idempotencyKey,
      expectedRevisionId: row.expectedRevisionId,
      reason: row.reason,
      replacement: trade
        ? prepareDraftTradeCash(trade, tradeId, now).command
        : null,
      proposedTrade: trade,
    },
    now
  )
}

export function prepareLiveIncomeCashRevision(
  raw: unknown,
  original: CashCommand,
  now = new Date()
): PreparedCashRevision {
  if (original.kind !== 'INCOME' || original.source.origin !== 'MANUAL')
    cashRevisionConflict(
      'Only manual income receipts can use this correction workflow'
    )
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Income correction must be an object', 400)
  const row = raw as Record<string, unknown>
  const allowed = [
    'idempotencyKey',
    'expectedRevisionId',
    'expectedAuditNumber',
    'expectedSourceFingerprint',
    'reason',
    'replacement',
  ]
  if (
    Object.keys(row).length !== allowed.length ||
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    !Number.isSafeInteger(row.expectedAuditNumber) ||
    (row.expectedAuditNumber as number) < 0 ||
    typeof row.expectedSourceFingerprint !== 'string'
  )
    cashRevisionConflict('Income correction request is invalid', 400)

  let replacement: CashCommand | null = null
  if (row.replacement !== null) {
    if (
      !row.replacement ||
      typeof row.replacement !== 'object' ||
      Array.isArray(row.replacement)
    )
      cashRevisionConflict(
        'Supply replacement income details, or null for terminal reversal',
        400
      )
    const next = row.replacement as Record<string, unknown>
    const replacementFields = [
      'entitlementDate',
      'paymentDate',
      'sequence',
      'grossAmount',
      'withholdingAmount',
      'frankedAmount',
      'unfrankedAmount',
      'frankingCreditAud',
    ]
    if (
      Object.keys(next).length !== replacementFields.length ||
      Object.keys(next).some((key) => !replacementFields.includes(key)) ||
      typeof next.entitlementDate !== 'string' ||
      typeof next.paymentDate !== 'string' ||
      typeof next.sequence !== 'number' ||
      typeof next.grossAmount !== 'string' ||
      typeof next.withholdingAmount !== 'string' ||
      typeof next.frankedAmount !== 'string' ||
      typeof next.unfrankedAmount !== 'string' ||
      typeof next.frankingCreditAud !== 'string'
    )
      cashRevisionConflict(
        'Income replacement cannot change asset, currency or source identity',
        400
      )
    const incomeInput: AccountIncomeReceiptInput = {
      idempotencyKey: text(row.idempotencyKey, 200),
      assetId: original.income.assetId,
      entitlementDate: next.entitlementDate,
      paymentDate: next.paymentDate,
      sequence: next.sequence,
      currency: original.cash.currency,
      grossAmount: next.grossAmount,
      withholdingAmount: next.withholdingAmount,
      frankedAmount: next.frankedAmount,
      unfrankedAmount: next.unfrankedAmount,
      frankingCreditAud: next.frankingCreditAud,
      sourceReference: original.source.reference,
    }

    replacement = prepareAccountIncomeReceipt(
      incomeInput,
      original.accountId,
      now
    ).cash.command
  }

  return prepareCashRevision(
    {
      idempotencyKey: row.idempotencyKey,
      expectedRevisionId: row.expectedRevisionId,
      expectedAuditNumber: row.expectedAuditNumber,
      expectedSourceFingerprint: row.expectedSourceFingerprint,
      reason: row.reason,
      replacement,
    },
    now
  )
}

export function prepareLiveFxCashRevision(
  raw: unknown,
  original: CashCommand,
  now = new Date()
): PreparedCashRevision {
  if (original.kind !== 'FX_CONVERSION' || original.source.origin !== 'MANUAL')
    cashRevisionConflict(
      'Only manual FX conversions can use this correction workflow'
    )
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('FX correction must be an object', 400)
  const row = raw as Record<string, unknown>
  const allowed = [
    'idempotencyKey',
    'expectedRevisionId',
    'expectedAuditNumber',
    'expectedSourceFingerprint',
    'reason',
    'replacement',
  ]
  if (
    Object.keys(row).length !== allowed.length ||
    Object.keys(row).some((key) => !allowed.includes(key))
  )
    cashRevisionConflict(
      'FX correction requires current review heads, a reason and no unsupported fields',
      400
    )
  let replacement: CashCommand | null = null
  if (row.replacement !== null) {
    if (
      !row.replacement ||
      typeof row.replacement !== 'object' ||
      Array.isArray(row.replacement)
    )
      cashRevisionConflict(
        'Supply exact replacement FX amounts/fees/date/order, or null for terminal reversal',
        400
      )
    const next = row.replacement as Record<string, unknown>
    const fields = [
      'effectiveDate',
      'sequence',
      'fromAmount',
      'toAmount',
      'fees',
    ]
    if (
      Object.keys(next).length !== fields.length ||
      Object.keys(next).some((key) => !fields.includes(key))
    )
      cashRevisionConflict(
        'FX correction cannot change account, currency direction or source identity',
        400
      )
    replacement = prepareAccountFxConversion(
      {
        idempotencyKey: row.idempotencyKey,
        effectiveDate: next.effectiveDate,
        sequence: next.sequence,
        from: { currency: original.from.currency, amount: next.fromAmount },
        to: { currency: original.to.currency, amount: next.toAmount },
        fees: next.fees,
        sourceReference: original.source.reference,
      },
      original.accountId,
      now
    ).cash.command
  }
  const prepared = prepareCashRevision(
    {
      idempotencyKey: row.idempotencyKey,
      expectedRevisionId: row.expectedRevisionId,
      expectedAuditNumber: row.expectedAuditNumber,
      expectedSourceFingerprint: row.expectedSourceFingerprint,
      reason: row.reason,
      replacement,
    },
    now
  )
  if (
    prepared.request.expectedAuditNumber === undefined ||
    prepared.request.expectedSourceFingerprint === undefined
  )
    cashRevisionConflict(
      'FX corrections require both current audit number and source fingerprint',
      400
    )
  return prepared
}

export function prepareCapitalCashRevision(
  raw: unknown,
  original: CashCommand,
  now = new Date()
): PreparedCashRevision {
  if (
    original.source.origin !== 'MANUAL' ||
    (original.kind !== 'DEPOSIT' && original.kind !== 'WITHDRAWAL')
  )
    cashRevisionConflict(
      'Only manual deposits and withdrawals can use this correction workflow'
    )
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Capital correction must be an object', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'idempotencyKey',
          'expectedRevisionId',
          'reason',
          'replacement',
        ].includes(key)
    )
  )
    cashRevisionConflict('Unsupported capital correction fields', 400)
  let replacement: CashCommand | null = null
  if (row.replacement !== null) {
    if (
      !row.replacement ||
      typeof row.replacement !== 'object' ||
      Array.isArray(row.replacement)
    )
      cashRevisionConflict(
        'Supply replacement date, sequence and amount, or null for reversal',
        400
      )
    const next = row.replacement as Record<string, unknown>
    if (
      Object.keys(next).some(
        (key) => !['effectiveDate', 'sequence', 'amount'].includes(key)
      )
    )
      cashRevisionConflict(
        'Replacement cannot change the currency, source or operation identity',
        400
      )
    replacement = prepareCashCommand(
      {
        ...original,
        idempotencyKey: row.idempotencyKey,
        effectiveDate: next.effectiveDate,
        sequence: next.sequence,
        cash: { currency: original.cash.currency, amount: next.amount },
      },
      now
    ).command
  }
  return prepareCashRevision(
    {
      idempotencyKey: row.idempotencyKey,
      expectedRevisionId: row.expectedRevisionId,
      reason: row.reason,
      replacement,
    },
    now
  )
}

export interface RevisionLeg extends CashLeg {
  phase: 'REVERSAL' | 'REPLACEMENT'
}

export function prepareLiveCapitalCashRevision(
  raw: unknown,
  original: CashCommand,
  now = new Date()
): PreparedCashRevision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Capital correction must be an object', 400)
  const row = raw as Record<string, unknown>
  const { expectedAuditNumber, expectedSourceFingerprint, ...capitalInput } =
    row
  if (
    !Number.isSafeInteger(expectedAuditNumber) ||
    (expectedAuditNumber as number) < 0 ||
    typeof expectedSourceFingerprint !== 'string'
  )
    cashRevisionConflict(
      'Live capital corrections require the current audit number and source fingerprint',
      400
    )
  return prepareCashRevision(
    {
      ...prepareCapitalCashRevision(capitalInput, original, now).request,
      expectedAuditNumber: expectedAuditNumber as number,
      expectedSourceFingerprint,
    },
    now
  )
}

export function prepareImportedCashRevision(
  raw: unknown,
  original: CashCommand,
  now = new Date()
): PreparedCashRevision {
  if (
    original.source.origin !== 'IMPORT' ||
    (original.kind !== 'BUY' && original.kind !== 'SELL')
  )
    cashRevisionConflict(
      'Only imported executions can use sequence corrections'
    )
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    cashRevisionConflict('Imported sequence correction must be an object', 400)
  const row = raw as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'idempotencyKey',
          'expectedRevisionId',
          'reason',
          'sequence',
        ].includes(key)
    )
  )
    cashRevisionConflict(
      'Imported corrections accept only sequence and audit fields',
      400
    )
  return prepareCashRevision(
    {
      idempotencyKey: row.idempotencyKey,
      expectedRevisionId: row.expectedRevisionId,
      reason: row.reason,
      replacement: {
        ...original,
        idempotencyKey: row.idempotencyKey,
        sequence: row.sequence,
      },
    },
    now
  )
}

export function prepareRevisionLegs(
  original: CashCommand,
  replacement: CashCommand | null,
  now = new Date()
): RevisionLeg[] {
  if (
    original.kind === 'FX_CONVERSION' ||
    replacement?.kind === 'FX_CONVERSION'
  )
    cashRevisionConflict(
      'FX corrections and reversals require the dedicated audited workflow, not generic cash revisions'
    )
  return buildRevisionLegs(original, replacement, now, false)
}

export function prepareTransferRevisionLegs(
  original: CashCommand,
  replacement: CashCommand | null,
  now = new Date()
): RevisionLeg[] {
  if (
    !('transfer' in original) ||
    (replacement &&
      (!('transfer' in replacement) ||
        replacement.transfer.fromAccountId !==
          original.transfer.fromAccountId ||
        replacement.transfer.toAccountId !== original.transfer.toAccountId ||
        replacement.cash.currency !== original.cash.currency))
  )
    cashRevisionConflict(
      'Paired transfer revision must preserve endpoint and currency identity'
    )
  return buildRevisionLegs(original, replacement, now, true)
}

export function prepareFxRevisionLegs(
  original: CashCommand,
  replacement: CashCommand | null,
  now = new Date()
): RevisionLeg[] {
  if (
    original.kind !== 'FX_CONVERSION' ||
    (replacement &&
      (replacement.kind !== 'FX_CONVERSION' ||
        replacement.from.currency !== original.from.currency ||
        replacement.to.currency !== original.to.currency))
  )
    cashRevisionConflict(
      'FX revision must preserve the currency pair and direction'
    )
  return buildRevisionLegs(original, replacement, now, false)
}

function buildRevisionLegs(
  original: CashCommand,
  replacement: CashCommand | null,
  now: Date,
  pairedTransfer: boolean
): RevisionLeg[] {
  const prior = prepareCashCommand(original, now)
  if (
    !pairedTransfer &&
    ('transfer' in prior.command || (replacement && 'transfer' in replacement))
  )
    cashRevisionConflict(
      'Cash transfers cannot be revised or reversed one account at a time'
    )
  if (replacement) {
    const next = prepareCashCommand(replacement, now).command
    const transactionIds = (command: CashCommand) =>
      command.kind === 'BUY' || command.kind === 'SELL'
        ? command.transactionIds
        : []
    if (
      next.accountId !== prior.command.accountId ||
      next.kind !== prior.command.kind ||
      JSON.stringify(next.source) !== JSON.stringify(prior.command.source) ||
      JSON.stringify(transactionIds(next)) !==
        JSON.stringify(transactionIds(prior.command))
    )
      cashRevisionConflict(
        'Replacement must retain account, operation kind, execution source and parcel transaction identities'
      )
  }
  return [
    ...prior.legs.map((leg) => ({
      ...leg,
      amount: new AccountingDecimal(leg.amount).negated().toFixed(),
      phase: 'REVERSAL' as const,
    })),
    ...(replacement
      ? prepareCashCommand(replacement, now).legs.map((leg) => ({
          ...leg,
          phase: 'REPLACEMENT' as const,
        }))
      : []),
  ]
}
