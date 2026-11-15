import { describe, expect, it } from 'vitest'
import { prepareAccountCashTransfer } from './account-cash-transfer.js'
import { replayCashLedger } from './cash-ledger.js'
import {
  prepareRevisionLegs,
  prepareLiveTransferCashRevision,
  prepareTransferRevisionLegs,
} from './cash-revisions.js'

const now = new Date('2026-11-14T00:00:00Z')
const input = {
  toAccountId: 'destination',
  idempotencyKey: 'transfer-1',
  effectiveDate: '2026-11-13',
  sourceSequence: 1,
  destinationSequence: 2,
  currency: 'AUD',
  amount: '40.000000000001',
  fee: '0.5',
  sourceReference: 'statement-transfer-1',
}

describe('paired cash transfers', () => {
  it('prepares linked immutable revisions with exact legs and fixed endpoint/currency/source identity', () => {
    const transfer = prepareAccountCashTransfer(input, 'source', now)
    const correction = {
      idempotencyKey: 'fix-1',
      reason: 'Correct broker fee',
      sourceHead: {
        revisionId: 'out-1',
        auditNumber: 1,
        sourceFingerprint: 'a'.repeat(64),
      },
      destinationHead: {
        revisionId: 'in-1',
        auditNumber: 4,
        sourceFingerprint: 'b'.repeat(64),
      },
      replacement: {
        effectiveDate: '2026-11-12',
        sourceSequence: 2,
        destinationSequence: 3,
        amount: '30',
        fee: '1.5',
      },
    }
    const outgoing = prepareLiveTransferCashRevision(
      correction,
      transfer.outgoing.command,
      now
    )
    const incoming = prepareLiveTransferCashRevision(
      correction,
      transfer.incoming.command,
      now
    )
    expect(outgoing.request.replacement).toMatchObject({
      accountId: 'source',
      cash: { currency: 'AUD', amount: '30' },
      fee: '1.5',
      transfer: { fromAccountId: 'source', toAccountId: 'destination' },
      source: { origin: 'MANUAL', reference: input.sourceReference },
    })
    expect(incoming.request.transferAudit).toMatchObject({ number: 5 })
    expect(incoming.request.replacement).toMatchObject({
      fee: '0',
      sequence: 3,
    })
    expect(
      prepareTransferRevisionLegs(
        transfer.outgoing.command,
        outgoing.request.replacement,
        now
      )
    ).toMatchObject([
      { amount: input.amount, phase: 'REVERSAL' },
      { amount: input.fee, phase: 'REVERSAL' },
      { amount: '-30', phase: 'REPLACEMENT' },
      { amount: '-1.5', phase: 'REPLACEMENT' },
    ])
    expect(() =>
      prepareLiveTransferCashRevision(
        {
          ...correction,
          replacement: { ...correction.replacement, currency: 'USD' },
        },
        transfer.outgoing.command,
        now
      )
    ).toThrow()
    expect(
      prepareLiveTransferCashRevision(
        { ...correction, replacement: null },
        transfer.outgoing.command,
        now
      ).request.replacement
    ).toBeNull()
  })

  it('conserves principal, charges the sender fee, and cancels capital flows across both endpoints', () => {
    const prepared = prepareAccountCashTransfer(input, 'source', now)
    const source = replayCashLedger(
      'source',
      {
        openingDate: '2026-11-01',
        cashBalances: [{ currency: 'AUD', amount: '100' }],
      },
      [prepared.outgoing.command],
      now
    )
    const destination = replayCashLedger(
      'destination',
      {
        openingDate: '2026-11-01',
        cashBalances: [{ currency: 'AUD', amount: '0' }],
      },
      [prepared.incoming.command],
      now
    )
    expect(source.balances[0]).toMatchObject({
      endingAmount: '59.499999999999',
      netExternalContribution: '-40.000000000001',
    })
    expect(destination.balances[0]).toMatchObject({
      endingAmount: '40.000000000001',
      netExternalContribution: '40.000000000001',
    })
    expect(
      prepareAccountCashTransfer({ ...input, fee: '0.5000' }, 'source', now)
        .payloadHash
    ).toBe(prepared.payloadHash)
    expect(
      prepareAccountCashTransfer(
        { ...input, toAccountId: 'other' },
        'source',
        now
      ).payloadHash
    ).not.toBe(prepared.payloadHash)
    expect(() =>
      prepareRevisionLegs(prepared.outgoing.command, null, now)
    ).toThrow(/one account at a time/)
  })

  it.each([
    { toAccountId: 'source' },
    { amount: '0' },
    { amount: 40 },
    { fee: '-1' },
    { fee: '0.0000000000001' },
    { currency: 'BTC' },
    { sourceSequence: 0 },
    { destinationSequence: '2' },
    { effectiveDate: '2026-11-15' },
    { sourceReference: ' reference ' },
    { destinationCurrency: 'USD' },
  ])('rejects invalid or unsupported transfer content %j', (override) => {
    expect(() =>
      prepareAccountCashTransfer({ ...input, ...override }, 'source', now)
    ).toThrow()
  })

  it('requires explicit currency openings and checks the dated timeline including fees', () => {
    const prepared = prepareAccountCashTransfer(
      { ...input, amount: '100' },
      'source',
      now
    )
    const replay = replayCashLedger(
      'source',
      {
        openingDate: '2026-11-01',
        cashBalances: [{ currency: 'AUD', amount: '100' }],
      },
      [prepared.outgoing.command],
      now
    )
    expect(replay.funded).toBe(false)
    expect(replay.fundingIssues[0].balance).toBe('-0.5')
    expect(() =>
      replayCashLedger(
        'destination',
        {
          openingDate: '2026-11-01',
          cashBalances: [],
        },
        [prepared.incoming.command],
        now
      )
    ).toThrow()
  })
})
