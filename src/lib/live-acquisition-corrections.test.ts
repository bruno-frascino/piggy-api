import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ operations: vi.fn() }))
vi.mock('./prisma.js', () => ({
  prisma: { accountCashOperation: { findMany: mocks.operations } },
}))
import { readLiveAcquisitionCorrections } from './live-acquisition-corrections.js'

const decimal = (value: string) => ({ toFixed: () => value })
function operation() {
  return {
    id: 'op1',
    sequence: 1n,
    ledger: { acceptedSourceFingerprint: 'a'.repeat(64) },
    revisions: [],
    transaction: {
      id: 'buy1',
      positionId: 'p1',
      date: new Date('2026-10-03T01:00:00Z'),
      quantity: 3,
      price: decimal('0.123456789012'),
      fees: decimal('0.12345678'),
      position: { transactions: [{ id: 'buy1' }] },
    },
  }
}
beforeEach(() => vi.resetAllMocks())
describe('live acquisition correction metadata', () => {
  it('preserves full bought quantity and exact money, and filters ineligible sources at the database boundary', async () => {
    mocks.operations.mockResolvedValue([operation()])
    const result = await readLiveAcquisitionCorrections('u1', ['p1'])
    expect(result.get('p1')).toEqual({
      operationId: 'op1',
      transactionId: 'buy1',
      expectedRevisionId: 'op1',
      expectedSourceFingerprint: 'a'.repeat(64),
      effectiveDate: '2026-10-03',
      sequence: 1,
      quantity: '3',
      price: '0.123456789012',
      fees: '0.12345678',
    })
    expect(mocks.operations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: 'BUY',
          importedEventId: null,
          ledger: { state: 'ACTIVE', openingStatement: { state: 'CONFIRMED' } },
          transaction: expect.objectContaining({
            type: 'BUY',
            brokerRef: null,
            position: expect.objectContaining({
              id: { in: ['p1'] },
              userId: 'u1',
              origin: 'MANUAL',
              positionType: 'LONG',
              account: { userId: 'u1', status: 'ACTIVE', isDemo: false },
              transactions: { none: { brokerRef: { not: null } } },
            }),
          }),
        }),
      })
    )
  })
  it('uses the latest revision sequence and excludes multi-BUY parcels', async () => {
    const row = operation()
    mocks.operations.mockResolvedValue([
      {
        ...row,
        revisions: [{ id: 'r1', request: { replacement: { sequence: 7 } } }],
      },
    ])
    expect(
      (await readLiveAcquisitionCorrections('u1', ['p1'])).get('p1')
    ).toMatchObject({ expectedRevisionId: 'r1', sequence: 7 })
    mocks.operations.mockResolvedValue([
      {
        ...row,
        transaction: {
          ...row.transaction,
          position: { transactions: [{ id: 'buy1' }, { id: 'buy2' }] },
        },
      },
    ])
    expect((await readLiveAcquisitionCorrections('u1', ['p1'])).size).toBe(0)
  })
  it('does not query empty pages and explicitly rejects inconsistent metadata', async () => {
    expect((await readLiveAcquisitionCorrections('u1', [])).size).toBe(0)
    expect(mocks.operations).not.toHaveBeenCalled()
    mocks.operations.mockResolvedValue([{ ...operation(), sequence: 0n }])
    await expect(
      readLiveAcquisitionCorrections('u1', ['p1'])
    ).rejects.toMatchObject({ status: 409 })
  })
})
