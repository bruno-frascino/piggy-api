import { prisma } from './prisma.js'

export interface LiveImportedExecutionCorrectionMetadata {
  eventId: string
  transactionId: string
  operationId: string
  expectedRevisionId: string
  expectedSourceFingerprint: string
  effectiveDate: string
  sequence: number
  price: string
  fees: string
  currency: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function readLiveImportedExecutionCorrections(
  userId: string,
  transactionIds: readonly string[]
): Promise<Map<string, LiveImportedExecutionCorrectionMetadata>> {
  if (!transactionIds.length) return new Map()
  const uniqueTransactionIds = [...new Set(transactionIds)]
  const requestedTransactions = await prisma.transaction.findMany({
    where: { id: { in: uniqueTransactionIds } },
    select: {
      id: true,
      brokerRef: true,
      type: true,
      position: {
        select: { id: true, accountId: true, userId: true },
      },
    },
  })
  const requestedByExternalId = new Map<
    string,
    {
      id: string
      type: string
      positionId: string
      accountId: string
      userId: string
    }[]
  >()
  for (const transaction of requestedTransactions) {
    if (!transaction.brokerRef) continue
    const linked = requestedByExternalId.get(transaction.brokerRef) ?? []
    linked.push({
      id: transaction.id,
      type: transaction.type,
      positionId: transaction.position.id,
      accountId: transaction.position.accountId,
      userId: transaction.position.userId,
    })
    requestedByExternalId.set(transaction.brokerRef, linked)
  }
  const importedEvents = requestedByExternalId.size
    ? await prisma.importedEvent.findMany({
        where: {
          userId,
          source: 'KRAKEN',
          externalId: { in: [...requestedByExternalId.keys()] },
        },
        select: { id: true },
      })
    : []
  const operations = await prisma.accountCashOperation.findMany({
    where: {
      OR: [
        { transactionId: { in: uniqueTransactionIds } },
        ...(importedEvents.length
          ? [
              {
                importedEventId: {
                  in: importedEvents.map((event) => event.id),
                },
              },
            ]
          : []),
      ],
    },
    include: {
      importedEvent: {
        include: { batch: { select: { accountId: true, userId: true } } },
      },
      ledger: {
        include: {
          account: {
            select: { userId: true, status: true, isDemo: true },
          },
        },
      },
      transaction: {
        include: {
          position: { include: { asset: { include: { exchange: true } } } },
        },
      },
      revisions: {
        orderBy: { revisionNumber: 'asc' },
        select: { id: true, request: true },
      },
    },
  })
  const result = new Map<string, LiveImportedExecutionCorrectionMetadata>()
  for (const operation of operations) {
    const event = operation.importedEvent
    const account = operation.ledger.account
    const transaction = operation.transaction
    if (
      !event ||
      operation.importedEventId !== event.id ||
      event.source !== 'KRAKEN' ||
      event.status !== 'APPLIED' ||
      (event.kind !== 'BUY' && event.kind !== 'SELL') ||
      operation.kind !== event.kind ||
      event.externalId !== transaction.brokerRef ||
      transaction.type !== event.kind ||
      transaction.position.origin !== 'IMPORT_TRADE' ||
      transaction.position.positionType !== 'LONG' ||
      event.batch.userId !== userId ||
      event.batch.accountId !== operation.accountId ||
      operation.ledger.state !== 'ACTIVE' ||
      account.userId !== userId ||
      account.status !== 'ACTIVE' ||
      account.isDemo ||
      operation.transactionId !== transaction.id ||
      transaction.position.asset.exchange.currency !== event.quoteCurrency ||
      (event.fee.toFixed() !== '0' && event.feeCurrency !== event.quoteCurrency)
    )
      continue
    const latest = operation.revisions.at(-1)
    const request = record(latest?.request)
    const replacement = record(request?.replacement)
    const audit = record(request?.importedExecutionAudit)
    const auditInput = record(audit?.input)
    const auditedAfter = Array.isArray(audit?.after)
      ? audit.after
          .map(record)
          .find((snapshot) => snapshot?.transactionId === transaction.id)
      : null
    const cashCommand = record(record(operation.command)?.cashCommand)
    const effectiveDate =
      typeof replacement?.effectiveDate === 'string'
        ? replacement.effectiveDate
        : typeof cashCommand?.effectiveDate === 'string'
          ? cashCommand.effectiveDate
          : null
    const sequence =
      typeof replacement?.sequence === 'number'
        ? replacement.sequence
        : typeof cashCommand?.sequence === 'number'
          ? cashCommand.sequence
          : null
    const price = latest
      ? typeof auditInput?.price === 'string'
        ? auditInput.price
        : null
      : transaction.price.toFixed()
    const fees = latest
      ? typeof auditInput?.fees === 'string'
        ? auditInput.fees
        : null
      : event.fee.toFixed()
    if (
      typeof effectiveDate !== 'string' ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      typeof price !== 'string' ||
      typeof fees !== 'string' ||
      (latest &&
        (audit?.eventId !== event.id ||
          auditInput?.effectiveDate !== effectiveDate ||
          auditInput?.sequence !== sequence ||
          auditedAfter?.price !== price))
    )
      continue
    const metadata = {
      eventId: event.id,
      transactionId: transaction.id,
      operationId: operation.id,
      expectedRevisionId: latest?.id ?? operation.id,
      expectedSourceFingerprint: operation.ledger.acceptedSourceFingerprint,
      effectiveDate,
      sequence,
      price,
      fees,
      currency: transaction.position.asset.exchange.currency,
    }
    for (const requested of requestedByExternalId.get(event.externalId) ?? []) {
      if (
        requested.accountId !== operation.accountId ||
        requested.userId !== userId ||
        requested.type !== event.kind ||
        !Array.isArray(event.appliedPositionIds) ||
        !event.appliedPositionIds.includes(requested.positionId)
      )
        continue
      result.set(requested.id, {
        ...metadata,
        transactionId: requested.id,
      })
    }
  }
  return result
}
