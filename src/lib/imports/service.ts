import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { lockOwnedTradingAccount } from '../account-lock.js'
import { savePositionHistory } from '../position-derived-values.js'
import Decimal from './decimal.js'
import { getHistoricalFxRateToAud } from '../fx-rates.js'
import { getCryptoDailyCloses } from '../crypto/pricing.js'
import { exchangeCodeFor, type CryptoVenue } from '../crypto/venues.js'
import {
  findOrCreateAsset,
  recomputePositionFromTransactions,
} from '../position-service.js'
import { beginLiveImportPosting } from '../draft-cash-ledger.js'
import {
  fetchHistoricalMaxDrawdown,
  fetchHistoricalMaxRunUp,
} from '../historical-drawdown.js'
import { ImportParseError, parseKrakenCsv } from './adapters/kraken-csv.js'
import { buildPlan, sydneyDate, sydneyDateKey } from './planner.js'
import type {
  EventResolution,
  ExistingParcel,
  ImportPlan,
  ImportSourceName,
  NormalizedEvent,
  PlannerEvent,
} from './types.js'

export class ImportError extends Error {
  status: number
  details?: unknown

  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.name = status === 409 ? 'Conflict' : 'Bad Request'
    this.status = status
    this.details = details
  }
}

export interface UploadedFile {
  kind: 'trades' | 'ledgers'
  fileName: string
  content: string
}

const SOURCE_VENUE: Record<ImportSourceName, CryptoVenue> = {
  KRAKEN: 'KRAKEN',
  BINANCE: 'BINANCE',
  COINBASE: 'COINBASE',
}

type ImportDb = Pick<
  typeof prisma,
  'importBatch' | 'importedEvent' | 'position'
>
const transactionOptions = {
  isolationLevel: 'ReadCommitted' as const,
  timeout: 120_000,
  maxWait: 10_000,
}

async function lockImportAccount(
  tx: Pick<typeof prisma, '$queryRaw' | 'tradingAccount'>,
  userId: string,
  accountId: string
) {
  await lockOwnedTradingAccount(tx, userId, accountId)
  const account = await tx.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: { isDemo: true, status: true },
  })
  if (!account)
    throw Object.assign(new Error('Trading account not found'), {
      status: 404,
      name: 'Not Found',
    })
  if (account.isDemo || account.status !== 'ACTIVE')
    throw new ImportError(
      400,
      'Imports need an active, non-demo trading account'
    )
}

function dustThresholdAud(): string {
  const configured = process.env.IMPORT_DUST_THRESHOLD_AUD
  return configured && Number(configured) >= 0 ? configured : '1'
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function parseUpload(
  source: ImportSourceName,
  files: UploadedFile[]
): ReturnType<typeof parseKrakenCsv> {
  if (source !== 'KRAKEN') {
    throw new ImportError(400, `${source} imports are not supported yet`)
  }
  const trades = files.find((f) => f.kind === 'trades')
  const ledgers = files.find((f) => f.kind === 'ledgers')
  if (!trades || !ledgers) {
    throw new ImportError(
      400,
      'A Kraken import needs both the trades CSV and the ledgers CSV'
    )
  }
  try {
    return parseKrakenCsv(trades.content, ledgers.content)
  } catch (error) {
    if (error instanceof ImportParseError) {
      throw new ImportError(400, error.message)
    }
    throw error
  }
}

export async function createImportBatch(params: {
  userId: string
  accountId: string
  source: ImportSourceName
  files: UploadedFile[]
}) {
  const { userId, accountId, source, files } = params
  const parsed = parseUpload(source, files)

  const existing = await prisma.importedEvent.findMany({
    where: {
      userId,
      source,
      externalId: { in: parsed.events.map((e) => e.externalId) },
    },
    select: {
      id: true,
      externalId: true,
      status: true,
      occurredAt: true,
      batch: {
        select: {
          id: true,
          accountId: true,
          status: true,
          account: { select: { name: true } },
        },
      },
    },
  })
  const existingByExternalId = new Map(existing.map((e) => [e.externalId, e]))

  const currentMonth = sydneyDateKey(new Date()).slice(0, 7)
  const fresh: NormalizedEvent[] = []
  const reattach: string[] = []
  const duplicateBatches = new Map<
    string,
    (typeof existing)[number]['batch'] & { eventCount: number }
  >()
  let duplicates = 0
  for (const event of parsed.events) {
    const known = existingByExternalId.get(event.externalId)
    if (!known) {
      fresh.push(event)
    } else if (
      known.status === 'DEFERRED' &&
      known.batch.accountId === accountId &&
      sydneyDateKey(known.occurredAt).slice(0, 7) < currentMonth
    ) {
      // A month that was still open last time is complete now, so it is picked up again.
      reattach.push(known.id)
    } else {
      duplicates += 1
      const previous = duplicateBatches.get(known.batch.id)
      duplicateBatches.set(known.batch.id, {
        ...known.batch,
        eventCount: (previous?.eventCount ?? 0) + 1,
      })
    }
  }

  const existingBatches = [...duplicateBatches.values()].map((batch) => ({
    id: batch.id,
    accountId: batch.accountId,
    accountName: batch.account.name,
    status: batch.status,
    eventCount: batch.eventCount,
  }))

  if (fresh.length === 0 && reattach.length === 0) {
    return {
      batchId: null,
      duplicates,
      existingBatches,
      warnings: parsed.warnings,
    }
  }

  const fileHash = createHash('sha256')
    .update(files.map((f) => f.content).join('\n'))
    .digest('hex')

  const batch = await prisma.$transaction(async (tx) => {
    await lockImportAccount(tx, userId, accountId)
    const created = await tx.importBatch.create({
      data: {
        userId,
        accountId,
        source,
        method: 'CSV',
        fileNames: files.map((f) => f.fileName),
        fileHash,
        warnings: toJson(parsed.warnings),
        meta: toJson({ ledgerBalances: parsed.ledgerBalances, duplicates }),
      },
    })
    if (fresh.length > 0) {
      await tx.importedEvent.createMany({
        data: fresh.map((event) => ({
          batchId: created.id,
          userId,
          source,
          externalId: event.externalId,
          kind: event.kind,
          occurredAt: event.occurredAt,
          baseAsset: event.baseAsset,
          quoteCurrency: event.quoteCurrency ?? null,
          exchangeCode: event.quoteCurrency
            ? exchangeCodeFor(SOURCE_VENUE[source], event.quoteCurrency)
            : null,
          quantity: event.quantity,
          price: event.price ?? null,
          grossValue: event.grossValue ?? null,
          fee: event.fee,
          feeCurrency: event.feeCurrency ?? null,
          warning: event.warning ?? null,
          raw: toJson(event.raw),
        })),
      })
    }
    if (reattach.length > 0) {
      const updated = await tx.importedEvent.updateMany({
        where: {
          id: { in: reattach },
          userId,
          status: 'DEFERRED',
          batch: { accountId },
        },
        data: { batchId: created.id, status: 'PENDING' },
      })
      if (updated.count !== reattach.length)
        throw new ImportError(
          409,
          'Deferred events changed during upload. Refresh the existing import and try again.'
        )
    }
    return created
  }, transactionOptions)

  return {
    batchId: batch.id,
    duplicates,
    existingBatches,
    warnings: parsed.warnings,
  }
}

async function loadOwnedBatch(
  batchId: string,
  userId: string,
  db: ImportDb = prisma
) {
  const batch = await db.importBatch.findFirst({
    where: { id: batchId, userId },
  })
  if (!batch) {
    const err = new Error('Import batch not found') as Error & {
      status: number
    }
    err.status = 404
    throw err
  }
  return batch
}

function asRecord(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {}
}

async function loadExistingParcels(
  userId: string,
  accountId: string,
  db: ImportDb = prisma
): Promise<ExistingParcel[]> {
  const positions = await db.position.findMany({
    where: {
      userId,
      accountId,
      status: { in: ['OPEN', 'PARTIAL'] },
      asset: { assetType: 'CRYPTO' },
    },
    include: { asset: { include: { exchange: true } } },
    orderBy: { id: 'asc' },
  })
  return positions.map((position) => ({
    id: position.id,
    baseAsset: position.asset.symbol.split('-')[0],
    exchangeCode: position.asset.exchange.code,
    currency: position.asset.exchange.currency,
    openDate: position.openDate,
    createdAt: position.createdAt,
    remainingQty: String(position.quantity),
    entryPrice: position.entryPrice.toString(),
  }))
}

async function loadFxRates(events: PlannerEvent[]) {
  const keys = new Map<string, Date>()
  for (const event of events) {
    if (event.kind === 'SELL' || event.kind === 'STAKING_REWARD') {
      const date = sydneyDate(event.occurredAt)
      keys.set(sydneyDateKey(event.occurredAt), date)
    }
  }
  const rates = new Map<string, number>()
  const entries = [...keys]
  for (let i = 0; i < entries.length; i += 10) {
    await Promise.all(
      entries.slice(i, i + 10).map(async ([key, date]) => {
        try {
          const { rate } = await getHistoricalFxRateToAud('USD', date)
          rates.set(key, rate)
        } catch {
          // left unset -> MISSING_FX / MISSING_FMV issue in the plan
        }
      })
    )
  }
  return (currency: string, date: Date): number | null => {
    if (currency === 'AUD') return 1
    if (currency !== 'USD') return null
    return rates.get(date.toISOString().slice(0, 10)) ?? null
  }
}

async function loadFmvFallbacks(events: PlannerEvent[]) {
  const fallbacks = new Map<string, string>()
  for (const event of events) {
    if (
      event.kind !== 'STAKING_REWARD' ||
      event.raw.fmvUsd !== undefined ||
      event.resolution?.fmvAud !== undefined
    ) {
      continue
    }
    const day = sydneyDate(event.occurredAt)
    const closes = await getCryptoDailyCloses(event.baseAsset, 'AUD', day, day)
    const close = closes.get(sydneyDateKey(event.occurredAt))
    if (close !== undefined) {
      fallbacks.set(event.id, new Decimal(event.quantity).mul(close).toFixed())
    }
  }
  return fallbacks
}

async function loadPlanState(batchId: string, userId: string, db: ImportDb) {
  const batch = await loadOwnedBatch(batchId, userId, db)
  const rows = await db.importedEvent.findMany({
    where: { batchId, userId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  })
  const existingParcels = await loadExistingParcels(userId, batch.accountId, db)
  const snapshot = createHash('sha256')
    .update(JSON.stringify({ batch, rows, existingParcels }))
    .digest('hex')
  return { batch, rows, existingParcels, snapshot }
}

async function prepareBatch(batchId: string, userId: string) {
  const { batch, rows, existingParcels, snapshot } = await loadPlanState(
    batchId,
    userId,
    prisma
  )

  const planEvents: PlannerEvent[] = rows
    .filter((row) => row.status === 'PENDING' || row.status === 'DEFERRED')
    .map((row) => ({
      id: row.id,
      source: row.source,
      externalId: row.externalId,
      kind: row.kind,
      occurredAt: row.occurredAt,
      baseAsset: row.baseAsset,
      quoteCurrency: (row.quoteCurrency ?? undefined) as
        | 'AUD'
        | 'USD'
        | undefined,
      quantity: row.quantity.toFixed(),
      price: row.price?.toFixed(),
      grossValue: row.grossValue?.toFixed(),
      fee: row.fee.toFixed(),
      feeCurrency: row.feeCurrency ?? undefined,
      raw: asRecord(row.raw),
      warning: row.warning ?? undefined,
      resolution: (row.resolution ?? null) as EventResolution | null,
    }))

  const [rateToAud, fmvFallbackAud] = await Promise.all([
    loadFxRates(planEvents),
    loadFmvFallbacks(planEvents),
  ])

  const meta = (batch.meta ?? {}) as {
    ledgerBalances?: Record<string, string>
  }
  const plan = buildPlan(planEvents, {
    now: new Date(),
    dustThresholdAud: dustThresholdAud(),
    existingParcels,
    ledgerBalances: meta.ledgerBalances ?? null,
    rateToAud,
    fmvFallbackAud,
  })

  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1

  return { batch, plan, eventCounts: counts, events: rows, snapshot }
}

export async function planBatch(batchId: string, userId: string) {
  const { snapshot: _snapshot, ...planned } = await prepareBatch(
    batchId,
    userId
  )
  return planned
}

export async function saveResolution(
  batchId: string,
  eventId: string,
  userId: string,
  resolution: EventResolution
) {
  const initial = await loadOwnedBatch(batchId, userId)
  await prisma.$transaction(async (tx) => {
    await lockOwnedTradingAccount(tx, userId, initial.accountId)
    const batch = await loadOwnedBatch(batchId, userId, tx)
    if (batch.status === 'DISCARDED')
      throw new ImportError(409, 'This import was discarded')
    const event = await tx.importedEvent.findFirst({
      where: { id: eventId, batchId, userId },
    })
    if (!event) {
      const err = new Error('Import event not found') as Error & {
        status: number
      }
      err.status = 404
      throw err
    }
    if (event.status !== 'PENDING' && event.status !== 'DEFERRED') {
      throw new ImportError(409, 'This event has already been processed')
    }
    if (resolution.allocations && event.kind !== 'SELL') {
      throw new ImportError(400, 'Allocations only apply to sell events')
    }
    if (resolution.fmvAud !== undefined && event.kind !== 'STAKING_REWARD') {
      throw new ImportError(400, 'fmvAud only applies to staking rewards')
    }

    const merged = {
      ...((event.resolution ?? {}) as EventResolution),
      ...resolution,
    }
    await tx.importedEvent.update({
      where: { id: eventId },
      data: { resolution: toJson(merged) },
    })
  }, transactionOptions)
  return planBatch(batchId, userId)
}

export async function discardBatch(batchId: string, userId: string) {
  const initial = await loadOwnedBatch(batchId, userId)
  await prisma.$transaction(async (tx) => {
    await lockOwnedTradingAccount(tx, userId, initial.accountId)
    await loadOwnedBatch(batchId, userId, tx)
    await tx.importedEvent.deleteMany({
      where: { batchId, userId, status: { in: ['PENDING', 'DEFERRED'] } },
    })
    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: 'DISCARDED' },
    })
  }, transactionOptions)
}

/** Applies a chronological prefix check so no event runs before an earlier unresolved one. */
function selectSteps(
  plan: ImportPlan,
  eventIds: string[] | undefined
): ImportPlan['steps'] {
  if (!eventIds) {
    if (plan.summary.blockingIssues > 0) {
      throw new ImportError(
        409,
        'Resolve the blocking issues before committing',
        plan.issues.filter((i) => i.blocking)
      )
    }
    return plan.steps
  }

  const selected = new Set(eventIds)
  const parcelEvents = new Map(
    plan.newPositions.map((p) => [p.ref, p.eventIds])
  )
  const sellById = new Map(plan.sells.map((s) => [s.eventId, s]))
  const assetOfStep = (step: ImportPlan['steps'][number]) =>
    step.type === 'SELL'
      ? (sellById.get(step.eventId)?.baseAsset as string)
      : (plan.newPositions.find((p) => p.ref === step.ref)?.baseAsset as string)
  const isSelected = (step: ImportPlan['steps'][number]) =>
    step.type === 'SELL'
      ? selected.has(step.eventId)
      : (parcelEvents.get(step.ref) ?? []).some((id) => selected.has(id))

  const chosen: ImportPlan['steps'] = []
  for (const step of plan.steps) {
    if (!isSelected(step)) continue
    const asset = assetOfStep(step)
    const blockingSell = plan.sells.find(
      (sell) =>
        sell.baseAsset === asset &&
        sell.occurredAt.getTime() < step.at.getTime() &&
        (!sell.resolved || !selected.has(sell.eventId))
    )
    if (blockingSell) {
      throw new ImportError(
        409,
        'An earlier sale of this asset is not part of the commit or still unresolved',
        [{ blockingEventId: blockingSell.eventId }]
      )
    }
    const earlierUnselected = plan.steps.find(
      (other) =>
        other !== step &&
        !isSelected(other) &&
        other.at.getTime() < step.at.getTime() &&
        assetOfStep(other) === asset
    )
    if (earlierUnselected) {
      throw new ImportError(
        409,
        'An earlier event of this asset is not part of the commit',
        [
          {
            blockingEventId:
              earlierUnselected.type === 'SELL'
                ? earlierUnselected.eventId
                : (parcelEvents.get(earlierUnselected.ref) ?? [])[0],
          },
        ]
      )
    }
    chosen.push(step)
  }
  const hasBlocking = plan.issues.some(
    (issue) => issue.blocking && selected.has(issue.eventId)
  )
  if (hasBlocking) {
    throw new ImportError(
      409,
      'Resolve the blocking issues before committing',
      plan.issues.filter((i) => i.blocking && selected.has(i.eventId))
    )
  }
  return chosen
}

export async function commitBatch(
  batchId: string,
  userId: string,
  eventIds?: string[]
) {
  const { batch, plan, snapshot, events } = await prepareBatch(batchId, userId)
  if (batch.status === 'DISCARDED') {
    throw new ImportError(409, 'This import was discarded')
  }
  const steps = selectSteps(plan, eventIds)
  const selected = eventIds ? new Set(eventIds) : null
  const inScope = (id: string) => !selected || selected.has(id)

  const initialLedger = await prisma.accountCashLedger.findUnique({
    where: { accountId: batch.accountId },
    select: { accountId: true, state: true },
  })
  if (initialLedger && initialLedger.state !== 'ACTIVE')
    throw new ImportError(
      409,
      'Exchange import commits require an active cash ledger'
    )
  const parcelByRef = new Map(plan.newPositions.map((p) => [p.ref, p]))
  const sellById = new Map(plan.sells.map((s) => [s.eventId, s]))
  const cashEvents = steps.flatMap((step) => {
    if (step.type === 'SELL') return [{ id: step.eventId, occurredAt: step.at }]
    const parcel = parcelByRef.get(step.ref)
    if (!parcel || parcel.origin !== 'IMPORT_TRADE') return []
    return parcel.eventIds.map((id) => ({
      id,
      occurredAt: parcel.acquiredAt,
    }))
  })
  const cashEventIds = new Set(cashEvents.map((event) => event.id))
  const hasCompleteCashEventCoverage = (pending: readonly { id: string }[]) =>
    cashEventIds.size === pending.length &&
    pending.every((event) => cashEventIds.has(event.id))
  const requireLedgerTradeBatch = (
    pending: readonly { id: string; kind: string }[]
  ) => {
    if (
      pending.some((event) => event.kind !== 'BUY' && event.kind !== 'SELL') ||
      !hasCompleteCashEventCoverage(pending) ||
      (selected && pending.some((event) => !selected.has(event.id)))
    )
      throw new ImportError(
        409,
        'Live-ledger imports require one complete batch of supported Kraken BUY/SELL executions'
      )
  }
  if (initialLedger) {
    const pending = events.filter(
      (event) => event.status === 'PENDING' || event.status === 'DEFERRED'
    )
    if (pending.length > 0) requireLedgerTradeBatch(pending)
    else if (cashEventIds.size > 0)
      throw new ImportError(409, 'Committed import has unexpected trade steps')
  }

  // Assets are idempotent find-or-create, so they can safely sit outside the transaction.
  const assetIds = new Map<string, string>()
  for (const step of steps) {
    if (step.type !== 'PARCEL') continue
    const parcel = parcelByRef.get(step.ref)
    if (!parcel) continue
    const asset = await findOrCreateAsset(
      parcel.symbol,
      parcel.exchangeCode,
      parcel.baseAsset,
      'CRYPTO'
    )
    assetIds.set(step.ref, asset.id)
  }

  const created: Array<{ ref: string; id: string }> = []
  const eventPositions = new Map<string, string[]>()

  await prisma.$transaction(async (tx) => {
    await lockImportAccount(tx, userId, batch.accountId)
    const ledger = await tx.accountCashLedger.findUnique({
      where: { accountId: batch.accountId },
      select: { accountId: true, openingStatementId: true, state: true },
    })
    if (ledger && ledger.state !== 'ACTIVE')
      throw new ImportError(
        409,
        'Exchange import commits require an active cash ledger'
      )
    const current = await loadPlanState(batchId, userId, tx)
    if (current.snapshot !== snapshot)
      throw new ImportError(
        409,
        'Import events or holdings changed during preparation. Review the refreshed plan and try again.'
      )
    if (ledger) {
      const pending = current.rows.filter(
        (event) => event.status === 'PENDING' || event.status === 'DEFERRED'
      )
      if (pending.length > 0) requireLedgerTradeBatch(pending)
      if (pending.length === 0 && cashEventIds.size > 0)
        throw new ImportError(
          409,
          'Committed import has unexpected trade steps'
        )
    }
    const liveImportPosting = ledger
      ? await beginLiveImportPosting(
          tx,
          userId,
          batch.accountId,
          batchId,
          cashEvents
        )
      : null
    if (ledger && cashEvents.length > 0 && !liveImportPosting)
      throw new ImportError(
        409,
        'This import contains no supported cash executions'
      )
    const positionIds = new Map<string, string>()
    const touched = new Set<string>()

    for (const step of steps) {
      if (step.type === 'PARCEL') {
        const parcel = parcelByRef.get(step.ref)
        if (!parcel) continue
        const totalBuyValue = new Decimal(parcel.totalBuyValue)
        const position = await tx.position.create({
          data: {
            userId,
            assetId: assetIds.get(step.ref) as string,
            accountId: batch.accountId,
            openDate: parcel.openDate,
            entryPrice: parcel.entryPrice,
            quantity: Number(parcel.quantity),
            positionType: 'LONG',
            totalBuyValue: totalBuyValue.toFixed(8),
            buyFees: parcel.buyFees,
            capitalAllocated: totalBuyValue.plus(parcel.buyFees).toFixed(8),
            origin: parcel.origin,
            externalRef: parcel.externalRef,
            tags: parcel.tags,
            notes: parcel.notes,
            transactions: {
              create: {
                type: 'BUY',
                date: parcel.openDate,
                quantity: Number(parcel.quantity),
                price: parcel.entryPrice,
                totalValue: totalBuyValue.toFixed(8),
                fees: parcel.buyFees,
                executionTime: parcel.acquiredAt,
                brokerRef: parcel.externalRef,
                orderType: parcel.orderType,
              },
            },
          },
        })
        positionIds.set(step.ref, position.id)
        created.push({ ref: step.ref, id: position.id })
        for (const id of parcel.eventIds) eventPositions.set(id, [position.id])
        continue
      }

      const sell = sellById.get(step.eventId)
      if (!sell) continue
      const ids: string[] = []
      for (const allocation of sell.allocations) {
        const positionId =
          positionIds.get(allocation.positionRef) ?? allocation.positionRef
        await tx.transaction.create({
          data: {
            positionId,
            type: 'SELL',
            date: sell.sellDate,
            quantity: Number(allocation.quantity),
            price: allocation.price,
            totalValue: allocation.totalValue,
            fees: allocation.fees,
            executionTime: sell.occurredAt,
            brokerRef: sell.externalId,
            orderType: sell.orderType,
            closeReason: sell.closeReason,
            notes: allocation.notes,
          },
        })
        touched.add(positionId)
        ids.push(positionId)
      }
      eventPositions.set(sell.eventId, ids)
    }

    for (const positionId of touched) {
      if (!(await recomputePositionFromTransactions(positionId, tx)))
        throw new ImportError(409, 'An allocated parcel no longer exists')
    }

    const applied = new Set<string>()
    for (const [eventId, ids] of eventPositions) {
      applied.add(eventId)
      await tx.importedEvent.update({
        where: { id: eventId },
        data: { status: 'APPLIED', appliedPositionIds: ids },
      })
    }

    for (const month of plan.staking) {
      const ids = month.eventIds.filter(inScope)
      if (ids.length === 0) continue
      if (month.status === 'DUST') {
        await tx.importedEvent.updateMany({
          where: { id: { in: ids }, userId },
          data: { status: 'SKIPPED', warning: 'DUST' },
        })
      } else if (month.status === 'DEFERRED') {
        await tx.importedEvent.updateMany({
          where: { id: { in: ids }, userId },
          data: { status: 'DEFERRED' },
        })
      }
      if (month.status === 'APPLY') {
        for (const id of ids) {
          if (month.fmvByEvent[id] !== undefined) {
            await tx.importedEvent.update({
              where: { id },
              data: { fmvAud: month.fmvByEvent[id] },
            })
          }
        }
      }
    }

    const nonApplied = [...plan.unsupported, ...plan.skipped]
      .map((item) => item.eventId)
      .filter(inScope)
    if (nonApplied.length > 0) {
      await tx.importedEvent.updateMany({
        where: { id: { in: nonApplied }, userId },
        data: { status: 'SKIPPED' },
      })
    }

    const remaining = await tx.importedEvent.count({
      where: { batchId, userId, status: 'PENDING' },
    })
    const hasApplied = await tx.importedEvent.count({
      where: { batchId, userId, status: 'APPLIED' },
    })
    await tx.importBatch.update({
      where: { id: batchId },
      data:
        remaining === 0
          ? { status: 'COMMITTED', committedAt: new Date() }
          : {
              status: hasApplied > 0 ? 'PARTIALLY_APPLIED' : batch.status,
            },
    })
    if (liveImportPosting) {
      await liveImportPosting([...eventPositions.keys()])
    }
  }, transactionOptions)

  void backfillHistory(created.map((c) => c.id))

  return {
    createdPositionIds: created.map((c) => c.id),
    appliedEvents: eventPositions.size,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Sequential and throttled so an import never bursts the market-data providers. */
async function backfillHistory(positionIds: string[]) {
  for (const id of positionIds) {
    try {
      const position = await prisma.position.findUnique({
        where: { id },
        include: { asset: true },
      })
      if (!position) continue
      const entry = Number(position.entryPrice)
      const [drawdown, runUp] = await Promise.all([
        fetchHistoricalMaxDrawdown(
          position.asset.symbol,
          entry,
          position.openDate
        ),
        fetchHistoricalMaxRunUp(
          position.asset.symbol,
          entry,
          position.openDate,
          position.status === 'CLOSED' && position.closeDate
            ? position.closeDate
            : undefined
        ),
      ])
      const data: Parameters<typeof savePositionHistory>[1] = {}
      if (drawdown !== null) data.maxDrawdownPercent = drawdown
      if (runUp !== null) data.maxRunUpPercent = runUp
      if (Object.keys(data).length > 0) {
        await savePositionHistory(position, data)
      }
    } catch (error) {
      console.warn('Import history calculation was not saved', error)
    }
    await sleep(300)
  }
}
