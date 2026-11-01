import { prisma } from './prisma.js'
import { lockOwnedTradingAccount } from './account-lock.js'
import { createHash } from 'node:crypto'
import { AccountingDecimal, isAccountingDate } from './accounting-values.js'
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
import { prepareCashRevision, prepareRevisionLegs } from './cash-revisions.js'

function conflict(message: string, status = 409): never {
  throw Object.assign(new Error(message), {
    status,
    name: status === 404 ? 'Not Found' : 'Accounting Conflict',
  })
}

type DraftDb = Pick<typeof prisma, 'accountOpeningStatement' | 'transaction'>
type HistoryDb = Pick<
  typeof prisma,
  | 'draftCashOperation'
  | 'draftOperationTradeLink'
  | 'draftCashPosting'
  | 'draftCashRevision'
  | 'draftCashRevisionPosting'
>

async function readCashHistory(
  db: HistoryDb,
  statementId: string,
  accountId: string,
  openingDate: string,
  now: Date
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
    },
  })
  if (rows.length + revisionCount > 50000)
    conflict('Draft cash history exceeds the supported replay limit', 422)
  const keys = new Set<string>()
  const sources = new Set<string>()
  const transactions = new Set<string>()
  const effective = new Map<string, CashCommand | null>()
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
    let current: CashCommand | null = command
    let previousId = row.id
    for (const [index, revision] of row.revisions.entries()) {
      if (!current)
        conflict('A reversed operation cannot have further corrections')
      const prepared = prepareCashRevision(revision.request, now)
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
    effective.set(row.id, current)
  }
  return {
    rows,
    effective,
    keys,
    postingCount: postingCount + revisionPostingCount,
    revisionCount,
  }
}

async function readStatement(db: DraftDb, userId: string, statementId: string) {
  const statement = await db.accountOpeningStatement.findFirst({
    where: { id: statementId, account: { userId, user: { deletedAt: null } } },
    include: {
      cashBalances: { orderBy: { currency: 'asc' } },
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
  return statement
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
}

/** Internal staging only: never posts spendable cash or mutates a live trade. */
export async function saveDraftCashOperation(
  userId: string,
  statementId: string,
  raw: unknown
) {
  const now = new Date()
  const prepared = prepareCashCommand(raw, now)
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
        now
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

/** Internal inactive capital corrections; trade corrections await atomic trade/posting integration. */
export async function correctDraftCashOperation(
  userId: string,
  statementId: string,
  operationId: string,
  raw: unknown
) {
  const now = new Date()
  const prepared = prepareCashRevision(raw, now)
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
        now
      )
      const operation = history.rows.find((row) => row.id === operationId)
      if (!operation)
        conflict('Cash operation not found in this opening statement', 404)
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
      if (current.kind === 'BUY' || current.kind === 'SELL')
        conflict(
          'Trade corrections require atomic parcel and cash posting integration and are not enabled'
        )
      const legs = prepareRevisionLegs(
        current,
        prepared.request.replacement,
        now
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
      }
    },
    { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }
  )
}
