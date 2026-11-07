import { describe, expect, it } from 'vitest'
import {
  correctImportedExecutionSnapshots,
  importedExecutionCorrectionHash,
  parseImportedExecutionAudit,
  parseImportedExecutionCorrectionInput,
} from './import-execution-correction.js'

const input = {
  idempotencyKey: 'import-correction-1',
  expectedRevisionId: 'operation-1',
  expectedSourceFingerprint: 'a'.repeat(64),
  reason: 'Corrected from broker statement',
  effectiveDate: '2026-10-12',
  sequence: 3,
  price: '12.345678901234',
  fees: '1.00000001',
}

const before = [
  {
    transactionId: 'tx-1',
    positionId: 'position-1',
    date: '2026-10-10T01:00:00.000Z',
    quantity: '2',
    price: '10',
    totalValue: '20',
    fees: '0.5',
    currency: 'AUD',
  },
  {
    transactionId: 'tx-2',
    positionId: 'position-2',
    date: '2026-10-10T01:00:00.000Z',
    quantity: '1',
    price: '10',
    totalValue: '10',
    fees: '0.5',
    currency: 'AUD',
  },
]

describe('imported execution corrections', () => {
  it('parses exact correction fields and rejects unsupported fields', () => {
    expect(parseImportedExecutionCorrectionInput(input)).toMatchObject({
      effectiveDate: input.effectiveDate,
      price: input.price,
      fees: input.fees,
    })
    expect(() =>
      parseImportedExecutionCorrectionInput({ ...input, quantity: '4' })
    ).toThrow()
    expect(() =>
      parseImportedExecutionCorrectionInput({ ...input, sequence: 0 })
    ).toThrow()
    expect(() =>
      parseImportedExecutionCorrectionInput({ ...input, fees: '-1' })
    ).toThrow()
  })

  it('reprices fixed parcel quantities and allocates fees exactly', () => {
    const corrected = correctImportedExecutionSnapshots(
      before,
      input.price,
      input.fees,
      input.effectiveDate
    )
    expect(corrected.map((row) => row.totalValue)).toEqual([
      '24.6913578',
      '12.3456789',
    ])
    expect(corrected.map((row) => row.fees)).toEqual([
      '0.66666667',
      '0.33333334',
    ])
    expect(corrected.map((row) => row.quantity)).toEqual(['2', '1'])
    expect(corrected.map((row) => row.positionId)).toEqual([
      'position-1',
      'position-2',
    ])
  })

  it('rejects allocations whose parcel currencies differ', () => {
    expect(() =>
      correctImportedExecutionSnapshots(
        [before[0], { ...before[1], currency: 'USD' }],
        '12',
        '1',
        input.effectiveDate
      )
    ).toThrow('single-currency allocation')
  })

  it('validates immutable audit snapshots and generates stable retry hashes', () => {
    const audit = {
      eventId: 'event-1',
      number: 1,
      previousFingerprint: 'a'.repeat(64),
      nextFingerprint: 'b'.repeat(64),
      input,
      before,
      after: correctImportedExecutionSnapshots(
        before,
        input.price,
        input.fees,
        input.effectiveDate
      ),
    }
    expect(parseImportedExecutionAudit(audit)).toMatchObject(audit)
    expect(importedExecutionCorrectionHash(input)).toBe(
      importedExecutionCorrectionHash({ ...input })
    )
    expect(() =>
      parseImportedExecutionAudit({
        ...audit,
        after: [...audit.after, audit.after[0]],
      })
    ).toThrow()
  })
})
