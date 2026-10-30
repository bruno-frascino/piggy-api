import Decimal from './decimal.js'
import {
  exchangeCodeFor,
  venueOfExchangeCode,
  type CryptoVenue,
} from '../crypto/venues.js'
import { toCanonicalSymbol } from '../crypto/symbols.js'
import type {
  CloseReasonName,
  ExistingParcel,
  ImportPlan,
  PlanIssue,
  PlannedAllocation,
  PlannedParcel,
  PlannedSell,
  PlannerEvent,
  PlanStep,
  QuoteCurrency,
  Reconciliation,
  StakingMonth,
} from './types.js'

export interface PlannerOptions {
  now: Date
  /** Monthly staking aggregates worth less than this (AUD) are skipped as dust. */
  dustThresholdAud: string
  existingParcels: ExistingParcel[]
  /** Last ledger balance per asset (all wallets); enables the reconciliation check. */
  ledgerBalances?: Record<string, string> | null
  /** Rate to convert 1 unit of `currency` to AUD on a Sydney calendar date (00:00Z). */
  rateToAud: (currency: string, date: Date) => number | null
  /** Staking FMV (AUD) by event id for rewards the export carries no USD value for. */
  fmvFallbackAud?: Map<string, string>
}

const SOURCE_VENUE: Record<string, CryptoVenue> = {
  KRAKEN: 'KRAKEN',
  BINANCE: 'BINANCE',
  COINBASE: 'COINBASE',
}
const SOURCE_LABEL: Record<string, string> = {
  KRAKEN: 'Kraken',
  BINANCE: 'Binance',
  COINBASE: 'Coinbase',
}
const QTY_EPSILON = new Decimal('1e-10')
const RECONCILE_EPSILON = new Decimal('1e-8')

const sydneyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Sydney',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function sydneyDateKey(date: Date): string {
  return sydneyFormatter.format(date)
}

/** Sydney calendar date at 00:00Z — the repo's representation of a manual date entry. */
export function sydneyDate(date: Date): Date {
  return new Date(`${sydneyDateKey(date)}T00:00:00Z`)
}

function closeReasonFromOrderType(
  orderType: string | null
): CloseReasonName | null {
  const type = (orderType ?? '').toLowerCase()
  if (type.startsWith('stop')) return 'STOP_LOSS'
  if (type.startsWith('take-profit')) return 'TARGET'
  return null
}

interface PoolEntry {
  ref: string
  acquiredAt: Date
  createdAt: Date
  existing: boolean
  remaining: Decimal
  currency: string
}

function orderIdOf(externalId: string): string {
  return externalId.split(':').slice(2).join(':')
}

function fixed(value: Decimal, places = 12): string {
  return value.toDecimalPlaces(places).toFixed()
}

export function buildPlan(
  events: PlannerEvent[],
  options: PlannerOptions
): ImportPlan {
  const issues: PlanIssue[] = []
  const unsupported: ImportPlan['unsupported'] = []
  const skipped: ImportPlan['skipped'] = []
  const parcels: PlannedParcel[] = []
  const staking: StakingMonth[] = []
  const sells: PlannedSell[] = []
  const steps: PlanStep[] = []
  const threshold = new Decimal(options.dustThresholdAud)
  const currentMonth = sydneyDateKey(options.now).slice(0, 7)

  const dustQty = new Map<string, Decimal>()
  const deferredQty = new Map<string, Decimal>()
  let dustTotalAud = new Decimal(0)

  const venueOf = (event: PlannerEvent) => SOURCE_VENUE[event.source]

  const sellEvents: PlannerEvent[] = []
  const rewardGroups = new Map<string, PlannerEvent[]>()

  for (const event of events) {
    if (event.resolution?.skip) {
      skipped.push({
        eventId: event.id,
        externalId: event.externalId,
        reason: 'Skipped by user',
      })
      continue
    }
    switch (event.kind) {
      case 'BUY': {
        const quote = event.quoteCurrency as QuoteCurrency
        const exchangeCode = exchangeCodeFor(venueOf(event), quote)
        if (!exchangeCode) {
          unsupported.push({
            eventId: event.id,
            externalId: event.externalId,
            reason: `No exchange for ${quote} at ${event.source}`,
          })
          break
        }
        const acquiredAt = event.occurredAt
        parcels.push({
          ref: `event:${event.externalId}`,
          origin: 'IMPORT_TRADE',
          externalRef: event.externalId,
          symbol: toCanonicalSymbol(event.baseAsset, quote),
          baseAsset: event.baseAsset,
          quoteCurrency: quote,
          exchangeCode,
          acquiredAt,
          openDate: sydneyDate(acquiredAt),
          quantity: event.quantity,
          entryPrice: fixed(new Decimal(event.price ?? '0')),
          totalBuyValue: event.grossValue ?? '0',
          buyFees: event.fee,
          orderType: event.raw.ordertype ?? null,
          notes: `Imported from ${SOURCE_LABEL[event.source]} (order ${orderIdOf(event.externalId)})`,
          tags: [`import:${event.source.toLowerCase()}`],
          eventIds: [event.id],
        })
        break
      }
      case 'SELL':
        sellEvents.push(event)
        break
      case 'STAKING_REWARD': {
        const key = `${event.baseAsset}|${sydneyDateKey(event.occurredAt).slice(0, 7)}`
        rewardGroups.set(key, [...(rewardGroups.get(key) ?? []), event])
        break
      }
      default:
        unsupported.push({
          eventId: event.id,
          externalId: event.externalId,
          reason: event.warning ?? 'Unsupported event',
        })
    }
  }

  for (const [groupKey, rewards] of rewardGroups) {
    const [baseAsset, month] = groupKey.split('|')
    const quantity = rewards.reduce(
      (sum, r) => sum.plus(r.quantity),
      new Decimal(0)
    )
    const first = rewards[0]
    const base = {
      key: `${first.source}:staking:${baseAsset}:${month}`,
      baseAsset,
      month,
      eventIds: rewards.map((r) => r.id),
      quantity: quantity.toFixed(),
    }

    // A parcel can never be appended to, so only completed months are applied.
    if (month >= currentMonth) {
      staking.push({
        ...base,
        fmvAud: '0',
        fmvByEvent: {},
        status: 'DEFERRED',
      })
      deferredQty.set(
        baseAsset,
        (deferredQty.get(baseAsset) ?? new Decimal(0)).plus(quantity)
      )
      continue
    }

    let fmv = new Decimal(0)
    const fmvByEvent: Record<string, string> = {}
    let blocked = false
    for (const reward of rewards) {
      const override = reward.resolution?.fmvAud
      let value: Decimal | null = null
      if (override !== undefined) {
        value = new Decimal(override)
      } else if (reward.raw.fmvUsd !== undefined) {
        const rate = options.rateToAud('USD', sydneyDate(reward.occurredAt))
        if (rate !== null) value = new Decimal(reward.raw.fmvUsd).mul(rate)
      } else if (options.fmvFallbackAud?.has(reward.id)) {
        value = new Decimal(options.fmvFallbackAud.get(reward.id) as string)
      }
      if (value === null) {
        blocked = true
        issues.push({
          type: 'MISSING_FMV',
          blocking: true,
          eventId: reward.id,
          externalId: reward.externalId,
          message: `Cannot determine the AUD value of this ${baseAsset} reward — enter it manually`,
        })
      } else {
        fmv = fmv.plus(value)
        fmvByEvent[reward.id] = value.toFixed()
      }
    }
    if (blocked) {
      staking.push({ ...base, fmvAud: '0', fmvByEvent: {}, status: 'BLOCKED' })
      continue
    }

    if (fmv.lt(threshold)) {
      staking.push({
        ...base,
        fmvAud: fmv.toFixed(),
        fmvByEvent,
        status: 'DUST',
      })
      dustQty.set(
        baseAsset,
        (dustQty.get(baseAsset) ?? new Decimal(0)).plus(quantity)
      )
      dustTotalAud = dustTotalAud.plus(fmv)
      continue
    }

    // Last reward date of the month: conservative for the 12-month discount.
    const last = rewards.reduce((a, b) => (a.occurredAt > b.occurredAt ? a : b))
    parcels.push({
      ref: `staking:${base.key}`,
      origin: 'STAKING_REWARD',
      externalRef: base.key,
      symbol: toCanonicalSymbol(baseAsset, 'AUD'),
      baseAsset,
      quoteCurrency: 'AUD',
      exchangeCode: exchangeCodeFor(venueOf(first), 'AUD') as string,
      acquiredAt: last.occurredAt,
      openDate: sydneyDate(last.occurredAt),
      quantity: quantity.toFixed(),
      entryPrice: fixed(fmv.div(quantity)),
      totalBuyValue: fmv.toFixed(),
      buyFees: '0',
      orderType: null,
      notes: `${SOURCE_LABEL[first.source]} staking rewards ${month} (valued at receipt)`,
      tags: [`import:${first.source.toLowerCase()}`, 'staking'],
      eventIds: rewards.map((r) => r.id),
    })
    staking.push({
      ...base,
      fmvAud: fmv.toFixed(),
      fmvByEvent,
      status: 'APPLY',
    })
  }

  // ── Chronological simulation per (venue, asset) ────────────────────────────
  type Timeline =
    | { at: Date; order: 0; parcel: PlannedParcel }
    | { at: Date; order: 1; sell: PlannerEvent }
  const timeline: Timeline[] = [
    ...parcels.map((parcel) => ({
      at: parcel.acquiredAt,
      order: 0 as const,
      parcel,
    })),
    ...sellEvents.map((sell) => ({
      at: sell.occurredAt,
      order: 1 as const,
      sell,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order)

  const pools = new Map<string, PoolEntry[]>()
  const poolKey = (venue: string, asset: string) => `${venue}|${asset}`
  for (const existing of options.existingParcels) {
    const venue = venueOfExchangeCode(existing.exchangeCode)
    if (!venue) continue
    const key = poolKey(venue, existing.baseAsset)
    pools.set(key, [
      ...(pools.get(key) ?? []),
      {
        ref: existing.id,
        acquiredAt: existing.openDate,
        createdAt: existing.createdAt,
        existing: true,
        remaining: new Decimal(existing.remainingQty),
        currency: existing.currency,
      },
    ])
  }

  const dustLeft = new Map(dustQty)
  // Coins the exchange sold that the plan could not match to any parcel.
  const unmatchedSold = new Map<string, Decimal>()

  for (const item of timeline) {
    if (item.order === 0) {
      const { parcel } = item
      const venue = venueOfExchangeCode(parcel.exchangeCode) as CryptoVenue
      const key = poolKey(venue, parcel.baseAsset)
      pools.set(key, [
        ...(pools.get(key) ?? []),
        {
          ref: parcel.ref,
          acquiredAt: parcel.acquiredAt,
          createdAt: parcel.acquiredAt,
          existing: false,
          remaining: new Decimal(parcel.quantity),
          currency: parcel.quoteCurrency,
        },
      ])
      steps.push({ type: 'PARCEL', ref: parcel.ref, at: parcel.acquiredAt })
      continue
    }

    const event = item.sell
    const quote = event.quoteCurrency as QuoteCurrency
    const sellDate = sydneyDate(event.occurredAt)
    const qty = new Decimal(event.quantity)
    const pool = pools.get(poolKey(venueOf(event), event.baseAsset)) ?? []
    const orderType = event.raw.ordertype ?? null
    const resolution = event.resolution
    const closeReason =
      resolution && 'closeReason' in resolution
        ? (resolution.closeReason ?? null)
        : closeReasonFromOrderType(orderType)

    const eligible = pool
      .filter(
        (entry) =>
          entry.remaining.gt(QTY_EPSILON) &&
          (entry.existing
            ? entry.acquiredAt.getTime() <= sellDate.getTime()
            : entry.acquiredAt.getTime() <= event.occurredAt.getTime())
      )
      .sort(
        (a, b) =>
          a.acquiredAt.getTime() - b.acquiredAt.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime()
      )

    const planned: PlannedSell = {
      eventId: event.id,
      externalId: event.externalId,
      occurredAt: event.occurredAt,
      sellDate,
      baseAsset: event.baseAsset,
      quoteCurrency: quote,
      quantity: event.quantity,
      orderType,
      closeReason,
      allocations: [],
      userOverridden: false,
      dustIgnored: null,
      resolved: false,
      eligible: eligible.map((entry) => ({
        positionRef: entry.ref,
        remaining: entry.remaining.toFixed(),
        acquiredAt: entry.acquiredAt,
        currency: entry.currency,
      })),
    }
    sells.push(planned)

    const raise = (
      type: PlanIssue['type'],
      blocking: boolean,
      message: string
    ) =>
      issues.push({
        type,
        blocking,
        eventId: event.id,
        externalId: event.externalId,
        message,
      })

    let chosen: Array<{ entry: PoolEntry; qty: Decimal }> = []
    let allocated = new Decimal(0)

    if (resolution?.allocations && resolution.allocations.length > 0) {
      const seen = new Set<string>()
      let valid = true
      for (const requested of resolution.allocations) {
        const entry = eligible.find((e) => e.ref === requested.positionRef)
        const requestedQty = new Decimal(requested.quantity)
        if (
          !entry ||
          seen.has(requested.positionRef) ||
          requestedQty.lte(0) ||
          requestedQty.gt(entry.remaining.plus(QTY_EPSILON))
        ) {
          valid = false
          break
        }
        seen.add(requested.positionRef)
        chosen.push({ entry, qty: requestedQty })
        allocated = allocated.plus(requestedQty)
      }
      if (valid && allocated.minus(qty).abs().lte(QTY_EPSILON)) {
        planned.userOverridden = true
      } else {
        raise(
          'INVALID_ALLOCATION',
          true,
          'The chosen parcels are not eligible or do not add up to the quantity sold'
        )
        chosen = []
      }
    } else {
      let left = qty
      for (const entry of eligible) {
        if (left.lte(QTY_EPSILON)) break
        const take = Decimal.min(entry.remaining, left)
        chosen.push({ entry, qty: take })
        allocated = allocated.plus(take)
        left = left.minus(take)
      }
      const shortfall = qty.minus(allocated)
      if (shortfall.gt(QTY_EPSILON)) {
        const dust = dustLeft.get(event.baseAsset) ?? new Decimal(0)
        if (allocated.gt(0) && shortfall.lte(dust.plus(QTY_EPSILON))) {
          planned.dustIgnored = shortfall.toFixed()
          dustLeft.set(event.baseAsset, dust.minus(shortfall))
          raise(
            'DUST_SHORTFALL',
            false,
            `Short by ${shortfall.toFixed()} ${event.baseAsset}, covered by skipped dust rewards — the dust portion is ignored`
          )
        } else {
          raise(
            'INSUFFICIENT_HOLDINGS',
            true,
            `Only ${allocated.toFixed()} of ${qty.toFixed()} ${event.baseAsset} is available to sell — import earlier history, or skip this sale`
          )
          chosen = []
        }
      }
    }

    if (chosen.length === 0) {
      unmatchedSold.set(
        event.baseAsset,
        (unmatchedSold.get(event.baseAsset) ?? new Decimal(0)).plus(qty)
      )
      continue
    }

    const gross = new Decimal(event.grossValue ?? '0')
    const fee = new Decimal(event.fee)
    const allocations: PlannedAllocation[] = []
    let fxFailed = false
    for (const { entry, qty: allocQty } of chosen) {
      const share = allocQty.div(qty)
      let grossShare = gross.mul(share)
      let feeShare = fee.mul(share)
      let notes = `Imported sale (order ${orderIdOf(event.externalId)})`

      if (entry.currency !== quote) {
        const fxQuote = quote === 'AUD' ? 1 : options.rateToAud(quote, sellDate)
        const fxParcel =
          entry.currency === 'AUD'
            ? 1
            : options.rateToAud(entry.currency, sellDate)
        if (fxQuote === null || fxParcel === null || fxParcel === 0) {
          fxFailed = true
          break
        }
        const factor = new Decimal(fxQuote).div(fxParcel)
        notes = `${notes}; sold in ${quote} at ${gross.div(qty).toFixed(8)}, converted to ${entry.currency} via AUD (${quote}→AUD ${fxQuote})`
        grossShare = grossShare.mul(factor)
        feeShare = feeShare.mul(factor)
      }
      allocations.push({
        positionRef: entry.ref,
        quantity: allocQty.toFixed(),
        price: fixed(grossShare.div(allocQty)),
        totalValue: grossShare.toFixed(),
        fees: feeShare.toFixed(),
        notes,
      })
    }
    if (fxFailed) {
      raise(
        'MISSING_FX',
        true,
        'No FX rate available to convert this sale to the parcel currency'
      )
      unmatchedSold.set(
        event.baseAsset,
        (unmatchedSold.get(event.baseAsset) ?? new Decimal(0)).plus(qty)
      )
      continue
    }

    for (const { entry, qty: allocQty } of chosen) {
      entry.remaining = entry.remaining.minus(allocQty)
    }
    planned.allocations = allocations
    planned.resolved = true
    steps.push({ type: 'SELL', eventId: event.id, at: event.occurredAt })
  }

  // ── Reconciliation against the exchange's own ledger balances ──────────────
  let reconciliation: Reconciliation | null = null
  if (options.ledgerBalances) {
    const simulated = new Map<string, Decimal>()
    const add = (asset: string, value: Decimal) =>
      simulated.set(asset, (simulated.get(asset) ?? new Decimal(0)).plus(value))
    for (const [key, entries] of pools) {
      const asset = key.split('|')[1]
      for (const entry of entries) add(asset, entry.remaining)
    }
    // Dust and not-yet-applied months are still coins held on the exchange.
    for (const [asset, qty] of dustQty) add(asset, qty)
    for (const [asset, qty] of deferredQty) add(asset, qty)
    for (const [asset, qty] of unmatchedSold) add(asset, qty.neg())

    const assets = new Set([
      ...Object.keys(options.ledgerBalances),
      ...simulated.keys(),
    ])
    const rows = [...assets]
      .sort()
      .map((asset) => {
        const expected = new Decimal(options.ledgerBalances?.[asset] ?? '0')
        const actual = simulated.get(asset) ?? new Decimal(0)
        return {
          asset,
          expected: expected.toFixed(),
          simulated: actual.toFixed(),
          difference: actual.minus(expected).toFixed(),
        }
      })
      .filter((row) => new Decimal(row.difference).abs().gt(RECONCILE_EPSILON))
    reconciliation = { reconciled: rows.length === 0, rows }
  }

  return {
    newPositions: parcels,
    sells,
    staking,
    unsupported,
    skipped,
    issues,
    reconciliation,
    steps,
    summary: {
      buys: parcels.filter((p) => p.origin === 'IMPORT_TRADE').length,
      sells: sells.length,
      stakingMonthsApplied: staking.filter((s) => s.status === 'APPLY').length,
      stakingMonthsDust: staking.filter((s) => s.status === 'DUST').length,
      stakingMonthsDeferred: staking.filter((s) => s.status === 'DEFERRED')
        .length,
      dustTotalAud: dustTotalAud.toFixed(),
      unsupported: unsupported.length,
      skipped: skipped.length,
      blockingIssues: issues.filter((i) => i.blocking).length,
    },
  }
}
