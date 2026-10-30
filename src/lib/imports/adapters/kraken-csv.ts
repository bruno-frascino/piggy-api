import { parse } from 'csv-parse/sync'
import Decimal from '../decimal.js'
import { normalizeAssetCode, parsePair } from '../../crypto/symbols.js'
import type { NormalizedEvent, ParseResult, QuoteCurrency } from '../types.js'

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportParseError'
  }
}

const TRADES_REQUIRED = [
  'txid',
  'ordertxid',
  'pair',
  'time',
  'type',
  'ordertype',
  'price',
  'cost',
  'fee',
  'vol',
  'margin',
  'ledgers',
]
const LEDGERS_REQUIRED = [
  'txid',
  'refid',
  'time',
  'type',
  'subtype',
  'asset',
  'amount',
  'fee',
  'balance',
]

const FIAT = new Set(['AUD', 'USD', 'EUR', 'GBP', 'CAD', 'JPY', 'NZD', 'CHF'])
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'PYUSD', 'USDG', 'TUSD'])
const IGNORED_EARN_SUBTYPES = new Set([
  'allocation',
  'deallocation',
  'autoallocation',
  'migration',
])

type Row = Record<string, string>

interface LedgerRow {
  txid: string
  refid: string
  time: Date
  type: string
  subtype: string
  asset: string
  wallet: string
  amount: Decimal
  fee: Decimal
  balance: Decimal
  amountUsd: Decimal | null
  feeUsd: Decimal | null
  raw: Row
}

const price12 = (value: Decimal) => value.toDecimalPlaces(12).toFixed()
const money = (value: Decimal) => value.toDecimalPlaces(8).toFixed()

function isFiat(asset: string) {
  return FIAT.has(asset)
}

function isTradable(asset: string) {
  return !FIAT.has(asset) && !STABLECOINS.has(asset)
}

function dec(value: string | undefined, field: string): Decimal {
  const text = (value ?? '').trim()
  if (text === '') return new Decimal(0)
  try {
    return new Decimal(text)
  } catch {
    throw new ImportParseError(`Invalid number "${text}" in column "${field}"`)
  }
}

function optionalDec(value: string | undefined): Decimal | null {
  const text = (value ?? '').trim()
  if (text === '') return null
  try {
    return new Decimal(text)
  } catch {
    return null
  }
}

/** Kraken times are UTC `YYYY-MM-DD HH:mm:ss[.ffff]`. */
export function parseKrakenTime(value: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/.exec(
    value.trim()
  )
  if (!match) throw new ImportParseError(`Invalid time "${value}"`)
  const millis = `${match[3] ?? ''}000`.slice(0, 3)
  const date = new Date(`${match[1]}T${match[2]}.${millis}Z`)
  if (Number.isNaN(date.getTime())) {
    throw new ImportParseError(`Invalid time "${value}"`)
  }
  return date
}

function readCsv(content: string, required: string[], label: string): Row[] {
  let rows: Row[]
  try {
    rows = parse(content, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
    }) as Row[]
  } catch (error) {
    throw new ImportParseError(
      `Could not read the ${label} CSV: ${error instanceof Error ? error.message : 'invalid CSV'}`
    )
  }

  const header = new Set(Object.keys(rows[0] ?? {}))
  if (rows.length === 0) {
    // csv-parse yields no rows for header-only files; check the header line itself.
    const first = content
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)[0]
      .split(',')
      .map((h) => h.replace(/"/g, '').trim().toLowerCase())
    first.forEach((h) => header.add(h))
  }
  const missing = required.filter((column) => !header.has(column))
  if (missing.length > 0) {
    throw new ImportParseError(
      `Unrecognised ${label} export format. Missing columns: ${missing.join(', ')}`
    )
  }
  return rows
}

function toLedgerRow(row: Row): LedgerRow {
  return {
    txid: row.txid,
    refid: row.refid,
    time: parseKrakenTime(row.time),
    type: row.type.toLowerCase(),
    subtype: (row.subtype ?? '').toLowerCase(),
    asset: normalizeAssetCode('KRAKEN', row.asset),
    wallet: row.wallet ?? '',
    amount: dec(row.amount, 'amount'),
    fee: dec(row.fee, 'fee'),
    balance: dec(row.balance, 'balance'),
    amountUsd: optionalDec(row.amountusd),
    feeUsd: optionalDec(row.feeusd),
    raw: row,
  }
}

function unsupported(
  externalId: string,
  occurredAt: Date,
  baseAsset: string,
  reason: string,
  raw: Row
): NormalizedEvent {
  return {
    source: 'KRAKEN',
    externalId,
    kind: 'UNSUPPORTED',
    occurredAt,
    baseAsset,
    quantity: '0',
    fee: '0',
    raw,
    warning: reason,
  }
}

function computeBalances(ledgers: LedgerRow[]): Record<string, string> {
  const sorted = [...ledgers].sort(
    (a, b) => a.time.getTime() - b.time.getTime()
  )
  const lastPerWallet = new Map<string, LedgerRow>()
  for (const row of sorted) {
    lastPerWallet.set(`${row.asset}|${row.wallet}`, row)
  }
  const totals = new Map<string, Decimal>()
  for (const row of lastPerWallet.values()) {
    if (isFiat(row.asset)) continue
    totals.set(
      row.asset,
      (totals.get(row.asset) ?? new Decimal(0)).plus(row.balance)
    )
  }
  return Object.fromEntries(
    [...totals].map(([asset, total]) => [asset, total.toFixed()])
  )
}

function buildOrderEvent(
  orderId: string,
  fills: Row[],
  ledgerByTxid: Map<string, LedgerRow>,
  ledgerByRefid: Map<string, LedgerRow[]>,
  consumed: Set<string>
): NormalizedEvent {
  const externalId = `KRAKEN:order:${orderId}`
  const times = fills.map((fill) => parseKrakenTime(fill.time))
  const occurredAt = new Date(Math.min(...times.map((t) => t.getTime())))
  const first = fills[0]
  const raw: Row = {
    ordertype: first.ordertype,
    pair: first.pair,
    fills: String(fills.length),
    ordertxid: orderId,
  }

  const pair = parsePair('KRAKEN', first.pair)
  if (!pair) {
    return unsupported(
      externalId,
      occurredAt,
      first.pair,
      `Unrecognised trading pair "${first.pair}"`,
      raw
    )
  }
  const { base, quote } = pair

  // Consume the legs first so unsupported orders don't resurface as loose ledger rows.
  const legs: LedgerRow[] = []
  for (const fill of fills) {
    const ids = (fill.ledgers ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    let found = ids
      .map((id) => ledgerByTxid.get(id))
      .filter((row): row is LedgerRow => row !== undefined)
    if (found.length === 0) found = ledgerByRefid.get(fill.txid) ?? []
    for (const leg of found) {
      consumed.add(leg.txid)
      legs.push(leg)
    }
  }

  if (fills.some((fill) => !dec(fill.margin, 'margin').isZero())) {
    return unsupported(
      externalId,
      occurredAt,
      base,
      'Margin trades are not supported',
      raw
    )
  }
  if (!isTradable(base) || !(quote === 'AUD' || quote === 'USD')) {
    return unsupported(
      externalId,
      occurredAt,
      base,
      `${base}/${quote} is not supported — only crypto traded against AUD or USD`,
      raw
    )
  }

  const baseLegs = legs.filter((leg) => leg.asset === base)
  const quoteLegs = legs.filter((leg) => leg.asset === quote)
  if (baseLegs.length === 0 || quoteLegs.length === 0) {
    return unsupported(
      externalId,
      occurredAt,
      base,
      'Ledger entries for this trade are missing from the ledgers CSV',
      raw
    )
  }

  const sum = (rows: LedgerRow[], key: 'amount' | 'fee') =>
    rows.reduce((acc, row) => acc.plus(row[key]), new Decimal(0))
  const baseAmount = sum(baseLegs, 'amount')
  const baseFee = sum(baseLegs, 'fee')
  const quoteAmount = sum(quoteLegs, 'amount')
  const quoteFee = sum(quoteLegs, 'fee')

  const totalVol = fills.reduce(
    (acc, fill) => acc.plus(dec(fill.vol, 'vol')),
    new Decimal(0)
  )
  const totalCost = fills.reduce(
    (acc, fill) => acc.plus(dec(fill.cost, 'cost')),
    new Decimal(0)
  )
  if (totalVol.isZero()) {
    return unsupported(externalId, occurredAt, base, 'Zero volume trade', raw)
  }
  const vwap = totalCost.div(totalVol)
  const side = first.type.toLowerCase()

  if (side === 'buy') {
    const quantity = baseAmount.minus(baseFee)
    const costBase = quoteAmount.abs().plus(quoteFee)
    const gross = vwap.mul(quantity)
    return {
      source: 'KRAKEN',
      externalId,
      kind: 'BUY',
      occurredAt,
      baseAsset: base,
      quoteCurrency: quote as QuoteCurrency,
      quantity: quantity.toFixed(),
      price: price12(vwap),
      grossValue: money(gross),
      fee: money(Decimal.max(0, costBase.minus(gross))),
      feeCurrency: quote,
      raw,
    }
  }
  if (side === 'sell') {
    const quantity = baseAmount.abs().plus(baseFee)
    return {
      source: 'KRAKEN',
      externalId,
      kind: 'SELL',
      occurredAt,
      baseAsset: base,
      quoteCurrency: quote as QuoteCurrency,
      quantity: quantity.toFixed(),
      price: price12(vwap),
      grossValue: money(totalCost),
      fee: money(quoteFee.plus(baseFee.mul(vwap))),
      feeCurrency: quote,
      raw,
    }
  }
  return unsupported(
    externalId,
    occurredAt,
    base,
    `Unknown trade type "${first.type}"`,
    raw
  )
}

function buildInstantEvent(
  refid: string,
  rows: LedgerRow[]
): NormalizedEvent | null {
  const spend = rows.filter((r) => r.type === 'spend')
  const receive = rows.filter((r) => r.type === 'receive')
  const occurredAt = rows[0].time
  const externalId = `KRAKEN:instant:${refid}`
  const raw: Row = { refid }

  if (spend.length !== 1 || receive.length !== 1) {
    return unsupported(
      externalId,
      occurredAt,
      rows[0].asset,
      'Unpaired spend/receive ledger entries',
      raw
    )
  }
  const [out] = spend
  const [inn] = receive

  if (isFiat(out.asset) && isTradable(inn.asset)) {
    if (out.asset !== 'AUD' && out.asset !== 'USD') {
      return unsupported(
        externalId,
        occurredAt,
        inn.asset,
        `${out.asset} purchases are not supported`,
        raw
      )
    }
    const spent = out.amount.abs()
    const price = spent.div(inn.amount)
    const quantity = inn.amount.minus(inn.fee)
    const costBase = spent.plus(out.fee)
    const gross = price.mul(quantity)
    return {
      source: 'KRAKEN',
      externalId,
      kind: 'BUY',
      occurredAt,
      baseAsset: inn.asset,
      quoteCurrency: out.asset,
      quantity: quantity.toFixed(),
      price: price12(price),
      grossValue: money(gross),
      fee: money(Decimal.max(0, costBase.minus(gross))),
      feeCurrency: out.asset,
      raw,
    }
  }
  if (isTradable(out.asset) && isFiat(inn.asset)) {
    if (inn.asset !== 'AUD' && inn.asset !== 'USD') {
      return unsupported(
        externalId,
        occurredAt,
        out.asset,
        `${inn.asset} proceeds are not supported`,
        raw
      )
    }
    const quantity = out.amount.abs().plus(out.fee)
    const price = inn.amount.div(out.amount.abs())
    return {
      source: 'KRAKEN',
      externalId,
      kind: 'SELL',
      occurredAt,
      baseAsset: out.asset,
      quoteCurrency: inn.asset,
      quantity: quantity.toFixed(),
      price: price12(price),
      grossValue: money(inn.amount),
      fee: money(inn.fee.plus(out.fee.mul(price))),
      feeCurrency: inn.asset,
      raw,
    }
  }
  return unsupported(
    externalId,
    occurredAt,
    out.asset,
    'Crypto-to-crypto conversions are not supported',
    raw
  )
}

function buildLooseLedgerEvent(row: LedgerRow): NormalizedEvent | null {
  const externalId = `KRAKEN:ledger:${row.txid}`

  if (row.type === 'deposit' || row.type === 'withdrawal') {
    if (isFiat(row.asset)) return null
    return unsupported(
      externalId,
      row.time,
      row.asset,
      "Crypto transfers aren't supported yet — add these positions manually",
      row.raw
    )
  }
  if (row.type === 'transfer') return null
  if (row.type === 'earn' && IGNORED_EARN_SUBTYPES.has(row.subtype)) return null

  const isReward =
    row.type === 'staking' || (row.type === 'earn' && row.subtype === 'reward')
  if (isReward) {
    if (!isTradable(row.asset)) {
      return unsupported(
        externalId,
        row.time,
        row.asset,
        `${row.asset} rewards are not supported`,
        row.raw
      )
    }
    const net = row.amount.minus(row.fee)
    const raw: Row = { ledgerTxid: row.txid }
    if (row.amountUsd !== null) {
      raw.fmvUsd = row.amountUsd.minus(row.feeUsd ?? 0).toFixed()
    }
    return {
      source: 'KRAKEN',
      externalId,
      kind: 'STAKING_REWARD',
      occurredAt: row.time,
      baseAsset: row.asset,
      quantity: net.toFixed(),
      fee: '0',
      raw,
    }
  }

  return unsupported(
    externalId,
    row.time,
    row.asset,
    `Unsupported Kraken ledger type "${row.type}"${row.subtype ? ` / "${row.subtype}"` : ''}`,
    row.raw
  )
}

/** Parses Kraken's spot `trades.csv` + `ledgers.csv`. Both are required. */
export function parseKrakenCsv(
  tradesCsv: string,
  ledgersCsv: string
): ParseResult {
  const tradeRows = readCsv(tradesCsv, TRADES_REQUIRED, 'trades')
  const ledgers = readCsv(ledgersCsv, LEDGERS_REQUIRED, 'ledgers').map(
    toLedgerRow
  )

  const ledgerByTxid = new Map(ledgers.map((row) => [row.txid, row]))
  const ledgerByRefid = new Map<string, LedgerRow[]>()
  for (const row of ledgers) {
    ledgerByRefid.set(row.refid, [...(ledgerByRefid.get(row.refid) ?? []), row])
  }

  const events: NormalizedEvent[] = []
  const warnings: string[] = []
  const consumed = new Set<string>()

  const orders = new Map<string, Row[]>()
  for (const fill of tradeRows) {
    orders.set(fill.ordertxid, [...(orders.get(fill.ordertxid) ?? []), fill])
  }
  for (const [orderId, fills] of orders) {
    events.push(
      buildOrderEvent(orderId, fills, ledgerByTxid, ledgerByRefid, consumed)
    )
  }

  const instantGroups = new Map<string, LedgerRow[]>()
  const orphanTradeLegs: LedgerRow[] = []
  for (const row of ledgers) {
    if (consumed.has(row.txid)) continue
    if (row.type === 'trade') {
      orphanTradeLegs.push(row)
      continue
    }
    if (row.type === 'spend' || row.type === 'receive') {
      instantGroups.set(row.refid, [
        ...(instantGroups.get(row.refid) ?? []),
        row,
      ])
      continue
    }
    const event = buildLooseLedgerEvent(row)
    if (event) events.push(event)
  }
  for (const [refid, rows] of instantGroups) {
    const event = buildInstantEvent(refid, rows)
    if (event) events.push(event)
  }

  if (orphanTradeLegs.length > 0) {
    warnings.push(
      `${orphanTradeLegs.length} ledger trade entries have no matching row in trades.csv — the trades CSV does not cover this period`
    )
  }

  events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  return { events, warnings, ledgerBalances: computeBalances(ledgers) }
}
