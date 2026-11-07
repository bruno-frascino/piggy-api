import { describe, expect, it } from 'vitest'
import {
  parseManualTradeVoidInput,
  parseManualTradeVoidAudit,
  manualTradeVoidHash,
} from './manual-trade-void.js'
import { prepareCashRevision } from './cash-revisions.js'

const input = {
  idempotencyKey: 'void-1',
  expectedRevisionId: 'operation-1',
  expectedSourceFingerprint: 'a'.repeat(64),
  reason: 'Duplicate execution',
}
const audit = {
  kind: 'BUY',
  number: 1,
  previousFingerprint: 'a'.repeat(64),
  nextFingerprint: 'b'.repeat(64),
  input,
  voidedAt: '2026-10-04T01:00:00.000Z',
  before: {
    transactionId: 'trade-1',
    positionId: 'parcel-1',
    date: '2026-10-02T01:00:00.000Z',
    quantity: '2',
    price: '10',
    fees: '1',
    totalValue: '20',
    currency: 'AUD',
  },
}
describe('manual trade void audit', () => {
  it('normalizes a bounded strict input and terminal BUY/SELL audit', () => {
    expect(parseManualTradeVoidInput(input)).toEqual(input)
    expect(manualTradeVoidHash(input)).toHaveLength(64)
    for (const kind of ['BUY', 'SELL']) {
      expect(parseManualTradeVoidAudit({ ...audit, kind }).kind).toBe(kind)
      const prepared = prepareCashRevision(
        {
          idempotencyKey: input.idempotencyKey,
          expectedRevisionId: input.expectedRevisionId,
          reason: input.reason,
          replacement: null,
          voidAudit: { ...audit, kind },
        },
        new Date('2026-10-04')
      )
      expect(prepared.request.replacement).toBeNull()
      expect(prepared.payloadHash).toHaveLength(64)
    }
  })
  it.each([
    null,
    { ...input, extra: true },
    { ...input, reason: ' ' },
    { ...input, reason: 'a\nb' },
    { ...input, reason: 'x'.repeat(1001) },
    { ...input, expectedSourceFingerprint: 'invalid' },
    { ...input, expectedRevisionId: 1 },
  ])('rejects malformed input %j', (raw) => {
    expect(() => parseManualTradeVoidInput(raw)).toThrow()
  })
  it.each([
    null,
    { ...audit, extra: true },
    { ...audit, kind: 'DIVIDEND' },
    { ...audit, voidedAt: 'bad' },
    { ...audit, number: 0 },
    { ...audit, previousFingerprint: 'c'.repeat(64) },
    { ...audit, before: { ...audit.before, quantity: '0' } },
    { ...audit, before: { ...audit.before, totalValue: '21' } },
  ])('rejects inconsistent source audit %j', (raw) => {
    expect(() => parseManualTradeVoidAudit(raw)).toThrow()
  })
  it('requires a terminal reversal and matching request identity', () => {
    for (const change of [
      { reason: 'other' },
      { idempotencyKey: 'other' },
      { proposedTrade: null },
    ]) {
      expect(() =>
        prepareCashRevision(
          {
            idempotencyKey: input.idempotencyKey,
            expectedRevisionId: input.expectedRevisionId,
            reason: input.reason,
            replacement: null,
            voidAudit: audit,
            ...change,
          },
          new Date('2026-10-04')
        )
      ).toThrow()
    }
  })
})
