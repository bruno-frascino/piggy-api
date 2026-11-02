import { describe, expect, it } from 'vitest'
import { replayCashLedger } from './cash-ledger.js'
import {
  compareDraftCashEvidence,
  prepareDraftCashEvidence,
  prepareDraftCashFlow,
} from './draft-cash-evidence.js'

const now = new Date('2026-11-02T10:00:00Z')
const opening = {
  openingDate: '2026-10-01',
  cashBalances: [
    { currency: 'AUD', amount: '100' },
    { currency: 'USD', amount: '0' },
  ],
}
const request = {
  idempotencyKey: 'statement-1',
  asOfDate: '2026-10-31',
  source: 'Example Bank',
  reference: 'Statement 2026-10',
  attested: true,
  cashBalances: [
    { currency: 'AUD', amount: '90' },
    { currency: 'USD', amount: '0' },
  ],
  decisions: [
    {
      currency: 'AUD',
      reason: 'UNRECORDED_OPERATION',
      note: 'One transfer not staged yet',
    },
  ],
}

describe('manual statement cash evidence', () => {
  it('normalizes and binds attested evidence, source, balances and discrepancy decision', () => {
    const prepared = prepareDraftCashEvidence(request, opening.openingDate, now)
    const reordered = prepareDraftCashEvidence(
      {
        ...request,
        cashBalances: [
          { currency: 'USD', amount: '0.00' },
          { currency: 'AUD', amount: '90.0' },
        ],
      },
      opening.openingDate,
      now
    )
    expect(prepared.request.cashBalances).toEqual([
      { currency: 'AUD', amount: '90' },
      { currency: 'USD', amount: '0' },
    ])
    expect(prepared.payloadHash).toBe(reordered.payloadHash)
    expect(
      prepareDraftCashEvidence(
        {
          ...request,
          reference: 'Statement 2026-11',
        },
        opening.openingDate,
        now
      ).payloadHash
    ).not.toBe(prepared.payloadHash)
  })

  it('compares exact replay per currency and reports signed differences', () => {
    const replay = replayCashLedger(
      'a1',
      opening,
      [
        prepareDraftCashFlow(
          {
            idempotencyKey: 'deposit',
            effectiveDate: '2026-10-15',
            sequence: 1,
            kind: 'DEPOSIT',
            currency: 'AUD',
            amount: '25',
            sourceReference: 'bank-transfer-25',
          },
          'a1',
          now
        ).command,
        prepareDraftCashFlow(
          {
            idempotencyKey: 'withdrawal',
            effectiveDate: '2026-10-20',
            sequence: 1,
            kind: 'WITHDRAWAL',
            currency: 'AUD',
            amount: '35',
            sourceReference: 'bank-transfer-35',
          },
          'a1',
          now
        ).command,
      ],
      now
    )
    const prepared = prepareDraftCashEvidence(
      {
        ...request,
        cashBalances: [
          { currency: 'AUD', amount: '95' },
          { currency: 'USD', amount: '0' },
        ],
        decisions: [
          {
            currency: 'AUD',
            reason: 'UNRECORDED_OPERATION',
            note: 'Five dollars not yet recorded',
          },
        ],
      },
      opening.openingDate,
      now
    )
    expect(compareDraftCashEvidence(prepared.request, replay)).toEqual({
      matchesReplay: false,
      variances: [
        {
          currency: 'AUD',
          expectedAmount: '90',
          statementAmount: '95',
          difference: '5',
        },
      ],
      decisions: prepared.request.decisions,
    })
  })

  it('requires an exact decision for every mismatch but none for matches', () => {
    const replay = replayCashLedger('a1', opening, [], now)
    const matching = prepareDraftCashEvidence(
      {
        ...request,
        cashBalances: opening.cashBalances,
        decisions: [],
      },
      opening.openingDate,
      now
    )
    expect(
      compareDraftCashEvidence(matching.request, replay).matchesReplay
    ).toBe(true)
    expect(() =>
      compareDraftCashEvidence(
        prepareDraftCashEvidence(
          { ...request, decisions: [] },
          opening.openingDate,
          now
        ).request,
        replay
      )
    ).toThrow('one explicit decision')
    expect(() =>
      compareDraftCashEvidence(
        prepareDraftCashEvidence(
          {
            ...request,
            cashBalances: opening.cashBalances,
            decisions: [
              { currency: 'AUD', reason: 'OTHER', note: 'No variance' },
            ],
          },
          opening.openingDate,
          now
        ).request,
        replay
      )
    ).toThrow('one explicit decision')
    expect(
      compareDraftCashEvidence(
        prepareDraftCashEvidence(
          {
            ...request,
            decisions: [],
          },
          opening.openingDate,
          now
        ).request,
        replay,
        false
      ).matchesReplay
    ).toBe(false)
  })

  it.each([
    null,
    [],
    { ...request, attested: false },
    { ...request, asOfDate: '2026-10-01' },
    { ...request, asOfDate: '2026-11-03' },
    { ...request, source: '' },
    { ...request, reference: ' padded ' },
    { ...request, extra: true },
    {
      ...request,
      cashBalances: [
        { currency: 'AUD', amount: '0' },
        { currency: 'AUD', amount: '1' },
      ],
    },
    { ...request, cashBalances: [{ currency: 'AUD', amount: '-1' }] },
    { ...request, cashBalances: [{ currency: 'AUD', amount: '1e3' }] },
    {
      ...request,
      decisions: [{ currency: 'AUD', reason: 'ACCEPT_DIFFERENCE', note: 'ok' }],
    },
    { ...request, decisions: [{ currency: 'AUD', reason: 'OTHER', note: '' }] },
    {
      ...request,
      decisions: [
        { currency: 'AUD', reason: 'OTHER', note: 'ok', extra: true },
      ],
    },
  ])('rejects invalid statement evidence or decisions %#', (raw) => {
    expect(() =>
      prepareDraftCashEvidence(raw, opening.openingDate, now)
    ).toThrow()
  })

  it.each([
    { ...request, cashBalances: [{ currency: 'AUD', amount: '90' }] },
    {
      ...request,
      cashBalances: [
        { currency: 'AUD', amount: '90' },
        { currency: 'USD', amount: '0' },
        { currency: 'CAD', amount: '0' },
      ],
    },
  ])(
    'requires evidence currency coverage to match all explicitly tracked currencies',
    (raw) => {
      expect(() =>
        compareDraftCashEvidence(
          prepareDraftCashEvidence(raw, opening.openingDate, now).request,
          replayCashLedger('a1', opening, [], now)
        )
      ).toThrow('every explicitly tracked')
    }
  )

  it('accepts only actual dated manual deposit/withdrawal operations', () => {
    expect(
      prepareDraftCashFlow(
        {
          idempotencyKey: 'flow-1',
          effectiveDate: '2026-10-15',
          sequence: 1,
          kind: 'DEPOSIT',
          currency: 'AUD',
          amount: '1.25',
          sourceReference: 'bank-ref-1',
        },
        'a1',
        now
      ).command
    ).toMatchObject({
      accountId: 'a1',
      kind: 'DEPOSIT',
      source: { origin: 'MANUAL', reference: 'bank-ref-1' },
    })
    for (const raw of [
      { kind: 'BUY' },
      { kind: 'WITHDRAWAL', amount: '0' },
      { kind: 'DEPOSIT', amount: '-1' },
      { kind: 'DEPOSIT', sourceReference: '' },
      { kind: 'DEPOSIT', extra: true },
    ])
      expect(() =>
        prepareDraftCashFlow(
          {
            idempotencyKey: 'flow-1',
            effectiveDate: '2026-10-15',
            sequence: 1,
            currency: 'AUD',
            amount: '1',
            sourceReference: 'ref',
            ...raw,
          },
          'a1',
          now
        )
      ).toThrow()
  })
})
