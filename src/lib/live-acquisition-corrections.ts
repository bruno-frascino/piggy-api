import { prisma } from './prisma.js'
import { AccountingDecimal } from './accounting-values.js'
import { sydneyCalendarDate } from './accounting-preview.js'

export async function readLiveAcquisitionCorrections(
  userId: string,
  positionIds: string[]
) {
  const corrections = new Map<
    string,
    {
      operationId: string
      transactionId: string
      expectedRevisionId: string
      expectedSourceFingerprint: string
      effectiveDate: string
      sequence: number
      quantity: string
      price: string
      fees: string
    }
  >()
  if (!positionIds.length) return corrections
  const operations = await prisma.accountCashOperation.findMany({
    where: {
      kind: 'BUY',
      importedEventId: null,
      ledger: { state: 'ACTIVE', openingStatement: { state: 'CONFIRMED' } },
      transaction: {
        voidedAt: null,
        type: 'BUY',
        brokerRef: null,
        position: {
          id: { in: positionIds },
          userId,
          origin: 'MANUAL',
          positionType: 'LONG',
          voidedAt: null,
          account: { userId, status: 'ACTIVE', isDemo: false },
          transactions: { none: { brokerRef: { not: null } } },
        },
      },
    },
    select: {
      id: true,
      sequence: true,
      ledger: { select: { acceptedSourceFingerprint: true } },
      revisions: {
        orderBy: { revisionNumber: 'asc' },
        select: { id: true, request: true },
      },
      transaction: {
        select: {
          id: true,
          positionId: true,
          date: true,
          quantity: true,
          price: true,
          fees: true,
          position: {
            select: {
              transactions: { where: { type: 'BUY' }, select: { id: true } },
            },
          },
        },
      },
    },
  })
  for (const operation of operations) {
    const trade = operation.transaction
    if (trade.position.transactions.length !== 1) continue
    const latest = operation.revisions.at(-1)
    const request = latest?.request
    const replacement =
      request && typeof request === 'object' && !Array.isArray(request)
        ? request.replacement
        : null
    const sequence =
      replacement &&
      typeof replacement === 'object' &&
      !Array.isArray(replacement)
        ? replacement.sequence
        : Number(operation.sequence)
    const fingerprint = operation.ledger.acceptedSourceFingerprint
    if (
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      typeof fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(fingerprint)
    )
      throw Object.assign(
        new Error('Live acquisition correction metadata is inconsistent'),
        { status: 409 }
      )
    corrections.set(trade.positionId, {
      operationId: operation.id,
      transactionId: trade.id,
      expectedRevisionId: latest?.id ?? operation.id,
      expectedSourceFingerprint: fingerprint,
      effectiveDate: sydneyCalendarDate(trade.date),
      sequence,
      quantity: new AccountingDecimal(String(trade.quantity)).toFixed(),
      price: trade.price.toFixed(),
      fees: trade.fees.toFixed(),
    })
  }
  return corrections
}
