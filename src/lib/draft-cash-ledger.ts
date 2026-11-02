import { prisma } from './prisma.js'
import { lockOwnedTradingAccount } from './account-lock.js'
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
  prepareCashRevision,
  prepareRevisionLegs,
  prepareDraftTradeRevision,
} from './cash-revisions.js'
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

type DraftDb = Pick<typeof prisma, 'accountOpeningStatement' | 'transaction'>
type HistoryDb = Pick<
  typeof prisma,
  | 'draftCashOperation'
  | 'draftOperationTradeLink'
  | 'draftCashPosting'
  | 'draftCashRevision'
  | 'draftCashRevisionPosting'
  | 'draftCashEvidence'
>

async function readCashHistory(
  db: HistoryDb,
  statementId: string,
  accountId: string,
  openingDate: string,
  now: Date,
  openingParcels: readonly DraftOpeningParcel[]
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
      command.source.origin !== 'MANUAL' ||
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
  }
}

async function readStatement(db: DraftDb, userId: string, statementId: string) {
  const statement = await db.accountOpeningStatement.findFirst({
    where: { id: statementId, account: { userId, user: { deletedAt: null } } },
    include: {
      cashBalances: { orderBy: { currency: 'asc' } },
      parcels: { orderBy: { positionId: 'asc' }, take: 5001 },
      account: { select: { id: true, status: true, isDemo: true } },
    },
  })
  if (!statement) conflict('Opening statement not found', 404)
  if (statement.state !== 'DRAFT' || statement.timezone !== 'Australia/Sydney')
    conflict(
      'Only inactive Sydney opening drafts can hold staged cash operations'
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
  statement: Awaited<ReturnType<typeof readStatement>>
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
  if (sourcePreview.sourceFingerprint !== statement.sourceFingerprint)
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
export async function saveDraftCashOperation(
  userId: string,
  statementId: string,
  raw: unknown
) {
  const now = new Date()
  const prepared = prepareCashCommand(raw, now)
  if (prepared.command.source.reference.startsWith('draft-trade:'))
    conflict('Proposed trades require the atomic draft trade writer')
  if (prepared.command.source.origin !== 'MANUAL')
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
      const history = await readCashHistory(
        db,
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels
      )
      const { rows } = history
      const prior = rows.find(
        (row) => row.idempotencyKey === prepared.command.idempotencyKey
      )
      const retry = resolveCashCommandRetry(
        prepared,
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
      if (
        history.postingCount + prepared.legs.length > 100000 ||
        rows.length + history.revisionCount >= 50000
      )
        conflict(
          'Draft cash history exceeds the supported audit replay limits',
          422
        )
      await verifyStatementSource(db, userId, statement)
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
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels
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
          idempotencyKey: current?.idempotencyKey ?? original.idempotencyKey,
          kind: displayed.kind,
          effectiveDate: displayed.effectiveDate,
          sequence: displayed.sequence,
          sourceOrigin: original.source.origin,
          sourceReference: original.source.reference,
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
      const sourceChanged =
        originalDatePreview.sourceFingerprint !== statement.sourceFingerprint
      const transactions = await db.transaction.findMany({
        where: { position: { accountId: statement.accountId, userId } },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        take: 50001,
        select: {
          id: true,
          positionId: true,
          type: true,
          date: true,
          quantity: true,
        },
      })
      if (transactions.length > 50000)
        conflict(
          'Reconciliation exceeds the supported transaction limit; no partial report was generated',
          422
        )
      const linked = new Map<string, (typeof history.rows)[number]>()
      for (const row of history.rows) {
        if (!row.proposedTrade)
          for (const link of row.tradeLinks) linked.set(link.transactionId, row)
      }
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
          currentFingerprint: originalDatePreview.sourceFingerprint,
          changed: sourceChanged,
        },
        cash: { verification: 'UNVERIFIED' as const, ...replay },
        cashOperations,
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
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels
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
      await verifyStatementSource(db, userId, statement)
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
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels
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
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels
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
      await verifyStatementSource(db, userId, statement)
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

async function correctDraftOperation(
  userId: string,
  statementId: string,
  operationId: string,
  raw: unknown,
  tradeCorrection: boolean
) {
  const now = new Date()
  return prisma.$transaction(
    async (db) => {
      let statement = await readStatement(db, userId, statementId)
      await lockOwnedTradingAccount(db, userId, statement.accountId)
      statement = await readStatement(db, userId, statementId)
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
        statementId,
        statement.accountId,
        opening.openingDate,
        now,
        statement.openingParcels
      )
      const operation = history.rows.find((row) => row.id === operationId)
      if (!operation)
        conflict('Cash operation not found in this opening statement', 404)
      if (tradeCorrection && !operation.proposedTrade)
        conflict(
          'Only isolated proposed trades can use draft trade corrections'
        )
      const prepared =
        tradeCorrection && operation.proposedTrade
          ? prepareDraftTradeRevision(raw, operation.proposedTrade.id, now)
          : prepareCashRevision(raw, now)
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
      await verifyStatementSource(db, userId, statement)
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
