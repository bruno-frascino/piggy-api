import { prisma } from './prisma.js'
import {
  parseManualTradeVoidInput,
  manualTradeVoidHash,
} from './manual-trade-void.js'
import { lockOwnedTradingAccount, lockOwnedPosition } from './account-lock.js'
import {
  quantityTolerance,
  recomputePositionFromTransactions,
} from './position-service.js'
import {
  continuedSourceFingerprint,
  parseExecutionAudit,
  parseSaleCorrection,
  parseAcquisitionCorrection,
  executionCorrectionHash,
  type ExecutionAudit,
  type ExecutionSnapshot,
} from './execution-correction.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  AccountingDecimal,
  isAccountingAmount,
  isAccountingCurrency,
  isAccountingDate,
} from './accounting-values.js'
import { readAccountOpeningPreview } from './accounting-preview-service.js'
import {
  parseOpeningPreviewInput,
  sydneyCalendarDate,
} from './accounting-preview.js'
import {
  prepareCashCommand,
  replayCashLedger,
  requireFundedCashLedger,
  resolveCashCommandRetry,
  type CashCommand,
} from './cash-ledger.js'
import {
  accountTradePayloadHash,
  parseAccountTradeInput,
} from './account-trade-command.js'
import {
  prepareCapitalCashRevision,
  prepareImportedCashRevision,
  prepareCashRevision,
  prepareRevisionLegs,
  prepareDraftTradeRevision,
} from './cash-revisions.js'
import {
  correctImportedExecutionSnapshots,
  importedExecutionCorrectionHash,
  parseImportedExecutionCorrectionInput,
  type ImportedExecutionTradeSnapshot,
} from './import-execution-correction.js'
import {
  prepareDraftTradeRequest,
  prepareDraftTradeCash,
  replayDraftTradeParcels,
  requireSameDraftTradeIdentity,
  type ProposedParcelTrade,
  type DraftTradeRequest,
  type DraftOpeningParcel,
} from './draft-trade-command.js'
import {
  compareDraftCashEvidence,
  prepareDraftCashEvidence,
  prepareDraftCashFlow,
} from './draft-cash-evidence.js'

function conflict(message: string, status = 409): never {
  throw Object.assign(new Error(message), {
    status,
    name: status === 404 ? 'Not Found' : 'Accounting Conflict',
  })
}

function requireNewOperationSlot(
  rows: { effectiveDate: Date; sequence: bigint }[],
  effectiveDate: string,
  sequence: number
): void {
  if (
    rows.some(
      (row) =>
        row.effectiveDate.toISOString().slice(0, 10) === effectiveDate &&
        row.sequence === BigInt(sequence)
    )
  )
    conflict(
      'Original operation date/sequence slots remain reserved, including after correction or reversal'
    )
}

type DraftDb = Pick<
  typeof prisma,
  'accountOpeningStatement' | 'transaction' | 'importedEvent'
>
type HistoryDb = Pick<
  typeof prisma,
  | 'draftCashOperation'
  | 'draftOperationTradeLink'
  | 'draftCashPosting'
  | 'draftCashRevision'
  | 'draftCashRevisionPosting'
  | 'draftCashEvidence'
  | 'transaction'
  | 'importedEvent'
>
type DraftCashTransaction = Pick<
  typeof prisma,
  | '$queryRaw'
  | 'tradingAccount'
  | 'position'
  | 'importBatch'
  | 'transaction'
  | 'importedEvent'
  | 'accountOpeningStatement'
  | 'accountCashLedger'
  | 'accountCashOperation'
  | 'draftCashOperation'
  | 'draftOperationTradeLink'
  | 'draftCashPosting'
  | 'draftCashRevision'
  | 'draftCashRevisionPosting'
  | 'draftCashEvidence'
>

type ImportedCashEvent = {
  id: string
  userId: string
  source: string
  externalId: string
  kind: string
  status: string
  occurredAt: Date
  quoteCurrency: string | null
  grossValue: { toFixed(): string } | null
  fee: { toFixed(): string }
  feeCurrency: string | null
  appliedPositionIds: string[]
  batch: { accountId: string; userId: string }
}

type ImportedCashTransaction = {
  id: string
  positionId: string
  brokerRef: string | null
  type: string
  date: Date
  quantity: number
  price: { toFixed(): string }
  totalValue: { toFixed(): string }
  fees: { toFixed(): string }
  position: {
    origin: string
    positionType: string
    asset: { exchange: { currency: string } }
  }
}

function validateImportedExecution(
  userId: string,
  accountId: string,
  command: CashCommand,
  event: ImportedCashEvent | null,
  transactions: readonly ImportedCashTransaction[],
  allowAuditedCorrection = false
): void {
  if (
    (command.kind !== 'BUY' && command.kind !== 'SELL') ||
    command.source.origin !== 'IMPORT' ||
    !event ||
    event.userId !== userId ||
    event.batch.userId !== userId ||
    event.batch.accountId !== accountId ||
    event.source !== 'KRAKEN' ||
    event.status !== 'APPLIED' ||
    event.externalId !== command.source.reference ||
    command.idempotencyKey !== `import-event:${event.id}` ||
    event.kind !== command.kind ||
    sydneyCalendarDate(event.occurredAt) !== command.effectiveDate ||
    !event.quoteCurrency ||
    !isAccountingCurrency(event.quoteCurrency) ||
    !event.grossValue ||
    !isAccountingAmount(event.fee.toFixed()) ||
    (new AccountingDecimal(event.fee.toFixed()).gt(0) &&
      (!event.feeCurrency || !isAccountingCurrency(event.feeCurrency))) ||
    !new AccountingDecimal(event.grossValue.toFixed()).gt(0)
  )
    conflict(
      'Imported cash must exactly match an applied Kraken execution in this account'
    )

  const linked = transactions
    .filter((transaction) => transaction.brokerRef === event.externalId)
    .sort((left, right) => left.id.localeCompare(right.id))
  const commandIds = [...command.transactionIds].sort()
  const linkedIds = linked.map((transaction) => transaction.id)
  const linkedPositionIds = [
    ...new Set(linked.map((row) => row.positionId)),
  ].sort()
  const appliedPositionIds = [...new Set(event.appliedPositionIds)].sort()
  if (
    linked.length !== commandIds.length ||
    JSON.stringify(linkedIds) !== JSON.stringify(commandIds) ||
    JSON.stringify(linkedPositionIds) !== JSON.stringify(appliedPositionIds) ||
    linked.some(
      (transaction) =>
        transaction.type !== command.kind ||
        transaction.position.positionType !== 'LONG' ||
        (command.kind === 'BUY' &&
          transaction.position.origin !== 'IMPORT_TRADE') ||
        !Number.isFinite(transaction.quantity) ||
        transaction.quantity <= 0 ||
        (!allowAuditedCorrection &&
          sydneyCalendarDate(transaction.date) !== command.effectiveDate)
    )
  )
    conflict(
      'Imported execution transaction links are missing, changed or outside this account'
    )

  const gross = event.grossValue.toFixed()
  const fee = event.fee.toFixed()
  if (
    command.consideration.currency !== event.quoteCurrency ||
    !new AccountingDecimal(command.consideration.amount).eq(gross) ||
    (new AccountingDecimal(fee).gt(0)
      ? command.fees.length !== 1 ||
        command.fees[0].currency !== event.feeCurrency ||
        !new AccountingDecimal(command.fees[0].amount).eq(fee)
      : command.fees.length !== 0)
  )
    conflict(
      'Imported execution consideration or fees do not match the persisted Kraken event'
    )

  if (
    command.kind === 'BUY' &&
    (linked.length !== 1 ||
      linked[0].position.asset.exchange.currency !== event.quoteCurrency)
  )
    conflict('Imported BUY does not match its acquired parcel currency')
}

async function validateImportedHistory(
  db: HistoryDb,
  userId: string,
  accountId: string,
  commands: readonly CashCommand[]
): Promise<void> {
  const imported = commands.filter(
    (command) => command.source.origin === 'IMPORT'
  )
  if (imported.length === 0) return
  if (
    imported.length > 50000 ||
    imported.some(
      (command) => command.kind !== 'BUY' && command.kind !== 'SELL'
    )
  )
    conflict('Stored imported cash history contains unsupported commands')
  const references = [
    ...new Set(imported.map((command) => command.source.reference)),
  ]
  const events = await db.importedEvent.findMany({
    where: {
      userId,
      source: 'KRAKEN',
      externalId: { in: references },
      batch: { userId, accountId },
    },
    select: {
      id: true,
      userId: true,
      source: true,
      externalId: true,
      kind: true,
      status: true,
      occurredAt: true,
      quoteCurrency: true,
      grossValue: true,
      fee: true,
      feeCurrency: true,
      appliedPositionIds: true,
      batch: { select: { accountId: true, userId: true } },
    },
  })
  const transactions = await db.transaction.findMany({
    where: {
      brokerRef: { in: references },
      position: { accountId, userId },
    },
    select: {
      id: true,
      positionId: true,
      brokerRef: true,
      type: true,
      date: true,
      quantity: true,
      price: true,
      totalValue: true,
      fees: true,
      position: {
        select: {
          origin: true,
          positionType: true,
          asset: { select: { exchange: { select: { currency: true } } } },
        },
      },
    },
  })
  const eventByReference = new Map(
    events.map((event) => [event.externalId, event])
  )
  const transactionsByReference = new Map<string, ImportedCashTransaction[]>()
  for (const transaction of transactions) {
    if (!transaction.brokerRef) continue
    const linked = transactionsByReference.get(transaction.brokerRef) ?? []
    linked.push(transaction)
    transactionsByReference.set(transaction.brokerRef, linked)
  }
  for (const command of imported) {
    validateImportedExecution(
      userId,
      accountId,
      command,
      eventByReference.get(command.source.reference) ?? null,
      transactionsByReference.get(command.source.reference) ?? []
    )
  }
}

async function readCashHistory(
  db: HistoryDb,
  userId: string,
  statementId: string,
  accountId: string,
  openingDate: string,
  now: Date,
  openingParcels: readonly DraftOpeningParcel[],
  sourceFingerprint: string
) {
  const linkCount = await db.draftOperationTradeLink.count({
    where: { statementId },
  })
  const postingCount = await db.draftCashPosting.count({
    where: { operation: { statementId } },
  })
  const revisionCount = await db.draftCashRevision.count({
    where: { statementId },
  })
  const revisionPostingCount = await db.draftCashRevisionPosting.count({
    where: { revision: { statementId } },
  })
  if (
    linkCount > 50000 ||
    postingCount + revisionPostingCount > 100000 ||
    revisionCount > 50000
  )
    conflict(
      'Draft cash history exceeds the supported audit replay limits',
      422
    )
  const rows = await db.draftCashOperation.findMany({
    where: { statementId },
    orderBy: [{ effectiveDate: 'asc' }, { sequence: 'asc' }],
    take: 50001,
    include: {
      postings: { orderBy: { legIndex: 'asc' } },
      tradeLinks: { orderBy: { transactionId: 'asc' } },
      revisions: {
        orderBy: { revisionNumber: 'asc' },
        include: { postings: { orderBy: { legIndex: 'asc' } } },
      },
      proposedTrade: true,
    },
  })
  if (rows.length + revisionCount > 50000)
    conflict('Draft cash history exceeds the supported replay limit', 422)
  const keys = new Set<string>()
  const sources = new Set<string>()
  const transactions = new Set<string>()
  const effective = new Map<string, CashCommand | null>()
  const proposedTrades: ProposedParcelTrade[] = []
  const executionAudits: ExecutionAudit[] = []
  for (const row of rows) {
    const existing = prepareCashCommand(row.command, now)
    const command = existing.command
    const links =
      command.kind === 'BUY' || command.kind === 'SELL'
        ? command.transactionIds
        : []
    if (
      row.statementId !== statementId ||
      command.effectiveDate <= openingDate ||
      row.state !== 'DRAFT' ||
      row.methodology !== existing.methodology ||
      row.payloadHash !== existing.payloadHash ||
      row.idempotencyKey !== command.idempotencyKey ||
      row.kind !== command.kind ||
      row.sourceOrigin !== command.source.origin ||
      row.sourceReference !== command.source.reference ||
      row.effectiveDate.toISOString().slice(0, 10) !== command.effectiveDate ||
      row.sequence !== BigInt(command.sequence) ||
      command.accountId !== accountId ||
      (command.source.origin !== 'MANUAL' &&
        command.source.origin !== 'IMPORT') ||
      JSON.stringify(row.tradeLinks.map((link) => link.transactionId)) !==
        JSON.stringify(links) ||
      row.postings.length !== existing.legs.length ||
      row.postings.some(
        (posting, index) =>
          posting.legIndex !== index ||
          posting.currency !== existing.legs[index].currency ||
          posting.role !== existing.legs[index].role ||
          posting.amount.toFixed() !== existing.legs[index].amount
      )
    )
      conflict(
        'Stored draft cash command, source links or postings are inconsistent; reconciliation is required'
      )
    if (keys.has(row.idempotencyKey))
      conflict('Duplicate accounting idempotency key')
    keys.add(row.idempotencyKey)
    const source = JSON.stringify(command.source)
    if (sources.has(source) || links.some((id) => transactions.has(id)))
      conflict(
        'Duplicate durable execution source or parcel transaction identity'
      )
    sources.add(source)
    for (const id of links) transactions.add(id)
    let proposedRequest: DraftTradeRequest | null = null
    if (row.proposedTrade) {
      const trade = row.proposedTrade
      const parsed = prepareDraftTradeRequest(trade.request, now)
      const cash = prepareDraftTradeCash(parsed.request, trade.id, now)
      if (
        trade.requestHash !== parsed.requestHash ||
        cash.payloadHash !== existing.payloadHash ||
        trade.operationId !== row.id ||
        trade.currency !== parsed.request.currency ||
        trade.quantity.toFixed() !== parsed.request.quantity ||
        trade.price.toFixed() !== parsed.request.price ||
        trade.fees.toFixed() !== parsed.request.fees ||
        (parsed.request.kind === 'BUY' &&
          trade.assetId !== parsed.request.assetId)
      )
        conflict(
          'Stored proposed trade and cash operation are inconsistent; reconciliation is required'
        )
      proposedRequest = parsed.request
    } else if (command.source.reference.startsWith('draft-trade:'))
      conflict('Proposed trade cash must have its atomic trade snapshot')
    let current: CashCommand | null = command
    let previousId = row.id
    for (const [index, revision] of row.revisions.entries()) {
      if (!current)
        conflict('A reversed operation cannot have further corrections')
      const prepared = prepareCashRevision(revision.request, now)
      if (prepared.request.voidAudit)
        conflict(
          'Manual trade void audits are supported only by live operation revisions'
        )
      const audit = prepared.request.executionAudit
      if (audit) {
        if (
          row.proposedTrade ||
          current.kind !== (audit.kind ?? 'SELL') ||
          current.source.origin !== 'MANUAL' ||
          current.transactionIds.length !== 1 ||
          current.transactionIds[0] !== audit.before.transactionId ||
          current.consideration.currency !== audit.before.currency ||
          current.consideration.amount !== audit.before.totalValue ||
          (current.fees[0]?.amount ?? '0') !== audit.before.fees ||
          current.effectiveDate !==
            sydneyCalendarDate(new Date(audit.before.date)) ||
          prepared.request.replacement?.source.reference !==
            command.source.reference
        )
          conflict(
            'Manual execution correction does not match its previous source and cash'
          )
        executionAudits.push(audit)
      }
      if (command.source.origin === 'IMPORT') {
        const replacement = prepared.request.replacement
        if (
          !replacement ||
          prepareImportedCashRevision(
            {
              idempotencyKey: prepared.request.idempotencyKey,
              expectedRevisionId: prepared.request.expectedRevisionId,
              reason: prepared.request.reason,
              sequence: replacement.sequence,
            },
            command,
            now
          ).payloadHash !== prepared.payloadHash
        )
          conflict(
            'Stored imported correction must retain execution values, date and transaction links'
          )
      }
      if (row.proposedTrade) {
        if (!('proposedTrade' in prepared.request) || !proposedRequest)
          conflict(
            'Proposed trade corrections must retain their atomic trade request'
          )
        const next = prepared.request.proposedTrade ?? null
        if (next) requireSameDraftTradeIdentity(proposedRequest, next)
        proposedRequest = next
      } else if ('proposedTrade' in prepared.request)
        conflict(
          'Cash-only operations cannot acquire a proposed trade through correction'
        )
      const legs = prepareRevisionLegs(
        current,
        prepared.request.replacement,
        now
      )
      if (
        revision.revisionNumber !== index + 1 ||
        revision.previousRevisionId !== (index ? previousId : null) ||
        prepared.request.expectedRevisionId !== previousId ||
        revision.payloadHash !== prepared.payloadHash ||
        revision.reason !== prepared.request.reason ||
        revision.idempotencyKey !== prepared.request.idempotencyKey ||
        revision.statementId !== statementId ||
        revision.operationId !== row.id ||
        (prepared.request.replacement &&
          prepared.request.replacement.effectiveDate <= openingDate) ||
        keys.has(revision.idempotencyKey) ||
        revision.postings.length !== legs.length ||
        revision.postings.some(
          (posting, legIndex) =>
            posting.legIndex !== legIndex ||
            posting.phase !== legs[legIndex].phase ||
            posting.currency !== legs[legIndex].currency ||
            posting.role !== legs[legIndex].role ||
            posting.amount.toFixed() !== legs[legIndex].amount
        )
      )
        conflict(
          'Stored correction chain or reversal/replacement postings are inconsistent; reconciliation is required'
        )
      keys.add(revision.idempotencyKey)
      current = prepared.request.replacement
      previousId = revision.id
    }
    if (row.proposedTrade && proposedRequest)
      proposedTrades.push({
        id: row.proposedTrade.id,
        parcelKey: row.proposedTrade.parcelKey,
        request: proposedRequest,
      })
    effective.set(row.id, current)
  }
  await validateImportedHistory(
    db,
    userId,
    accountId,
    rows.map((row) => prepareCashCommand(row.command, now).command)
  )
  continuedSourceFingerprint(sourceFingerprint, executionAudits)
  if (executionAudits.length) {
    const latest = new Map<string, ExecutionAudit>()
    for (const audit of [...executionAudits].sort(
      (a, b) => a.number - b.number
    ))
      latest.set(audit.after.transactionId, audit)
    const sources = await db.transaction.findMany({
      where: {
        id: { in: [...latest.keys()] },
        position: { userId, accountId },
      },
      include: {
        position: { include: { asset: { include: { exchange: true } } } },
      },
    })
    if (
      sources.length !== latest.size ||
      sources.some(
        (source) =>
          source.type !== (latest.get(source.id)?.kind ?? 'SELL') ||
          source.brokerRef !== null ||
          source.position.origin !== 'MANUAL' ||
          source.position.positionType !== 'LONG' ||
          JSON.stringify(executionSnapshot(source)) !==
            JSON.stringify(latest.get(source.id)?.after)
      )
    )
      conflict(
        'Corrected manual execution has changed outside its audited source revision'
      )
  }
  const parcels = replayDraftTradeParcels(proposedTrades, openingParcels)
  const openingByKey = new Map(
    openingParcels.map((parcel) => [parcel.parcelKey, parcel])
  )
  const openingAssets = new Map<string, string>()
  const parcelByKey = new Map(
    parcels.map((parcel) => [parcel.parcelKey, parcel])
  )
  for (const row of rows) {
    if (row.proposedTrade) {
      const openingParcel = openingByKey.get(row.proposedTrade.parcelKey)
      if (row.proposedTrade.parcelKey.startsWith('opening:') && !openingParcel)
        conflict('Proposed opening sale has lost its confirmed opening parcel')
      if (openingParcel) {
        const trade = row.proposedTrade
        const asset = openingAssets.get(trade.parcelKey)
        if (
          row.kind !== 'SELL' ||
          trade.symbol !== openingParcel.symbol ||
          trade.currency !== openingParcel.currency ||
          (asset !== undefined && asset !== trade.assetId)
        )
          conflict('Proposed opening sale snapshot identity is inconsistent')
        openingAssets.set(trade.parcelKey, trade.assetId)
        continue
      }
      if (!effective.get(row.id)) continue
      const parcel = parcelByKey.get(row.proposedTrade.parcelKey)
      if (
        !parcel ||
        parcel.assetId !== row.proposedTrade.assetId ||
        parcel.currency !== row.proposedTrade.currency
      )
        conflict('Proposed trade parcel identity is inconsistent')
    }
  }
  if (
    openingAssets.size &&
    rows.some(
      (row) => !row.proposedTrade && (row.kind === 'BUY' || row.kind === 'SELL')
    )
  )
    conflict('Recorded live trade cash cannot mix with opening sale proposals')
  return {
    rows,
    effective,
    keys,
    postingCount: postingCount + revisionPostingCount,
    revisionCount,
    proposedTrades,
    parcels,
    executionAudits,
  }
}

async function readStatement(
  db: DraftDb,
  userId: string,
  statementId: string,
  expectedState: 'DRAFT' | 'CONFIRMED' = 'DRAFT'
) {
  const statement = await db.accountOpeningStatement.findFirst({
    where: { id: statementId, account: { userId, user: { deletedAt: null } } },
    include: {
      cashBalances: { orderBy: { currency: 'asc' } },
      parcels: { orderBy: { positionId: 'asc' }, take: 5001 },
      account: { select: { id: true, status: true, isDemo: true } },
    },
  })
  if (!statement) conflict('Opening statement not found', 404)
  if (
    statement.state !== expectedState ||
    statement.timezone !== 'Australia/Sydney'
  )
    conflict(
      expectedState === 'DRAFT'
        ? 'Only inactive Sydney opening drafts can hold staged cash operations'
        : 'Live trade posting requires the account confirmed opening statement'
    )
  const opening = parseOpeningPreviewInput({
    openingDate: statement.openingDate.toISOString().slice(0, 10),
    cashBalances: statement.cashBalances.map((row) => ({
      currency: row.currency,
      amount: row.amount.toFixed(),
    })),
  })
  if (
    createHash('sha256').update(JSON.stringify(opening)).digest('hex') !==
    statement.inputHash
  )
    conflict(
      'Stored opening cash does not match its reviewed input identity; reconciliation is required'
    )
  const snapshot = statement.previewSnapshot
  if (
    statement.parcels.length > 5000 ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    !('parcels' in snapshot) ||
    !Array.isArray(snapshot.parcels) ||
    snapshot.parcels.length !== statement.parcels.length
  )
    conflict(
      'Opening parcel snapshot is inconsistent; reconciliation is required'
    )
  const snapshots = new Map<string, Record<string, unknown>>()
  for (const raw of snapshot.parcels) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !('positionId' in raw) ||
      typeof raw.positionId !== 'string' ||
      snapshots.has(raw.positionId)
    )
      conflict('Opening parcel snapshot identities are inconsistent')
    snapshots.set(raw.positionId, raw)
  }
  const openingParcels: DraftOpeningParcel[] = statement.parcels.map((row) => {
    const saved = snapshots.get(row.positionId)
    if (
      row.statementId !== statement.id ||
      !saved ||
      saved.symbol !== row.symbol ||
      saved.currency !== row.currency ||
      !isAccountingCurrency(row.currency) ||
      !isAccountingAmount(saved.openingQuantity) ||
      new AccountingDecimal(saved.openingQuantity).toFixed() !==
        row.quantity.toFixed()
    )
      conflict('Opening parcel balances do not match their reviewed snapshot')
    return {
      parcelKey: `opening:${row.id}`,
      positionId: row.positionId,
      symbol: row.symbol,
      currency: row.currency,
      quantity: row.quantity.toFixed(),
    }
  })
  return { ...statement, openingParcels }
}

async function validateTrade(
  db: DraftDb,
  userId: string,
  command: CashCommand
) {
  if (command.kind !== 'BUY' && command.kind !== 'SELL') return
  if (command.source.origin === 'IMPORT') {
    const event = await db.importedEvent.findFirst({
      where: {
        userId,
        source: 'KRAKEN',
        externalId: command.source.reference,
        status: 'APPLIED',
        batch: { userId, accountId: command.accountId },
      },
      select: {
        id: true,
        userId: true,
        source: true,
        externalId: true,
        kind: true,
        status: true,
        occurredAt: true,
        quoteCurrency: true,
        grossValue: true,
        fee: true,
        feeCurrency: true,
        appliedPositionIds: true,
        batch: { select: { accountId: true, userId: true } },
      },
    })
    const transactions = await db.transaction.findMany({
      where: {
        brokerRef: command.source.reference,
        position: { accountId: command.accountId, userId },
      },
      select: {
        id: true,
        positionId: true,
        brokerRef: true,
        type: true,
        date: true,
        quantity: true,
        price: true,
        totalValue: true,
        fees: true,
        position: {
          select: {
            origin: true,
            positionType: true,
            asset: { select: { exchange: { select: { currency: true } } } },
          },
        },
      },
    })
    validateImportedExecution(
      userId,
      command.accountId,
      command,
      event,
      transactions
    )
    return
  }
  const transactions = await db.transaction.findMany({
    where: {
      id: { in: command.transactionIds },
      position: { accountId: command.accountId, userId },
    },
    include: {
      position: { include: { asset: { include: { exchange: true } } } },
    },
  })
  if (transactions.length !== command.transactionIds.length)
    conflict(
      'Every cash trade link must belong to this user and trading account'
    )
  const transaction = transactions[0]
  if (
    !transaction ||
    transaction.type !== command.kind ||
    (command.source.reference.startsWith('manual-transaction:') &&
      transaction.brokerRef !== null) ||
    transaction.position.origin !== 'MANUAL' ||
    transaction.position.positionType !== 'LONG' ||
    !Number.isFinite(transaction.quantity) ||
    transaction.quantity <= 0 ||
    sydneyCalendarDate(transaction.date) !== command.effectiveDate ||
    transaction.position.asset.exchange.currency !==
      command.consideration.currency ||
    !new AccountingDecimal(transaction.totalValue.toFixed()).eq(
      command.consideration.amount
    )
  )
    conflict(
      'Draft cash trade must exactly match a supported manual parcel transaction, date, currency and gross amount'
    )
  if (
    command.fees.some((fee) => fee.currency !== command.consideration.currency)
  )
    conflict(
      'Legacy manual trades do not record foreign fee currencies; a verified execution adapter is required'
    )
  const fee = command.fees[0]?.amount ?? '0'
  if (!new AccountingDecimal(transaction.fees.toFixed()).eq(fee))
    conflict(
      'Draft cash fees must exactly match the recorded manual trade fees'
    )
}

async function verifyStatementSource(
  db: Parameters<typeof readAccountOpeningPreview>[0],
  userId: string,
  statement: Awaited<ReturnType<typeof readStatement>>,
  history: Pick<Awaited<ReturnType<typeof readCashHistory>>, 'executionAudits'>
) {
  const snapshot = statement.previewSnapshot
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    !('asOfDate' in snapshot) ||
    !isAccountingDate(snapshot.asOfDate)
  )
    conflict('Opening draft has no valid source snapshot date')
  const sourcePreview = await readAccountOpeningPreview(
    db,
    userId,
    statement.accountId,
    {
      openingDate: statement.openingDate.toISOString().slice(0, 10),
      cashBalances: statement.cashBalances.map((row) => ({
        currency: row.currency,
        amount: row.amount.toFixed(),
      })),
    },
    new Date(`${snapshot.asOfDate}T01:00:00Z`)
  )
  if (
    sourcePreview.sourceFingerprint !==
    continuedSourceFingerprint(
      statement.sourceFingerprint,
      history.executionAudits
    )
  )
    conflict(
      'Opening draft source records have changed. Review and save a fresh opening revision before staging more cash.'
    )
  const sourceParcels = new Map(
    sourcePreview.parcels.map((parcel) => [parcel.positionId, parcel])
  )
  if (
    sourceParcels.size !== statement.parcels.length ||
    statement.parcels.some((row) => {
      const source = sourceParcels.get(row.positionId)
      return (
        !source ||
        source.symbol !== row.symbol ||
        source.currency !== row.currency ||
        source.openingQuantity !== row.quantity.toFixed()
      )
    })
  )
    conflict(
      'Opening parcel balances do not match their verified source inventory'
    )
}

/** Internal staging only: never posts spendable cash or mutates a live trade. */
export function saveDraftCashOperation(
  userId: string,
  statementId: string,
  raw: unknown
) {
  return persistDraftCashOperation(userId, statementId, raw, false)
}

export async function saveDraftManualExecutionCash(
  userId: string,
  accountId: string,
  statementId: string,
  transactionId: string,
  sequence: number
) {
  const [transaction] = await prisma.transaction.findMany({
    where: {
      id: transactionId,
      brokerRef: null,
      position: { accountId, userId, origin: 'MANUAL', positionType: 'LONG' },
    },
    include: {
      position: { include: { asset: { include: { exchange: true } } } },
    },
    take: 1,
  })
  if (!transaction)
    conflict('Supported manual execution not found for this account', 404)
  const currency = transaction.position.asset.exchange.currency
  const fee = transaction.fees.toFixed()
  return saveDraftCashOperation(userId, statementId, {
    accountId,
    kind: transaction.type,
    idempotencyKey: `manual-transaction:${transaction.id}`,
    source: {
      origin: 'MANUAL',
      reference: `manual-transaction:${transaction.id}`,
    },
    effectiveDate: sydneyCalendarDate(transaction.date),
    sequence,
    consideration: { currency, amount: transaction.totalValue.toFixed() },
    fees: new AccountingDecimal(fee).gt(0) ? [{ currency, amount: fee }] : [],
    transactionIds: [transaction.id],
  })
}

export async function saveDraftImportedExecutionCash(
  userId: string,
  accountId: string,
  statementId: string,
  eventId: string,
  sequence: number
) {
  const event = await prisma.importedEvent.findFirst({
    where: {
      id: eventId,
      userId,
      source: 'KRAKEN',
      status: 'APPLIED',
      kind: { in: ['BUY', 'SELL'] },
      batch: { userId, accountId },
    },
    select: {
      id: true,
      externalId: true,
      kind: true,
      occurredAt: true,
      quoteCurrency: true,
      grossValue: true,
      fee: true,
      feeCurrency: true,
    },
  })
  if (!event)
    conflict('Applied Kraken execution not found for this account', 404)
  if (event.kind !== 'BUY' && event.kind !== 'SELL')
    conflict('Only applied Kraken BUY/SELL executions can stage cash')
  const transactions = await prisma.transaction.findMany({
    where: {
      brokerRef: event.externalId,
      type: event.kind,
      position: { accountId, userId },
    },
    select: { id: true },
  })
  if (transactions.length === 0)
    conflict('Applied execution has no persisted transaction links')
  const fee = event.fee.toFixed()
  return persistDraftCashOperation(
    userId,
    statementId,
    {
      accountId,
      kind: event.kind,
      idempotencyKey: `import-event:${event.id}`,
      source: { origin: 'IMPORT', reference: event.externalId },
      effectiveDate: sydneyCalendarDate(event.occurredAt),
      sequence,
      consideration: {
        currency: event.quoteCurrency,
        amount: event.grossValue?.toFixed(),
      },
      fees:
        new AccountingDecimal(fee).gt(0) && event.feeCurrency
          ? [{ currency: event.feeCurrency, amount: fee }]
          : [],
      transactionIds: transactions.map((transaction) => transaction.id),
    },
    true
  )
}

function importedExecutionCashCommand(
  accountId: string,
  event: {
    id: string
    externalId: string
    kind: string
    occurredAt: Date
    quoteCurrency: string | null
    grossValue: { toFixed(): string } | null
    fee: { toFixed(): string }
    feeCurrency: string | null
  },
  transactionIds: string[],
  sequence: number
) {
  if (
    (event.kind !== 'BUY' && event.kind !== 'SELL') ||
    !event.quoteCurrency ||
    !event.grossValue
  )
    conflict('Applied Kraken execution does not contain supported cash values')
  const fee = event.fee.toFixed()
  return {
    accountId,
    kind: event.kind,
    idempotencyKey: `import-event:${event.id}`,
    source: { origin: 'IMPORT' as const, reference: event.externalId },
    effectiveDate: sydneyCalendarDate(event.occurredAt),
    sequence,
    consideration: {
      currency: event.quoteCurrency,
      amount: event.grossValue.toFixed(),
    },
    fees:
      new AccountingDecimal(fee).gt(0) && event.feeCurrency
        ? [{ currency: event.feeCurrency, amount: fee }]
        : [],
    transactionIds,
  }
}

async function persistDraftCashOperation(
  userId: string,
  statementId: string,
  raw: unknown,
  allowImported: boolean
) {
  const now = new Date()
  const prepared = prepareCashCommand(raw, now)
  if (prepared.command.source.reference.startsWith('draft-trade:'))
    conflict('Proposed trades require the atomic draft trade writer')
  if (
    prepared.command.source.origin !== 'MANUAL' &&
    !(allowImported && prepared.command.source.origin === 'IMPORT')
  )
    conflict(
      'Imported cash staging requires a verified execution-currency adapter and is not enabled'
    )
  return prisma.$transaction(
    async (db) => {
      let statement = await readStatement(db, userId, statementId)
      await lockOwnedTradingAccount(db, userId, statement.accountId)
      statement = await readStatement(db, userId, statementId)
      if (statement.account.status !== 'ACTIVE' || statement.account.isDemo)
        conflict('Draft cash operations require an active real trading account')
      if (prepared.command.accountId !== statement.accountId)
        conflict('Cash command account does not match its opening draft')
      const opening = {
        openingDate: statement.openingDate.toISOString().slice(0, 10),
        cashBalances: statement.cashBalances.map((row) => ({
          currency: row.currency,
          amount: row.amount.toFixed(),
        })),
      }
      if (prepared.command.effectiveDate <= opening.openingDate)
        conflict('Cash operations must be after the opening statement boundary')
      const history = await readCashHistory(
        db,
        userId,
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels,
        statement.sourceFingerprint
      )
      const { rows } = history
      const prior = rows.find(
        (row) => row.idempotencyKey === prepared.command.idempotencyKey
      )
      let retryPrepared = prepared
      const currentPrior = prior ? history.effective.get(prior.id) : null
      if (
        prior &&
        (currentPrior?.kind === 'SELL' || currentPrior?.kind === 'BUY') &&
        currentPrior.source.origin === 'MANUAL' &&
        currentPrior.source.reference.startsWith('manual-transaction:') &&
        prior.revisions.some(
          (revision) =>
            prepareCashRevision(revision.request, now).request.executionAudit
        )
      ) {
        const original = prepareCashCommand(prior.command, now)
        const currentRetry = prepareCashCommand(
          {
            ...currentPrior,
            idempotencyKey: prepared.command.idempotencyKey,
            sequence: original.command.sequence,
          },
          now
        )
        if (currentRetry.payloadHash === prepared.payloadHash)
          retryPrepared = original
      }
      const retry = resolveCashCommandRetry(
        retryPrepared,
        prior
          ? {
              accountId: statement.accountId,
              idempotencyKey: prior.idempotencyKey,
              payloadHash: prior.payloadHash,
            }
          : null
      )
      if (retry === 'REUSE' && prior) {
        const replay = replayCashLedger(
          statement.accountId,
          opening,
          [...history.effective.values()].filter((command) => command !== null),
          now
        )
        requireFundedCashLedger(replay)
        return {
          operationId: prior.id,
          state: 'DRAFT' as const,
          created: false,
          replay,
        }
      }
      if (history.keys.has(prepared.command.idempotencyKey))
        conflict('Idempotency key is already associated with a cash correction')
      requireNewOperationSlot(
        rows,
        prepared.command.effectiveDate,
        prepared.command.sequence
      )
      if (
        rows.some(
          (row) =>
            row.sourceOrigin === prepared.command.source.origin &&
            row.sourceReference === prepared.command.source.reference
        )
      )
        conflict(
          'Execution source already has a durable operation identity, including reversed operations'
        )
      if (prepared.command.kind === 'BUY' || prepared.command.kind === 'SELL') {
        const transactionIds = new Set(prepared.command.transactionIds)
        if (
          rows.some((row) =>
            row.tradeLinks.some((link) =>
              transactionIds.has(link.transactionId)
            )
          )
        )
          conflict(
            'Parcel transaction is already linked to a draft cash operation'
          )
      }
      if (
        history.postingCount + prepared.legs.length > 100000 ||
        rows.length + history.revisionCount >= 50000
      )
        conflict(
          'Draft cash history exceeds the supported audit replay limits',
          422
        )
      await verifyStatementSource(db, userId, statement, history)
      if (
        (prepared.command.kind === 'BUY' || prepared.command.kind === 'SELL') &&
        rows.some((row) => row.proposedTrade?.parcelKey.startsWith('opening:'))
      )
        conflict(
          'Recorded live trade cash cannot mix with opening sale proposals'
        )
      await validateTrade(db, userId, prepared.command)
      const replay = replayCashLedger(
        statement.accountId,
        opening,
        [...history.effective.values()]
          .filter((command) => command !== null)
          .concat(prepared.command),
        now
      )
      requireFundedCashLedger(replay)
      const command = prepared.command
      const operation = await db.draftCashOperation.create({
        data: {
          statementId,
          state: 'DRAFT',
          methodology: prepared.methodology,
          idempotencyKey: command.idempotencyKey,
          payloadHash: prepared.payloadHash,
          kind: command.kind,
          effectiveDate: new Date(`${command.effectiveDate}T00:00:00Z`),
          sequence: BigInt(command.sequence),
          sourceOrigin: command.source.origin,
          sourceReference: command.source.reference,
          command: { ...command },
          postings: {
            create: prepared.legs.map((leg, legIndex) => ({
              ...leg,
              legIndex,
            })),
          },
          tradeLinks: {
            create:
              command.kind === 'BUY' || command.kind === 'SELL'
                ? command.transactionIds.map((transactionId) => ({
                    transactionId,
                  }))
                : [],
          },
        },
        select: { id: true },
      })
      return {
        operationId: operation.id,
        state: 'DRAFT' as const,
        created: true,
        replay,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}

/** Read-only reconciliation; a funded draft is not a confirmed live ledger. */
export async function reconcileDraftOpening(
  userId: string,
  statementId: string,
  accountId?: string
) {
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      let statement = await readStatement(db, userId, statementId)
      if (accountId && statement.accountId !== accountId)
        conflict('Opening statement not found for this account', 404)
      await lockOwnedTradingAccount(db, userId, statement.accountId)
      statement = await readStatement(db, userId, statementId)
      if (accountId && statement.accountId !== accountId)
        conflict('Opening statement not found for this account', 404)
      const opening = {
        openingDate: statement.openingDate.toISOString().slice(0, 10),
        cashBalances: statement.cashBalances.map((row) => ({
          currency: row.currency,
          amount: row.amount.toFixed(),
        })),
      }
      const history = await readCashHistory(
        db,
        userId,
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels,
        statement.sourceFingerprint
      )
      const replay = replayCashLedger(
        statement.accountId,
        opening,
        [...history.effective.values()].filter((command) => command !== null),
        now
      )
      const evidenceRows = await db.draftCashEvidence.findMany({
        where: { statementId },
        orderBy: [{ asOfDate: 'desc' }, { recordedAt: 'desc' }],
        take: 20,
        include: {
          balances: { orderBy: { currency: 'asc' } },
          decisions: { orderBy: { currency: 'asc' } },
        },
      })
      const evidenceHistory = evidenceRows.map((row) => {
        const prepared = prepareDraftCashEvidence(
          {
            idempotencyKey: row.idempotencyKey,
            asOfDate: row.asOfDate.toISOString().slice(0, 10),
            source: row.source,
            reference: row.reference,
            attested: row.attested,
            cashBalances: row.balances.map((balance) => ({
              currency: balance.currency,
              amount: balance.amount.toFixed(),
            })),
            decisions: row.decisions.map((decision) => ({
              currency: decision.currency,
              reason: decision.reason,
              note: decision.note,
            })),
          },
          opening.openingDate,
          now
        )
        if (
          row.payloadHash !== prepared.payloadHash ||
          row.statementId !== statementId
        )
          conflict(
            'Stored cash evidence is inconsistent; reconciliation is required'
          )
        const datedCommands = [...history.effective.values()].filter(
          (command): command is CashCommand =>
            command !== null &&
            command.effectiveDate <= prepared.request.asOfDate
        )
        const datedReplay = replayCashLedger(
          statement.accountId,
          opening,
          datedCommands,
          now
        )
        const comparison = compareDraftCashEvidence(
          prepared.request,
          datedReplay,
          false
        )
        return {
          id: row.id,
          asOfDate: prepared.request.asOfDate,
          source: row.source,
          reference: row.reference,
          attested: row.attested,
          recordedAt: row.recordedAt.toISOString(),
          statementBalances: prepared.request.cashBalances,
          decisions: prepared.request.decisions,
          currentComparison: comparison,
          fundedAtEvidenceDate: datedReplay.funded,
        }
      })
      const cashOperations = history.rows.map((row) => {
        const original = prepareCashCommand(row.command, now).command
        const current = history.effective.get(row.id)
        const displayed = current ?? original
        return {
          operationId: row.id,
          currentRevisionId: row.revisions.at(-1)?.id ?? row.id,
          idempotencyKey: current?.idempotencyKey ?? original.idempotencyKey,
          kind: displayed.kind,
          effectiveDate: displayed.effectiveDate,
          sequence: displayed.sequence,
          sourceOrigin: original.source.origin,
          sourceReference: original.source.reference,
          cash:
            displayed.kind === 'DEPOSIT' || displayed.kind === 'WITHDRAWAL'
              ? displayed.cash
              : null,
          revisions: row.revisions.map((revision) => ({
            revisionId: revision.id,
            reason: revision.reason,
            replacement:
              prepareCashRevision(revision.request, now).request.replacement !==
              null,
            executionAudit:
              prepareCashRevision(revision.request, now).request
                .executionAudit ?? null,
          })),
          status:
            current === null
              ? ('REVERSED' as const)
              : row.revisions.length
                ? ('CORRECTED' as const)
                : ('EFFECTIVE' as const),
        }
      })
      const live = await readAccountOpeningPreview(
        db,
        userId,
        statement.accountId,
        opening,
        now
      )
      const snapshot = statement.previewSnapshot
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        Array.isArray(snapshot) ||
        !('asOfDate' in snapshot) ||
        !isAccountingDate(snapshot.asOfDate)
      )
        conflict('Opening draft has no valid source snapshot date')
      // Compare at the saved observation date; merely advancing a day is not source drift.
      const originalDatePreview =
        live.asOfDate === snapshot.asOfDate
          ? live
          : await readAccountOpeningPreview(
              db,
              userId,
              statement.accountId,
              opening,
              new Date(`${snapshot.asOfDate}T01:00:00Z`)
            )
      const acceptedFingerprint = continuedSourceFingerprint(
        statement.sourceFingerprint,
        history.executionAudits
      )
      const sourceChanged =
        originalDatePreview.sourceFingerprint !== acceptedFingerprint
      const transactions = await db.transaction.findMany({
        where: { position: { accountId: statement.accountId, userId } },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        take: 50001,
        select: {
          id: true,
          positionId: true,
          brokerRef: true,
          type: true,
          date: true,
          quantity: true,
          price: true,
          totalValue: true,
          fees: true,
          position: {
            select: {
              origin: true,
              positionType: true,
              asset: { select: { exchange: { select: { currency: true } } } },
            },
          },
        },
      })
      if (transactions.length > 50000)
        conflict(
          'Reconciliation exceeds the supported transaction limit; no partial report was generated',
          422
        )
      const importedEvents = await db.importedEvent.findMany({
        where: {
          userId,
          source: 'KRAKEN',
          status: 'APPLIED',
          kind: { in: ['BUY', 'SELL'] },
          batch: { userId, accountId: statement.accountId },
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: 10001,
        select: {
          id: true,
          batchId: true,
          externalId: true,
          kind: true,
          occurredAt: true,
          quoteCurrency: true,
          grossValue: true,
          fee: true,
          feeCurrency: true,
          appliedPositionIds: true,
        },
      })
      if (importedEvents.length > 10000)
        conflict(
          'Reconciliation exceeds the supported 10,000 imported-execution limit; no partial report was generated',
          422
        )
      const linked = new Map<string, (typeof history.rows)[number]>()
      for (const row of history.rows) {
        if (!row.proposedTrade)
          for (const link of row.tradeLinks) linked.set(link.transactionId, row)
      }
      const importOperationByReference = new Map(
        cashOperations
          .filter((operation) => operation.sourceOrigin === 'IMPORT')
          .map((operation) => [operation.sourceReference, operation])
      )
      const transactionsByBrokerReference = new Map<
        string,
        typeof transactions
      >()
      for (const transaction of transactions) {
        if (!transaction.brokerRef) continue
        const linkedTransactions =
          transactionsByBrokerReference.get(transaction.brokerRef) ?? []
        linkedTransactions.push(transaction)
        transactionsByBrokerReference.set(
          transaction.brokerRef,
          linkedTransactions
        )
      }
      const hasOpeningSaleProposal = history.rows.some(
        (row) =>
          row.proposedTrade?.parcelKey.startsWith('opening:') &&
          row.kind === 'SELL'
      )
      const cashManualExecutions = transactions.flatMap((transaction) => {
        if (
          transaction.position?.origin !== 'MANUAL' ||
          transaction.brokerRef !== null
        )
          return []
        const effectiveDate = sydneyCalendarDate(transaction.date)
        const currency = transaction.position.asset.exchange.currency
        const grossValue = transaction.totalValue.toFixed()
        const fee = transaction.fees.toFixed()
        const operation = linked.get(transaction.id)
        const reason = operation
          ? 'ALREADY_LINKED'
          : effectiveDate <= opening.openingDate
            ? 'ON_OR_BEFORE_BOUNDARY'
            : effectiveDate > live.asOfDate
              ? 'AFTER_OBSERVATION_DATE'
              : sourceChanged
                ? 'STALE_OPENING_SOURCE'
                : statement.account.status !== 'ACTIVE' ||
                    statement.account.isDemo
                  ? 'ACCOUNT_NOT_ELIGIBLE'
                  : hasOpeningSaleProposal
                    ? 'INCOMPATIBLE_OPENING_SALE'
                    : transaction.position.positionType !== 'LONG' ||
                        !isAccountingCurrency(currency) ||
                        !isAccountingAmount(grossValue) ||
                        !new AccountingDecimal(grossValue).gt(0) ||
                        !isAccountingAmount(fee) ||
                        !Number.isFinite(transaction.quantity) ||
                        transaction.quantity <= 0
                      ? 'UNSUPPORTED_EXECUTION'
                      : null
        return [
          {
            transactionId: transaction.id,
            positionId: transaction.positionId,
            kind: transaction.type,
            effectiveDate,
            currency,
            grossValue,
            fee,
            price: transaction.price.toFixed(),
            quantity: new AccountingDecimal(
              String(transaction.quantity)
            ).toFixed(),
            occurredAt: transaction.date.toISOString(),
            stageable: reason === null,
            reason,
            operationId: operation?.id ?? null,
          },
        ]
      })
      const cashImportExecutions = importedEvents.map((event) => {
        const effectiveDate = sydneyCalendarDate(event.occurredAt)
        const transactionLinks =
          transactionsByBrokerReference.get(event.externalId) ?? []
        const linkedOperation = transactionLinks
          .map((transaction) => linked.get(transaction.id))
          .find((candidate) => candidate !== undefined)
        const importOperation = importOperationByReference.get(event.externalId)
        const operationId =
          importOperation?.operationId ?? linkedOperation?.id ?? null
        const linkedPositionIds = [
          ...new Set(
            transactionLinks.map((transaction) => transaction.positionId)
          ),
        ].sort()
        const appliedPositionIds = [...new Set(event.appliedPositionIds)].sort()
        const eventFee = new AccountingDecimal(event.fee.toFixed())
        let reason:
          | 'ALREADY_STAGED'
          | 'ON_OR_BEFORE_BOUNDARY'
          | 'AFTER_OBSERVATION_DATE'
          | 'TRANSACTION_ALREADY_LINKED'
          | 'UNSUPPORTED_EXECUTION'
          | 'MISSING_TRANSACTION_LINK'
          | 'INCOMPATIBLE_OPENING_SALE'
          | 'STALE_OPENING_SOURCE'
          | 'ACCOUNT_NOT_ELIGIBLE'
          | null = null
        if (importOperationByReference.has(event.externalId))
          reason = 'ALREADY_STAGED'
        else if (linkedOperation) reason = 'TRANSACTION_ALREADY_LINKED'
        else if (effectiveDate <= opening.openingDate)
          reason = 'ON_OR_BEFORE_BOUNDARY'
        else if (effectiveDate > live.asOfDate)
          reason = 'AFTER_OBSERVATION_DATE'
        else if (sourceChanged) reason = 'STALE_OPENING_SOURCE'
        else if (
          statement.account.status !== 'ACTIVE' ||
          statement.account.isDemo
        )
          reason = 'ACCOUNT_NOT_ELIGIBLE'
        else if (
          !event.quoteCurrency ||
          !isAccountingCurrency(event.quoteCurrency) ||
          !event.grossValue ||
          !new AccountingDecimal(event.grossValue.toFixed()).gt(0) ||
          !isAccountingAmount(event.fee.toFixed()) ||
          (eventFee.gt(0) &&
            (!event.feeCurrency || !isAccountingCurrency(event.feeCurrency)))
        )
          reason = 'UNSUPPORTED_EXECUTION'
        else if (
          transactionLinks.length === 0 ||
          transactionLinks.some(
            (transaction) =>
              transaction.type !== event.kind ||
              transaction.position.positionType !== 'LONG' ||
              (event.kind === 'BUY' &&
                transaction.position.origin !== 'IMPORT_TRADE') ||
              sydneyCalendarDate(transaction.date) !== effectiveDate ||
              !Number.isFinite(transaction.quantity) ||
              transaction.quantity <= 0 ||
              (event.kind === 'BUY' &&
                transaction.position.asset.exchange.currency !==
                  event.quoteCurrency)
          ) ||
          JSON.stringify(linkedPositionIds) !==
            JSON.stringify(appliedPositionIds)
        )
          reason = 'MISSING_TRANSACTION_LINK'
        else if (hasOpeningSaleProposal) reason = 'INCOMPATIBLE_OPENING_SALE'
        return {
          eventId: event.id,
          batchId: event.batchId,
          externalId: event.externalId,
          kind: event.kind,
          occurredAt: event.occurredAt.toISOString(),
          effectiveDate,
          quoteCurrency: event.quoteCurrency,
          grossValue: event.grossValue?.toFixed() ?? null,
          fee: event.fee.toFixed(),
          feeCurrency: event.feeCurrency,
          transactionIds: transactionLinks.map((transaction) => transaction.id),
          positionIds: linkedPositionIds,
          stageable: reason === null,
          reason,
          operationId,
        }
      })
      const openingByKey = new Map(
        statement.openingParcels.map((parcel) => [parcel.parcelKey, parcel])
      )
      const proposalsByPosition = new Map<string, string[]>()
      for (const row of history.rows) {
        if (!row.proposedTrade || !history.effective.get(row.id)) continue
        const parcel = openingByKey.get(row.proposedTrade.parcelKey)
        if (!parcel) continue
        const ids = proposalsByPosition.get(parcel.positionId) ?? []
        ids.push(row.id)
        proposalsByPosition.set(parcel.positionId, ids)
      }
      let overlapReferences = 0
      const tradeSources = transactions.flatMap((row) => {
        const date = sydneyCalendarDate(row.date)
        if (date <= opening.openingDate || date > live.asOfDate) return []
        const operation = linked.get(row.id)
        const potentialOverlapOperationIds =
          proposalsByPosition.get(row.positionId) ?? []
        overlapReferences += potentialOverlapOperationIds.length
        if (overlapReferences > 100000)
          conflict(
            'Reconciliation exceeds the supported overlap limit; no partial report was generated',
            422
          )
        return [
          {
            transactionId: row.id,
            positionId: row.positionId,
            kind: row.type,
            effectiveDate: date,
            quantity: String(row.quantity),
            operationId: operation?.id ?? null,
            linkage: operation
              ? history.effective.get(operation.id)
                ? ('LINKED' as const)
                : ('REVERSED' as const)
              : ('UNLINKED' as const),
            potentialOverlapOperationIds,
          },
        ]
      })
      const transactionById = new Map(transactions.map((row) => [row.id, row]))
      const excludedLinkedSources = [...linked].flatMap(
        ([transactionId, operation]) => {
          const transaction = transactionById.get(transactionId)
          const date = transaction ? sydneyCalendarDate(transaction.date) : null
          const reason = !date
            ? ('MISSING_SOURCE' as const)
            : date <= opening.openingDate
              ? ('ON_OR_BEFORE_BOUNDARY' as const)
              : date > live.asOfDate
                ? ('AFTER_OBSERVATION_DATE' as const)
                : null
          return reason
            ? [{ transactionId, operationId: operation.id, reason }]
            : []
        }
      )
      const liveByPosition = new Map(
        live.parcels.map((parcel) => [parcel.positionId, parcel])
      )
      const projectedByPosition = new Map(
        history.parcels.flatMap((parcel) =>
          parcel.positionId ? [[parcel.positionId, parcel] as const] : []
        )
      )
      const positions = new Set([
        ...liveByPosition.keys(),
        ...projectedByPosition.keys(),
      ])
      return {
        mode: 'RECONCILIATION_ONLY' as const,
        state: 'DRAFT' as const,
        accountingActive: false as const,
        activationReady: false as const,
        statementId,
        accountId: statement.accountId,
        openingDate: opening.openingDate,
        asOfDate: live.asOfDate,
        source: {
          reviewedAsOfDate: snapshot.asOfDate,
          savedFingerprint: statement.sourceFingerprint,
          acceptedFingerprint,
          correctionCount: history.executionAudits.length,
          currentFingerprint: originalDatePreview.sourceFingerprint,
          changed: sourceChanged,
        },
        cash: { verification: 'UNVERIFIED' as const, ...replay },
        cashOperations,
        cashImportExecutions,
        cashManualExecutions,
        cashEvidence: evidenceHistory,
        inventory: [...positions].sort().map((positionId) => {
          const recorded = liveByPosition.get(positionId)
          const proposed = projectedByPosition.get(positionId)
          return {
            positionId,
            openingParcelKey: proposed?.parcelKey ?? null,
            openingQuantity: proposed?.acquired ?? null,
            liveOpeningQuantity: recorded?.openingQuantity ?? null,
            openingDifference:
              proposed && recorded
                ? new AccountingDecimal(proposed.acquired)
                    .minus(recorded.openingQuantity)
                    .toFixed()
                : null,
            proposedRemaining: proposed?.remaining ?? null,
            liveExpectedRemaining: recorded?.expectedCurrentQuantity ?? null,
            liveRecordedRemaining: recorded?.recordedCurrentQuantity ?? null,
            scenarioDifference:
              proposed && recorded
                ? new AccountingDecimal(proposed.remaining)
                    .minus(recorded.expectedCurrentQuantity)
                    .toFixed()
                : null,
          }
        }),
        proposedParcels: history.parcels.filter((parcel) => !parcel.positionId),
        tradeSources,
        excludedLinkedSources,
        previewIssues: live.issues,
        reviewReasons: [
          'CASH_NOT_EXTERNALLY_VERIFIED',
          'LIVE_ACCOUNTING_NOT_ENABLED',
          ...(evidenceHistory.length ? [] : ['CASH_EVIDENCE_MISSING']),
          ...(evidenceHistory[0] &&
          !evidenceHistory[0].currentComparison.matchesReplay
            ? ['CASH_EVIDENCE_MISMATCH']
            : []),
          ...(sourceChanged ? ['OPENING_SOURCE_CHANGED'] : []),
          ...(statement.openingParcels.some((parcel) => {
            const recorded = liveByPosition.get(parcel.positionId)
            return (
              !recorded ||
              !new AccountingDecimal(parcel.quantity).eq(
                recorded.openingQuantity
              )
            )
          })
            ? ['OPENING_INVENTORY_CHANGED']
            : []),
          ...(!replay.funded ? ['DATED_FUNDING_GAP'] : []),
          ...(tradeSources.some((row) => row.linkage !== 'LINKED')
            ? ['RECORDED_TRADES_NOT_FULLY_LINKED']
            : []),
          ...(tradeSources.some(
            (row) => row.potentialOverlapOperationIds.length
          )
            ? ['PROPOSED_RECORDED_TRADE_OVERLAP']
            : []),
          ...(live.issues.some((issue) => issue.severity === 'BLOCKING')
            ? ['LIVE_PREVIEW_BLOCKING_ISSUES']
            : []),
          ...(excludedLinkedSources.length
            ? ['LINKED_SOURCE_REQUIRES_REVIEW']
            : []),
        ],
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}

export async function recordDraftCashEvidence(
  userId: string,
  statementId: string,
  raw: unknown,
  accountId?: string
) {
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      let statement = await readStatement(db, userId, statementId)
      if (accountId && statement.accountId !== accountId)
        conflict('Opening statement not found for this account', 404)
      await lockOwnedTradingAccount(db, userId, statement.accountId)
      statement = await readStatement(db, userId, statementId)
      if (accountId && statement.accountId !== accountId)
        conflict('Opening statement not found for this account', 404)
      if (statement.account.status !== 'ACTIVE' || statement.account.isDemo)
        conflict('Cash evidence requires an active real trading account')
      const opening = {
        openingDate: statement.openingDate.toISOString().slice(0, 10),
        cashBalances: statement.cashBalances.map((row) => ({
          currency: row.currency,
          amount: row.amount.toFixed(),
        })),
      }
      const prepared = prepareDraftCashEvidence(raw, opening.openingDate, now)
      const history = await readCashHistory(
        db,
        userId,
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels,
        statement.sourceFingerprint
      )
      const prior = await db.draftCashEvidence.findUnique({
        where: {
          statementId_idempotencyKey: {
            statementId,
            idempotencyKey: prepared.request.idempotencyKey,
          },
        },
        include: {
          balances: { orderBy: { currency: 'asc' } },
          decisions: { orderBy: { currency: 'asc' } },
        },
      })
      if (prior) {
        if (prior.payloadHash !== prepared.payloadHash)
          conflict('Cash evidence idempotency key has different content')
        const replay = replayCashLedger(
          statement.accountId,
          opening,
          [...history.effective.values()].filter(
            (command): command is CashCommand =>
              command !== null &&
              command.effectiveDate <= prepared.request.asOfDate
          ),
          now
        )
        return {
          evidenceId: prior.id,
          created: false,
          replay,
          comparison: compareDraftCashEvidence(prepared.request, replay, false),
        }
      }
      await verifyStatementSource(db, userId, statement, history)
      const replay = replayCashLedger(
        statement.accountId,
        opening,
        [...history.effective.values()].filter(
          (command): command is CashCommand =>
            command !== null &&
            command.effectiveDate <= prepared.request.asOfDate
        ),
        now
      )
      const comparison = compareDraftCashEvidence(prepared.request, replay)
      const evidence = await db.draftCashEvidence.create({
        data: {
          statementId,
          idempotencyKey: prepared.request.idempotencyKey,
          payloadHash: prepared.payloadHash,
          asOfDate: new Date(`${prepared.request.asOfDate}T00:00:00Z`),
          source: prepared.request.source,
          reference: prepared.request.reference,
          attested: prepared.request.attested,
          balances: {
            create: prepared.request.cashBalances.map((balance) => ({
              currency: balance.currency,
              amount: balance.amount,
            })),
          },
          decisions: {
            create: prepared.request.decisions.map((decision) => ({
              currency: decision.currency,
              reason: decision.reason,
              note: decision.note,
            })),
          },
        },
        select: { id: true },
      })
      return {
        evidenceId: evidence.id,
        created: true,
        replay,
        comparison,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}

export async function previewDraftCashEvidence(
  userId: string,
  statementId: string,
  raw: unknown,
  accountId?: string
) {
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      let statement = await readStatement(db, userId, statementId)
      if (accountId && statement.accountId !== accountId)
        conflict('Opening statement not found for this account', 404)
      await lockOwnedTradingAccount(db, userId, statement.accountId)
      statement = await readStatement(db, userId, statementId)
      if (accountId && statement.accountId !== accountId)
        conflict('Opening statement not found for this account', 404)
      const opening = {
        openingDate: statement.openingDate.toISOString().slice(0, 10),
        cashBalances: statement.cashBalances.map((row) => ({
          currency: row.currency,
          amount: row.amount.toFixed(),
        })),
      }
      const prepared = prepareDraftCashEvidence(raw, opening.openingDate, now)
      const history = await readCashHistory(
        db,
        userId,
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels,
        statement.sourceFingerprint
      )
      const replay = replayCashLedger(
        statement.accountId,
        opening,
        [...history.effective.values()].filter(
          (command): command is CashCommand =>
            command !== null &&
            command.effectiveDate <= prepared.request.asOfDate
        ),
        now
      )
      return {
        asOfDate: prepared.request.asOfDate,
        replay,
        comparison: compareDraftCashEvidence(prepared.request, replay, false),
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}

export async function saveDraftReconciliationCashOperation(
  userId: string,
  statementId: string,
  raw: unknown,
  accountId: string
) {
  const prepared = prepareDraftCashFlow(raw, accountId)
  return saveDraftCashOperation(userId, statementId, prepared.command)
}

/** Isolated proposed parcels only; never creates or edits a live Position/Transaction. */
export async function saveDraftManualTrade(
  userId: string,
  statementId: string,
  raw: unknown
) {
  const now = new Date()
  const parsed = prepareDraftTradeRequest(raw, now)
  const request = parsed.request
  return prisma.$transaction(
    async (db) => {
      let statement = await readStatement(db, userId, statementId)
      await lockOwnedTradingAccount(db, userId, statement.accountId)
      statement = await readStatement(db, userId, statementId)
      if (
        request.accountId !== statement.accountId ||
        statement.account.isDemo ||
        statement.account.status !== 'ACTIVE'
      )
        conflict(
          'Proposed trades require their owned active real account and opening draft'
        )
      const opening = {
        openingDate: statement.openingDate.toISOString().slice(0, 10),
        cashBalances: statement.cashBalances.map((row) => ({
          currency: row.currency,
          amount: row.amount.toFixed(),
        })),
      }
      const history = await readCashHistory(
        db,
        userId,
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels,
        statement.sourceFingerprint
      )
      const prior = history.rows.find(
        (row) => row.idempotencyKey === request.idempotencyKey
      )
      if (prior) {
        if (
          !prior.proposedTrade ||
          prior.proposedTrade.requestHash !== parsed.requestHash
        )
          conflict(
            'Idempotency key is already associated with different proposed trade content'
          )
        const replay = replayCashLedger(
          statement.accountId,
          opening,
          [...history.effective.values()].filter((command) => command !== null),
          now
        )
        requireFundedCashLedger(replay)
        return {
          operationId: prior.id,
          tradeId: prior.proposedTrade.id,
          parcelKey: prior.proposedTrade.parcelKey,
          state: 'DRAFT' as const,
          created: false,
          replay,
          parcels: history.parcels,
        }
      }
      if (history.keys.has(request.idempotencyKey))
        conflict('Idempotency key is already associated with a cash correction')
      requireNewOperationSlot(
        history.rows,
        request.effectiveDate,
        request.sequence
      )
      await verifyStatementSource(db, userId, statement, history)
      const tradeId = randomUUID()
      const prepared = prepareDraftTradeCash(request, tradeId, now)
      if (
        history.rows.length + history.revisionCount >= 50000 ||
        history.postingCount + prepared.legs.length > 100000
      )
        conflict(
          'Draft trade history exceeds the supported audit replay limits',
          422
        )
      let assetId: string
      let symbol: string
      const parcelKey = request.kind === 'BUY' ? tradeId : request.parcelKey
      if (request.kind === 'BUY') {
        const asset = await db.asset.findUnique({
          where: { id: request.assetId },
          include: { exchange: true },
        })
        if (
          !asset ||
          !asset.isActive ||
          asset.exchange.currency !== request.currency
        )
          conflict(
            'Proposed BUY requires an active asset in the explicit execution currency'
          )
        assetId = asset.id
        symbol = asset.symbol
      } else {
        const openingParcel = statement.openingParcels.find(
          (parcel) => parcel.parcelKey === parcelKey
        )
        if (openingParcel) {
          if (
            history.rows.some(
              (row) =>
                !row.proposedTrade &&
                (row.kind === 'BUY' || row.kind === 'SELL')
            )
          )
            conflict(
              'Opening sale proposals cannot mix with recorded live trade cash'
            )
          const position = await db.position.findFirst({
            where: {
              id: openingParcel.positionId,
              accountId: statement.accountId,
              userId,
              positionType: 'LONG',
            },
            select: {
              assetId: true,
              asset: {
                select: {
                  symbol: true,
                  exchange: { select: { currency: true } },
                },
              },
            },
          })
          if (
            !position ||
            position.asset.symbol !== openingParcel.symbol ||
            position.asset.exchange.currency !== openingParcel.currency
          )
            conflict('Opening sale requires its unchanged owned source parcel')
          assetId = position.assetId
          symbol = openingParcel.symbol
        } else {
          const buy = history.rows.find(
            (row) => row.proposedTrade?.id === parcelKey
          )
          if (!buy?.proposedTrade || buy.kind !== 'BUY')
            conflict(
              'Proposed SELL must select a BUY parcel in this opening draft or a confirmed opening parcel'
            )
          assetId = buy.proposedTrade.assetId
          symbol = buy.proposedTrade.symbol
        }
      }
      const parcels = replayDraftTradeParcels(
        [...history.proposedTrades, { id: tradeId, parcelKey, request }],
        statement.openingParcels
      )
      const replay = replayCashLedger(
        statement.accountId,
        opening,
        [...history.effective.values()]
          .filter((command) => command !== null)
          .concat(prepared.command),
        now
      )
      requireFundedCashLedger(replay)
      const operation = await db.draftCashOperation.create({
        data: {
          statementId,
          state: 'DRAFT',
          methodology: prepared.methodology,
          idempotencyKey: request.idempotencyKey,
          payloadHash: prepared.payloadHash,
          kind: request.kind,
          effectiveDate: new Date(`${request.effectiveDate}T00:00:00Z`),
          sequence: BigInt(request.sequence),
          sourceOrigin: 'MANUAL',
          sourceReference: prepared.command.source.reference,
          command: { ...prepared.command },
          postings: {
            create: prepared.legs.map((leg, legIndex) => ({
              ...leg,
              legIndex,
            })),
          },
          tradeLinks: { create: { transactionId: tradeId } },
          proposedTrade: {
            create: {
              id: tradeId,
              parcelKey,
              assetId,
              symbol,
              currency: request.currency,
              quantity: request.quantity,
              price: request.price,
              fees: request.fees,
              requestHash: parsed.requestHash,
              request: { ...request },
            },
          },
        },
        select: { id: true },
      })
      return {
        operationId: operation.id,
        tradeId,
        parcelKey,
        state: 'DRAFT' as const,
        created: true,
        replay,
        parcels,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}

/** Cash-only corrections cannot independently change an isolated trade. */
export async function correctDraftCashOperation(
  userId: string,
  statementId: string,
  operationId: string,
  raw: unknown
) {
  const prepared = prepareCashRevision(raw)
  if ('proposedTrade' in prepared.request)
    conflict(
      'Proposed corrections require the atomic draft trade correction writer'
    )
  return correctDraftOperation(userId, statementId, operationId, raw, false)
}

export async function correctDraftManualTrade(
  userId: string,
  statementId: string,
  operationId: string,
  raw: unknown
) {
  return correctDraftOperation(userId, statementId, operationId, raw, true)
}

export async function correctDraftReconciliationCashOperation(
  userId: string,
  accountId: string,
  statementId: string,
  operationId: string,
  raw: unknown
) {
  return correctDraftOperation(userId, statementId, operationId, raw, false, {
    accountId,
    kind: 'CAPITAL',
  })
}

type LiveTradeSnapshot = {
  transactionId: string
  positionId: string
  assetId: string
  kind: 'BUY' | 'SELL'
  date: string
  quantity: string
  price: string
  totalValue: string
  fees: string
  currency: string
}

function liveTradeSnapshot(transaction: {
  id: string
  positionId: string
  type: string
  date: Date
  quantity: number
  price: { toFixed(): string }
  totalValue: { toFixed(): string }
  fees: { toFixed(): string }
  position: {
    assetId: string
    asset: { exchange: { currency: string } }
  }
}): LiveTradeSnapshot {
  if (transaction.type !== 'BUY' && transaction.type !== 'SELL')
    conflict('Live cash operations support only BUY and SELL transactions')
  return {
    transactionId: transaction.id,
    positionId: transaction.positionId,
    assetId: transaction.position.assetId,
    kind: transaction.type,
    date: transaction.date.toISOString(),
    quantity: new AccountingDecimal(String(transaction.quantity)).toFixed(),
    price: transaction.price.toFixed(),
    totalValue: transaction.totalValue.toFixed(),
    fees: transaction.fees.toFixed(),
    currency: transaction.position.asset.exchange.currency,
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    conflict('Stored live cash audit is invalid')
  return value as Record<string, unknown>
}

function sameLiveTradeSnapshot(
  value: unknown,
  expected: LiveTradeSnapshot
): boolean {
  const stored = recordValue(value)
  const keys = Object.keys(expected) as (keyof LiveTradeSnapshot)[]
  return (
    Object.keys(stored).length === keys.length &&
    keys.every((key) => stored[key] === expected[key])
  )
}

function isFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function snapshotMatchesExecution(
  live: LiveTradeSnapshot,
  execution: ExecutionSnapshot
): boolean {
  return (
    live.transactionId === execution.transactionId &&
    live.positionId === execution.positionId &&
    live.date === execution.date &&
    live.quantity === execution.quantity &&
    live.price === execution.price &&
    live.totalValue === execution.totalValue &&
    live.fees === execution.fees &&
    live.currency === execution.currency
  )
}

function parseLiveTradeSnapshot(value: unknown): LiveTradeSnapshot {
  const row = recordValue(value)
  const expectedKeys = [
    'transactionId',
    'positionId',
    'assetId',
    'kind',
    'date',
    'quantity',
    'price',
    'totalValue',
    'fees',
    'currency',
  ]
  if (
    Object.keys(row).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in row))
  )
    conflict('Stored live trade snapshot is invalid')
  const text = (key: string) => {
    const item = row[key]
    if (typeof item !== 'string')
      conflict('Stored live trade snapshot is invalid')
    return item
  }
  const kind = text('kind')
  const date = text('date')
  if (
    (kind !== 'BUY' && kind !== 'SELL') ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString() !== date ||
    !isAccountingCurrency(text('currency'))
  )
    conflict('Stored live trade snapshot is invalid')
  return {
    transactionId: text('transactionId'),
    positionId: text('positionId'),
    assetId: text('assetId'),
    kind,
    date,
    quantity: text('quantity'),
    price: text('price'),
    totalValue: text('totalValue'),
    fees: text('fees'),
    currency: text('currency'),
  }
}

function importedExecutionSnapshot(
  event: ImportedCashEvent,
  transactions: readonly ImportedCashTransaction[]
): string[] {
  const fee = event.fee.toFixed()
  return [
    JSON.stringify([
      event.id,
      event.userId,
      event.source,
      event.externalId,
      event.kind,
      event.status,
      event.occurredAt.toISOString(),
      event.quoteCurrency,
      event.grossValue?.toFixed() ?? null,
      fee,
      event.feeCurrency,
      [...event.appliedPositionIds].sort(),
    ]),
    ...[...transactions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((transaction) =>
        JSON.stringify([
          transaction.id,
          transaction.positionId,
          transaction.brokerRef,
          transaction.type,
          transaction.date.toISOString(),
          new AccountingDecimal(String(transaction.quantity)).toFixed(),
          transaction.price.toFixed(),
          transaction.totalValue.toFixed(),
          transaction.fees.toFixed(),
          transaction.position.origin,
          transaction.position.positionType,
          transaction.position.asset.exchange.currency,
        ])
      ),
  ]
}

function parseImportedExecutionSourceSnapshot(
  value: unknown,
  event: ImportedCashEvent
): ImportedExecutionTradeSnapshot[] {
  if (!Array.isArray(value) || value.length < 2)
    conflict('Stored imported execution snapshot is invalid')
  const [eventRow, ...tradeRows] = value
  const expectedEvent = importedExecutionSnapshot(event, [])[0]
  if (eventRow !== expectedEvent || tradeRows.length > 5000)
    conflict('Stored imported execution no longer matches its source event')
  const snapshots = tradeRows.map((raw) => {
    if (typeof raw !== 'string')
      conflict('Stored imported trade snapshot is invalid')
    let row: unknown
    try {
      row = JSON.parse(raw)
    } catch {
      conflict('Stored imported trade snapshot is invalid')
    }
    if (!Array.isArray(row) || row.length !== 12)
      conflict('Stored imported trade snapshot is invalid')
    const [
      transactionId,
      positionId,
      brokerRef,
      type,
      date,
      quantity,
      price,
      totalValue,
      fees,
      origin,
      positionType,
      currency,
    ] = row
    if (
      typeof transactionId !== 'string' ||
      typeof positionId !== 'string' ||
      brokerRef !== event.externalId ||
      type !== event.kind ||
      typeof date !== 'string' ||
      typeof quantity !== 'string' ||
      typeof price !== 'string' ||
      typeof totalValue !== 'string' ||
      typeof fees !== 'string' ||
      (origin !== 'MANUAL' && origin !== 'IMPORT_TRADE') ||
      positionType !== 'LONG' ||
      typeof currency !== 'string'
    )
      conflict('Stored imported trade snapshot is invalid')
    return {
      transactionId,
      positionId,
      date,
      quantity,
      price,
      totalValue,
      fees,
      currency,
    }
  })
  if (
    new Set(snapshots.map((snapshot) => snapshot.transactionId)).size !==
    snapshots.length
  )
    conflict('Stored imported trade identities are duplicated')
  return snapshots
}

function sameImportedExecutionSnapshot(
  value: unknown,
  expected: readonly string[]
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every(
      (row, index) => typeof row === 'string' && row === expected[index]
    )
  )
}

function sameImportedExecutionTradeSnapshots(
  value: unknown,
  expected: readonly ImportedExecutionTradeSnapshot[]
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
      const actual = raw as Record<string, unknown>
      const snapshot = expected[index]
      return (
        snapshot !== undefined &&
        actual.transactionId === snapshot.transactionId &&
        actual.positionId === snapshot.positionId &&
        actual.date === snapshot.date &&
        actual.quantity === snapshot.quantity &&
        actual.price === snapshot.price &&
        actual.totalValue === snapshot.totalValue &&
        actual.fees === snapshot.fees &&
        actual.currency === snapshot.currency
      )
    })
  )
}

function getOpeningSnapshotDate(statement: {
  previewSnapshot: unknown
}): string {
  const snapshot = statement.previewSnapshot
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    !('asOfDate' in snapshot) ||
    !isAccountingDate(snapshot.asOfDate)
  )
    conflict('Confirmed opening statement has no valid source observation date')
  return snapshot.asOfDate
}

async function readLiveCashState(
  db: DraftCashTransaction,
  userId: string,
  accountId: string,
  now: Date,
  excludedImportBatchId?: string,
  readOnly = false
) {
  const account = await db.tradingAccount.findFirst({
    where: { id: accountId, userId, user: { deletedAt: null } },
    select: { id: true, status: true, isDemo: true },
  })
  if (!account) conflict('Trading account not found', 404)
  if ((!readOnly && account.status !== 'ACTIVE') || account.isDemo)
    conflict('Live cash posting requires an active real trading account')
  const ledger = await db.accountCashLedger.findUnique({
    where: { accountId },
  })
  if (!ledger || ledger.state !== 'ACTIVE')
    conflict(
      'This legacy account has no active confirmed cash ledger. Existing trade creation remains unchanged.'
    )
  const statement = await readStatement(
    db,
    userId,
    ledger.openingStatementId,
    'CONFIRMED'
  )
  if (
    statement.accountId !== accountId ||
    statement.sourceFingerprint !== ledger.openingSourceFingerprint
  )
    conflict('Confirmed cash ledger and opening statement do not match')
  const openingDate = statement.openingDate.toISOString().slice(0, 10)
  const opening = {
    openingDate,
    cashBalances: statement.cashBalances.map((row) => ({
      currency: row.currency,
      amount: row.amount.toFixed(),
    })),
  }
  const sourceObservationDate = getOpeningSnapshotDate(statement)
  const openingParcels: DraftOpeningParcel[] = statement.parcels.map((row) => ({
    parcelKey: `opening:${row.id}`,
    positionId: row.positionId,
    symbol: row.symbol,
    currency: row.currency,
    quantity: row.quantity.toFixed(),
  }))
  const history = await readCashHistory(
    db,
    userId,
    statement.id,
    accountId,
    openingDate,
    now,
    openingParcels,
    statement.sourceFingerprint
  )
  if (history.proposedTrades.length)
    conflict(
      'Resolve isolated proposed trades before enabling live cash posting'
    )
  const cashLedgerOps = await db.accountCashOperation.findMany({
    where: { accountId },
    orderBy: { auditNumber: 'asc' },
    include: {
      postings: { orderBy: { legIndex: 'asc' } },
      revisions: {
        orderBy: { revisionNumber: 'asc' },
        include: { postings: { orderBy: { legIndex: 'asc' } } },
      },
      transaction: {
        include: {
          position: { include: { asset: { include: { exchange: true } } } },
        },
      },
      importedEvent: { select: { id: true } },
    },
    take: 50001,
  })
  if (cashLedgerOps.length > 50000)
    conflict('Live cash history exceeds the supported replay limit', 422)
  const liveRevisionCount = cashLedgerOps.reduce(
    (count, operation) => count + operation.revisions.length,
    0
  )
  if (cashLedgerOps.length + liveRevisionCount > 50000)
    conflict('Live cash history exceeds the supported replay limit', 422)
  let acceptedFingerprint = continuedSourceFingerprint(
    statement.sourceFingerprint,
    history.executionAudits
  )
  const liveCommandByOperation = new Map<string, CashCommand | null>()
  const liveReservedSlots: { effectiveDate: Date; sequence: bigint }[] = []
  const liveEvents: {
    auditNumber: number
    operation: (typeof cashLedgerOps)[number]
    revision?: (typeof cashLedgerOps)[number]['revisions'][number]
    prepared?: ReturnType<typeof prepareCashRevision>
  }[] = []
  const linkedTransactions = new Set(
    [...history.effective.values()].flatMap((command) =>
      command && 'transactionIds' in command ? command.transactionIds : []
    )
  )
  for (const operation of cashLedgerOps) {
    liveReservedSlots.push({
      effectiveDate: operation.effectiveDate,
      sequence: operation.sequence,
    })
    const stored = recordValue(operation.command)
    const prepared = prepareCashCommand(
      operation.importedEventId
        ? (() => {
            if (Object.keys(stored).length !== 1 || !('cashCommand' in stored))
              conflict('Stored imported cash operation is invalid')
            return stored.cashCommand
          })()
        : (() => {
            if (
              Object.keys(stored).length !== 2 ||
              !('request' in stored) ||
              !('cashCommand' in stored)
            )
              conflict('Stored live cash request is invalid')
            return stored.cashCommand
          })(),
      now
    )
    const command = prepared.command
    if (command.kind !== 'BUY' && command.kind !== 'SELL')
      conflict('Stored live cash operation is not a trade')
    const commonInvalid =
      operation.accountId !== accountId ||
      operation.kind !== command.kind ||
      operation.idempotencyKey !== command.idempotencyKey ||
      command.accountId !== accountId ||
      !isFingerprint(operation.previousFingerprint) ||
      !isFingerprint(operation.nextFingerprint) ||
      command.effectiveDate !==
        operation.effectiveDate.toISOString().slice(0, 10) ||
      command.sequence !== Number(operation.sequence) ||
      operation.postings.length !== prepared.legs.length ||
      operation.postings.some(
        (posting, legIndex) =>
          posting.legIndex !== legIndex ||
          posting.currency !== prepared.legs[legIndex].currency ||
          posting.role !== prepared.legs[legIndex].role ||
          posting.amount.toFixed() !== prepared.legs[legIndex].amount
      )
    if (operation.importedEventId) {
      const event = await db.importedEvent.findFirst({
        where: {
          id: operation.importedEventId,
          userId,
          source: 'KRAKEN',
          status: 'APPLIED',
          batch: { userId, accountId },
        },
        select: {
          id: true,
          userId: true,
          source: true,
          externalId: true,
          kind: true,
          status: true,
          occurredAt: true,
          quoteCurrency: true,
          grossValue: true,
          fee: true,
          feeCurrency: true,
          appliedPositionIds: true,
          batch: { select: { accountId: true, userId: true } },
        },
      })
      if (!event)
        conflict('Stored imported cash operation has no applied Kraken source')
      const transactions = await db.transaction.findMany({
        where: {
          brokerRef: event.externalId,
          position: { accountId, userId },
        },
        select: {
          id: true,
          positionId: true,
          brokerRef: true,
          type: true,
          date: true,
          quantity: true,
          price: true,
          totalValue: true,
          fees: true,
          position: {
            select: {
              origin: true,
              positionType: true,
              asset: {
                select: { exchange: { select: { currency: true } } },
              },
            },
          },
        },
      })
      validateImportedExecution(
        userId,
        accountId,
        command,
        event,
        transactions,
        operation.revisions.length > 0
      )
      const snapshot = importedExecutionSnapshot(event, transactions)
      const baseSnapshots = parseImportedExecutionSourceSnapshot(
        operation.transactionSnapshot,
        event
      )
      const currentSnapshots = transactions
        .map(executionSnapshot)
        .sort((left, right) =>
          left.transactionId.localeCompare(right.transactionId)
        )
      if (
        commonInvalid ||
        operation.importedEvent?.id !== event.id ||
        command.source.origin !== 'IMPORT' ||
        command.source.reference !== event.externalId ||
        command.idempotencyKey !== `import-event:${event.id}` ||
        operation.payloadHash !== prepared.payloadHash ||
        operation.transactionId !== command.transactionIds[0] ||
        baseSnapshots.length !== command.transactionIds.length ||
        JSON.stringify(baseSnapshots.map((row) => row.transactionId)) !==
          JSON.stringify([...command.transactionIds].sort()) ||
        baseSnapshots.some(
          (row, index) =>
            row.currency !== command.consideration.currency ||
            row.quantity !== currentSnapshots[index]?.quantity ||
            row.positionId !== currentSnapshots[index]?.positionId
        ) ||
        (!operation.revisions.length &&
          !sameImportedExecutionSnapshot(
            operation.transactionSnapshot,
            snapshot
          ))
      )
        conflict(
          'Stored imported execution, source audit or cash postings are inconsistent'
        )
      let priorCommand = command
      let priorSnapshots = baseSnapshots
      let previousRevisionId: string | null = null
      let expectedRevisionId = operation.id
      for (const [revisionIndex, revision] of operation.revisions.entries()) {
        const revisionPrepared = prepareCashRevision(revision.request, now)
        const audit = revisionPrepared.request.importedExecutionAudit
        const replacement = revisionPrepared.request.replacement
        const legs = prepareRevisionLegs(priorCommand, replacement, now)
        const revisionSnapshots = audit?.after
        if (
          !audit ||
          !replacement ||
          revisionPrepared.request.executionAudit ||
          audit.eventId !== event.id ||
          revision.accountId !== accountId ||
          revision.operationId !== operation.id ||
          revision.revisionNumber !== revisionIndex + 1 ||
          revision.previousRevisionId !== previousRevisionId ||
          revisionPrepared.request.expectedRevisionId !== expectedRevisionId ||
          revision.payloadHash !== revisionPrepared.payloadHash ||
          revision.idempotencyKey !== revisionPrepared.request.idempotencyKey ||
          revision.reason !== revisionPrepared.request.reason ||
          revision.auditNumber < 1 ||
          !isFingerprint(revision.previousFingerprint) ||
          !isFingerprint(revision.nextFingerprint) ||
          audit.number !== revision.auditNumber ||
          audit.previousFingerprint !== revision.previousFingerprint ||
          audit.nextFingerprint !== revision.nextFingerprint ||
          audit.input.expectedRevisionId !== expectedRevisionId ||
          !isFingerprint(audit.input.expectedSourceFingerprint) ||
          JSON.stringify(audit.before) !== JSON.stringify(priorSnapshots) ||
          !revisionSnapshots ||
          !sameImportedExecutionTradeSnapshots(
            revision.transactionSnapshot,
            revisionSnapshots
          ) ||
          replacement.source.origin !== 'IMPORT' ||
          replacement.source.reference !== event.externalId ||
          replacement.kind !== command.kind ||
          replacement.transactionIds.length !== command.transactionIds.length ||
          JSON.stringify([...replacement.transactionIds].sort()) !==
            JSON.stringify([...command.transactionIds].sort()) ||
          replacement.effectiveDate !== audit.input.effectiveDate ||
          replacement.sequence !== audit.input.sequence ||
          revisionSnapshots.some(
            (row, index) =>
              row.transactionId !== priorSnapshots[index]?.transactionId ||
              row.positionId !== priorSnapshots[index]?.positionId ||
              row.quantity !== priorSnapshots[index]?.quantity ||
              row.currency !== priorSnapshots[index]?.currency ||
              row.date.slice(0, 10) !== audit.input.effectiveDate ||
              row.price !== audit.input.price
          ) ||
          legs.length !== revision.postings.length ||
          revision.postings.some(
            (posting, legIndex) =>
              posting.legIndex !== legIndex ||
              posting.phase !== legs[legIndex].phase ||
              posting.currency !== legs[legIndex].currency ||
              posting.role !== legs[legIndex].role ||
              posting.amount.toFixed() !== legs[legIndex].amount
          )
        )
          conflict(
            'Stored imported execution correction, source audit or postings are inconsistent'
          )
        liveEvents.push({
          auditNumber: revision.auditNumber,
          operation,
          revision,
          prepared: revisionPrepared,
        })
        liveReservedSlots.push({
          effectiveDate: new Date(`${replacement.effectiveDate}T00:00:00Z`),
          sequence: BigInt(replacement.sequence),
        })
        priorCommand = replacement
        priorSnapshots = revisionSnapshots
        previousRevisionId = revision.id
        expectedRevisionId = revision.id
      }
      if (JSON.stringify(priorSnapshots) !== JSON.stringify(currentSnapshots))
        conflict(
          'Current imported trades do not match their latest immutable correction snapshot'
        )
      liveCommandByOperation.set(operation.id, priorCommand)
    } else {
      const storedInput = parseAccountTradeInput(stored.request)
      const baseSnapshot = parseLiveTradeSnapshot(operation.transactionSnapshot)
      const currentTrade = liveTradeSnapshot(operation.transaction)
      const originalGross = new AccountingDecimal(storedInput.quantity)
        .mul(storedInput.price)
        .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
        .toFixed()
      const expectedBaseSnapshot: LiveTradeSnapshot = {
        transactionId: operation.transactionId,
        positionId: operation.transaction.positionId,
        assetId: operation.transaction.position.assetId,
        kind: storedInput.kind,
        date: new Date(`${storedInput.effectiveDate}T01:00:00Z`).toISOString(),
        quantity: storedInput.quantity,
        price: storedInput.price,
        totalValue: originalGross,
        fees: storedInput.fees,
        currency: currentTrade.currency,
      }
      if (
        commonInvalid ||
        operation.transactionId !== baseSnapshot.transactionId ||
        operation.payloadHash !== accountTradePayloadHash(storedInput) ||
        command.source.origin !== 'MANUAL' ||
        command.source.reference !== `live-trade:${operation.transactionId}` ||
        command.transactionIds.length !== 1 ||
        command.transactionIds[0] !== operation.transactionId ||
        storedInput.idempotencyKey !== operation.idempotencyKey ||
        command.effectiveDate !== storedInput.effectiveDate ||
        command.sequence !== storedInput.sequence ||
        command.consideration.currency !== baseSnapshot.currency ||
        command.consideration.amount !== baseSnapshot.totalValue ||
        (command.fees[0]?.amount ?? '0') !== baseSnapshot.fees ||
        command.kind !== storedInput.kind ||
        command.transactionIds.length !== 1 ||
        command.consideration.amount !== originalGross ||
        storedInput.quantity !== baseSnapshot.quantity ||
        storedInput.price !== baseSnapshot.price ||
        storedInput.fees !== baseSnapshot.fees ||
        (storedInput.kind === 'BUY'
          ? storedInput.assetId !== baseSnapshot.assetId
          : storedInput.positionId !== baseSnapshot.positionId) ||
        !sameLiveTradeSnapshot(
          operation.transactionSnapshot,
          expectedBaseSnapshot
        ) ||
        baseSnapshot.transactionId !== operation.transactionId ||
        baseSnapshot.kind !== storedInput.kind ||
        baseSnapshot.positionId !== operation.transaction.positionId ||
        baseSnapshot.assetId !== operation.transaction.position.assetId ||
        currentTrade.transactionId !== operation.transactionId ||
        currentTrade.kind !== storedInput.kind ||
        currentTrade.currency !== baseSnapshot.currency
      )
        conflict(
          'Stored live trade, source audit or cash postings are inconsistent'
        )
      let priorCommand: CashCommand | null = command
      let priorSnapshot = baseSnapshot
      let voidedAt: string | null = null
      let previousRevisionId: string | null = null
      let expectedRevisionId = operation.id
      for (const [revisionIndex, revision] of operation.revisions.entries()) {
        const revisionPrepared = prepareCashRevision(revision.request, now)
        const audit = revisionPrepared.request.executionAudit
        const voidAudit = revisionPrepared.request.voidAudit
        const sourceAudit = audit ?? voidAudit
        if (!sourceAudit)
          conflict('A manual revision requires its immutable source audit')
        const replacement = revisionPrepared.request.replacement
        if (!priorCommand)
          conflict('A voided manual trade cannot have further revisions')
        const legs = prepareRevisionLegs(priorCommand, replacement, now)
        const revisionSnapshot = parseLiveTradeSnapshot(
          revision.transactionSnapshot
        )
        if (
          (audit ? (audit.kind ?? 'SELL') : voidAudit?.kind) !==
            storedInput.kind ||
          priorCommand.kind !== storedInput.kind ||
          (voidAudit
            ? replacement !== null
            : replacement?.kind !== storedInput.kind) ||
          operation.importedEventId ||
          revision.accountId !== accountId ||
          revision.operationId !== operation.id ||
          revision.revisionNumber !== revisionIndex + 1 ||
          revision.previousRevisionId !== previousRevisionId ||
          revisionPrepared.request.expectedRevisionId !== expectedRevisionId ||
          revision.payloadHash !== revisionPrepared.payloadHash ||
          revision.idempotencyKey !== revisionPrepared.request.idempotencyKey ||
          revision.reason !== revisionPrepared.request.reason ||
          revision.auditNumber < 1 ||
          !isFingerprint(revision.previousFingerprint) ||
          !isFingerprint(revision.nextFingerprint) ||
          sourceAudit.number !== revision.auditNumber ||
          sourceAudit.previousFingerprint !== revision.previousFingerprint ||
          sourceAudit.nextFingerprint !== revision.nextFingerprint ||
          !snapshotMatchesExecution(priorSnapshot, sourceAudit.before) ||
          (audit
            ? !snapshotMatchesExecution(revisionSnapshot, audit.after)
            : !sameLiveTradeSnapshot(priorSnapshot, revisionSnapshot)) ||
          revisionSnapshot.kind !== storedInput.kind ||
          revisionSnapshot.assetId !== baseSnapshot.assetId ||
          revisionSnapshot.positionId !== baseSnapshot.positionId ||
          legs.length !== revision.postings.length ||
          revision.postings.some(
            (posting, legIndex) =>
              posting.legIndex !== legIndex ||
              posting.phase !== legs[legIndex].phase ||
              posting.currency !== legs[legIndex].currency ||
              posting.role !== legs[legIndex].role ||
              posting.amount.toFixed() !== legs[legIndex].amount
          )
        )
          conflict(
            'Stored live manual execution revision, source audit or postings are inconsistent'
          )
        liveEvents.push({
          auditNumber: revision.auditNumber,
          operation,
          revision,
          prepared: revisionPrepared,
        })
        if (replacement)
          liveReservedSlots.push({
            effectiveDate: new Date(`${replacement.effectiveDate}T00:00:00Z`),
            sequence: BigInt(replacement.sequence),
          })
        voidedAt = voidAudit?.voidedAt ?? null
        priorCommand = replacement
        priorSnapshot = revisionSnapshot
        previousRevisionId = revision.id
        expectedRevisionId = revision.id
      }
      if (!sameLiveTradeSnapshot(priorSnapshot, currentTrade))
        conflict(
          'Current manual execution does not match its latest immutable correction snapshot'
        )
      if (
        (operation.transaction.voidedAt?.toISOString() ?? null) !== voidedAt ||
        (voidedAt &&
          storedInput.kind === 'BUY' &&
          operation.transaction.position.voidedAt?.toISOString() !==
            voidedAt) ||
        (!voidedAt && operation.transaction.position.voidedAt)
      )
        conflict('Manual trade void marker does not match its immutable audit')
      liveCommandByOperation.set(operation.id, priorCommand)
    }
    liveEvents.push({ auditNumber: operation.auditNumber, operation })
    for (const transactionId of command.transactionIds)
      linkedTransactions.add(transactionId)
  }
  liveEvents.sort((left, right) => left.auditNumber - right.auditNumber)
  let expectedAuditNumber = history.executionAudits.length + 1
  for (const event of liveEvents) {
    const operation = event.operation
    if (
      event.auditNumber !== expectedAuditNumber ||
      operation.accountId !== accountId
    )
      conflict('Live cash audit sequence is inconsistent')
    if (event.revision) {
      const revision = event.revision
      const audit = event.prepared?.request.executionAudit
      const importedAudit = event.prepared?.request.importedExecutionAudit
      const voidAudit = event.prepared?.request.voidAudit
      const replacement = event.prepared?.request.replacement
      if (
        (!audit && !importedAudit && !voidAudit) ||
        (!replacement && !voidAudit) ||
        revision.previousFingerprint !== acceptedFingerprint ||
        (audit && audit.previousFingerprint !== acceptedFingerprint) ||
        (importedAudit &&
          importedAudit.previousFingerprint !== acceptedFingerprint) ||
        (voidAudit && voidAudit.previousFingerprint !== acceptedFingerprint)
      )
        conflict('Live cash correction fingerprint chain is inconsistent')
      acceptedFingerprint = revision.nextFingerprint
      liveCommandByOperation.set(operation.id, replacement ?? null)
    } else {
      if (
        operation.auditNumber !== expectedAuditNumber ||
        operation.previousFingerprint !== acceptedFingerprint
      )
        conflict('Live cash operation fingerprint chain is inconsistent')
      acceptedFingerprint = operation.nextFingerprint
    }
    expectedAuditNumber += 1
  }
  const liveCommands = [...liveCommandByOperation.values()].filter(
    (command): command is CashCommand => command !== null
  )
  for (const command of liveCommands)
    if ('transactionIds' in command)
      for (const transactionId of command.transactionIds)
        linkedTransactions.add(transactionId)
  if (ledger.acceptedSourceFingerprint !== acceptedFingerprint)
    conflict('Live cash source audit head is inconsistent')
  const existingTrades = await db.transaction.findMany({
    where: {
      position: { accountId, userId },
      type: { in: ['BUY', 'SELL'] },
    },
    select: { id: true, date: true },
    take: 50001,
  })
  if (existingTrades.length > 50000)
    conflict('Account trade history exceeds the supported audit limit', 422)
  if (
    existingTrades.some(
      (trade) =>
        sydneyCalendarDate(trade.date) > openingDate &&
        !linkedTransactions.has(trade.id)
    )
  )
    conflict(
      'Post-opening account trades must be staged in the cash ledger before live posting'
    )
  // Archived accounts retain audit access even if their current preview has changed.
  if (!readOnly) {
    const beforePreview = await readAccountOpeningPreview(
      db,
      userId,
      accountId,
      opening,
      new Date(`${sourceObservationDate}T01:00:00Z`),
      excludedImportBatchId
        ? { excludeImportBatchId: excludedImportBatchId }
        : undefined
    )
    if (beforePreview.sourceFingerprint !== acceptedFingerprint)
      conflict(
        'Confirmed account source changed outside its audited live cash history'
      )
  }
  return {
    ledger,
    statement,
    opening,
    openingDate,
    sourceObservationDate,
    history,
    cashLedgerOps,
    liveAuditEventCount: liveEvents.length,
    liveReservedSlots,
    acceptedFingerprint,
    liveCommands,
    linkedTransactions,
    existingTrades,
  }
}

export async function beginLiveImportPosting(
  db: DraftCashTransaction,
  userId: string,
  accountId: string,
  batchId: string,
  events: readonly { id: string; occurredAt: Date }[]
) {
  if (!events.length) return null
  const unique = new Set(events.map((event) => event.id))
  if (unique.size !== events.length)
    conflict('An imported execution was selected more than once')

  const pendingEvents = await db.importedEvent.findMany({
    where: {
      batchId,
      userId,
      status: { in: ['PENDING', 'DEFERRED'] },
      batch: {
        userId,
        accountId,
        status: { in: ['PENDING_REVIEW', 'PARTIALLY_APPLIED'] },
      },
    },
    select: { id: true, source: true, kind: true },
  })
  if (
    pendingEvents.length !== events.length ||
    pendingEvents.some(
      (event) =>
        !unique.has(event.id) ||
        event.source !== 'KRAKEN' ||
        (event.kind !== 'BUY' && event.kind !== 'SELL')
    )
  )
    conflict(
      'A live-ledger import must include every pending supported trade in its batch'
    )

  const now = new Date()
  const state = await readLiveCashState(db, userId, accountId, now, batchId)
  const byDate = new Map<string, { id: string; occurredAt: Date }[]>()
  for (const event of events) {
    const date = sydneyCalendarDate(event.occurredAt)
    if (date <= state.openingDate)
      conflict(
        'Imported executions must follow the confirmed end-of-day opening'
      )
    const day = byDate.get(date) ?? []
    day.push(event)
    byDate.set(date, day)
  }
  const ordered = [...byDate.entries()]
    .flatMap(([date, day]) => {
      day.sort(
        (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()
      )
      if (
        day.some(
          (event, index) =>
            index > 0 &&
            event.occurredAt.getTime() === day[index - 1].occurredAt.getTime()
        )
      )
        conflict(
          'Kraken executions with identical timestamps need an explicit sequence before posting'
        )
      return day.map((event, index) => ({
        ...event,
        date,
        sequence: index + 1,
      }))
    })
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.occurredAt.getTime() - right.occurredAt.getTime()
    )
  const affectedDates = new Set(ordered.map((event) => event.date))
  if (
    state.history.rows.some((row) =>
      affectedDates.has(row.effectiveDate.toISOString().slice(0, 10))
    ) ||
    state.liveReservedSlots.some((row) =>
      affectedDates.has(row.effectiveDate.toISOString().slice(0, 10))
    ) ||
    state.existingTrades.some((row) =>
      affectedDates.has(sydneyCalendarDate(row.date))
    )
  )
    conflict(
      'Kraken executions cannot be interleaved with existing same-day cash activity'
    )

  let completed = false
  return async (appliedEventIds: readonly string[]) => {
    if (completed) conflict('Imported cash posting was already completed')
    if (
      appliedEventIds.length !== events.length ||
      new Set(appliedEventIds).size !== events.length ||
      appliedEventIds.some((id) => !unique.has(id))
    )
      conflict('Imported cash sources changed during commit')
    const eventRows = await db.importedEvent.findMany({
      where: {
        id: { in: [...unique] },
        userId,
        source: 'KRAKEN',
        kind: { in: ['BUY', 'SELL'] },
        status: 'APPLIED',
        batch: { userId, accountId },
      },
      select: {
        id: true,
        userId: true,
        source: true,
        externalId: true,
        kind: true,
        status: true,
        occurredAt: true,
        quoteCurrency: true,
        grossValue: true,
        fee: true,
        feeCurrency: true,
        appliedPositionIds: true,
        batch: { select: { accountId: true, userId: true } },
      },
    })
    if (eventRows.length !== events.length)
      conflict('Every imported execution must be applied in this account')
    const eventById = new Map(eventRows.map((event) => [event.id, event]))
    const externalIds = eventRows.map((event) => event.externalId)
    const transactions = await db.transaction.findMany({
      where: {
        brokerRef: { in: externalIds },
        position: { accountId, userId },
      },
      select: {
        id: true,
        positionId: true,
        brokerRef: true,
        type: true,
        date: true,
        quantity: true,
        price: true,
        totalValue: true,
        fees: true,
        position: {
          select: {
            origin: true,
            positionType: true,
            asset: {
              select: { exchange: { select: { currency: true } } },
            },
          },
        },
      },
    })
    const transactionsByReference = new Map<string, ImportedCashTransaction[]>()
    for (const transaction of transactions) {
      if (!transaction.brokerRef) continue
      const linked = transactionsByReference.get(transaction.brokerRef) ?? []
      linked.push(transaction)
      transactionsByReference.set(transaction.brokerRef, linked)
    }
    const preparedRows = ordered.map(({ id, occurredAt, sequence }) => {
      const event = eventById.get(id)
      if (!event || event.occurredAt.getTime() !== occurredAt.getTime())
        conflict('Imported execution timestamps changed during commit')
      const linked = transactionsByReference.get(event.externalId) ?? []
      const prepared = prepareCashCommand(
        importedExecutionCashCommand(
          accountId,
          event,
          linked.map((transaction) => transaction.id),
          sequence
        ),
        now
      )
      validateImportedExecution(
        userId,
        accountId,
        prepared.command,
        event,
        linked
      )
      return { event, linked, prepared }
    })
    const commands = [
      ...[...state.history.effective.values()].filter(
        (command): command is CashCommand => command !== null
      ),
      ...state.liveCommands,
    ]
    const slots: { effectiveDate: Date; sequence: bigint }[] = [
      ...state.history.rows.map(({ effectiveDate, sequence }) => ({
        effectiveDate,
        sequence,
      })),
      ...state.liveReservedSlots,
    ]
    for (const row of preparedRows) {
      requireNewOperationSlot(
        slots.map((slot) => ({
          effectiveDate: slot.effectiveDate,
          sequence: slot.sequence,
        })),
        row.prepared.command.effectiveDate,
        row.prepared.command.sequence
      )
      commands.push(row.prepared.command)
      requireFundedCashLedger(
        replayCashLedger(accountId, state.opening, commands, now)
      )
      slots.push({
        effectiveDate: new Date(
          `${row.prepared.command.effectiveDate}T00:00:00Z`
        ),
        sequence: BigInt(row.prepared.command.sequence),
      })
    }

    const afterPreview = await readAccountOpeningPreview(
      db,
      userId,
      accountId,
      state.opening,
      new Date(`${state.sourceObservationDate}T01:00:00Z`)
    )
    let previousFingerprint = state.acceptedFingerprint
    const finalFingerprint = afterPreview.sourceFingerprint
    for (const [index, row] of preparedRows.entries()) {
      const command = row.prepared.command
      if (command.kind !== 'BUY' && command.kind !== 'SELL')
        conflict('Imported cash operation is not a trade')
      await db.accountCashOperation.create({
        data: {
          accountId,
          idempotencyKey: command.idempotencyKey,
          payloadHash: row.prepared.payloadHash,
          transactionId: command.transactionIds[0],
          importedEventId: row.event.id,
          kind: command.kind,
          effectiveDate: new Date(`${command.effectiveDate}T00:00:00Z`),
          sequence: BigInt(command.sequence),
          auditNumber:
            state.history.executionAudits.length +
            state.liveAuditEventCount +
            index +
            1,
          command: { cashCommand: command },
          previousFingerprint,
          nextFingerprint: finalFingerprint,
          transactionSnapshot: importedExecutionSnapshot(row.event, row.linked),
          postings: {
            create: row.prepared.legs.map((leg, legIndex) => ({
              ...leg,
              legIndex,
            })),
          },
        },
        select: { id: true },
      })
      previousFingerprint = finalFingerprint
    }
    await db.accountCashLedger.update({
      where: { accountId },
      data: { acceptedSourceFingerprint: finalFingerprint },
    })
    completed = true
  }
}

/** Posts one new manual trade only after an explicit confirmed ledger exists. */
export async function postAccountTrade(
  userId: string,
  accountId: string,
  raw: unknown
) {
  const input = parseAccountTradeInput(raw)
  const payloadHash = accountTradePayloadHash(input)
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      await lockOwnedTradingAccount(db, userId, accountId)
      const state = await readLiveCashState(db, userId, accountId, now)
      const {
        opening,
        openingDate,
        sourceObservationDate,
        history,
        acceptedFingerprint,
        liveCommands,
      } = state

      const existing = await db.accountCashOperation.findUnique({
        where: {
          accountId_idempotencyKey: {
            accountId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      })
      const commands = [
        ...[...history.effective.values()].filter(
          (command): command is CashCommand => command !== null
        ),
        ...liveCommands,
      ]
      const replay = replayCashLedger(accountId, opening, commands, now)
      requireFundedCashLedger(replay)
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          conflict(
            'Idempotency key is already associated with different live trade content'
          )
        return {
          operationId: existing.id,
          transactionId: existing.transactionId,
          created: false,
          replay,
        }
      }
      const currentTradeSlots = [...history.effective.values()].flatMap(
        (command) =>
          command
            ? [
                {
                  effectiveDate: new Date(`${command.effectiveDate}T00:00:00Z`),
                  sequence: BigInt(command.sequence),
                },
              ]
            : []
      )
      requireNewOperationSlot(
        [...history.rows, ...state.liveReservedSlots, ...currentTradeSlots],
        input.effectiveDate,
        input.sequence
      )
      if (input.effectiveDate <= openingDate)
        conflict('Live trades must be after the confirmed end-of-day opening')
      const date = new Date(`${input.effectiveDate}T01:00:00Z`)
      let positionId: string
      let currency: string
      if (input.kind === 'BUY') {
        const asset = await db.asset.findUnique({
          where: { id: input.assetId },
          include: { exchange: true },
        })
        if (!asset) conflict('Trade asset not found', 404)
        currency = asset.exchange.currency
        positionId = randomUUID()
      } else {
        await lockOwnedPosition(db, userId, input.positionId)
        const currentPosition = await db.position.findFirst({
          where: { id: input.positionId, userId, accountId, voidedAt: null },
          include: {
            asset: { include: { exchange: true } },
            transactions: {
              where: { voidedAt: null },
              orderBy: { date: 'asc' },
            },
          },
        })
        if (
          !currentPosition ||
          currentPosition.origin !== 'MANUAL' ||
          currentPosition.positionType !== 'LONG' ||
          currentPosition.transactions.some(
            (transaction) => transaction.brokerRef !== null
          )
        )
          conflict(
            'Live manual sales require an owned long manual parcel without imported allocations'
          )
        const buys = currentPosition.transactions.filter(
          (transaction) => transaction.type === 'BUY'
        )
        const buyQuantity = buys.reduce(
          (sum, transaction) => sum.plus(String(transaction.quantity)),
          new AccountingDecimal(0)
        )
        const soldQuantity = currentPosition.transactions
          .filter((transaction) => transaction.type === 'SELL')
          .reduce(
            (sum, transaction) => sum.plus(String(transaction.quantity)),
            new AccountingDecimal(0)
          )
        const remaining = buyQuantity.minus(soldQuantity)
        const recorded = new AccountingDecimal(String(currentPosition.quantity))
        if (
          buys.length !== 1 ||
          remaining.lte(0) ||
          remaining
            .minus(recorded)
            .abs()
            .gt(
              quantityTolerance(
                Number(remaining.toFixed()),
                currentPosition.quantity
              )
            ) ||
          new AccountingDecimal(input.quantity).gt(remaining) ||
          input.effectiveDate < sydneyCalendarDate(buys[0].date)
        )
          conflict(
            'Sale quantity, acquisition date or parcel inventory is invalid'
          )
        if (sydneyCalendarDate(buys[0].date) === input.effectiveDate) {
          const acquisition = [
            ...history.effective.values(),
            ...liveCommands,
          ].find(
            (command) =>
              command?.kind === 'BUY' &&
              command.transactionIds.includes(buys[0].id) &&
              command.effectiveDate === input.effectiveDate
          )
          if (!acquisition || acquisition.sequence >= input.sequence)
            conflict(
              'Same-day sales must follow their acquisition in explicit cash sequence order'
            )
        }
        positionId = currentPosition.id
        currency = currentPosition.asset.exchange.currency
      }
      const transactionGross = new AccountingDecimal(input.quantity)
        .mul(input.price)
        .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
      if (
        !isAccountingAmount(transactionGross.toFixed()) ||
        transactionGross.gte('10000000000')
      )
        conflict(
          'Trade consideration exceeds transaction storage precision',
          400
        )
      const capital = transactionGross
        .plus(input.fees)
        .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
      if (input.kind === 'BUY' && capital.gte('10000000000'))
        conflict('Trade capital allocation exceeds storage precision', 400)
      if (input.kind === 'BUY') {
        await db.position.create({
          data: {
            id: positionId,
            userId,
            accountId,
            assetId: input.assetId,
            openDate: date,
            entryPrice: input.price,
            quantity: Number(input.quantity),
            positionType: 'LONG',
            totalBuyValue: transactionGross.toFixed(),
            buyFees: input.fees,
            capitalAllocated: capital.toFixed(),
            origin: 'MANUAL',
            externalRef: `ACCOUNT_TRADE:${positionId}`,
          },
        })
      }
      const transaction = await db.transaction.create({
        data: {
          positionId,
          type: input.kind,
          date,
          quantity: Number(input.quantity),
          price: input.price,
          totalValue: transactionGross.toFixed(),
          fees: input.fees,
        },
      })
      if (!(await recomputePositionFromTransactions(positionId, db)))
        conflict('Position not found while posting account trade', 404)
      const postedTransaction = await db.transaction.findUniqueOrThrow({
        where: { id: transaction.id },
        include: {
          position: { include: { asset: { include: { exchange: true } } } },
        },
      })
      const snapshot = liveTradeSnapshot(postedTransaction)
      if (snapshot.currency !== currency)
        conflict('Trade cash currency does not match the parcel exchange')
      const cashPrepared = prepareCashCommand(
        {
          accountId,
          idempotencyKey: input.idempotencyKey,
          source: {
            origin: 'MANUAL',
            reference: `live-trade:${transaction.id}`,
          },
          effectiveDate: input.effectiveDate,
          sequence: input.sequence,
          kind: input.kind,
          consideration: { currency, amount: snapshot.totalValue },
          fees: input.fees === '0' ? [] : [{ currency, amount: input.fees }],
          transactionIds: [transaction.id],
        },
        now
      )
      const nextCommands = [...commands, cashPrepared.command]
      const nextReplay = replayCashLedger(accountId, opening, nextCommands, now)
      requireFundedCashLedger(nextReplay)
      const afterPreview = await readAccountOpeningPreview(
        db,
        userId,
        accountId,
        opening,
        new Date(`${sourceObservationDate}T01:00:00Z`)
      )
      const liveOperation = await db.accountCashOperation.create({
        data: {
          accountId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          transactionId: transaction.id,
          kind: input.kind,
          effectiveDate: date,
          sequence: BigInt(input.sequence),
          auditNumber:
            history.executionAudits.length + state.liveAuditEventCount + 1,
          command: { request: input, cashCommand: cashPrepared.command },
          previousFingerprint: acceptedFingerprint,
          nextFingerprint: afterPreview.sourceFingerprint,
          transactionSnapshot: snapshot,
          postings: {
            create: cashPrepared.legs.map((leg, legIndex) => ({
              ...leg,
              legIndex,
            })),
          },
        },
        select: { id: true },
      })
      await db.accountCashLedger.update({
        where: { accountId },
        data: { acceptedSourceFingerprint: afterPreview.sourceFingerprint },
      })
      return {
        operationId: liveOperation.id,
        transactionId: transaction.id,
        created: true,
        replay: nextReplay,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 20000, maxWait: 5000 }
  )
}

export async function correctLiveManualSale(
  userId: string,
  accountId: string,
  transactionId: string,
  raw: unknown
) {
  return correctLiveManualExecution(
    userId,
    accountId,
    transactionId,
    raw,
    'SELL'
  )
}

export async function voidLiveManualTrade(
  userId: string,
  accountId: string,
  transactionId: string,
  raw: unknown
) {
  const input = parseManualTradeVoidInput(raw)
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      await lockOwnedTradingAccount(db, userId, accountId)
      const state = await readLiveCashState(db, userId, accountId, now)
      const operation = state.cashLedgerOps.find(
        (row) => row.transactionId === transactionId && !row.importedEventId
      )
      if (!operation || (operation.kind !== 'BUY' && operation.kind !== 'SELL'))
        conflict('Live manual trade not found', 404)
      const prior = operation.revisions.find(
        (row) => row.idempotencyKey === input.idempotencyKey
      )
      const commands = [
        ...[...state.history.effective.values()].filter(
          (c): c is CashCommand => c !== null
        ),
        ...state.liveCommands,
      ]
      if (prior) {
        const audit = prepareCashRevision(prior.request, now).request.voidAudit
        if (
          !audit ||
          manualTradeVoidHash(audit.input) !== manualTradeVoidHash(input)
        )
          conflict(
            'Idempotency key is already associated with different void content'
          )
        const replay = replayCashLedger(accountId, state.opening, commands, now)
        requireFundedCashLedger(replay)
        return {
          operationId: operation.id,
          revisionId: prior.id,
          created: false,
          replay,
        }
      }
      if (
        state.history.keys.has(input.idempotencyKey) ||
        state.cashLedgerOps.some(
          (row) =>
            row.idempotencyKey === input.idempotencyKey ||
            row.revisions.some(
              (revision) => revision.idempotencyKey === input.idempotencyKey
            )
        )
      )
        conflict('Idempotency key is already associated with a cash operation')
      const latest = operation.revisions.at(-1)
      if (
        (latest?.id ?? operation.id) !== input.expectedRevisionId ||
        state.acceptedFingerprint !== input.expectedSourceFingerprint
      )
        conflict(
          'Account history changed. Refresh and review the current trade before voiding it.'
        )
      if (state.liveAuditEventCount >= 50000)
        conflict('Live cash history exceeds the supported replay limit', 422)
      const current = state.liveCommands.find(
        (command) =>
          (command.kind === 'BUY' || command.kind === 'SELL') &&
          command.transactionIds.includes(transactionId)
      )
      if (
        !current ||
        (current.kind !== 'BUY' && current.kind !== 'SELL') ||
        current.source.origin !== 'MANUAL' ||
        current.transactionIds.length !== 1
      )
        conflict('Only an effective single manual trade can be voided')
      await lockOwnedPosition(db, userId, operation.transaction.positionId)
      const trade = await db.transaction.findFirst({
        where: {
          id: transactionId,
          voidedAt: null,
          brokerRef: null,
          position: {
            userId,
            accountId,
            origin: 'MANUAL',
            positionType: 'LONG',
            voidedAt: null,
          },
        },
        include: {
          position: {
            include: {
              asset: { include: { exchange: true } },
              transactions: true,
            },
          },
        },
      })
      if (!trade || trade.type !== operation.kind)
        conflict('Owned manual trade not found', 404)
      const effective = trade.position.transactions.filter(
        (row) => row.voidedAt === null
      )
      if (
        effective.filter((row) => row.type === 'BUY').length !== 1 ||
        effective.some((row) => row.type !== 'BUY' && row.type !== 'SELL') ||
        trade.position.transactions.some((row) => row.brokerRef !== null)
      )
        conflict(
          'Voiding requires a reconciled manual parcel without imported allocations'
        )
      if (trade.type === 'BUY' && effective.some((row) => row.type === 'SELL'))
        conflict('Void the effective sales before voiding their acquisition')
      const replay = replayCashLedger(
        accountId,
        state.opening,
        commands.filter(
          (command) =>
            !('transactionIds' in command) ||
            !command.transactionIds.includes(transactionId)
        ),
        now
      )
      requireFundedCashLedger(replay)
      const before = executionSnapshot(trade)
      await db.transaction.update({
        where: { id: transactionId },
        data: { voidedAt: now },
      })
      await db.position.update({
        where: { id: trade.positionId },
        data: {
          ...(trade.type === 'BUY' ? { voidedAt: now, quantity: 0 } : {}),
          unrealizedPnL: null,
        },
      })
      if (!(await recomputePositionFromTransactions(trade.positionId, db)))
        conflict('Parcel not found during trade void', 404)
      const next = await readAccountOpeningPreview(
        db,
        userId,
        accountId,
        state.opening,
        new Date(`${state.sourceObservationDate}T01:00:00Z`)
      )
      const auditNumber =
        state.history.executionAudits.length + state.liveAuditEventCount + 1
      const prepared = prepareCashRevision(
        {
          idempotencyKey: input.idempotencyKey,
          expectedRevisionId: input.expectedRevisionId,
          reason: input.reason,
          replacement: null,
          voidAudit: {
            kind: trade.type,
            number: auditNumber,
            previousFingerprint: state.acceptedFingerprint,
            nextFingerprint: next.sourceFingerprint,
            input,
            before,
            voidedAt: now.toISOString(),
          },
        },
        now
      )
      const legs = prepareRevisionLegs(current, null, now)
      const revision = await db.accountCashOperationRevision.create({
        data: {
          accountId,
          operationId: operation.id,
          revisionNumber: operation.revisions.length + 1,
          previousRevisionId: latest?.id ?? null,
          idempotencyKey: input.idempotencyKey,
          payloadHash: prepared.payloadHash,
          reason: input.reason,
          request: { ...prepared.request },
          auditNumber,
          previousFingerprint: state.acceptedFingerprint,
          nextFingerprint: next.sourceFingerprint,
          transactionSnapshot: liveTradeSnapshot(trade),
          postings: {
            create: legs.map((leg, legIndex) => ({ ...leg, legIndex })),
          },
        },
        select: { id: true },
      })
      await db.accountCashLedger.update({
        where: { accountId },
        data: { acceptedSourceFingerprint: next.sourceFingerprint },
      })
      return {
        operationId: operation.id,
        revisionId: revision.id,
        created: true,
        replay,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 20000, maxWait: 5000 }
  )
}

export async function readLiveManualTradeVoids(
  userId: string,
  accountId: string,
  limit = 100,
  offset = 0
) {
  return prisma.$transaction(
    async (db) => {
      await lockOwnedTradingAccount(db, userId, accountId)
      const state = await readLiveCashState(
        db,
        userId,
        accountId,
        new Date(),
        undefined,
        true
      )
      const items = state.cashLedgerOps
        .flatMap((operation) =>
          operation.revisions.flatMap((revision) => {
            const audit = prepareCashRevision(revision.request, new Date())
              .request.voidAudit
            return audit
              ? [
                  {
                    operationId: operation.id,
                    revisionId: revision.id,
                    transactionId: audit.before.transactionId,
                    positionId: audit.before.positionId,
                    kind: audit.kind,
                    voidedAt: audit.voidedAt,
                    reason: audit.input.reason,
                    before: audit.before,
                  },
                ]
              : []
          })
        )
        .sort(
          (a, b) =>
            b.voidedAt.localeCompare(a.voidedAt) ||
            b.revisionId.localeCompare(a.revisionId)
        )
      return {
        items: items.slice(offset, offset + limit),
        total: items.length,
        limit,
        offset,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 20000, maxWait: 5000 }
  )
}

export async function correctLiveManualAcquisition(
  userId: string,
  accountId: string,
  transactionId: string,
  raw: unknown
) {
  return correctLiveManualExecution(
    userId,
    accountId,
    transactionId,
    raw,
    'BUY'
  )
}

async function correctLiveManualExecution(
  userId: string,
  accountId: string,
  transactionId: string,
  raw: unknown,
  kind: 'BUY' | 'SELL'
) {
  const acquisition = kind === 'BUY' ? parseAcquisitionCorrection(raw) : null
  const input = acquisition ?? parseSaleCorrection(raw)
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      await lockOwnedTradingAccount(db, userId, accountId)
      const state = await readLiveCashState(db, userId, accountId, now)
      const operation = state.cashLedgerOps.find(
        (row) => row.transactionId === transactionId && !row.importedEventId
      )
      if (!operation || operation.kind !== kind)
        conflict('Live manual execution operation not found', 404)

      const priorRevision = operation.revisions.find(
        (revision) => revision.idempotencyKey === input.idempotencyKey
      )
      if (priorRevision) {
        const prepared = prepareCashRevision(priorRevision.request, now)
        const audit = prepared.request.executionAudit
        if (
          prepared.payloadHash !== priorRevision.payloadHash ||
          !audit ||
          (audit.kind ?? 'SELL') !== kind ||
          executionCorrectionHash(audit.input) !==
            executionCorrectionHash(input)
        )
          conflict(
            'Idempotency key is already associated with different correction content'
          )
        const replay = replayCashLedger(
          accountId,
          state.opening,
          [
            ...[...state.history.effective.values()].filter(
              (command): command is CashCommand => command !== null
            ),
            ...state.liveCommands,
          ],
          now
        )
        requireFundedCashLedger(replay)
        return {
          operationId: operation.id,
          revisionId: priorRevision.id,
          created: false,
          replay,
        }
      }

      if (
        state.history.keys.has(input.idempotencyKey) ||
        state.cashLedgerOps.some(
          (row) =>
            row.idempotencyKey === input.idempotencyKey ||
            row.revisions.some(
              (revision) => revision.idempotencyKey === input.idempotencyKey
            )
        )
      )
        conflict('Idempotency key is already associated with a cash operation')
      if (state.liveAuditEventCount >= 50000)
        conflict('Live cash history exceeds the supported replay limit', 422)
      const latestRevision = operation.revisions.at(-1)
      const expectedRevisionId = latestRevision?.id ?? operation.id
      if (input.expectedRevisionId !== expectedRevisionId)
        conflict(
          'Cash operation was corrected concurrently. Review the current revision.'
        )
      if (input.expectedSourceFingerprint !== state.acceptedFingerprint)
        conflict(
          'Source revision changed. Refresh account history before correcting this execution.'
        )

      const current = state.liveCommands.find(
        (command) =>
          'transactionIds' in command &&
          command.kind === kind &&
          command.transactionIds.includes(transactionId)
      )
      if (
        !current ||
        !('transactionIds' in current) ||
        current.source.origin !== 'MANUAL' ||
        current.transactionIds.length !== 1
      )
        conflict('Only an effective single manual execution can be corrected')

      const candidate = await db.transaction.findFirst({
        where: {
          id: transactionId,
          type: kind,
          brokerRef: null,
          position: {
            accountId,
            userId,
            origin: 'MANUAL',
            positionType: 'LONG',
          },
        },
        select: { positionId: true },
      })
      if (!candidate)
        conflict('Owned manual execution not found or source is imported', 404)
      await lockOwnedPosition(db, userId, candidate.positionId)
      const transaction = await db.transaction.findFirst({
        where: {
          id: transactionId,
          type: kind,
          brokerRef: null,
          position: {
            accountId,
            userId,
            origin: 'MANUAL',
            positionType: 'LONG',
          },
        },
        include: {
          position: {
            include: {
              asset: { include: { exchange: true } },
              transactions: {
                where: { voidedAt: null },
                orderBy: [{ date: 'asc' }, { id: 'asc' }],
              },
            },
          },
        },
      })
      if (
        !transaction ||
        transaction.position.transactions.some((row) => row.brokerRef !== null)
      )
        conflict('Owned manual execution not found or source is imported', 404)
      const buys = transaction.position.transactions.filter(
        (row) => row.type === 'BUY'
      )
      const bought = buys.reduce(
        (sum, row) => sum.plus(String(row.quantity)),
        new AccountingDecimal(0)
      )
      const sold = transaction.position.transactions
        .filter((row) => row.type === 'SELL')
        .reduce(
          (sum, row) => sum.plus(String(row.quantity)),
          new AccountingDecimal(0)
        )
      if (
        buys.length !== 1 ||
        !bought.gt(0) ||
        sold.gt(bought) ||
        (kind === 'SELL' &&
          input.effectiveDate < sydneyCalendarDate(buys[0].date))
      )
        conflict(
          'Execution correction requires a reconciled acquisition parcel and valid acquisition date'
        )
      if (acquisition) {
        if (
          buys[0].id !== transaction.id ||
          new AccountingDecimal(acquisition.quantity).lt(sold) ||
          transaction.position.transactions.some(
            (row) =>
              row.type === 'SELL' &&
              sydneyCalendarDate(row.date) < input.effectiveDate
          )
        )
          conflict(
            'Acquisition must cover all existing sales and precede their dates'
          )
        for (const sale of transaction.position.transactions.filter(
          (row) =>
            row.type === 'SELL' &&
            sydneyCalendarDate(row.date) === input.effectiveDate
        )) {
          const cash = [
            ...state.history.effective.values(),
            ...state.liveCommands,
          ].find(
            (command) =>
              command?.kind === 'SELL' &&
              command.transactionIds.includes(sale.id)
          )
          if (
            !cash ||
            cash.effectiveDate !== input.effectiveDate ||
            cash.sequence <= input.sequence
          )
            conflict(
              'Same-day sales must be ordered after the corrected acquisition cash'
            )
        }
      } else if (input.effectiveDate === sydneyCalendarDate(buys[0].date)) {
        const acquisition = [
          ...state.history.effective.values(),
          ...state.liveCommands,
        ].find(
          (command) =>
            command?.kind === 'BUY' &&
            command.transactionIds.includes(buys[0].id)
        )
        if (
          !acquisition ||
          acquisition.effectiveDate !== input.effectiveDate ||
          acquisition.sequence >= input.sequence
        )
          conflict(
            'A same-day sale must be ordered after its effective acquisition cash'
          )
      }
      if (
        input.effectiveDate <= state.openingDate ||
        input.effectiveDate > state.sourceObservationDate
      )
        conflict(
          'Corrected execution must remain after the confirmed opening and within the reviewed observation date'
        )

      const before = executionSnapshot(transaction)
      const after: ExecutionSnapshot = {
        ...before,
        date:
          input.effectiveDate === sydneyCalendarDate(transaction.date)
            ? before.date
            : new Date(`${input.effectiveDate}T01:00:00Z`).toISOString(),
        price: input.price,
        fees: input.fees,
        quantity: acquisition?.quantity ?? before.quantity,
        totalValue: new AccountingDecimal(input.price)
          .mul(acquisition?.quantity ?? before.quantity)
          .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
          .toFixed(),
      }
      const auditNumber =
        state.history.executionAudits.length + state.liveAuditEventCount + 1
      parseExecutionAudit({
        number: auditNumber,
        previousFingerprint: state.acceptedFingerprint,
        nextFingerprint: state.acceptedFingerprint,
        input,
        before,
        after,
        ...(acquisition ? { kind: 'BUY' } : {}),
      })
      if (
        acquisition &&
        new AccountingDecimal(after.totalValue)
          .plus(after.fees)
          .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
          .gte('10000000000')
      )
        conflict(
          'Acquisition capital allocation exceeds storage precision',
          400
        )
      if (
        JSON.stringify(before) === JSON.stringify(after) &&
        current.sequence === input.sequence
      )
        conflict(
          'Correction must change the recorded execution or its stable sequence',
          400
        )

      const currentSlotIs = (row: { effectiveDate: Date; sequence: bigint }) =>
        row.effectiveDate.toISOString().slice(0, 10) ===
          current.effectiveDate && row.sequence === BigInt(current.sequence)
      const reservedSlots = [
        ...state.history.rows,
        ...state.liveReservedSlots.filter((row) => !currentSlotIs(row)),
      ]
      requireNewOperationSlot(
        reservedSlots,
        input.effectiveDate,
        input.sequence
      )
      const replacement = prepareCashCommand(
        {
          ...current,
          idempotencyKey: input.idempotencyKey,
          effectiveDate: input.effectiveDate,
          sequence: input.sequence,
          consideration: {
            currency: before.currency,
            amount: after.totalValue,
          },
          fees: new AccountingDecimal(after.fees).gt(0)
            ? [{ currency: before.currency, amount: after.fees }]
            : [],
        },
        now
      ).command
      const legs = prepareRevisionLegs(current, replacement, now)
      const commands = [
        ...[...state.history.effective.values()].filter(
          (command): command is CashCommand => command !== null
        ),
        ...state.liveCommands.map((command) =>
          'transactionIds' in command &&
          command.transactionIds.includes(transactionId)
            ? replacement
            : command
        ),
      ]
      const replay = replayCashLedger(accountId, state.opening, commands, now)
      requireFundedCashLedger(replay)

      await applyExecutionCorrection(db, before, after, kind)
      const next = await readAccountOpeningPreview(
        db,
        userId,
        accountId,
        state.opening,
        new Date(`${state.sourceObservationDate}T01:00:00Z`)
      )
      const prepared = prepareCashRevision(
        {
          idempotencyKey: input.idempotencyKey,
          expectedRevisionId: input.expectedRevisionId,
          reason: input.reason,
          replacement,
          executionAudit: {
            number: auditNumber,
            previousFingerprint: state.acceptedFingerprint,
            nextFingerprint: next.sourceFingerprint,
            input,
            before,
            after,
            ...(acquisition ? { kind: 'BUY' } : {}),
          },
        },
        now
      )
      const correctedTransaction = await db.transaction.findUniqueOrThrow({
        where: { id: transaction.id },
        include: {
          position: { include: { asset: { include: { exchange: true } } } },
        },
      })
      const revision = await db.accountCashOperationRevision.create({
        data: {
          accountId,
          operationId: operation.id,
          revisionNumber: operation.revisions.length + 1,
          previousRevisionId: latestRevision?.id ?? null,
          idempotencyKey: input.idempotencyKey,
          payloadHash: prepared.payloadHash,
          reason: input.reason,
          request: { ...prepared.request },
          auditNumber,
          previousFingerprint: state.acceptedFingerprint,
          nextFingerprint: next.sourceFingerprint,
          transactionSnapshot: liveTradeSnapshot(correctedTransaction),
          postings: {
            create: legs.map((leg, legIndex) => ({ ...leg, legIndex })),
          },
        },
        select: { id: true },
      })
      await db.accountCashLedger.update({
        where: { accountId },
        data: { acceptedSourceFingerprint: next.sourceFingerprint },
      })
      return {
        operationId: operation.id,
        revisionId: revision.id,
        created: true,
        replay,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 20000, maxWait: 5000 }
  )
}

export async function correctDraftImportedExecutionCash(
  userId: string,
  accountId: string,
  statementId: string,
  operationId: string,
  raw: unknown
) {
  return correctDraftOperation(userId, statementId, operationId, raw, false, {
    accountId,
    kind: 'IMPORT',
  })
}

function executionSnapshot(transaction: {
  id: string
  positionId: string
  date: Date
  quantity: number
  price: { toFixed(): string }
  totalValue: { toFixed(): string }
  fees: { toFixed(): string }
  position: { asset: { exchange: { currency: string } } }
}): ExecutionSnapshot {
  return {
    transactionId: transaction.id,
    positionId: transaction.positionId,
    date: transaction.date.toISOString(),
    quantity: new AccountingDecimal(String(transaction.quantity)).toFixed(),
    price: transaction.price.toFixed(),
    totalValue: transaction.totalValue.toFixed(),
    fees: transaction.fees.toFixed(),
    currency: transaction.position.asset.exchange.currency,
  }
}

async function applyExecutionCorrection(
  db: DraftCashTransaction,
  before: ExecutionSnapshot,
  after: ExecutionSnapshot,
  kind: 'BUY' | 'SELL'
) {
  if (JSON.stringify(before) === JSON.stringify(after)) return
  await db.transaction.update({
    where: { id: after.transactionId },
    data: {
      date: new Date(after.date),
      price: after.price,
      totalValue: after.totalValue,
      fees: after.fees,
      ...(kind === 'BUY' ? { quantity: Number(after.quantity) } : {}),
    },
  })
  if (kind === 'BUY') {
    await db.position.update({
      where: { id: after.positionId },
      data: {
        openDate: new Date(after.date),
        entryPrice: after.price,
        totalBuyValue: after.totalValue,
        buyFees: after.fees,
        capitalAllocated: new AccountingDecimal(after.totalValue)
          .plus(after.fees)
          .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
          .toFixed(),
        maxDrawdownPercent: null,
        maxRunUpPercent: null,
        unrealizedPnL: null,
      },
    })
  }
  if (!(await recomputePositionFromTransactions(after.positionId, db)))
    conflict('Position not found during manual execution correction', 404)
}

async function applyImportedExecutionCorrection(
  db: DraftCashTransaction,
  before: readonly ImportedExecutionTradeSnapshot[],
  after: readonly ImportedExecutionTradeSnapshot[],
  kind: 'BUY' | 'SELL'
) {
  const affectedPositions = new Set<string>()
  for (const snapshot of after) {
    await db.transaction.update({
      where: { id: snapshot.transactionId },
      data: {
        date: new Date(snapshot.date),
        price: snapshot.price,
        totalValue: snapshot.totalValue,
        fees: snapshot.fees,
      },
    })
    affectedPositions.add(snapshot.positionId)
  }
  if (kind === 'BUY') {
    const original = before[0]
    const replacement = after.find(
      (snapshot) => snapshot.transactionId === original?.transactionId
    )
    if (!replacement)
      conflict('Imported acquisition correction lost its transaction')
    await db.position.update({
      where: { id: replacement.positionId },
      data: {
        openDate: new Date(replacement.date),
        entryPrice: replacement.price,
        totalBuyValue: replacement.totalValue,
        buyFees: replacement.fees,
        capitalAllocated: new AccountingDecimal(replacement.totalValue)
          .plus(replacement.fees)
          .toDecimalPlaces(8, AccountingDecimal.ROUND_HALF_UP)
          .toFixed(),
        maxDrawdownPercent: null,
        maxRunUpPercent: null,
        unrealizedPnL: null,
      },
    })
  }
  for (const positionId of [...affectedPositions].sort()) {
    if (!(await recomputePositionFromTransactions(positionId, db)))
      conflict('Imported execution correction could not recompute its parcel')
  }
}

export async function correctLiveImportedExecution(
  userId: string,
  accountId: string,
  eventId: string,
  raw: unknown
) {
  const input = parseImportedExecutionCorrectionInput(raw)
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      await lockOwnedTradingAccount(db, userId, accountId)
      const state = await readLiveCashState(db, userId, accountId, now)
      const operation = state.cashLedgerOps.find(
        (row) => row.importedEventId === eventId
      )
      if (!operation || (operation.kind !== 'BUY' && operation.kind !== 'SELL'))
        conflict('Live imported execution operation not found', 404)
      const priorRevision = operation.revisions.find(
        (revision) => revision.idempotencyKey === input.idempotencyKey
      )
      if (priorRevision) {
        const prepared = prepareCashRevision(priorRevision.request, now)
        const audit = prepared.request.importedExecutionAudit
        if (
          prepared.payloadHash !== priorRevision.payloadHash ||
          !audit ||
          audit.eventId !== eventId ||
          importedExecutionCorrectionHash(audit.input) !==
            importedExecutionCorrectionHash(input)
        )
          conflict(
            'Idempotency key is already associated with different imported correction content'
          )
        const replay = replayCashLedger(
          accountId,
          state.opening,
          [
            ...[...state.history.effective.values()].filter(
              (command): command is CashCommand => command !== null
            ),
            ...state.liveCommands,
          ],
          now
        )
        requireFundedCashLedger(replay)
        return {
          operationId: operation.id,
          revisionId: priorRevision.id,
          created: false,
          replay,
        }
      }
      if (
        state.history.keys.has(input.idempotencyKey) ||
        state.cashLedgerOps.some(
          (row) =>
            row.idempotencyKey === input.idempotencyKey ||
            row.revisions.some(
              (revision) => revision.idempotencyKey === input.idempotencyKey
            )
        )
      )
        conflict('Idempotency key is already associated with a cash operation')
      if (state.liveAuditEventCount >= 50000)
        conflict('Live cash history exceeds the supported replay limit', 422)
      const latestRevision = operation.revisions.at(-1)
      const expectedRevisionId = latestRevision?.id ?? operation.id
      if (input.expectedRevisionId !== expectedRevisionId)
        conflict(
          'Cash operation was corrected concurrently. Review the current revision.'
        )
      if (input.expectedSourceFingerprint !== state.acceptedFingerprint)
        conflict(
          'Source revision changed. Refresh account history before correcting this execution.'
        )

      const event = await db.importedEvent.findFirst({
        where: {
          id: eventId,
          userId,
          source: 'KRAKEN',
          status: 'APPLIED',
          kind: operation.kind,
          batch: { userId, accountId },
        },
        select: {
          id: true,
          userId: true,
          source: true,
          externalId: true,
          kind: true,
          status: true,
          occurredAt: true,
          quoteCurrency: true,
          grossValue: true,
          fee: true,
          feeCurrency: true,
          appliedPositionIds: true,
          batch: { select: { accountId: true, userId: true } },
        },
      })
      if (!event)
        conflict('Applied imported execution not found in this account', 404)
      const current = state.liveCommands.find(
        (command) =>
          command.source.origin === 'IMPORT' &&
          command.source.reference === event.externalId
      )
      if (
        !current ||
        current.kind !== operation.kind ||
        current.transactionIds.length === 0 ||
        !current.transactionIds.includes(operation.transactionId)
      )
        conflict('Imported cash operation has inconsistent source links')
      if (
        !event.quoteCurrency ||
        !isAccountingCurrency(event.quoteCurrency) ||
        (event.fee.toFixed() !== '0' &&
          event.feeCurrency !== event.quoteCurrency)
      )
        conflict(
          'Imported execution correction requires consideration and fees in the same currency'
        )
      if (
        input.effectiveDate <= state.openingDate ||
        input.effectiveDate > state.sourceObservationDate
      )
        conflict(
          'Imported execution correction must stay after opening and within the reviewed observation date',
          400
        )

      const transactions = await db.transaction.findMany({
        where: {
          brokerRef: event.externalId,
          position: { accountId, userId },
        },
        include: {
          position: {
            include: {
              asset: { include: { exchange: true } },
              transactions: {
                where: { voidedAt: null },
                orderBy: [{ date: 'asc' }, { id: 'asc' }],
              },
            },
          },
        },
        orderBy: { id: 'asc' },
      })
      if (
        transactions.length !== current.transactionIds.length ||
        JSON.stringify(transactions.map((transaction) => transaction.id)) !==
          JSON.stringify([...current.transactionIds].sort()) ||
        transactions.some(
          (transaction) =>
            transaction.type !== operation.kind ||
            transaction.position.positionType !== 'LONG' ||
            transaction.position.asset.exchange.currency !== event.quoteCurrency
        )
      )
        conflict(
          'Imported execution has changed parcel links or unsupported currency allocations'
        )
      for (const positionId of [
        ...new Set(transactions.map((transaction) => transaction.positionId)),
      ].sort()) {
        await lockOwnedPosition(db, userId, positionId)
      }
      const before = transactions
        .map(executionSnapshot)
        .sort((left, right) =>
          left.transactionId.localeCompare(right.transactionId)
        )
      const after = correctImportedExecutionSnapshots(
        before,
        input.price,
        input.fees,
        input.effectiveDate
      )
      if (
        before.every(
          (snapshot, index) =>
            JSON.stringify(snapshot) === JSON.stringify(after[index])
        ) &&
        current.effectiveDate === input.effectiveDate &&
        current.sequence === input.sequence
      )
        conflict(
          'Correction must change the imported execution or its stable sequence',
          400
        )

      for (const transaction of transactions) {
        const positionTransactions = transaction.position.transactions
        const acquired = positionTransactions.filter(
          (row) => row.type === 'BUY'
        )
        if (
          acquired.length !== 1 ||
          (operation.kind === 'BUY' && acquired[0]?.id !== transaction.id)
        )
          conflict(
            'Imported correction requires one reconciled acquisition per parcel'
          )
        const sameDayTrades = positionTransactions.filter(
          (row) => row.id !== transaction.id && row.type !== transaction.type
        )
        for (const related of sameDayTrades) {
          const relatedCommand = state.liveCommands.find(
            (command) =>
              'transactionIds' in command &&
              command.transactionIds.includes(related.id)
          )
          const relatedDate = sydneyCalendarDate(related.date)
          if (operation.kind === 'BUY') {
            if (relatedDate < input.effectiveDate)
              conflict(
                'Imported acquisition cannot move after an existing disposal',
                400
              )
            if (
              relatedDate === input.effectiveDate &&
              (!relatedCommand || relatedCommand.sequence <= input.sequence)
            )
              conflict(
                'Same-day imported acquisitions must precede their disposals in cash sequence',
                400
              )
          } else {
            if (relatedDate > input.effectiveDate)
              conflict('Imported disposal cannot precede its acquisition', 400)
            if (
              relatedDate === input.effectiveDate &&
              (!relatedCommand || relatedCommand.sequence >= input.sequence)
            )
              conflict(
                'Same-day imported disposals must follow their acquisitions in cash sequence',
                400
              )
          }
        }
      }

      const replacementGross = after.reduce(
        (sum, snapshot) => sum.plus(snapshot.totalValue),
        new AccountingDecimal(0)
      )
      const replacementFees = after.reduce(
        (sum, snapshot) => sum.plus(snapshot.fees),
        new AccountingDecimal(0)
      )
      const replacement = prepareCashCommand(
        {
          ...current,
          idempotencyKey: input.idempotencyKey,
          effectiveDate: input.effectiveDate,
          sequence: input.sequence,
          consideration: {
            currency: event.quoteCurrency,
            amount: replacementGross.toFixed(),
          },
          fees: replacementFees.gt(0)
            ? [
                {
                  currency: event.quoteCurrency,
                  amount: replacementFees.toFixed(),
                },
              ]
            : [],
        },
        now
      ).command
      const currentSlotIs = (slot: { effectiveDate: Date; sequence: bigint }) =>
        slot.effectiveDate.toISOString().slice(0, 10) ===
          current.effectiveDate && slot.sequence === BigInt(current.sequence)
      requireNewOperationSlot(
        [
          ...state.history.rows,
          ...state.liveReservedSlots.filter((slot) => !currentSlotIs(slot)),
        ],
        replacement.effectiveDate,
        replacement.sequence
      )
      const legs = prepareRevisionLegs(current, replacement, now)
      const commands = [
        ...[...state.history.effective.values()].filter(
          (command): command is CashCommand => command !== null
        ),
        ...state.liveCommands.map((command) =>
          command.source.origin === 'IMPORT' &&
          command.source.reference === event.externalId
            ? replacement
            : command
        ),
      ]
      const replay = replayCashLedger(accountId, state.opening, commands, now)
      requireFundedCashLedger(replay)

      await applyImportedExecutionCorrection(db, before, after, operation.kind)
      const next = await readAccountOpeningPreview(
        db,
        userId,
        accountId,
        state.opening,
        new Date(`${state.sourceObservationDate}T01:00:00Z`)
      )
      const auditNumber =
        state.history.executionAudits.length + state.liveAuditEventCount + 1
      const request = prepareCashRevision(
        {
          idempotencyKey: input.idempotencyKey,
          expectedRevisionId: input.expectedRevisionId,
          reason: input.reason,
          replacement,
          importedExecutionAudit: {
            eventId,
            number: auditNumber,
            previousFingerprint: state.acceptedFingerprint,
            nextFingerprint: next.sourceFingerprint,
            input,
            before,
            after,
          },
        },
        now
      )
      const revision = await db.accountCashOperationRevision.create({
        data: {
          accountId,
          operationId: operation.id,
          revisionNumber: operation.revisions.length + 1,
          previousRevisionId: latestRevision?.id ?? null,
          idempotencyKey: input.idempotencyKey,
          payloadHash: request.payloadHash,
          reason: input.reason,
          request: { ...request.request },
          auditNumber,
          previousFingerprint: state.acceptedFingerprint,
          nextFingerprint: next.sourceFingerprint,
          transactionSnapshot: after,
          postings: {
            create: legs.map((leg, legIndex) => ({ ...leg, legIndex })),
          },
        },
        select: { id: true },
      })
      await db.accountCashLedger.update({
        where: { accountId },
        data: { acceptedSourceFingerprint: next.sourceFingerprint },
      })
      return {
        operationId: operation.id,
        revisionId: revision.id,
        created: true,
        replay,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 20000, maxWait: 5000 }
  )
}

export async function correctDraftRecordedSale(
  userId: string,
  accountId: string,
  statementId: string,
  operationId: string,
  raw: unknown
) {
  return correctDraftRecordedExecution(
    userId,
    accountId,
    statementId,
    operationId,
    raw,
    'SELL'
  )
}

export async function correctDraftRecordedAcquisition(
  userId: string,
  accountId: string,
  statementId: string,
  operationId: string,
  raw: unknown
) {
  return correctDraftRecordedExecution(
    userId,
    accountId,
    statementId,
    operationId,
    raw,
    'BUY'
  )
}

async function correctDraftRecordedExecution(
  userId: string,
  accountId: string,
  statementId: string,
  operationId: string,
  raw: unknown,
  kind: 'BUY' | 'SELL'
) {
  const acquisition = kind === 'BUY' ? parseAcquisitionCorrection(raw) : null
  const input = acquisition ?? parseSaleCorrection(raw)
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      let statement = await readStatement(db, userId, statementId)
      if (statement.accountId !== accountId)
        conflict('Opening statement not found for this account', 404)
      await lockOwnedTradingAccount(db, userId, accountId)
      statement = await readStatement(db, userId, statementId)
      if (statement.accountId !== accountId)
        conflict('Opening statement not found for this account', 404)
      if (statement.account.status !== 'ACTIVE' || statement.account.isDemo)
        conflict(
          'Manual execution corrections require an active real trading account'
        )
      const opening = {
        openingDate: statement.openingDate.toISOString().slice(0, 10),
        cashBalances: statement.cashBalances.map((row) => ({
          currency: row.currency,
          amount: row.amount.toFixed(),
        })),
      }
      const history = await readCashHistory(
        db,
        userId,
        statementId,
        accountId,
        opening.openingDate,
        now,
        statement.openingParcels,
        statement.sourceFingerprint
      )
      const operation = history.rows.find((row) => row.id === operationId)
      if (
        !operation ||
        operation.proposedTrade ||
        operation.kind !== kind ||
        operation.sourceOrigin !== 'MANUAL'
      )
        conflict('Recorded manual execution cash operation not found', 404)
      const prior = history.rows
        .flatMap((row) => row.revisions)
        .find((row) => row.idempotencyKey === input.idempotencyKey)
      if (prior) {
        const audit = prepareCashRevision(prior.request, now).request
          .executionAudit
        if (
          prior.operationId !== operationId ||
          !audit ||
          (audit.kind ?? 'SELL') !== kind ||
          executionCorrectionHash(audit.input) !==
            executionCorrectionHash(input)
        )
          conflict(
            'Idempotency key is already associated with different correction content'
          )
        const replay = replayCashLedger(
          accountId,
          opening,
          [...history.effective.values()].filter((command) => command !== null),
          now
        )
        requireFundedCashLedger(replay)
        return {
          operationId,
          revisionId: prior.id,
          state: 'DRAFT' as const,
          created: false,
          replay,
        }
      }
      if (history.keys.has(input.idempotencyKey))
        conflict('Idempotency key is already associated with a cash operation')
      const latest = operation.revisions.at(-1)
      if ((latest?.id ?? operationId) !== input.expectedRevisionId)
        conflict(
          'Cash operation was corrected concurrently. Review the current revision.'
        )
      const current = history.effective.get(operationId)
      if (
        !current ||
        current.kind !== kind ||
        current.source.origin !== 'MANUAL' ||
        current.transactionIds.length !== 1
      )
        conflict('Only an effective single manual execution can be corrected')
      const accepted = continuedSourceFingerprint(
        statement.sourceFingerprint,
        history.executionAudits
      )
      if (accepted !== input.expectedSourceFingerprint)
        conflict(
          'Source revision changed. Refresh reconciliation before correcting this execution.'
        )
      await verifyStatementSource(db, userId, statement, history)
      await validateTrade(db, userId, current)
      const transaction = await db.transaction.findFirst({
        where: {
          id: current.transactionIds[0],
          type: kind,
          brokerRef: null,
          position: {
            accountId,
            userId,
            origin: 'MANUAL',
            positionType: 'LONG',
          },
        },
        include: {
          position: {
            include: {
              asset: { include: { exchange: true } },
              transactions: { where: { voidedAt: null } },
            },
          },
        },
      })
      if (!transaction)
        conflict('Owned manual execution not found or source is imported', 404)
      await lockOwnedPosition(db, userId, transaction.positionId)
      const buys = transaction.position.transactions.filter(
        (row) => row.type === 'BUY'
      )
      const bought = buys.reduce(
        (sum, row) => sum.plus(String(row.quantity)),
        new AccountingDecimal(0)
      )
      const sold = transaction.position.transactions
        .filter((row) => row.type === 'SELL')
        .reduce(
          (sum, row) => sum.plus(String(row.quantity)),
          new AccountingDecimal(0)
        )
      if (
        buys.length !== 1 ||
        !bought.gt(0) ||
        sold.gt(bought) ||
        (kind === 'SELL' &&
          input.effectiveDate < sydneyCalendarDate(buys[0].date))
      )
        conflict(
          'Execution correction requires a reconciled acquisition parcel and valid acquisition date'
        )
      if (acquisition) {
        const sameDaySales = transaction.position.transactions.filter(
          (row) =>
            row.type === 'SELL' &&
            sydneyCalendarDate(row.date) === input.effectiveDate
        )
        for (const sale of sameDaySales) {
          const cash = [...history.effective.values()].find(
            (command) =>
              command?.kind === 'SELL' &&
              command.transactionIds.includes(sale.id)
          )
          if (
            !cash ||
            cash.effectiveDate !== input.effectiveDate ||
            cash.sequence <= input.sequence
          )
            conflict(
              'Same-day sales must have effective draft cash ordered after the corrected acquisition. Stage or resequence those sales first.'
            )
        }
        if (
          buys[0].id !== transaction.id ||
          transaction.position.transactions.some(
            (row) =>
              row.type === 'SELL' &&
              (row.brokerRef !== null ||
                sydneyCalendarDate(row.date) < input.effectiveDate)
          ) ||
          new AccountingDecimal(acquisition.quantity).lt(sold)
        )
          conflict(
            'Acquisition must cover all existing sales, precede their dates and have no imported sale allocations'
          )
      } else if (input.effectiveDate === sydneyCalendarDate(buys[0].date)) {
        const acquisitionCash = [...history.effective.values()].find(
          (command) =>
            command?.kind === 'BUY' &&
            command.transactionIds.includes(buys[0].id)
        )
        if (
          !acquisitionCash ||
          acquisitionCash.effectiveDate !== input.effectiveDate ||
          acquisitionCash.sequence >= input.sequence
        )
          conflict(
            'A same-day sale must be ordered after its effective acquisition cash'
          )
      }
      const snapshot = statement.previewSnapshot
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        Array.isArray(snapshot) ||
        !('asOfDate' in snapshot) ||
        !isAccountingDate(snapshot.asOfDate)
      )
        conflict('Opening draft has no valid source observation date')
      if (
        input.effectiveDate <= opening.openingDate ||
        input.effectiveDate > snapshot.asOfDate
      )
        conflict(
          'Corrected execution must remain after the opening boundary and within the reviewed observation date'
        )
      const before = executionSnapshot(transaction)
      const after: ExecutionSnapshot = {
        ...before,
        date:
          input.effectiveDate === sydneyCalendarDate(transaction.date)
            ? before.date
            : new Date(`${input.effectiveDate}T01:00:00Z`).toISOString(),
        price: input.price,
        fees: input.fees,
        quantity: acquisition?.quantity ?? before.quantity,
        totalValue: new AccountingDecimal(input.price)
          .mul(acquisition?.quantity ?? before.quantity)
          .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
          .toFixed(),
      }
      parseExecutionAudit({
        number: history.executionAudits.length + 1,
        previousFingerprint: accepted,
        nextFingerprint: accepted,
        input,
        before,
        after,
        ...(acquisition ? { kind: 'BUY' } : {}),
      })
      if (
        kind === 'BUY' &&
        new AccountingDecimal(after.totalValue)
          .plus(after.fees)
          .toDecimalPlaces(2, AccountingDecimal.ROUND_HALF_UP)
          .gte('10000000000')
      )
        conflict(
          'Acquisition capital allocation exceeds storage precision',
          400
        )
      if (
        JSON.stringify(before) === JSON.stringify(after) &&
        current.sequence === input.sequence
      )
        conflict(
          'Correction must change the recorded execution or its stable sequence',
          400
        )
      const replacement = prepareCashCommand(
        {
          ...current,
          idempotencyKey: input.idempotencyKey,
          effectiveDate: input.effectiveDate,
          sequence: input.sequence,
          consideration: {
            currency: before.currency,
            amount: after.totalValue,
          },
          fees: new AccountingDecimal(after.fees).gt(0)
            ? [{ currency: before.currency, amount: after.fees }]
            : [],
        },
        now
      ).command
      const legs = prepareRevisionLegs(current, replacement, now)
      if (
        history.postingCount + legs.length > 100000 ||
        history.rows.length + history.revisionCount >= 50000
      )
        conflict('Draft cash history exceeds supported audit limits', 422)
      history.effective.set(operationId, replacement)
      const replay = replayCashLedger(
        accountId,
        opening,
        [...history.effective.values()].filter((command) => command !== null),
        now
      )
      requireFundedCashLedger(replay)
      await applyExecutionCorrection(db, before, after, kind)
      const next = await readAccountOpeningPreview(
        db,
        userId,
        accountId,
        opening,
        new Date(`${snapshot.asOfDate}T01:00:00Z`)
      )
      const prepared = prepareCashRevision(
        {
          idempotencyKey: input.idempotencyKey,
          expectedRevisionId: input.expectedRevisionId,
          reason: input.reason,
          replacement,
          executionAudit: {
            number: history.executionAudits.length + 1,
            previousFingerprint: accepted,
            nextFingerprint: next.sourceFingerprint,
            input,
            before,
            after,
            ...(acquisition ? { kind: 'BUY' } : {}),
          },
        },
        now
      )
      const revision = await db.draftCashRevision.create({
        data: {
          statementId,
          operationId,
          revisionNumber: operation.revisions.length + 1,
          previousRevisionId: latest?.id ?? null,
          idempotencyKey: input.idempotencyKey,
          payloadHash: prepared.payloadHash,
          reason: input.reason,
          request: { ...prepared.request },
          postings: {
            create: legs.map((leg, legIndex) => ({ ...leg, legIndex })),
          },
        },
        select: { id: true },
      })
      return {
        operationId,
        revisionId: revision.id,
        state: 'DRAFT' as const,
        created: true,
        replay,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}

async function correctDraftOperation(
  userId: string,
  statementId: string,
  operationId: string,
  raw: unknown,
  tradeCorrection: boolean,
  reviewScope?: { accountId: string; kind: 'CAPITAL' | 'IMPORT' }
) {
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      let statement = await readStatement(db, userId, statementId)
      if (reviewScope && statement.accountId !== reviewScope.accountId)
        conflict('Opening statement not found for this account', 404)
      await lockOwnedTradingAccount(db, userId, statement.accountId)
      statement = await readStatement(db, userId, statementId)
      if (reviewScope && statement.accountId !== reviewScope.accountId)
        conflict('Opening statement not found for this account', 404)
      if (statement.account.status !== 'ACTIVE' || statement.account.isDemo)
        conflict(
          'Draft cash corrections require an active real trading account'
        )
      const opening = {
        openingDate: statement.openingDate.toISOString().slice(0, 10),
        cashBalances: statement.cashBalances.map((row) => ({
          currency: row.currency,
          amount: row.amount.toFixed(),
        })),
      }
      const history = await readCashHistory(
        db,
        userId,
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels,
        statement.sourceFingerprint
      )
      const operation = history.rows.find((row) => row.id === operationId)
      if (!operation)
        conflict('Cash operation not found in this opening statement', 404)
      if (operation.sourceOrigin === 'IMPORT' && reviewScope?.kind !== 'IMPORT')
        conflict(
          'Imported execution cash corrections require a source-aware import workflow'
        )
      if (tradeCorrection && !operation.proposedTrade)
        conflict(
          'Only isolated proposed trades can use draft trade corrections'
        )
      const prepared = reviewScope
        ? (reviewScope.kind === 'IMPORT'
            ? prepareImportedCashRevision
            : prepareCapitalCashRevision)(
            raw,
            prepareCashCommand(operation.command, now).command,
            now
          )
        : tradeCorrection && operation.proposedTrade
          ? prepareDraftTradeRevision(raw, operation.proposedTrade.id, now)
          : prepareCashRevision(raw, now)
      if (prepared.request.voidAudit)
        conflict(
          'Manual trade voids require the dedicated live trade void writer',
          400
        )
      const prior = history.rows
        .flatMap((row) => row.revisions)
        .find(
          (revision) =>
            revision.idempotencyKey === prepared.request.idempotencyKey
        )
      if (prior) {
        if (
          prior.operationId !== operationId ||
          prior.payloadHash !== prepared.payloadHash
        )
          conflict(
            'Idempotency key is already associated with different correction content'
          )
        const replay = replayCashLedger(
          statement.accountId,
          opening,
          [...history.effective.values()].filter((command) => command !== null),
          now
        )
        requireFundedCashLedger(replay)
        return {
          operationId,
          revisionId: prior.id,
          state: 'DRAFT' as const,
          created: false,
          replay,
          parcels: history.parcels,
        }
      }
      if (history.keys.has(prepared.request.idempotencyKey))
        conflict('Idempotency key is already associated with a cash operation')
      const latest = operation.revisions.at(-1)
      if (prepared.request.expectedRevisionId !== (latest?.id ?? operationId))
        conflict(
          'Cash operation was corrected concurrently. Review the current revision.'
        )
      const current = history.effective.get(operationId)
      if (!current) conflict('A reversed operation cannot be corrected again')
      if (
        !tradeCorrection &&
        reviewScope?.kind !== 'IMPORT' &&
        (current.kind === 'BUY' || current.kind === 'SELL')
      )
        conflict(
          'Trade corrections require atomic parcel and cash posting integration and are not enabled'
        )
      const legs = prepareRevisionLegs(
        current,
        prepared.request.replacement,
        now
      )
      let proposedTrades = history.proposedTrades
      if (tradeCorrection && operation.proposedTrade) {
        const original = prepareDraftTradeRequest(
          operation.proposedTrade.request,
          now
        ).request
        const next = prepared.request.proposedTrade
        if (next) requireSameDraftTradeIdentity(original, next)
        proposedTrades = history.proposedTrades.filter(
          (trade) => trade.id !== operation.proposedTrade?.id
        )
        if (next)
          proposedTrades.push({
            id: operation.proposedTrade.id,
            parcelKey: operation.proposedTrade.parcelKey,
            request: next,
          })
      }
      const parcels = replayDraftTradeParcels(
        proposedTrades,
        statement.openingParcels
      )
      if (
        history.postingCount + legs.length > 100000 ||
        history.rows.length + history.revisionCount >= 50000
      )
        conflict(
          'Draft cash history exceeds the supported audit replay limits',
          422
        )
      await verifyStatementSource(db, userId, statement, history)
      history.effective.set(operationId, prepared.request.replacement)
      // Restate the economic timeline; reversing a funding deposit "today" cannot hide an earlier deficit.
      const replay = replayCashLedger(
        statement.accountId,
        opening,
        [...history.effective.values()].filter((command) => command !== null),
        now
      )
      requireFundedCashLedger(replay)
      const revision = await db.draftCashRevision.create({
        data: {
          statementId,
          operationId,
          revisionNumber: operation.revisions.length + 1,
          previousRevisionId: latest?.id ?? null,
          idempotencyKey: prepared.request.idempotencyKey,
          payloadHash: prepared.payloadHash,
          reason: prepared.request.reason,
          request: { ...prepared.request },
          postings: {
            create: legs.map((leg, legIndex) => ({ ...leg, legIndex })),
          },
        },
        select: { id: true },
      })
      return {
        operationId,
        revisionId: revision.id,
        state: 'DRAFT' as const,
        created: true,
        replay,
        parcels,
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}
