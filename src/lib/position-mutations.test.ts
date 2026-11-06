import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lock: vi.fn(),
  position: vi.fn(),
  sell: vi.fn(),
  event: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  recompute: vi.fn(),
  account: vi.fn(),
  accountUpsert: vi.fn(),
  create: vi.fn(),
  accountLock: vi.fn(),
  tradeLink: vi.fn(),
  liveTradeLink: vi.fn(),
  cashLedger: vi.fn(),
}))
vi.mock('./prisma.js', () => ({ prisma: { $transaction: mocks.transaction } }))
vi.mock('./user-lock.js', () => ({ lockActiveUser: vi.fn() }))
vi.mock('./account-lock.js', () => ({
  lockOwnedPosition: mocks.lock,
  lockOwnedTradingAccount: mocks.accountLock,
}))
vi.mock('./position-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./position-service.js')>()),
  recomputePositionFromTransactions: mocks.recompute,
}))
import {
  closePosition,
  deletePosition,
  updateCloseEvent,
  createPosition,
  updatePositionAcquisition,
} from './position-mutations.js'

const input = { closeDate: new Date('2026-10-03T00:00:00Z'), exitPrice: 12 }
const initial = {
  id: 'p1',
  origin: 'MANUAL',
  accountId: 'a1',
  assetId: 'asset1',
  status: 'OPEN',
  quantity: 10,
  transactions: [{ id: 'b1', type: 'BUY', quantity: 10, brokerRef: null }],
}
const tx = {
  draftOperationTradeLink: { findFirst: mocks.tradeLink },
  accountCashOperation: { findFirst: mocks.liveTradeLink },
  accountCashLedger: { findUnique: mocks.cashLedger },
  position: {
    findFirst: mocks.position,
    delete: mocks.remove,
    update: mocks.update,
    create: mocks.create,
  },
  tradingAccount: { findFirst: mocks.account, upsert: mocks.accountUpsert },
  transaction: {
    create: mocks.sell,
    findFirst: mocks.event,
    update: mocks.update,
  },
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.lock.mockResolvedValue(undefined)
  mocks.tradeLink.mockResolvedValue(null)
  mocks.liveTradeLink.mockResolvedValue(null)
  mocks.cashLedger.mockResolvedValue(null)
  mocks.accountLock.mockResolvedValue(undefined)
  mocks.account.mockResolvedValue({ id: 'a1', isDemo: false })
  mocks.accountUpsert.mockResolvedValue({ id: 'a1', isDemo: false })
  mocks.create.mockResolvedValue({ id: 'p1' })
  mocks.position.mockResolvedValue(initial)
  mocks.recompute.mockResolvedValue({ id: 'p1' })
  mocks.sell.mockResolvedValue({ id: 's1' })
  mocks.event.mockResolvedValue({
    positionId: 'p1',
    quantity: 4,
    position: { accountId: 'a1' },
    brokerRef: null,
    date: new Date('2026-10-03T00:00:00Z'),
    price: 12,
    fees: 1,
  })
  mocks.update.mockResolvedValue({ id: 's1' })
  mocks.transaction.mockImplementation(
    (callback: (db: typeof tx) => Promise<unknown>) => callback(tx)
  )
})

describe('atomic parcel disposal mutations', () => {
  const acquisition = {
    ...initial,
    openDate: new Date('2026-10-02T00:00:00Z'),
    entryPrice: 10,
    buyFees: 2,
    account: { isDemo: false },
    transactions: [
      { id: 'b1', type: 'BUY', quantity: 10, brokerRef: null },
      { id: 's1', type: 'SELL', quantity: 6, brokerRef: null },
    ],
  }
  it('rejects new acquisitions when the account was closed before the lock was acquired', async () => {
    mocks.account
      .mockResolvedValueOnce({ id: 'a1', status: 'ACTIVE' })
      .mockResolvedValueOnce({ id: 'a1', status: 'CLOSED' })
    await expect(
      createPosition(
        'u1',
        { accountId: 'a1' },
        {
          assetId: 'asset1',
          openDate: input.closeDate,
          entryPrice: 10,
          quantity: 1,
          totalBuyValue: 10,
          capitalAllocated: 10,
        }
      )
    ).rejects.toMatchObject({ status: 409, message: /Reopen/ })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rejects an account disappearing after acquisition locking', async () => {
    mocks.account
      .mockResolvedValueOnce({ id: 'a1' })
      .mockResolvedValueOnce(null)
    await expect(
      createPosition(
        'u1',
        { accountId: 'a1' },
        {
          assetId: 'asset1',
          openDate: input.closeDate,
          entryPrice: 10,
          quantity: 1,
          totalBuyValue: 10,
          capitalAllocated: 10,
        }
      )
    ).rejects.toMatchObject({ status: 404 })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rolls back an edit that would reopen a parcel inside an archived account', async () => {
    mocks.position
      .mockResolvedValueOnce({
        ...acquisition,
        status: 'CLOSED',
        account: { isDemo: false, status: 'CLOSED' },
      })
      .mockResolvedValueOnce({ ...acquisition, status: 'PARTIAL' })
    await expect(
      updatePositionAcquisition('u1', 'p1', { quantity: 12 }, {})
    ).rejects.toMatchObject({ status: 409, message: /Reopen/ })
  })
  it('preserves cost corrections and metadata edits that leave an archived parcel closed', async () => {
    mocks.position.mockResolvedValue({
      ...acquisition,
      status: 'CLOSED',
      account: { isDemo: false, status: 'CLOSED' },
    })
    await expect(
      updatePositionAcquisition('u1', 'p1', { entryPrice: 12 }, {})
    ).resolves.toMatchObject({ status: 'CLOSED' })
  })
  it('rejects moving open holdings to a closed account but allows closed history', async () => {
    mocks.account.mockResolvedValue({ isDemo: false, status: 'CLOSED' })
    mocks.position.mockResolvedValue(acquisition)
    await expect(
      updatePositionAcquisition('u1', 'p1', {}, {}, 'a2')
    ).rejects.toMatchObject({ status: 409 })
    mocks.position.mockResolvedValue({ ...acquisition, status: 'CLOSED' })
    await expect(
      updatePositionAcquisition('u1', 'p1', {}, {}, 'a2')
    ).resolves.toMatchObject({ status: 'CLOSED' })
  })
  it('creates the parcel and nested BUY under an account lock using the transaction client', async () => {
    const data = {
      assetId: 'asset1',
      openDate: input.closeDate,
      entryPrice: 10,
      quantity: 10,
      totalBuyValue: 100,
      capitalAllocated: 102,
      transactions: {
        create: {
          type: 'BUY' as const,
          date: input.closeDate,
          quantity: 10,
          price: 10,
          totalValue: 100,
        },
      },
    }
    await createPosition('u1', { accountId: 'a1' }, data)
    expect(mocks.accountLock).toHaveBeenCalledWith(tx, 'u1', 'a1')
    expect(mocks.create.mock.calls[0][0].data).toEqual({
      ...data,
      userId: 'u1',
      accountId: 'a1',
    })
    expect(mocks.accountLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0]
    )
  })
  it('keeps legacy close and acquisition writes disabled for ledger-backed trades', async () => {
    mocks.cashLedger.mockResolvedValue({ accountId: 'a1' })
    await expect(closePosition('u1', 'p1', input)).rejects.toMatchObject({
      status: 409,
      message: /account trade posting flow/,
    })
    expect(mocks.sell).not.toHaveBeenCalled()

    mocks.cashLedger.mockResolvedValue(null)
    mocks.liveTradeLink.mockResolvedValue({ id: 'live-op' })
    mocks.position.mockResolvedValue(acquisition)
    await expect(
      updatePositionAcquisition('u1', 'p1', { entryPrice: 11 }, {})
    ).rejects.toMatchObject({
      status: 409,
      message: /active account cash ledger/,
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('blocks legacy financial edits and deletion of opening parcels behind a cash ledger', async () => {
    mocks.cashLedger.mockResolvedValue({ accountId: 'a1' })
    mocks.position.mockResolvedValue(acquisition)
    await expect(
      updatePositionAcquisition('u1', 'p1', { entryPrice: 11 }, {})
    ).rejects.toMatchObject({
      status: 409,
      message: /confirmed cash ledger/,
    })
    await expect(deletePosition('u1', 'p1')).rejects.toMatchObject({
      status: 409,
      message: /confirmed cash ledger/,
    })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it('updates acquisition and disposal totals in the same transaction after rereading inventory', async () => {
    mocks.position.mockResolvedValue(acquisition)
    await updatePositionAcquisition(
      'u1',
      'p1',
      { entryPrice: 11, quantity: 12, buyFees: 3, openDate: input.closeDate },
      { notes: 'reviewed' }
    )
    expect(mocks.update.mock.calls[0][0]).toEqual({
      where: { id: 'b1' },
      data: {
        date: input.closeDate,
        price: 11,
        quantity: 12,
        fees: 3,
        totalValue: 132,
      },
    })
    expect(mocks.update.mock.calls[1][0].data).toMatchObject({
      notes: 'reviewed',
      quantity: 6,
      totalBuyValue: 132,
      capitalAllocated: 135,
    })
    expect(mocks.recompute).toHaveBeenCalledWith('p1', tx)
  })
  it('allows metadata-only edits without needing a BUY or recomputing trade results', async () => {
    await updatePositionAcquisition('u1', 'p1', {}, { notes: 'metadata' })
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'p1' },
      data: { notes: 'metadata' },
    })
    expect(mocks.recompute).not.toHaveBeenCalled()
  })
  it('locks both move accounts then rechecks the demo boundary from current data', async () => {
    mocks.position.mockResolvedValue(acquisition)
    await updatePositionAcquisition('u1', 'p1', {}, {}, 'a2')
    expect(mocks.lock).toHaveBeenCalledWith(tx, 'u1', 'p1', 'a2')
    expect(mocks.account.mock.calls[0][0].where).toEqual({
      id: 'a2',
      userId: 'u1',
    })
    expect(mocks.update.mock.calls[0][0].data.accountId).toBe('a2')
    mocks.account.mockResolvedValue({ id: 'a2', isDemo: true })
    await expect(
      updatePositionAcquisition('u1', 'p1', {}, {}, 'a2')
    ).rejects.toThrow('demo and real')
    mocks.account.mockResolvedValue(null)
    await expect(
      updatePositionAcquisition('u1', 'p1', {}, {}, 'a2')
    ).rejects.toMatchObject({ status: 404 })
  })
  it('rejects reducing acquisition units below sold units before writing either record', async () => {
    mocks.position.mockResolvedValue(acquisition)
    await expect(
      updatePositionAcquisition('u1', 'p1', { quantity: 5 }, {})
    ).rejects.toThrow('already sold')
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it.each([
    { quantity: 0 },
    { quantity: NaN },
    { entryPrice: -1 },
    { entryPrice: 0 },
    { buyFees: -1 },
    { openDate: new Date('invalid') },
  ])(
    'rejects invalid acquisition input before taking database locks %#',
    async (invalid) => {
      await expect(
        updatePositionAcquisition('u1', 'p1', invalid, {})
      ).rejects.toMatchObject({ status: 400 })
      expect(mocks.transaction).not.toHaveBeenCalled()
    }
  )
  it('rejects missing/multiple BUY rows instead of changing just the parcel', async () => {
    for (const transactions of [
      [],
      [...acquisition.transactions, { id: 'b2', type: 'BUY', quantity: 1 }],
    ]) {
      mocks.position.mockResolvedValue({ ...acquisition, transactions })
      await expect(
        updatePositionAcquisition('u1', 'p1', { entryPrice: 12 }, {})
      ).rejects.toMatchObject({ status: 409 })
    }
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('rejects non-finite acquisition consideration and inconsistent sold inventory', async () => {
    mocks.position.mockResolvedValue(acquisition)
    await expect(
      updatePositionAcquisition(
        'u1',
        'p1',
        { entryPrice: Number.MAX_VALUE },
        {}
      )
    ).rejects.toThrow('consideration')
    mocks.position.mockResolvedValue({
      ...acquisition,
      transactions: [
        { id: 'b1', type: 'BUY', quantity: 10, brokerRef: null },
        { id: 's1', type: 'SELL', quantity: Infinity },
      ],
    })
    await expect(
      updatePositionAcquisition('u1', 'p1', { entryPrice: 12 }, {})
    ).rejects.toThrow('already sold')
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('rolls back acquisition edits when recompute or final parcel lookup fails', async () => {
    mocks.position.mockResolvedValue(acquisition)
    mocks.recompute.mockResolvedValue(null)
    await expect(
      updatePositionAcquisition('u1', 'p1', { entryPrice: 12 }, {})
    ).rejects.toMatchObject({ status: 404 })
    mocks.recompute.mockResolvedValue({ id: 'p1' })
    mocks.position
      .mockResolvedValueOnce(acquisition)
      .mockResolvedValueOnce(null)
    await expect(
      updatePositionAcquisition('u1', 'p1', { entryPrice: 12 }, {})
    ).rejects.toMatchObject({ status: 404 })
    mocks.position.mockResolvedValue(null)
    await expect(
      updatePositionAcquisition('u1', 'p1', {}, {})
    ).rejects.toMatchObject({ status: 404 })
  })
  it('reads remaining inventory only after locking and recomputes using the transaction client', async () => {
    await closePosition('u1', 'p1', {
      ...input,
      quantity: 4,
      fees: 1,
      notes: ' trimmed ',
    })
    expect(mocks.lock).toHaveBeenCalledWith(tx, 'u1', 'p1')
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.position.mock.invocationCallOrder[0]
    )
    expect(mocks.sell).toHaveBeenCalledWith({
      data: {
        positionId: 'p1',
        type: 'SELL',
        date: input.closeDate,
        quantity: 4,
        price: 12,
        totalValue: 48,
        fees: 1,
        notes: 'trimmed',
        closeReason: 'MANUAL',
      },
    })
    expect(mocks.recompute).toHaveBeenCalledWith('p1', tx)
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'ReadCommitted',
      timeout: 15000,
      maxWait: 5000,
    })
  })
  it('closes only the remaining quantity after earlier disposals', async () => {
    mocks.position.mockResolvedValue({
      ...initial,
      transactions: [
        { type: 'BUY', quantity: 10 },
        { type: 'SELL', quantity: 6 },
      ],
    })
    await closePosition('u1', 'p1', input)
    expect(mocks.sell.mock.calls[0][0].data.quantity).toBe(4)
  })
  it.each([
    { ...input, closeDate: new Date('invalid') },
    { ...input, exitPrice: 0 },
    { ...input, exitPrice: Infinity },
    { ...input, fees: -1 },
    { ...input, quantity: 0 },
    { ...input, quantity: NaN },
  ])(
    'rejects invalid mutation input before opening a database transaction %#',
    async (invalid) => {
      await expect(closePosition('u1', 'p1', invalid)).rejects.toMatchObject({
        status: 400,
      })
      expect(mocks.transaction).not.toHaveBeenCalled()
    }
  )
  it.each([
    null,
    { ...initial, status: 'CLOSED' },
    { ...initial, transactions: [] },
    { ...initial, transactions: [{ type: 'BUY', quantity: Infinity }] },
  ])(
    'rejects missing/closed/invalid parcels before creating any sale %#',
    async (position) => {
      mocks.position.mockResolvedValue(position)
      await expect(closePosition('u1', 'p1', input)).rejects.toThrow()
      expect(mocks.sell).not.toHaveBeenCalled()
    }
  )
  it('rejects overselling against inventory re-read under the lock', async () => {
    await expect(
      closePosition('u1', 'p1', { ...input, quantity: 11 })
    ).rejects.toThrow('exceeds remaining')
    expect(mocks.sell).not.toHaveBeenCalled()
  })
  it('rejects non-finite computed consideration without partial sales', async () => {
    await expect(
      closePosition('u1', 'p1', { ...input, exitPrice: Number.MAX_VALUE })
    ).rejects.toThrow('consideration')
    expect(mocks.sell).not.toHaveBeenCalled()
  })
  it('surfaces recompute failure inside the transaction and never returns the committed-looking sale', async () => {
    mocks.recompute.mockRejectedValue(new Error('Recompute failed'))
    await expect(closePosition('u1', 'p1', input)).rejects.toThrow(
      'Recompute failed'
    )
    expect(mocks.position).toHaveBeenCalledTimes(1)
  })
  it('refuses a missing recomputation result and a disappeared response parcel', async () => {
    mocks.recompute.mockResolvedValue(null)
    await expect(closePosition('u1', 'p1', input)).rejects.toMatchObject({
      status: 404,
    })
    mocks.recompute.mockResolvedValue({ id: 'p1' })
    mocks.position.mockResolvedValueOnce(initial).mockResolvedValueOnce(null)
    await expect(closePosition('u1', 'p1', input)).rejects.toMatchObject({
      status: 404,
    })
  })
  it('edits a sale and recomputes parcel totals in the same transaction after a locked reread', async () => {
    await updateCloseEvent('u1', 's1', {
      ...input,
      sellFees: 2,
      notes: '  ',
      closeReason: null,
    })
    expect(mocks.event).toHaveBeenCalledTimes(2)
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: {
        date: input.closeDate,
        price: 12,
        totalValue: 48,
        fees: 2,
        notes: null,
        closeReason: null,
      },
    })
    expect(mocks.recompute).toHaveBeenCalledWith('p1', tx)
  })
  it.each([
    {},
    { closeReason: 'TARGET' as const },
    { sellFees: 0 },
    { notes: 'reason' },
  ])('preserves metadata-only and zero-fee corrections %#', async (patch) => {
    await updateCloseEvent('u1', 's1', patch)
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.recompute).toHaveBeenCalledWith('p1', tx)
  })
  it.each([
    { exitPrice: 0 },
    { exitPrice: NaN },
    { sellFees: -1 },
    { closeDate: new Date('invalid') },
  ])(
    'validates sale corrections before opening a transaction %#',
    async (patch) => {
      await expect(updateCloseEvent('u1', 's1', patch)).rejects.toMatchObject({
        status: 400,
      })
      expect(mocks.transaction).not.toHaveBeenCalled()
    }
  )
  it('rejects missing, moved or deleted close events before editing', async () => {
    mocks.event.mockResolvedValueOnce(null)
    await expect(updateCloseEvent('u1', 's1', {})).rejects.toMatchObject({
      status: 404,
    })
    mocks.event
      .mockResolvedValueOnce({ positionId: 'p1' })
      .mockResolvedValueOnce(null)
    await expect(updateCloseEvent('u1', 's1', {})).rejects.toMatchObject({
      status: 404,
    })
    mocks.event
      .mockResolvedValueOnce({ positionId: 'p1' })
      .mockResolvedValueOnce({ positionId: 'p2' })
    await expect(updateCloseEvent('u1', 's1', {})).rejects.toMatchObject({
      status: 409,
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('rejects non-finite correction consideration and failed recompute', async () => {
    await expect(
      updateCloseEvent('u1', 's1', { exitPrice: Number.MAX_VALUE })
    ).rejects.toThrow('consideration')
    expect(mocks.update).not.toHaveBeenCalled()
    mocks.recompute.mockResolvedValue(null)
    await expect(updateCloseEvent('u1', 's1', {})).rejects.toMatchObject({
      status: 404,
    })
  })
  it('locks and ownership-rechecks parcel deletion, propagating delete failures', async () => {
    await deletePosition('u1', 'p1')
    expect(mocks.lock).toHaveBeenCalledWith(tx, 'u1', 'p1')
    expect(mocks.remove).toHaveBeenCalledWith({ where: { id: 'p1' } })
    mocks.position.mockResolvedValue(null)
    await expect(deletePosition('u1', 'p1')).rejects.toMatchObject({
      status: 404,
    })
    mocks.position.mockResolvedValue(initial)
    mocks.remove.mockRejectedValue(new Error('Deletion failed'))
    await expect(deletePosition('u1', 'p1')).rejects.toThrow('Deletion failed')
  })
  it.each(['IMPORT_TRADE', 'STAKING_REWARD'])(
    'preserves %s acquisition money, instrument, account and deletion',
    async (origin) => {
      mocks.position.mockResolvedValue({ ...acquisition, origin })
      for (const edit of [
        () => updatePositionAcquisition('u1', 'p1', { entryPrice: 11 }, {}),
        () => updatePositionAcquisition('u1', 'p1', { quantity: 11 }, {}),
        () =>
          updatePositionAcquisition('u1', 'p1', {}, { assetId: 'other-asset' }),
        () => updatePositionAcquisition('u1', 'p1', {}, {}, 'a2'),
        () => deletePosition('u1', 'p1'),
      ])
        await expect(edit()).rejects.toMatchObject({
          status: 409,
          message: /Imported execution records/,
        })
      expect(mocks.update).not.toHaveBeenCalled()
      expect(mocks.remove).not.toHaveBeenCalled()
    }
  )
  it('preserves imported sale allocations even on a manual acquisition parcel', async () => {
    mocks.event.mockResolvedValue({
      positionId: 'p1',
      quantity: 4,
      brokerRef: 'KRAKEN:order:1',
      date: input.closeDate,
      price: 12,
      fees: 1,
    })
    for (const patch of [
      { exitPrice: 13 },
      { sellFees: 2 },
      { closeDate: new Date('2026-10-04') },
    ])
      await expect(updateCloseEvent('u1', 's1', patch)).rejects.toMatchObject({
        status: 409,
      })
    expect(mocks.update).not.toHaveBeenCalled()
    mocks.position.mockResolvedValue({
      ...acquisition,
      transactions: acquisition.transactions.map((row) => ({
        ...row,
        brokerRef: row.type === 'SELL' ? 'KRAKEN:order:1' : null,
      })),
    })
    await expect(deletePosition('u1', 'p1')).rejects.toMatchObject({
      status: 409,
    })
    await expect(
      updatePositionAcquisition('u1', 'p1', {}, {}, 'a2')
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      updatePositionAcquisition('u1', 'p1', {}, { assetId: 'other-asset' })
    ).rejects.toMatchObject({ status: 409 })
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it('checks durable cash links after locking and rejects financial edits, moves and deletion', async () => {
    mocks.position.mockResolvedValue(acquisition)
    mocks.tradeLink.mockResolvedValue({ operationId: 'cash-operation' })
    for (const edit of [
      () => updatePositionAcquisition('u1', 'p1', { entryPrice: 11 }, {}),
      () =>
        updatePositionAcquisition('u1', 'p1', {}, { assetId: 'other-asset' }),
      () => updatePositionAcquisition('u1', 'p1', {}, {}, 'a2'),
      () => updateCloseEvent('u1', 's1', { sellFees: 2 }),
      () => deletePosition('u1', 'p1'),
    ])
      await expect(edit()).rejects.toMatchObject({
        status: 409,
        message: /coordinated trade\/cash correction/,
      })
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.tradeLink.mock.invocationCallOrder[0]
    )
    expect(mocks.tradeLink).toHaveBeenCalledWith({
      where: { transactionId: { in: ['b1', 's1'] } },
      select: { operationId: true },
    })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it('allows imported and linked metadata saves with unchanged financial fields', async () => {
    mocks.position.mockResolvedValue({ ...acquisition, origin: 'IMPORT_TRADE' })
    mocks.tradeLink.mockResolvedValue({ operationId: 'cash-operation' })
    await updatePositionAcquisition(
      'u1',
      'p1',
      {
        openDate: acquisition.openDate,
        entryPrice: acquisition.entryPrice,
        buyFees: acquisition.buyFees,
        quantity: 10,
      },
      { notes: 'reviewed', assetId: 'asset1' },
      'a1'
    )
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'p1' },
      data: { notes: 'reviewed', assetId: 'asset1', accountId: 'a1' },
    })
    expect(mocks.recompute).not.toHaveBeenCalled()
    mocks.update.mockClear()
    mocks.event.mockResolvedValue({
      positionId: 'p1',
      quantity: 4,
      brokerRef: 'KRAKEN:order:1',
      date: input.closeDate,
      price: 12,
      fees: 1,
    })
    await updateCloseEvent('u1', 's1', {
      closeDate: input.closeDate,
      exitPrice: 12,
      sellFees: 1,
      notes: ' reviewed ',
      closeReason: 'TARGET',
    })
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 's1' },
      data: { notes: 'reviewed', closeReason: 'TARGET' },
    })
    expect(mocks.tradeLink).not.toHaveBeenCalled()
  })
})
