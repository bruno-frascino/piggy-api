import { describe, expect, it } from 'vitest'
import {
  LEDGER_HEADER,
  TRADES_HEADER,
  ledgerRow,
  loadKrakenFixture,
  tradeRow,
} from '../kraken-fixture.js'
import {
  ImportParseError,
  parseKrakenCsv,
  parseKrakenTime,
} from './kraken-csv.js'

const emptyTrades = `${TRADES_HEADER}\n`
const ledgers = (...rows: string[]) => `${LEDGER_HEADER}\n${rows.join('\n')}\n`

describe('parseKrakenTime', () => {
  it('parses UTC times with variable fraction digits', () => {
    expect(parseKrakenTime('2025-10-30 16:01:25.1493').toISOString()).toBe(
      '2025-10-30T16:01:25.149Z'
    )
    expect(parseKrakenTime('2025-10-28 22:58:29').toISOString()).toBe(
      '2025-10-28T22:58:29.000Z'
    )
  })

  it('rejects garbage', () => {
    expect(() => parseKrakenTime('yesterday')).toThrow(ImportParseError)
  })
})

describe('parseKrakenCsv — real (anonymised) export', () => {
  const fixture = loadKrakenFixture()
  const result = parseKrakenCsv(fixture.trades, fixture.ledgers)
  const byKind = (kind: string) => result.events.filter((e) => e.kind === kind)

  it('groups the 28 fills into 5 buys and 5 sells, one event per order', () => {
    expect(byKind('BUY')).toHaveLength(5)
    expect(byKind('SELL')).toHaveLength(5)
    expect(result.events.filter((e) => e.kind === 'UNSUPPORTED')).toHaveLength(
      0
    )
    expect(result.warnings).toEqual([])
  })

  it('derives the buy quantity net of the base-asset fee (ledger-driven)', () => {
    const buy = byKind('BUY')[0]
    expect(buy.baseAsset).toBe('SOL')
    expect(buy.quoteCurrency).toBe('AUD')
    // trades.csv vol is 12.43781094; Kraken kept 0.03109453 SOL as the fee
    expect(buy.quantity).toBe('12.40671641')
    expect(Number(buy.price)).toBeCloseTo(281.4, 4)
    // price × quantity + fee == AUD actually debited
    expect(Number(buy.grossValue) + Number(buy.fee)).toBeCloseTo(3500, 2)
    expect(Number(buy.fee)).toBeCloseTo(8.75, 2)
    expect(buy.occurredAt.toISOString()).toBe('2025-10-30T16:01:25.149Z')
    expect(buy.raw.ordertype).toBe('limit')
  })

  it('takes the sell quantity and AUD fee from the ledger', () => {
    const sell = byKind('SELL')[0]
    expect(sell.quantity).toBe('12.40671641')
    expect(Number(sell.grossValue)).toBeCloseTo(3507.67343, 2)
    expect(Number(sell.fee)).toBeCloseTo(9.18618, 2)
    expect(sell.raw.ordertype).toBe('stop limit')
  })

  it('merges multi-fill orders using the earliest fill time', () => {
    const nineFills = result.events.find((e) => e.raw.fills === '9')
    expect(nineFills?.kind).toBe('SELL')
    expect(nineFills?.occurredAt.toISOString()).toBe('2026-06-01T13:47:11.957Z')
  })

  it('turns every earn/reward row into a staking event with a USD value', () => {
    const rewards = byKind('STAKING_REWARD')
    expect(rewards).toHaveLength(68)
    expect(new Set(rewards.map((r) => r.baseAsset))).toEqual(
      new Set(['SOL', 'BABY'])
    )
    expect(rewards.every((r) => Number(r.raw.fmvUsd) > 0)).toBe(true)
  })

  it('ignores fiat deposits and internal wallet moves', () => {
    expect(result.events).toHaveLength(78)
  })

  it('reports the last ledger balance per asset across wallets', () => {
    expect(result.ledgerBalances).toEqual({
      SOL: '0.0008646593',
      BTC: '0',
      BABY: '6.58872',
    })
  })
})

describe('parseKrakenCsv — validation', () => {
  it('rejects a trades file with the wrong header', () => {
    expect(() =>
      parseKrakenCsv(
        'a,b,c\n1,2,3\n',
        ledgers(
          ledgerRow({
            txid: 'L1',
            refid: 'R',
            time: '2026-01-01 00:00:00',
            type: 'deposit',
            asset: 'AUD',
            amount: '1',
          })
        )
      )
    ).toThrow(/trades export.*Missing columns/)
  })

  it('rejects a ledgers file with the wrong header', () => {
    expect(() => parseKrakenCsv(emptyTrades, 'txid,foo\n1,2\n')).toThrow(
      /ledgers export.*Missing columns/
    )
  })

  it('accepts header-only files', () => {
    const result = parseKrakenCsv(emptyTrades, `${LEDGER_HEADER}\n`)
    expect(result.events).toEqual([])
  })
})

// The user's export has none of the rows below; these fixtures are SYNTHETIC,
// built from Kraken's documented format using the verified 16-column header.
describe('parseKrakenCsv — synthetic fixtures', () => {
  it('maps Buy Crypto spend/receive pairs to an instant BUY', () => {
    const result = parseKrakenCsv(
      emptyTrades,
      ledgers(
        ledgerRow({
          txid: 'L1',
          refid: 'INST1',
          time: '2026-02-01 03:00:00',
          type: 'spend',
          asset: 'ZAUD',
          amount: '-1000',
          fee: '10',
          balance: '0',
        }),
        ledgerRow({
          txid: 'L2',
          refid: 'INST1',
          time: '2026-02-01 03:00:00',
          type: 'receive',
          asset: 'XXBT',
          amount: '0.01',
          balance: '0.01',
        })
      )
    )
    const [buy] = result.events
    expect(buy).toMatchObject({
      kind: 'BUY',
      externalId: 'KRAKEN:instant:INST1',
      baseAsset: 'BTC',
      quoteCurrency: 'AUD',
      quantity: '0.01',
    })
    expect(Number(buy.price)).toBeCloseTo(100000, 6)
    expect(Number(buy.grossValue) + Number(buy.fee)).toBeCloseTo(1010, 6)
  })

  it('maps crypto spend / fiat receive to an instant SELL', () => {
    const result = parseKrakenCsv(
      emptyTrades,
      ledgers(
        ledgerRow({
          txid: 'L1',
          refid: 'INST2',
          time: '2026-02-01 03:00:00',
          type: 'spend',
          asset: 'XXBT',
          amount: '-0.01',
        }),
        ledgerRow({
          txid: 'L2',
          refid: 'INST2',
          time: '2026-02-01 03:00:00',
          type: 'receive',
          asset: 'ZUSD',
          amount: '700',
          fee: '7',
        })
      )
    )
    expect(result.events[0]).toMatchObject({
      kind: 'SELL',
      baseAsset: 'BTC',
      quoteCurrency: 'USD',
      quantity: '0.01',
      grossValue: '700',
      fee: '7',
    })
  })

  it('flags crypto-to-crypto conversions as unsupported', () => {
    const result = parseKrakenCsv(
      emptyTrades,
      ledgers(
        ledgerRow({
          txid: 'L1',
          refid: 'CV',
          time: '2026-02-01 03:00:00',
          type: 'spend',
          asset: 'XXBT',
          amount: '-0.01',
        }),
        ledgerRow({
          txid: 'L2',
          refid: 'CV',
          time: '2026-02-01 03:00:00',
          type: 'receive',
          asset: 'XETH',
          amount: '0.3',
        })
      )
    )
    expect(result.events[0].kind).toBe('UNSUPPORTED')
    expect(result.events[0].warning).toMatch(/Crypto-to-crypto/)
  })

  it('reports crypto deposits and withdrawals as unsupported, ignores fiat', () => {
    const result = parseKrakenCsv(
      emptyTrades,
      ledgers(
        ledgerRow({
          txid: 'D1',
          refid: 'R1',
          time: '2026-02-01 03:00:00',
          type: 'deposit',
          asset: 'XXBT',
          amount: '0.5',
        }),
        ledgerRow({
          txid: 'W1',
          refid: 'R2',
          time: '2026-02-02 03:00:00',
          type: 'withdrawal',
          asset: 'XXBT',
          amount: '-0.2',
          fee: '0.0001',
        }),
        ledgerRow({
          txid: 'F1',
          refid: 'R3',
          time: '2026-02-03 03:00:00',
          type: 'deposit',
          asset: 'ZAUD',
          amount: '100',
        })
      )
    )
    expect(result.events.map((e) => [e.kind, e.warning])).toEqual([
      [
        'UNSUPPORTED',
        "Crypto transfers aren't supported yet — add these positions manually",
      ],
      [
        'UNSUPPORTED',
        "Crypto transfers aren't supported yet — add these positions manually",
      ],
    ])
  })

  it('maps staking-type rows and subtracts the commission', () => {
    const result = parseKrakenCsv(
      emptyTrades,
      ledgers(
        ledgerRow({
          txid: 'S1',
          refid: 'R1',
          time: '2026-02-01 03:00:00',
          type: 'staking',
          asset: 'DOT.S',
          amount: '0.1',
          fee: '0.01',
          amountusd: '0.5',
          feeusd: '0.05',
        })
      )
    )
    expect(result.events[0]).toMatchObject({
      kind: 'STAKING_REWARD',
      baseAsset: 'DOT',
      quantity: '0.09',
    })
    expect(result.events[0].raw.fmvUsd).toBe('0.45')
  })

  it('flags margin trades and unknown ledger types as unsupported', () => {
    const result = parseKrakenCsv(
      `${TRADES_HEADER}\n${tradeRow({ txid: 'T1', ordertxid: 'O1', pair: 'XBT/AUD', time: '2026-02-01 03:00:00.1', type: 'buy', price: '100', cost: '100', fee: '1', vol: '1', margin: '5.0', ledgers: 'L1,L2' })}\n`,
      ledgers(
        ledgerRow({
          txid: 'L1',
          refid: 'T1',
          time: '2026-02-01 03:00:00',
          type: 'trade',
          asset: 'XXBT',
          amount: '1',
        }),
        ledgerRow({
          txid: 'L2',
          refid: 'T1',
          time: '2026-02-01 03:00:00',
          type: 'trade',
          asset: 'ZAUD',
          amount: '-100',
        }),
        ledgerRow({
          txid: 'L3',
          refid: 'X',
          time: '2026-02-02 03:00:00',
          type: 'rollover',
          asset: 'ZAUD',
          amount: '-1',
        })
      )
    )
    expect(result.events.map((e) => [e.kind, e.warning])).toEqual([
      ['UNSUPPORTED', 'Margin trades are not supported'],
      ['UNSUPPORTED', 'Unsupported Kraken ledger type "rollover"'],
    ])
  })

  it('flags crypto/crypto and stablecoin pairs and warns about uncovered ledger trades', () => {
    const result = parseKrakenCsv(
      `${TRADES_HEADER}\n${tradeRow({ txid: 'T1', ordertxid: 'O1', pair: 'ETH/XBT', time: '2026-02-01 03:00:00.1', type: 'buy', price: '0.03', cost: '0.03', fee: '0', vol: '1', ledgers: 'L1,L2' })}\n`,
      ledgers(
        ledgerRow({
          txid: 'L1',
          refid: 'T1',
          time: '2026-02-01 03:00:00',
          type: 'trade',
          asset: 'XETH',
          amount: '1',
        }),
        ledgerRow({
          txid: 'L2',
          refid: 'T1',
          time: '2026-02-01 03:00:00',
          type: 'trade',
          asset: 'XXBT',
          amount: '-0.03',
        }),
        ledgerRow({
          txid: 'L9',
          refid: 'T9',
          time: '2026-02-05 03:00:00',
          type: 'trade',
          asset: 'SOL',
          amount: '1',
        })
      )
    )
    expect(result.events).toHaveLength(1)
    expect(result.events[0].warning).toMatch(/ETH\/BTC is not supported/)
    expect(result.warnings[0]).toMatch(
      /1 ledger trade entries have no matching row/
    )
  })

  it('treats a sell charged in the base asset as a larger disposal', () => {
    const result = parseKrakenCsv(
      `${TRADES_HEADER}\n${tradeRow({ txid: 'T1', ordertxid: 'O1', pair: 'SOL/AUD', time: '2026-02-01 03:00:00.1', type: 'sell', price: '200', cost: '1000', fee: '2.5', vol: '5', ledgers: 'L1,L2' })}\n`,
      ledgers(
        ledgerRow({
          txid: 'L1',
          refid: 'T1',
          time: '2026-02-01 03:00:00',
          type: 'trade',
          asset: 'SOL',
          amount: '-5',
          fee: '0.0125',
        }),
        ledgerRow({
          txid: 'L2',
          refid: 'T1',
          time: '2026-02-01 03:00:00',
          type: 'trade',
          asset: 'ZAUD',
          amount: '1000',
        })
      )
    )
    expect(result.events[0]).toMatchObject({
      kind: 'SELL',
      quantity: '5.0125',
      grossValue: '1000',
      fee: '2.5',
    })
  })
})
