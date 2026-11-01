import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import {
  prepareCashCommand,
  replayCashLedger,
  requireFundedCashLedger,
  resolveCashCommandRetry,
  type CashCommand,
} from './cash-ledger.js'

const now = new Date('2026-10-31T12:00:00Z')
const opening = {
  openingDate: '2026-10-01',
  cashBalances: [{ currency: 'AUD', amount: '10000' }],
}
function trade(
  overrides: Partial<Extract<CashCommand, { kind: 'BUY' | 'SELL' }>> = {}
): CashCommand {
  return {
    accountId: 'a1',
    idempotencyKey: 'buy-1',
    source: { origin: 'MANUAL', reference: 'execution-1' },
    effectiveDate: '2026-10-02',
    sequence: 1,
    kind: 'BUY',
    consideration: { currency: 'AUD', amount: '1000' },
    fees: [{ currency: 'AUD', amount: '10' }],
    transactionIds: ['buy-tx'],
    ...overrides,
  }
}
function capital(kind: 'DEPOSIT' | 'WITHDRAWAL', amount = '100'): CashCommand {
  return {
    accountId: 'a1',
    idempotencyKey: `capital-${kind}`,
    source: { origin: 'MANUAL', reference: `statement-${kind}` },
    effectiveDate: '2026-10-02',
    sequence: 2,
    kind,
    cash: { currency: 'AUD', amount },
  }
}
const prepare = (raw: unknown) => prepareCashCommand(raw, now)
const replay = (commands: unknown[], start = opening) =>
  replayCashLedger('a1', start, commands, now)

describe('cash command preparation', () => {
  it.each([
    ['BUY', '-1000', '-10'],
    ['SELL', '1000', '-10'],
  ] as const)(
    'derives exact %s execution consideration and cash fees',
    (kind, gross, fee) => {
      const prepared = prepare(trade({ kind }))
      expect(prepared.legs).toEqual([
        { currency: 'AUD', amount: gross, role: 'TRADE_CONSIDERATION' },
        { currency: 'AUD', amount: fee, role: 'CASH_FEE' },
      ])
      expect(prepared.payloadHash).toMatch(/^[a-f0-9]{64}$/)
    }
  )
  it.each([
    ['DEPOSIT', '100'],
    ['WITHDRAWAL', '-100'],
  ] as const)(
    'classifies %s as external capital, not trade profit',
    (kind, amount) => {
      expect(prepare(capital(kind)).legs).toEqual([
        { currency: 'AUD', amount, role: 'EXTERNAL_CAPITAL' },
      ])
    }
  )
  it('groups one imported sale execution across parcels without multiplying receipts or fees', () => {
    const command = trade({
      kind: 'SELL',
      source: { origin: 'IMPORT', reference: 'kraken:execution-123' },
      transactionIds: ['sell-p2', 'sell-p1'],
    })
    const prepared = prepare(command)
    expect(prepared.command).toMatchObject({
      transactionIds: ['sell-p1', 'sell-p2'],
    })
    expect(prepared.legs).toHaveLength(2)
    expect(replay([command]).balances[0].endingAmount).toBe('10990')
  })
  it('normalizes amount formatting, fee order and allocation order before hashing', () => {
    const first = prepare(
      trade({
        kind: 'SELL',
        source: { origin: 'IMPORT', reference: 'execution-1' },
        consideration: { currency: 'AUD', amount: '1000.000' },
        transactionIds: ['t2', 't1'],
        fees: [
          { currency: 'USD', amount: '0.100' },
          { currency: 'AUD', amount: '10.00' },
        ],
      })
    )
    const second = prepare(
      trade({
        kind: 'SELL',
        source: { origin: 'IMPORT', reference: 'execution-1' },
        consideration: { currency: 'AUD', amount: '1000' },
        transactionIds: ['t1', 't2'],
        fees: [
          { currency: 'AUD', amount: '10' },
          { currency: 'USD', amount: '0.1' },
        ],
      })
    )
    expect(first).toEqual(second)
  })
  it('preserves the smallest stored cash unit without scientific notation or global Decimal changes', () => {
    const precision = Decimal.precision
    const rounding = Decimal.rounding
    const prepared = prepare(
      trade({
        consideration: { currency: 'AUD', amount: '0.000000000001' },
        fees: [],
      })
    )
    expect(prepared.legs[0].amount).toBe('-0.000000000001')
    expect(Decimal.precision).toBe(precision)
    expect(Decimal.rounding).toBe(rounding)
  })
  it.each([
    null,
    [],
    {},
    { kind: 'DIVIDEND' },
    { ...trade(), accountId: '' },
    { ...trade(), idempotencyKey: ' key ' },
    { ...trade(), idempotencyKey: 'a'.repeat(201) },
    { ...trade(), idempotencyKey: 'bad\nkey' },
    { ...trade(), source: { origin: 'UNKNOWN', reference: 'x' } },
    {
      ...trade(),
      source: { origin: 'IMPORT', reference: '', currency: 'AUD' },
    },
    { ...trade(), effectiveDate: '2026-02-30' },
    { ...trade(), effectiveDate: '2026-11-01' },
    { ...trade(), sequence: 0 },
    { ...trade(), sequence: 1.5 },
    { ...trade(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...trade(), sequence: '1' },
    { ...trade(), transactionIds: [] },
    { ...trade(), transactionIds: ['t1', 't1'] },
    { ...trade(), transactionIds: ['t1', 't2'] },
    { ...trade(), kind: 'SELL', transactionIds: ['t1', 't2'] },
    { ...trade(), transactionIds: new Array(1) },
    { ...trade(), fees: new Array(1) },
    { ...trade(), transactionIds: Array(5001).fill('t') },
    { ...trade(), fees: undefined },
    { ...trade(), fees: Array(21).fill({ currency: 'AUD', amount: '1' }) },
    {
      ...trade(),
      fees: [
        { currency: 'AUD', amount: '1' },
        { currency: 'AUD', amount: '2' },
      ],
    },
    { ...trade(), consideration: { currency: 'aud', amount: '1' } },
    { ...trade(), consideration: { currency: 'BTC', amount: '1' } },
    { ...trade(), consideration: { currency: 'AUD', amount: 1 } },
    { ...trade(), consideration: { currency: 'AUD', amount: '0' } },
    { ...trade(), consideration: { currency: 'AUD', amount: '-1' } },
    { ...trade(), consideration: { currency: 'AUD', amount: '1e2' } },
    { ...trade(), consideration: { currency: 'AUD', amount: 'NaN' } },
    {
      ...trade(),
      consideration: { currency: 'AUD', amount: '0.0000000000001' },
    },
    {
      ...trade(),
      consideration: { currency: 'AUD', amount: '100000000000000000000000000' },
    },
    { ...trade(), fees: [{ currency: 'AUD', amount: '-1' }] },
    { ...trade(), fees: [{ currency: 'AUD', amount: '1', assetUnits: '1' }] },
    { ...trade(), cash: { currency: 'AUD', amount: '1' } },
    { ...capital('DEPOSIT'), transactionIds: ['t1'] },
    { ...capital('DEPOSIT'), cash: { currency: 'AUD', amount: '0' } },
    { ...trade(), kind: 'FX_CONVERSION' },
  ])(
    'rejects invalid/unsupported commands without silently normalizing economic meaning %#',
    (raw) => {
      expect(() => prepare(raw)).toThrow()
      try {
        prepare(raw)
      } catch (error) {
        expect(error).toMatchObject({ status: 400 })
      }
    }
  )
  it('takes an independent normalized snapshot of command data', () => {
    const raw = trade()
    const prepared = prepare(raw)
    if (raw.kind !== 'BUY') throw new Error('Invalid fixture')
    raw.consideration.amount = '2000'
    raw.fees[0].amount = '100'
    raw.transactionIds.push('new-id')
    expect(prepared.command).toMatchObject({
      consideration: { amount: '1000' },
      fees: [{ amount: '10' }],
      transactionIds: ['buy-tx'],
    })
  })
})

describe('effective-dated cash ledger replay', () => {
  it('matches the reference opening, buy, partial sale and full sale cash amounts', () => {
    const commands = [
      trade(),
      trade({
        kind: 'SELL',
        effectiveDate: '2026-10-03',
        idempotencyKey: 'partial',
        source: { origin: 'MANUAL', reference: 'partial' },
        transactionIds: ['partial-tx'],
        consideration: { currency: 'AUD', amount: '480' },
        fees: [{ currency: 'AUD', amount: '5' }],
      }),
      trade({
        kind: 'SELL',
        effectiveDate: '2026-10-04',
        idempotencyKey: 'full',
        source: { origin: 'MANUAL', reference: 'full' },
        transactionIds: ['full-tx'],
        consideration: { currency: 'AUD', amount: '720' },
        fees: [{ currency: 'AUD', amount: '5' }],
      }),
    ]
    const result = replay(commands)
    expect(result.funded).toBe(true)
    expect(result.activity.map((row) => row.changes[0].balanceAfter)).toEqual([
      '8990',
      '9465',
      '10180',
    ])
    expect(result.balances).toEqual([
      {
        currency: 'AUD',
        openingAmount: '10000',
        endingAmount: '10180',
        minimumAmount: '8990',
        netExternalContribution: '0',
      },
    ])
    expect(() => requireFundedCashLedger(result)).not.toThrow()
  })
  it('keeps deposits/withdrawals separate from investment gain', () => {
    const result = replay([
      capital('DEPOSIT', '200'),
      {
        ...capital('WITHDRAWAL', '50'),
        sequence: 3,
      },
    ])
    expect(result.balances[0]).toMatchObject({
      endingAmount: '10150',
      netExternalContribution: '150',
    })
  })
  it('rejects spending that a later deposit covers only in the ending balance', () => {
    const result = replay(
      [trade(), { ...capital('DEPOSIT', '2000'), effectiveDate: '2026-10-03' }],
      { ...opening, cashBalances: [{ currency: 'AUD', amount: '100' }] }
    )
    expect(result.balances[0]).toMatchObject({
      endingAmount: '1090',
      minimumAmount: '-910',
    })
    expect(result.fundingIssues).toEqual([
      {
        currency: 'AUD',
        idempotencyKey: 'buy-1',
        effectiveDate: '2026-10-02',
        sequence: 1,
        balance: '-910',
      },
    ])
    expect(result.funded).toBe(false)
    expect(() => requireFundedCashLedger(result)).toThrow(
      'Insufficient recorded cash'
    )
    try {
      requireFundedCashLedger(result)
    } catch (error) {
      expect(error).toMatchObject({
        status: 422,
        details: result.fundingIssues,
      })
    }
  })
  it('sorts by persisted date/sequence, never by deposit/trade type or amount', () => {
    const start = {
      ...opening,
      cashBalances: [{ currency: 'AUD', amount: '0' }],
    }
    const funded = replay(
      [
        { ...trade(), sequence: 2 },
        { ...capital('DEPOSIT', '1010'), sequence: 1 },
      ],
      start
    )
    expect(funded.funded).toBe(true)
    expect(funded.activity.map((row) => row.kind)).toEqual(['DEPOSIT', 'BUY'])
    const unfunded = replay([capital('DEPOSIT', '1010'), trade()], start)
    expect(unfunded.funded).toBe(false)
    expect(unfunded.balances[0].endingAmount).toBe('0')
  })
  it('requires sufficient cash for fees exceeding a sale receipt, but credits gross atomically', () => {
    const zero = {
      ...opening,
      cashBalances: [{ currency: 'AUD', amount: '0' }],
    }
    expect(replay([trade({ kind: 'SELL' })], zero).funded).toBe(true)
    const result = replay(
      [
        trade({
          kind: 'SELL',
          consideration: { currency: 'AUD', amount: '1' },
          fees: [{ currency: 'AUD', amount: '2' }],
        }),
      ],
      zero
    )
    expect(result.funded).toBe(false)
    expect(result.balances[0].endingAmount).toBe('-1')
  })
  it('requires fee-currency funding without auto-converting available AUD', () => {
    const result = replay(
      [trade({ fees: [{ currency: 'USD', amount: '2' }] })],
      {
        ...opening,
        cashBalances: [
          { currency: 'AUD', amount: '10000' },
          { currency: 'USD', amount: '1' },
        ],
      }
    )
    expect(result.funded).toBe(false)
    expect(result.fundingIssues[0]).toMatchObject({
      currency: 'USD',
      balance: '-1',
    })
    expect(result.balances[0].endingAmount).toBe('9000')
  })
  it.each(['BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL'] as const)(
    'never assumes a missing currency balance is zero for %s',
    (kind) => {
      const command =
        kind === 'BUY' || kind === 'SELL'
          ? trade({
              kind,
              consideration: { currency: 'USD', amount: '1' },
              fees: [],
            })
          : { ...capital(kind), cash: { currency: 'USD', amount: '1' } }
      expect(() => replay([command])).toThrow(
        'Missing explicit opening cash balance for USD'
      )
    }
  )
  it('requires explicit cash even for a fee reported as zero in another currency', () => {
    expect(() =>
      replay([trade({ fees: [{ currency: 'USD', amount: '0' }] })])
    ).toThrow('Missing explicit opening cash balance for USD')
  })
  it.each(['2026-10-01', '2026-09-30'])(
    'does not post included pre-boundary trades again (%s)',
    (date) => {
      expect(() => replay([trade({ effectiveDate: date })])).toThrow(
        'opening boundary'
      )
    }
  )
  it.each(
    [
      [trade(), trade()],
      [trade(), trade({ idempotencyKey: 'other', transactionIds: ['other'] })],
      [
        trade(),
        trade({
          idempotencyKey: 'other',
          source: { origin: 'MANUAL', reference: 'other' },
          sequence: 2,
        }),
      ],
      [
        trade(),
        trade({
          idempotencyKey: 'other',
          source: { origin: 'MANUAL', reference: 'other' },
          transactionIds: ['other'],
        }),
      ],
      [trade({ accountId: 'another-account' })],
    ].map((commands) => ({ commands }))
  )(
    'rejects duplicate identities, links, intraday slots or mixed accounts %#',
    ({ commands }) => {
      expect(() => replay(commands)).toThrow()
      try {
        replay(commands)
      } catch (error) {
        expect(error).toMatchObject({ status: 409 })
      }
    }
  )
  it('allows source references from different namespaces without treating them as the same execution', () => {
    const result = replay([
      trade(),
      trade({
        source: { origin: 'IMPORT', reference: 'execution-1' },
        sequence: 2,
        idempotencyKey: 'import',
        transactionIds: ['import-tx'],
      }),
    ])
    expect(result.balances[0].endingAmount).toBe('7980')
  })
  it('preserves full 38-digit cash precision across repeated tiny debits', () => {
    const result = replay(
      [
        trade({
          consideration: { currency: 'AUD', amount: '0.000000000001' },
          fees: [],
        }),
        { ...capital('WITHDRAWAL', '0.000000000001') },
      ],
      {
        ...opening,
        cashBalances: [
          {
            currency: 'AUD',
            amount: '99999999999999999999999999.999999999999',
          },
        ],
      }
    )
    expect(result.balances[0].endingAmount).toBe(
      '99999999999999999999999999.999999999997'
    )
  })
  it('rejects summed cash overflow even when each input fits storage', () => {
    expect(() =>
      replay([capital('DEPOSIT', '1')], {
        ...opening,
        cashBalances: [
          { currency: 'AUD', amount: '99999999999999999999999999' },
        ],
      })
    ).toThrow('exceeds Decimal(38,12)')
    expect(() =>
      replay([
        trade({
          consideration: {
            currency: 'AUD',
            amount: '99999999999999999999999999',
          },
          fees: [{ currency: 'AUD', amount: '2' }],
        }),
      ])
    ).toThrow('exceeds Decimal(38,12)')
  })
  it('returns explicit unchanged balances for an empty ledger and never mutates inputs', () => {
    const commands = [trade()]
    const original = JSON.stringify({ opening, commands })
    replay(commands)
    expect(JSON.stringify({ opening, commands })).toBe(original)
    expect(replay([])).toMatchObject({
      funded: true,
      activity: [],
      fundingIssues: [],
      balances: [{ endingAmount: '10000', netExternalContribution: '0' }],
    })
  })
  it('fails the replay bound instead of returning partial balances', () => {
    expect(() => replay(Array(50001).fill(trade()))).toThrow('limited to 50000')
  })
  it('accepts the exact 50000-operation limit with complete balances and activity', () => {
    const commands = Array.from({ length: 50000 }, (_, index) => ({
      ...capital('DEPOSIT', '0.000000000001'),
      idempotencyKey: `deposit-${index}`,
      source: { origin: 'MANUAL', reference: `deposit-${index}` },
      sequence: index + 1,
    }))
    const result = replay(commands)
    expect(result.activity).toHaveLength(50000)
    expect(result.balances[0].endingAmount).toBe('10000.00000005')
    expect(result.balances[0].netExternalContribution).toBe('0.00000005')
    expect(result.funded).toBe(true)
  }, 20000)
  it('accepts exactly 50000 parcel links and rejects one more without partial execution cash', () => {
    const commands = Array.from({ length: 10 }, (_, index) =>
      trade({
        kind: 'SELL',
        idempotencyKey: `sell-${index}`,
        source: { origin: 'IMPORT', reference: `sell-${index}` },
        sequence: index + 1,
        transactionIds: Array.from(
          { length: 5000 },
          (_, parcel) => `tx-${index}-${parcel}`
        ),
      })
    )
    expect(replay(commands).activity).toHaveLength(10)
    expect(() =>
      replay([
        ...commands,
        trade({
          idempotencyKey: 'buy-extra',
          source: { origin: 'MANUAL', reference: 'extra' },
          transactionIds: ['extra'],
          sequence: 11,
        }),
      ])
    ).toThrow('limited to 50000 transaction links')
  })
  it('accepts exactly 100000 posting legs and rejects one more', () => {
    const currencies = Intl.supportedValuesOf('currency').slice(0, 20)
    const start = {
      ...opening,
      cashBalances: currencies.map((currency) => ({ currency, amount: '0' })),
    }
    const commands = Array.from({ length: 5000 }, (_, index) =>
      trade({
        kind: 'SELL',
        idempotencyKey: `sell-${index}`,
        source: { origin: 'MANUAL', reference: `sell-${index}` },
        sequence: index + 1,
        transactionIds: [`tx-${index}`],
        consideration: { currency: currencies[0], amount: '1' },
        fees: currencies
          .slice(0, 19)
          .map((currency) => ({ currency, amount: '0' })),
      })
    )
    expect(replay(commands, start).balances[0].endingAmount).toBe('5000')
    const last = commands[commands.length - 1]
    if (last.kind !== 'SELL') throw new Error('Invalid fixture')
    expect(() =>
      replay(
        [
          ...commands.slice(0, -1),
          {
            ...last,
            fees: currencies.map((currency) => ({ currency, amount: '0' })),
          },
        ],
        start
      )
    ).toThrow('100000 posting legs')
  }, 20000)
  it('rejects sparse command lists explicitly instead of silently skipping economic events', () => {
    expect(() => replay(new Array(1))).toThrow(
      'Accounting command must be an object'
    )
  })
})

describe('account-scoped command retry identity', () => {
  it('returns new/reuse only for the same account, key and normalized payload', () => {
    const prepared = prepare(trade())
    expect(resolveCashCommandRetry(prepared, null)).toBe('NEW')
    expect(
      resolveCashCommandRetry(prepared, {
        accountId: 'a1',
        idempotencyKey: 'buy-1',
        payloadHash: prepared.payloadHash,
      })
    ).toBe('REUSE')
  })
  it.each([
    { accountId: 'a2', idempotencyKey: 'buy-1' },
    { accountId: 'a1', idempotencyKey: 'other-key' },
  ])(
    'rejects a cached result outside the exact account/key scope %#',
    (metadata) => {
      const prepared = prepare(trade())
      expect(() =>
        resolveCashCommandRetry(prepared, {
          ...metadata,
          payloadHash: prepared.payloadHash,
        })
      ).toThrow('different accounting content')
    }
  )
  it('conflicts on changed money, execution, allocation links or ordering under the same key', () => {
    const original = prepare(trade())
    const existing = {
      accountId: 'a1',
      idempotencyKey: 'buy-1',
      payloadHash: original.payloadHash,
    }
    for (const command of [
      trade({ consideration: { currency: 'AUD', amount: '1001' } }),
      trade({ effectiveDate: '2026-10-03' }),
      trade({ sequence: 2 }),
      trade({ transactionIds: ['another-tx'] }),
      trade({ source: { origin: 'MANUAL', reference: 'another-execution' } }),
    ]) {
      expect(() => resolveCashCommandRetry(prepare(command), existing)).toThrow(
        'different accounting content'
      )
    }
  })
})
