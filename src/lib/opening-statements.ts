import { createHash } from 'node:crypto'
import { prisma } from './prisma.js'
import { lockActiveUser } from './user-lock.js'
import { parseOpeningPreviewInput } from './accounting-preview.js'
import { readAccountOpeningPreview } from './accounting-preview-service.js'

const statementSelect = {
  id: true,
  accountId: true,
  version: true,
  openingDate: true,
  timezone: true,
  state: true,
  sourceFingerprint: true,
  inputHash: true,
  createdAt: true,
  cashBalances: {
    orderBy: { currency: 'asc' },
    select: { currency: true, amount: true },
  },
  _count: { select: { parcels: true } },
} as const

type StatementDb = Pick<typeof prisma, 'accountOpeningStatement'>
async function findReviewedStatement(
  db: StatementDb,
  accountId: string,
  sourceFingerprint: string
) {
  return db.accountOpeningStatement.findUnique({
    where: { accountId_sourceFingerprint: { accountId, sourceFingerprint } },
    select: statementSelect,
  })
}
type StatementRow = NonNullable<
  Awaited<ReturnType<typeof findReviewedStatement>>
>

function statementSummary(row: StatementRow) {
  if (row.state !== 'DRAFT' || row.timezone !== 'Australia/Sydney')
    throw new Error('Unsupported opening statement state or timezone')
  return {
    id: row.id,
    accountId: row.accountId,
    version: row.version,
    openingDate: row.openingDate.toISOString().slice(0, 10),
    timezone: 'Australia/Sydney' as const,
    state: 'DRAFT' as const,
    sourceFingerprint: row.sourceFingerprint,
    createdAt: row.createdAt.toISOString(),
    cashBalances: row.cashBalances.map((balance) => ({
      currency: balance.currency,
      amount: balance.amount.toFixed(),
    })),
    parcelCount: row._count.parcels,
  }
}

function clientError(status: number, name: string, message: string): never {
  throw Object.assign(new Error(message), { status, name })
}

function isConcurrentConflict(error: unknown) {
  if (!error || typeof error !== 'object') return false
  if ('code' in error && (error.code === 'P2034' || error.code === 'P2002'))
    return true
  // PostgreSQL serialization failures at COMMIT can escape Prisma's P2034 mapping.
  return (
    'name' in error &&
    error.name === 'DriverAdapterError' &&
    'cause' in error &&
    error.cause !== null &&
    typeof error.cause === 'object' &&
    'kind' in error.cause &&
    error.cause.kind === 'TransactionWriteConflict' &&
    'originalCode' in error.cause &&
    error.cause.originalCode === '40001'
  )
}

export async function saveOpeningStatement(
  userId: string,
  accountId: string,
  raw: unknown
) {
  const now = new Date()
  const input = parseOpeningPreviewInput(raw, now)
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('sourceFingerprint' in raw) ||
    typeof raw.sourceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.sourceFingerprint)
  )
    clientError(
      400,
      'Validation Error',
      'A reviewed preview fingerprint is required'
    )
  const sourceFingerprint = raw.sourceFingerprint
  const inputHash = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (db) => {
          await lockActiveUser(db, userId)
          const account = await db.tradingAccount.findFirst({
            where: { id: accountId, userId },
            select: { id: true, isDemo: true, status: true },
          })
          if (!account)
            clientError(404, 'Not Found', 'Trading account not found')
          if (account.isDemo || account.status !== 'ACTIVE')
            clientError(
              409,
              'Conflict',
              'Opening drafts can only be saved for active real accounts'
            )
          const existing = await findReviewedStatement(
            db,
            accountId,
            sourceFingerprint
          )
          if (existing) {
            if (existing.inputHash !== inputHash)
              clientError(
                409,
                'Conflict',
                'This fingerprint was already saved with different opening inputs'
              )
            return { statement: statementSummary(existing), created: false }
          }
          const preview = await readAccountOpeningPreview(
            db,
            userId,
            accountId,
            input,
            now
          )
          if (preview.sourceFingerprint !== sourceFingerprint)
            clientError(
              409,
              'Conflict',
              'The preview or inputs have changed. Preview balances again before saving.'
            )
          if (
            preview.parcels.some(
              (parcel) =>
                !/^(?:0|[1-9]\d{0,25})(?:\.\d{1,12})?$/.test(
                  parcel.openingQuantity
                )
            )
          )
            clientError(
              422,
              'Invalid Opening Inventory',
              'Opening quantities cannot be saved without loss of precision or with negative inventory. Reconcile the affected parcels first.'
            )
          const latest = await db.accountOpeningStatement.findFirst({
            where: { accountId },
            orderBy: { version: 'desc' },
            select: { version: true },
          })
          const saved = await db.accountOpeningStatement.create({
            data: {
              accountId,
              version: (latest?.version ?? 0) + 1,
              openingDate: new Date(`${input.openingDate}T00:00:00Z`),
              timezone: 'Australia/Sydney',
              state: 'DRAFT',
              sourceFingerprint,
              inputHash,
              previewSnapshot: {
                ...preview,
                parcels: preview.parcels.map((parcel) => ({ ...parcel })),
                cashBalances: preview.cashBalances.map((balance) => ({
                  ...balance,
                })),
                issues: preview.issues.map((issue) => ({ ...issue })),
                counts: { ...preview.counts },
              },
              cashBalances: {
                create: input.cashBalances.map((balance) => ({ ...balance })),
              },
              parcels: {
                create: preview.parcels.map((parcel) => ({
                  positionId: parcel.positionId,
                  symbol: parcel.symbol,
                  currency: parcel.currency,
                  quantity: parcel.openingQuantity,
                })),
              },
            },
            select: statementSelect,
          })
          return { statement: statementSummary(saved), created: true }
        },
        { isolationLevel: 'Serializable', timeout: 15000 }
      )
    } catch (error: unknown) {
      if (!isConcurrentConflict(error)) throw error
      if (attempt === 2)
        clientError(
          409,
          'Conflict',
          'Another draft changed concurrently. Reload and retry saving.'
        )
    }
  }
  throw new Error('Opening draft transaction did not complete')
}

export async function listOpeningStatements(
  userId: string,
  accountId: string,
  beforeVersion?: number
) {
  const account = await prisma.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  })
  if (!account) clientError(404, 'Not Found', 'Trading account not found')
  const rows = await prisma.accountOpeningStatement.findMany({
    where: {
      accountId,
      account: { userId },
      ...(beforeVersion ? { version: { lt: beforeVersion } } : {}),
    },
    orderBy: { version: 'desc' },
    take: 21,
    select: statementSelect,
  })
  const page = rows.slice(0, 20)
  return {
    statements: page.map(statementSummary),
    nextBeforeVersion: rows.length > 20 ? page[page.length - 1].version : null,
  }
}
