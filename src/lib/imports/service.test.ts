import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  batchFindFirst: vi.fn(),
  batchCreate: vi.fn(),
  batchUpdate: vi.fn(),
  eventFindMany: vi.fn(),
  eventFindFirst: vi.fn(),
  eventCreateMany: vi.fn(),
  eventUpdate: vi.fn(),
  eventUpdateMany: vi.fn(),
  eventDeleteMany: vi.fn(),
  eventCount: vi.fn(),
  positionFindMany: vi.fn(),
  positionFindUnique: vi.fn(),
  positionCreate: vi.fn(),
  positionUpdate: vi.fn(),
  transactionCreate: vi.fn(),
  findOrCreateAsset: vi.fn(),
  recompute: vi.fn(),
  fx: vi.fn(),
  closes: vi.fn(),
  drawdown: vi.fn(),
  runUp: vi.fn(),
  saveHistory: vi.fn(),
  queryRaw: vi.fn(),
  accountFindFirst: vi.fn(),
  cashLedgerFindUnique: vi.fn(),
  beginLiveImportPosting: vi.fn(),
  finishLiveImportPosting: vi.fn(),
}))

vi.mock('../prisma.js', () => {
  const tx = {
    $queryRaw: m.queryRaw,
    accountCashLedger: { findUnique: m.cashLedgerFindUnique },
    tradingAccount: { findFirst: m.accountFindFirst },
    importBatch: {
      findFirst: m.batchFindFirst,
      create: m.batchCreate,
      update: m.batchUpdate,
    },
    importedEvent: {
      findFirst: m.eventFindFirst,
      findMany: m.eventFindMany,
      createMany: m.eventCreateMany,
      update: m.eventUpdate,
      updateMany: m.eventUpdateMany,
      deleteMany: m.eventDeleteMany,
      count: m.eventCount,
    },
    position: { create: m.positionCreate, findMany: m.positionFindMany },
    transaction: { create: m.transactionCreate },
  }
  return {
    prisma: {
      importBatch: { findFirst: m.batchFindFirst },
      importedEvent: {
        findMany: m.eventFindMany,
        findFirst: m.eventFindFirst,
        update: m.eventUpdate,
      },
      position: {
        findMany: m.positionFindMany,
        findUnique: m.positionFindUnique,
        update: m.positionUpdate,
      },
      accountCashLedger: { findUnique: m.cashLedgerFindUnique },
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    },
  }
})
vi.mock('../position-service.js', () => ({
  findOrCreateAsset: m.findOrCreateAsset,
  recomputePositionFromTransactions: m.recompute,
}))
vi.mock('../draft-cash-ledger.js', () => ({
  beginLiveImportPosting: m.beginLiveImportPosting,
}))
vi.mock('../fx-rates.js', () => ({ getHistoricalFxRateToAud: m.fx }))
vi.mock('../crypto/pricing.js', () => ({ getCryptoDailyCloses: m.closes }))
vi.mock('../historical-drawdown.js', () => ({
  fetchHistoricalMaxDrawdown: m.drawdown,
  fetchHistoricalMaxRunUp: m.runUp,
}))
vi.mock('../position-derived-values.js', () => ({
  savePositionHistory: m.saveHistory,
}))

import {
  ImportError,
  commitBatch,
  createImportBatch,
  discardBatch,
  planBatch,
  saveResolution,
} from './service.js'
import {
  LEDGER_HEADER,
  TRADES_HEADER,
  loadKrakenFixture,
} from './kraken-fixture.js'

const fixture = loadKrakenFixture()
const files = [
  { kind: 'trades' as const, fileName: 't.csv', content: fixture.trades },
  { kind: 'ledgers' as const, fileName: 'l.csv', content: fixture.ledgers },
]

function eventRow(overrides: Record<string, unknown>) {
  return {
    id: 'e1',
    batchId: 'b1',
    userId: 'u1',
    source: 'KRAKEN',
    externalId: 'KRAKEN:order:X',
    kind: 'BUY',
    status: 'PENDING',
    occurredAt: new Date('2026-01-10T01:00:00Z'),
    baseAsset: 'BTC',
    quoteCurrency: 'AUD',
    quantity: { toFixed: () => '1' },
    price: { toFixed: () => '100' },
    grossValue: { toFixed: () => '100' },
    fee: { toFixed: () => '1' },
    feeCurrency: 'AUD',
    resolution: null,
    raw: { ordertype: 'limit' },
    warning: null,
    ...overrides,
  }
}

const batch = {
  id: 'b1',
  userId: 'u1',
  accountId: 'acc1',
  status: 'PENDING_REVIEW',
  meta: {},
}

beforeEach(() => {
  vi.resetAllMocks()
  m.batchFindFirst.mockResolvedValue(batch)
  m.positionFindMany.mockResolvedValue([])
  m.fx.mockResolvedValue({ rate: 1.5, source: 'RBA' })
  m.closes.mockResolvedValue(new Map())
  m.findOrCreateAsset.mockResolvedValue({ id: 'asset1' })
  m.eventCount.mockResolvedValue(0)
  m.positionCreate.mockResolvedValue({ id: 'pos1' })
  m.drawdown.mockResolvedValue(null)
  m.runUp.mockResolvedValue(null)
  m.queryRaw.mockResolvedValue([{ id: 'acc1' }])
  m.accountFindFirst.mockResolvedValue({ isDemo: false, status: 'ACTIVE' })
  m.cashLedgerFindUnique.mockResolvedValue(null)
  m.beginLiveImportPosting.mockResolvedValue(m.finishLiveImportPosting)
  m.finishLiveImportPosting.mockResolvedValue(undefined)
  m.recompute.mockResolvedValue({ id: 'pos1' })
})

describe('createImportBatch', () => {
  const params = { userId: 'u1', accountId: 'acc1', source: 'KRAKEN' as const }

  it('requires both files', async () => {
    await expect(
      createImportBatch({ ...params, files: [files[0]] })
    ).rejects.toMatchObject({ status: 400, message: /both the trades CSV/ })
  })

  it('rejects unsupported sources', async () => {
    await expect(
      createImportBatch({ ...params, source: 'BINANCE', files })
    ).rejects.toBeInstanceOf(ImportError)
  })

  it('turns an unrecognised header into a 400', async () => {
    await expect(
      createImportBatch({
        ...params,
        files: [
          { kind: 'trades', fileName: 't.csv', content: 'a,b\n1,2\n' },
          { kind: 'ledgers', fileName: 'l.csv', content: LEDGER_HEADER + '\n' },
        ],
      })
    ).rejects.toMatchObject({ status: 400, message: /Missing columns/ })
  })

  it('stores every parsed event in one batch with the ledger balances', async () => {
    m.eventFindMany.mockResolvedValue([])
    m.batchCreate.mockResolvedValue({ id: 'b9' })

    const result = await createImportBatch({ ...params, files })

    expect(result).toMatchObject({ batchId: 'b9', duplicates: 0 })
    const batchData = m.batchCreate.mock.calls[0][0].data
    expect(batchData).toMatchObject({
      userId: 'u1',
      accountId: 'acc1',
      source: 'KRAKEN',
      method: 'CSV',
      fileNames: ['t.csv', 'l.csv'],
    })
    expect(batchData.meta.ledgerBalances.SOL).toBe('0.0008646593')
    const rows = m.eventCreateMany.mock.calls[0][0].data
    expect(rows).toHaveLength(78)
    const buy = rows.find((r: { kind: string }) => r.kind === 'BUY')
    expect(buy).toMatchObject({ exchangeCode: 'KRAKEN', quoteCurrency: 'AUD' })
  })

  it.each(['PENDING_REVIEW', 'PARTIALLY_APPLIED', 'COMMITTED'])(
    'links to the existing %s batch when every event was uploaded before',
    async (status) => {
      m.eventFindMany.mockImplementation(
        async (args: { where: { externalId: { in: string[] } } }) =>
          args.where.externalId.in.map((externalId, i) => ({
            id: 'old' + i,
            externalId,
            status: 'APPLIED',
            occurredAt: new Date('2026-01-01T00:00:00Z'),
            batch: {
              id: 'previous',
              accountId: 'acc1',
              status,
              account: { name: 'Kraken account' },
            },
          }))
      )

      const result = await createImportBatch({ ...params, files })

      expect(result).toMatchObject({ batchId: null, duplicates: 78 })
      expect(result.existingBatches).toEqual([
        {
          id: 'previous',
          accountId: 'acc1',
          accountName: 'Kraken account',
          status,
          eventCount: 78,
        },
      ])
      expect(m.batchCreate).not.toHaveBeenCalled()
    }
  )

  it('reports each matching batch and its account without moving duplicate events', async () => {
    m.eventFindMany.mockImplementation(
      async (args: {
        where: { userId: string; source: string; externalId: { in: string[] } }
      }) => {
        expect(args.where).toMatchObject({ userId: 'u1', source: 'KRAKEN' })
        return args.where.externalId.in.map((externalId, i) => ({
          id: 'old' + i,
          externalId,
          status: i === 0 ? 'APPLIED' : 'PENDING',
          batch: {
            id: i === 0 ? 'committed' : 'pending',
            accountId: i === 0 ? 'other-account' : 'acc1',
            status: i === 0 ? 'COMMITTED' : 'PENDING_REVIEW',
            account: { name: i === 0 ? 'Other account' : 'Kraken account' },
          },
        }))
      }
    )
    const result = await createImportBatch({ ...params, files })
    expect(result.existingBatches).toEqual([
      {
        id: 'committed',
        accountId: 'other-account',
        accountName: 'Other account',
        status: 'COMMITTED',
        eventCount: 1,
      },
      {
        id: 'pending',
        accountId: 'acc1',
        accountName: 'Kraken account',
        status: 'PENDING_REVIEW',
        eventCount: 77,
      },
    ])
    expect(m.eventUpdateMany).not.toHaveBeenCalled()
  })

  it('re-attaches deferred rewards once their month has completed, not before', async () => {
    const old = new Date('2026-01-15T00:00:00Z')
    const current = new Date()
    m.eventFindMany.mockImplementation(
      async (args: { where: { externalId: { in: string[] } } }) =>
        args.where.externalId.in.map((externalId, i) => ({
          id: 'old' + i,
          externalId,
          status: i === 0 ? 'DEFERRED' : i === 1 ? 'DEFERRED' : 'APPLIED',
          occurredAt: i === 0 ? old : current,
          batch: {
            id: 'previous',
            accountId: 'acc1',
            status: 'COMMITTED',
            account: { name: 'Kraken account' },
          },
        }))
    )
    m.batchCreate.mockResolvedValue({ id: 'b9' })
    m.eventUpdateMany.mockResolvedValue({ count: 1 })

    const result = await createImportBatch({ ...params, files })

    expect(result.batchId).toBe('b9')
    expect(result.duplicates).toBe(77)
    expect(result.existingBatches[0].eventCount).toBe(77)
    expect(m.eventCreateMany).not.toHaveBeenCalled()
    expect(m.eventUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['old0'] },
        userId: 'u1',
        status: 'DEFERRED',
        batch: { accountId: 'acc1' },
      },
      data: { batchId: 'b9', status: 'PENDING' },
    })
  })

  it('refuses to reattach rewards processed while the upload was being prepared', async () => {
    m.eventFindMany.mockImplementation(
      async (args: { where: { externalId: { in: string[] } } }) =>
        args.where.externalId.in.map((externalId, i) => ({
          id: 'old' + i,
          externalId,
          status: 'DEFERRED',
          occurredAt: new Date('2026-01-15T00:00:00Z'),
          batch: {
            id: 'previous',
            accountId: 'acc1',
            status: 'COMMITTED',
            account: { name: 'Kraken account' },
          },
        }))
    )
    m.batchCreate.mockResolvedValue({ id: 'b9' })
    m.eventUpdateMany.mockResolvedValue({ count: 0 })
    await expect(createImportBatch({ ...params, files })).rejects.toMatchObject(
      { status: 409, message: /Deferred events changed/ }
    )
  })

  it('accepts header-only exports (nothing to import)', async () => {
    m.eventFindMany.mockResolvedValue([])
    const result = await createImportBatch({
      ...params,
      files: [
        { kind: 'trades', fileName: 't.csv', content: TRADES_HEADER + '\n' },
        { kind: 'ledgers', fileName: 'l.csv', content: LEDGER_HEADER + '\n' },
      ],
    })
    expect(result.batchId).toBeNull()
    expect(result.existingBatches).toEqual([])
  })
})

describe('planBatch', () => {
  it('404s for a batch the user does not own', async () => {
    m.batchFindFirst.mockResolvedValue(null)
    await expect(planBatch('b1', 'u1')).rejects.toMatchObject({ status: 404 })
  })

  it('plans only pending and deferred events and counts all statuses', async () => {
    m.eventFindMany.mockResolvedValue([
      eventRow({ id: 'e1' }),
      eventRow({ id: 'e2', status: 'APPLIED', externalId: 'KRAKEN:order:Y' }),
    ])
    const { plan, eventCounts } = await planBatch('b1', 'u1')
    expect(plan.summary.buys).toBe(1)
    expect(eventCounts).toEqual({ PENDING: 1, APPLIED: 1 })
  })

  it('feeds open crypto parcels of the account into the plan', async () => {
    m.positionFindMany.mockResolvedValue([
      {
        id: 'pos-old',
        quantity: 1,
        openDate: new Date('2025-12-01T00:00:00Z'),
        createdAt: new Date('2025-12-01T00:00:00Z'),
        entryPrice: { toString: () => '50' },
        asset: {
          symbol: 'BTC-AUD',
          exchange: { code: 'KRAKEN', currency: 'AUD' },
        },
      },
    ])
    m.eventFindMany.mockResolvedValue([
      eventRow({
        id: 's1',
        kind: 'SELL',
        externalId: 'KRAKEN:order:S',
        quantity: { toFixed: () => '1' },
      }),
    ])
    const { plan } = await planBatch('b1', 'u1')
    expect(plan.sells[0].allocations[0].positionRef).toBe('pos-old')
  })
})

describe('commitBatch', () => {
  const buyRow = eventRow({ id: 'buy1', externalId: 'KRAKEN:order:BUY' })
  const sellRow = eventRow({
    id: 'sell1',
    kind: 'SELL',
    externalId: 'KRAKEN:order:SELL',
    occurredAt: new Date('2026-02-10T01:00:00Z'),
    raw: { ordertype: 'stop market' },
    price: { toFixed: () => '120' },
    grossValue: { toFixed: () => '120' },
    fee: { toFixed: () => '2' },
  })

  it('posts import cash with the imported trades in the same live-ledger transaction', async () => {
    m.eventFindMany.mockResolvedValue([buyRow])
    m.cashLedgerFindUnique.mockResolvedValue({
      accountId: 'acc1',
      openingStatementId: 'statement1',
      state: 'ACTIVE',
    })
    await commitBatch('b1', 'u1')
    expect(m.beginLiveImportPosting).toHaveBeenCalledWith(
      expect.any(Object),
      'u1',
      'acc1',
      'b1',
      [{ id: 'buy1', occurredAt: buyRow.occurredAt }]
    )
    expect(m.positionCreate).toHaveBeenCalled()
    expect(m.transactionCreate).not.toHaveBeenCalled()
    expect(m.finishLiveImportPosting).toHaveBeenCalledWith(['buy1'])
    expect(m.batchUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      m.finishLiveImportPosting.mock.invocationCallOrder[0]
    )
  })

  it('rejects partial live-ledger batches before writing any import records', async () => {
    m.eventFindMany.mockResolvedValue([buyRow, sellRow])
    m.cashLedgerFindUnique.mockResolvedValue({
      accountId: 'acc1',
      openingStatementId: 'statement1',
      state: 'ACTIVE',
    })

    await expect(commitBatch('b1', 'u1', ['buy1'])).rejects.toMatchObject({
      status: 409,
      message: /one complete batch/,
    })
    expect(m.beginLiveImportPosting).not.toHaveBeenCalled()
    expect(m.positionCreate).not.toHaveBeenCalled()
    expect(m.eventUpdate).not.toHaveBeenCalled()
  })

  it('locks the owned account before rereading and writing financial records', async () => {
    m.eventFindMany.mockResolvedValue([buyRow, sellRow])
    await commitBatch('b1', 'u1')
    const lockOrder = m.queryRaw.mock.invocationCallOrder[0]
    expect(lockOrder).toBeLessThan(
      m.accountFindFirst.mock.invocationCallOrder[0]
    )
    expect(lockOrder).toBeLessThan(m.eventFindMany.mock.invocationCallOrder[1])
    expect(lockOrder).toBeLessThan(
      m.positionFindMany.mock.invocationCallOrder[1]
    )
    expect(m.positionFindMany.mock.invocationCallOrder[1]).toBeLessThan(
      m.positionCreate.mock.invocationCallOrder[0]
    )
    expect(m.fx).toHaveBeenCalledTimes(1)
  })

  it.each(['events', 'holdings', 'batch'])(
    'rejects changed %s after preparation without writing trades',
    async (changed) => {
      m.eventFindMany.mockResolvedValue([buyRow])
      if (changed === 'events')
        m.eventFindMany.mockResolvedValueOnce([buyRow]).mockResolvedValue([])
      if (changed === 'batch')
        m.batchFindFirst.mockResolvedValueOnce(batch).mockResolvedValue({
          ...batch,
          status: 'DISCARDED',
        })
      if (changed === 'holdings')
        m.positionFindMany.mockResolvedValueOnce([]).mockResolvedValue([
          {
            id: 'new-position',
            asset: {
              symbol: 'BTC-AUD',
              exchange: { code: 'KRAKEN', currency: 'AUD' },
            },
            openDate: new Date('2026-01-01'),
            createdAt: new Date('2026-01-01'),
            quantity: 1,
            entryPrice: '100',
          },
        ])
      await expect(commitBatch('b1', 'u1')).rejects.toMatchObject({
        status: 409,
        message: /changed during preparation/,
      })
      expect(m.positionCreate).not.toHaveBeenCalled()
      expect(m.transactionCreate).not.toHaveBeenCalled()
      expect(m.eventUpdate).not.toHaveBeenCalled()
      expect(m.batchUpdate).not.toHaveBeenCalled()
    }
  )

  it.each([
    { isDemo: true, status: 'ACTIVE' },
    { isDemo: false, status: 'CLOSED' },
  ])('rechecks account eligibility under lock: %s', async (account) => {
    m.eventFindMany.mockResolvedValue([buyRow])
    m.accountFindFirst.mockResolvedValue(account)
    await expect(commitBatch('b1', 'u1')).rejects.toMatchObject({ status: 400 })
    expect(m.positionCreate).not.toHaveBeenCalled()
  })

  it('rejects a missing owned account before any trade write', async () => {
    m.eventFindMany.mockResolvedValue([buyRow])
    m.queryRaw
      .mockResolvedValueOnce([{ id: 'u1', deletedAt: null }])
      .mockResolvedValue([])
    await expect(commitBatch('b1', 'u1')).rejects.toMatchObject({ status: 404 })
    expect(m.positionCreate).not.toHaveBeenCalled()
  })

  it('surfaces an account disappearing after lock acquisition', async () => {
    m.eventFindMany.mockResolvedValue([buyRow])
    m.accountFindFirst.mockResolvedValue(null)
    await expect(commitBatch('b1', 'u1')).rejects.toMatchObject({ status: 404 })
    expect(m.positionCreate).not.toHaveBeenCalled()
  })

  it('fails the transaction if an allocated parcel cannot be recomputed', async () => {
    m.eventFindMany.mockResolvedValue([buyRow, sellRow])
    m.recompute.mockResolvedValue(null)
    await expect(commitBatch('b1', 'u1')).rejects.toMatchObject({
      status: 409,
      message: /parcel no longer exists/,
    })
    expect(m.eventUpdate).not.toHaveBeenCalled()
    expect(m.batchUpdate).not.toHaveBeenCalled()
  })

  it('creates the parcel, the SELL transaction and marks events applied, in one transaction', async () => {
    m.eventFindMany.mockResolvedValue([buyRow, sellRow])

    const result = await commitBatch('b1', 'u1')

    expect(m.findOrCreateAsset).toHaveBeenCalledWith(
      'BTC-AUD',
      'KRAKEN',
      'BTC',
      'CRYPTO'
    )
    const position = m.positionCreate.mock.calls[0][0].data
    expect(position).toMatchObject({
      userId: 'u1',
      accountId: 'acc1',
      assetId: 'asset1',
      origin: 'IMPORT_TRADE',
      externalRef: 'KRAKEN:order:BUY',
      quantity: 1,
      entryPrice: '100',
      buyFees: '1',
      tags: ['import:kraken'],
    })
    expect(position.openDate.toISOString()).toBe('2026-01-10T00:00:00.000Z')
    expect(position.transactions.create).toMatchObject({
      type: 'BUY',
      brokerRef: 'KRAKEN:order:BUY',
    })
    expect(m.transactionCreate).toHaveBeenCalledTimes(1)
    expect(m.transactionCreate.mock.calls[0][0].data).toMatchObject({
      positionId: 'pos1',
      type: 'SELL',
      quantity: 1,
      totalValue: '120',
      fees: '2',
      closeReason: 'STOP_LOSS',
      brokerRef: 'KRAKEN:order:SELL',
    })
    expect(m.recompute).toHaveBeenCalledWith('pos1', expect.anything())
    expect(m.eventUpdate).toHaveBeenCalledWith({
      where: { id: 'buy1' },
      data: { status: 'APPLIED', appliedPositionIds: ['pos1'] },
    })
    expect(m.eventUpdate).toHaveBeenCalledWith({
      where: { id: 'sell1' },
      data: { status: 'APPLIED', appliedPositionIds: ['pos1'] },
    })
    expect(m.batchUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: expect.objectContaining({ status: 'COMMITTED' }),
    })
    expect(result).toEqual({ createdPositionIds: ['pos1'], appliedEvents: 2 })
  })

  it('backfills imported history through the guarded writer using the fetched source', async () => {
    m.eventFindMany.mockResolvedValue([buyRow, sellRow])
    const position = {
      id: 'pos1',
      userId: 'u1',
      accountId: 'acc1',
      assetId: 'asset1',
      entryPrice: 100,
      openDate: new Date('2026-01-10'),
      status: 'CLOSED',
      closeDate: new Date('2026-01-20'),
      asset: { symbol: 'BTC-AUD' },
    }
    m.positionFindUnique.mockResolvedValueOnce(position)
    m.drawdown.mockResolvedValueOnce(10)
    m.runUp.mockResolvedValueOnce(20)
    await commitBatch('b1', 'u1')
    await vi.waitFor(() =>
      expect(m.saveHistory).toHaveBeenCalledWith(position, {
        maxDrawdownPercent: 10,
        maxRunUpPercent: 20,
      })
    )
    expect(m.runUp).toHaveBeenCalledWith(
      'BTC-AUD',
      100,
      position.openDate,
      position.closeDate
    )
  })

  it('refuses to commit while blocking issues remain', async () => {
    m.eventFindMany.mockResolvedValue([sellRow])

    await expect(commitBatch('b1', 'u1')).rejects.toMatchObject({
      status: 409,
      details: [expect.objectContaining({ type: 'INSUFFICIENT_HOLDINGS' })],
    })
    expect(m.positionCreate).not.toHaveBeenCalled()
  })

  it('rejects a subset commit that skips an earlier event of the same asset', async () => {
    m.eventFindMany.mockResolvedValue([buyRow, sellRow])

    await expect(commitBatch('b1', 'u1', ['sell1'])).rejects.toMatchObject({
      status: 409,
      details: [{ blockingEventId: 'buy1' }],
    })
  })

  it('applies a chronological prefix and leaves the batch partially applied', async () => {
    m.eventFindMany.mockResolvedValue([buyRow, sellRow])
    m.eventCount.mockImplementation(
      async (args: { where: { status: string } }) =>
        args.where.status === 'PENDING' ? 1 : 1
    )

    const result = await commitBatch('b1', 'u1', ['buy1'])

    expect(result.appliedEvents).toBe(1)
    expect(m.transactionCreate).not.toHaveBeenCalled()
    expect(m.batchUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'PARTIALLY_APPLIED' },
    })
  })

  it('records skipped, unsupported and dust events without touching positions', async () => {
    m.eventFindMany.mockResolvedValue([
      eventRow({
        id: 'u1e',
        kind: 'UNSUPPORTED',
        externalId: 'KRAKEN:ledger:U',
        warning: 'nope',
      }),
      eventRow({
        id: 'skip1',
        externalId: 'KRAKEN:order:SK',
        resolution: { skip: true },
      }),
      eventRow({
        id: 'r1',
        kind: 'STAKING_REWARD',
        externalId: 'KRAKEN:ledger:R',
        occurredAt: new Date('2026-02-10T01:00:00Z'),
        quantity: { toFixed: () => '0.001' },
        quoteCurrency: null,
        raw: { fmvUsd: '0.1' },
      }),
    ])

    await commitBatch('b1', 'u1')

    expect(m.positionCreate).not.toHaveBeenCalled()
    expect(m.eventUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] }, userId: 'u1' },
      data: { status: 'SKIPPED', warning: 'DUST' },
    })
    expect(m.eventUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1e', 'skip1'] }, userId: 'u1' },
      data: { status: 'SKIPPED' },
    })
  })

  it('creates a staking parcel with the monthly value stored on each event', async () => {
    m.eventFindMany.mockResolvedValue([
      eventRow({
        id: 'r1',
        kind: 'STAKING_REWARD',
        externalId: 'KRAKEN:ledger:R',
        occurredAt: new Date('2026-02-10T01:00:00Z'),
        baseAsset: 'SOL',
        quoteCurrency: null,
        quantity: { toFixed: () => '2' },
        raw: { fmvUsd: '100' },
      }),
    ])

    await commitBatch('b1', 'u1')

    expect(m.positionCreate.mock.calls[0][0].data).toMatchObject({
      origin: 'STAKING_REWARD',
      externalRef: 'KRAKEN:staking:SOL:2026-02',
      totalBuyValue: '150.00000000',
      buyFees: '0',
    })
    expect(m.eventUpdate).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { fmvAud: '150' },
    })
  })

  it('does not commit a discarded batch', async () => {
    m.batchFindFirst.mockResolvedValue({ ...batch, status: 'DISCARDED' })
    m.eventFindMany.mockResolvedValue([])
    await expect(commitBatch('b1', 'u1')).rejects.toMatchObject({ status: 409 })
  })
})

describe('saveResolution', () => {
  it('rejects changes when the batch was discarded while waiting for its lock', async () => {
    m.batchFindFirst.mockResolvedValueOnce(batch).mockResolvedValue({
      ...batch,
      status: 'DISCARDED',
    })
    await expect(
      saveResolution('b1', 'e1', 'u1', { skip: true })
    ).rejects.toMatchObject({ status: 409 })
    expect(m.eventUpdate).not.toHaveBeenCalled()
  })

  it('404s when the event is not in the batch', async () => {
    m.eventFindFirst.mockResolvedValue(null)
    await expect(
      saveResolution('b1', 'nope', 'u1', { skip: true })
    ).rejects.toMatchObject({ status: 404 })
  })

  it('rejects changes to processed events', async () => {
    m.eventFindFirst.mockResolvedValue(eventRow({ status: 'APPLIED' }))
    await expect(
      saveResolution('b1', 'e1', 'u1', { skip: true })
    ).rejects.toMatchObject({ status: 409 })
  })

  it('rejects allocations on non-sell events and fmv on non-rewards', async () => {
    m.eventFindFirst.mockResolvedValue(eventRow({}))
    await expect(
      saveResolution('b1', 'e1', 'u1', {
        allocations: [{ positionRef: 'x', quantity: '1' }],
      })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      saveResolution('b1', 'e1', 'u1', { fmvAud: '5' })
    ).rejects.toMatchObject({ status: 400 })
  })

  it('merges the resolution and returns the re-computed plan', async () => {
    m.eventFindFirst.mockResolvedValue(
      eventRow({ resolution: { closeReason: 'TARGET' } })
    )
    m.eventFindMany.mockResolvedValue([eventRow({})])

    const planned = await saveResolution('b1', 'e1', 'u1', { skip: true })

    expect(m.eventUpdate).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { resolution: { closeReason: 'TARGET', skip: true } },
    })
    expect(planned.plan).toBeDefined()
  })
})

describe('saveResolution — clearing an override', () => {
  it('drops a previous allocation when allocations is undefined', async () => {
    m.eventFindFirst.mockResolvedValue(
      eventRow({
        kind: 'SELL',
        resolution: {
          allocations: [{ positionRef: 'p', quantity: '1' }],
          closeReason: 'MANUAL',
        },
      })
    )
    m.eventFindMany.mockResolvedValue([])

    await saveResolution('b1', 'e1', 'u1', { allocations: undefined })

    const saved = m.eventUpdate.mock.calls[0][0].data.resolution
    expect(JSON.parse(JSON.stringify(saved))).toEqual({ closeReason: 'MANUAL' })
  })
})

describe('discardBatch', () => {
  it('deletes unapplied events and flags the batch discarded', async () => {
    await discardBatch('b1', 'u1')
    expect(m.eventDeleteMany).toHaveBeenCalledWith({
      where: {
        batchId: 'b1',
        userId: 'u1',
        status: { in: ['PENDING', 'DEFERRED'] },
      },
    })
    expect(m.batchUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'DISCARDED' },
    })
  })

  it('404s for a foreign batch', async () => {
    m.batchFindFirst.mockResolvedValue(null)
    await expect(discardBatch('b1', 'u2')).rejects.toMatchObject({
      status: 404,
    })
  })
})
