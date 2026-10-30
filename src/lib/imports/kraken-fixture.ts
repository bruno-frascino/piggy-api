import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'kraken'
)

/** Anonymised copy of a real Kraken export (ids replaced, amounts and times kept). */
export function loadKrakenFixture() {
  return {
    trades: readFileSync(join(dir, 'trades.csv'), 'utf8'),
    ledgers: readFileSync(join(dir, 'ledgers.csv'), 'utf8'),
  }
}

export const LEDGER_HEADER =
  'txid,refid,time,type,subtype,aclass,subclass,asset,wallet,amount,fee,balance,amountusd,feeusd,balanceusd,feecurrency'
export const TRADES_HEADER =
  'txid,ordertxid,pair,aclass,subclass,time,type,ordertype,price,cost,fee,vol,margin,misc,ledgers,posttxid,posstatuscode,cprice,ccost,cfee,cvol,cmargin,net,trades'

/** Builds a ledger CSV row (synthetic fixtures) with the real 16-column layout. */
export function ledgerRow(r: {
  txid: string
  refid: string
  time: string
  type: string
  subtype?: string
  asset: string
  wallet?: string
  amount: string
  fee?: string
  balance?: string
  amountusd?: string
  feeusd?: string
}) {
  return [
    r.txid,
    r.refid,
    r.time,
    r.type,
    r.subtype ?? '',
    'currency',
    'crypto',
    r.asset,
    r.wallet ?? 'spot / main',
    r.amount,
    r.fee ?? '0',
    r.balance ?? '0',
    r.amountusd ?? '',
    r.feeusd ?? '',
    '',
    '',
  ].join(',')
}

/** Builds a trades CSV row (synthetic fixtures). */
export function tradeRow(r: {
  txid: string
  ordertxid: string
  pair: string
  time: string
  type: 'buy' | 'sell'
  ordertype?: string
  price: string
  cost: string
  fee: string
  vol: string
  margin?: string
  ledgers: string
}) {
  return [
    r.txid,
    r.ordertxid,
    r.pair,
    'forex',
    'crypto',
    r.time,
    r.type,
    r.ordertype ?? 'limit',
    r.price,
    r.cost,
    r.fee,
    r.vol,
    r.margin ?? '0.00000',
    '',
    `"${r.ledgers}"`,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ].join(',')
}
