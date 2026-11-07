import { describe, expect, it } from 'vitest'
import { prepareCashCommand } from './cash-ledger.js'
import {
  prepareCapitalCashRevision,
  prepareImportedCashRevision,
  prepareCashRevision,
  prepareRevisionLegs,
  prepareDraftTradeRevision,
} from './cash-revisions.js'

const now = new Date('2026-10-31T12:00:00Z')
const original = prepareCashCommand(
  {
    accountId: 'a1',
    kind: 'DEPOSIT',
    idempotencyKey: 'original',
    source: { origin: 'MANUAL', reference: 'bank-line-1' },
    effectiveDate: '2026-10-02',
    sequence: 1,
    cash: { currency: 'AUD', amount: '100' },
  },
  now
).command
const replacement = {
  ...original,
  idempotencyKey: 'correction',
  cash: { currency: 'AUD', amount: '60.000' },
}
const request = {
  idempotencyKey: 'correction',
  expectedRevisionId: 'op1',
  reason: 'Correct bank statement amount',
  replacement,
}

describe('cash revision contract', () => {
  it('only resequences imported execution cash, retaining all persisted financial and source fields', () => {
    const execution = prepareCashCommand(
      {
        accountId: 'a1',
        kind: 'BUY',
        idempotencyKey: 'import-event:e1',
        source: { origin: 'IMPORT', reference: 'KRAKEN:order:1' },
        effectiveDate: '2026-10-02',
        sequence: 1,
        consideration: { currency: 'AUD', amount: '60.12345678' },
        fees: [{ currency: 'USD', amount: '1' }],
        transactionIds: ['t1'],
      },
      now
    ).command
    const input = {
      idempotencyKey: 'fix-sequence',
      expectedRevisionId: 'op1',
      reason: 'Broker order confirmed',
      sequence: 3,
    }
    const prepared = prepareImportedCashRevision(input, execution, now)
    expect(prepared.request.replacement).toEqual({
      ...execution,
      sequence: 3,
      idempotencyKey: input.idempotencyKey,
    })
    expect(
      prepareImportedCashRevision({ ...input, sequence: 4 }, execution, now)
        .payloadHash
    ).not.toBe(prepared.payloadHash)
    for (const invalid of [
      null,
      [],
      { ...input, sequence: 0 },
      { ...input, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, reason: ' ' },
      { ...input, replacement: null },
      { ...input, amount: '20' },
      { ...input, effectiveDate: '2026-10-03' },
      { ...input, transactionIds: ['other'] },
    ])
      expect(() =>
        prepareImportedCashRevision(invalid, execution, now)
      ).toThrow()
    expect(() => prepareImportedCashRevision(input, original, now)).toThrow(
      'Only imported'
    )
    expect(() =>
      prepareImportedCashRevision(
        input,
        { ...execution, source: { origin: 'MANUAL', reference: 'manual' } },
        now
      )
    ).toThrow('Only imported')
  })
  it('derives capital identity and currency from the stored operation, never from correction input', () => {
    const raw = {
      idempotencyKey: 'correction',
      expectedRevisionId: 'op1',
      reason: 'Correct bank amount',
      replacement: {
        effectiveDate: '2026-10-03',
        sequence: 2,
        amount: '60.000',
      },
    }
    expect(
      prepareCapitalCashRevision(raw, original, now).request.replacement
    ).toEqual({
      ...original,
      idempotencyKey: 'correction',
      effectiveDate: '2026-10-03',
      sequence: 2,
      cash: { currency: 'AUD', amount: '60' },
    })
    expect(
      prepareCapitalCashRevision({ ...raw, replacement: null }, original, now)
        .request.replacement
    ).toBeNull()
    for (const invalid of [
      null,
      { ...raw, source: { origin: 'IMPORT', reference: 'other' } },
      { ...raw, replacement: undefined },
      { ...raw, replacement: [] },
      { ...raw, replacement: { ...raw.replacement, currency: 'USD' } },
      { ...raw, replacement: { ...raw.replacement, amount: '-1' } },
      { ...raw, replacement: { ...raw.replacement, sequence: 0 } },
      { ...raw, reason: ' ' },
    ]) {
      expect(() => prepareCapitalCashRevision(invalid, original, now)).toThrow()
    }
    expect(() =>
      prepareCapitalCashRevision(
        raw,
        { ...original, source: { origin: 'IMPORT', reference: 'event' } },
        now
      )
    ).toThrow('Only manual')
    const trade = prepareCashCommand(
      {
        accountId: 'a1',
        kind: 'BUY',
        idempotencyKey: 'trade',
        source: { origin: 'MANUAL', reference: 'trade' },
        effectiveDate: '2026-10-02',
        sequence: 1,
        consideration: { currency: 'AUD', amount: '10' },
        fees: [],
        transactionIds: ['t1'],
      },
      now
    ).command
    expect(() => prepareCapitalCashRevision(raw, trade, now)).toThrow(
      'Only manual'
    )
  })
  it('binds quantity and price independently of equal trade consideration in revision hashes', () => {
    const trade = {
      accountId: 'a1',
      kind: 'BUY',
      assetId: 'asset1',
      currency: 'AUD',
      effectiveDate: '2026-10-02',
      sequence: 1,
      quantity: '10',
      price: '5',
      fees: '1',
      idempotencyKey: 'correction',
    }
    const envelope = {
      idempotencyKey: 'correction',
      expectedRevisionId: 'op1',
      reason: 'Fix units',
      replacement: trade,
    }
    const first = prepareDraftTradeRevision(envelope, 'trade1', now)
    const second = prepareDraftTradeRevision(
      {
        ...envelope,
        replacement: { ...trade, quantity: '5', price: '10' },
      },
      'trade1',
      now
    )
    expect(first.request.replacement).toEqual(second.request.replacement)
    expect(first.payloadHash).not.toBe(second.payloadHash)
    expect(
      prepareDraftTradeRevision(
        { ...envelope, replacement: null },
        'trade1',
        now
      ).request
    ).toMatchObject({ replacement: null, proposedTrade: null })
    expect(() =>
      prepareDraftTradeRevision(
        { ...envelope, unexpected: true },
        'trade1',
        now
      )
    ).toThrow()
    expect(() => prepareDraftTradeRevision(null, 'trade1', now)).toThrow()
    expect(() =>
      prepareCashRevision(
        { ...first.request, proposedTrade: { ...trade, quantity: '9' } },
        now
      )
    ).toThrow('exactly match')
    expect(() =>
      prepareCashRevision({ ...first.request, proposedTrade: null }, now)
    ).toThrow('also reverse')
    expect(() =>
      prepareCashRevision({ ...first.request, replacement: null }, now)
    ).toThrow('exactly match')
  })
  it('normalizes replacements and binds reason, expected revision and command to the retry hash', () => {
    const prepared = prepareCashRevision(request, now)
    expect(prepared.request.replacement).toMatchObject({
      cash: { amount: '60' },
    })
    expect(prepared.payloadHash).toBe(
      prepareCashRevision(
        {
          ...request,
          replacement: {
            ...replacement,
            cash: { currency: 'AUD', amount: '60' },
          },
        },
        now
      ).payloadHash
    )
    expect(prepared.payloadHash).not.toBe(
      prepareCashRevision({ ...request, reason: 'Other reason' }, now)
        .payloadHash
    )
    expect(prepared.payloadHash).not.toBe(
      prepareCashRevision({ ...request, expectedRevisionId: 'other' }, now)
        .payloadHash
    )
  })
  it('retains exact original reversal and replacement legs without netting away the audit trail', () => {
    expect(
      prepareRevisionLegs(
        original,
        prepareCashRevision(request, now).request.replacement,
        now
      )
    ).toEqual([
      {
        phase: 'REVERSAL',
        currency: 'AUD',
        amount: '-100',
        role: 'EXTERNAL_CAPITAL',
      },
      {
        phase: 'REPLACEMENT',
        currency: 'AUD',
        amount: '60',
        role: 'EXTERNAL_CAPITAL',
      },
    ])
  })
  it('supports reversal without replacement and exact fractional withdrawal reversals', () => {
    expect(
      prepareCashRevision({ ...request, replacement: null }, now).request
        .replacement
    ).toBeNull()
    const withdrawal = prepareCashCommand(
      {
        ...original,
        kind: 'WITHDRAWAL',
        cash: { currency: 'AUD', amount: '0.000000000001' },
      },
      now
    ).command
    expect(prepareRevisionLegs(withdrawal, null, now)).toEqual([
      {
        phase: 'REVERSAL',
        currency: 'AUD',
        amount: '0.000000000001',
        role: 'EXTERNAL_CAPITAL',
      },
    ])
  })
  it('reverses imported execution cash once, including foreign-currency fees across allocations', () => {
    const sale = prepareCashCommand(
      {
        accountId: 'a1',
        kind: 'SELL',
        idempotencyKey: 'sale',
        effectiveDate: '2026-10-02',
        sequence: 1,
        source: { origin: 'IMPORT', reference: 'execution' },
        consideration: { currency: 'USD', amount: '100' },
        fees: [{ currency: 'AUD', amount: '1' }],
        transactionIds: ['t1', 't2'],
      },
      now
    ).command
    expect(prepareRevisionLegs(sale, null, now)).toEqual([
      {
        phase: 'REVERSAL',
        currency: 'USD',
        amount: '-100',
        role: 'TRADE_CONSIDERATION',
      },
      { phase: 'REVERSAL', currency: 'AUD', amount: '1', role: 'CASH_FEE' },
    ])
    const next = prepareCashCommand(
      {
        ...sale,
        transactionIds: ['t3'],
        idempotencyKey: 'new',
      },
      now
    ).command
    expect(() => prepareRevisionLegs(sale, next, now)).toThrow(
      'parcel transaction identities'
    )
  })
  it.each([
    null,
    [],
    {},
    { ...request, reason: '' },
    { ...request, reason: ' reason ' },
    { ...request, reason: 'x'.repeat(1001) },
    { ...request, reason: 'line\nbreak' },
    { ...request, expectedRevisionId: 1 },
    { ...request, idempotencyKey: 'x'.repeat(201) },
    { ...request, extra: true },
    { ...request, replacement: undefined },
    {
      ...request,
      replacement: { ...replacement, idempotencyKey: 'different' },
    },
  ])('rejects invalid or unhashed fields %#', (raw) => {
    expect(() => prepareCashRevision(raw, now)).toThrow()
  })
  it('requires imported correction snapshots, fees and source head to match the cash revision', () => {
    const previousFingerprint = 'a'.repeat(64)
    const nextFingerprint = 'b'.repeat(64)
    const input = {
      idempotencyKey: 'import-fix',
      expectedRevisionId: 'operation-1',
      expectedSourceFingerprint: previousFingerprint,
      reason: 'Corrected from broker statement',
      effectiveDate: '2026-10-03',
      sequence: 2,
      price: '50',
      fees: '2',
    }
    const replacement = prepareCashCommand(
      {
        accountId: 'a1',
        kind: 'BUY',
        idempotencyKey: input.idempotencyKey,
        source: { origin: 'IMPORT', reference: 'KRAKEN:order:1' },
        effectiveDate: input.effectiveDate,
        sequence: input.sequence,
        consideration: { currency: 'AUD', amount: '50' },
        fees: [{ currency: 'AUD', amount: '2' }],
        transactionIds: ['tx1'],
      },
      now
    ).command
    const before = {
      transactionId: 'tx1',
      positionId: 'p1',
      date: '2026-10-02T01:00:00.000Z',
      quantity: '1',
      price: '60',
      totalValue: '60',
      fees: '1',
      currency: 'AUD',
    }
    const after = {
      ...before,
      date: '2026-10-03T01:00:00.000Z',
      price: '50',
      totalValue: '50',
      fees: '2',
    }
    const revision = {
      idempotencyKey: input.idempotencyKey,
      expectedRevisionId: input.expectedRevisionId,
      reason: input.reason,
      replacement,
      importedExecutionAudit: {
        eventId: 'event-1',
        number: 1,
        previousFingerprint,
        nextFingerprint,
        input,
        before: [before],
        after: [after],
      },
    }

    expect(prepareCashRevision(revision, now).request).toMatchObject({
      importedExecutionAudit: { eventId: 'event-1', input },
    })
    expect(() =>
      prepareCashRevision(
        {
          ...revision,
          importedExecutionAudit: {
            ...revision.importedExecutionAudit,
            input: {
              ...input,
              expectedSourceFingerprint: 'c'.repeat(64),
            },
          },
        },
        now
      )
    ).toThrow('Imported execution audit must exactly match')
    expect(() =>
      prepareCashRevision(
        {
          ...revision,
          importedExecutionAudit: {
            ...revision.importedExecutionAudit,
            input: { ...input, fees: '3' },
          },
        },
        now
      )
    ).toThrow('Imported execution audit must exactly match')
  })
  it.each([
    { ...replacement, accountId: 'other' },
    { ...replacement, kind: 'WITHDRAWAL' },
    { ...replacement, source: { origin: 'MANUAL', reference: 'different' } },
  ])('rejects changing durable identity %#', (raw) => {
    const next = prepareCashCommand(raw, now).command
    expect(() => prepareRevisionLegs(original, next, now)).toThrow(
      'retain account'
    )
  })
})
