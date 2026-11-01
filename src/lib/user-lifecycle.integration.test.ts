import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('./prisma.js').prisma
let deletion: typeof import('./account-deletion.js')
let mutations: typeof import('./position-mutations.js')
let lifecycle: typeof import('./trading-account-mutations.js')
let locks: typeof import('./user-lock.js')
let snapshots: typeof import('./portfolio-snapshot.js')
let positionService: typeof import('./position-service.js')
let resets: typeof import('./password-reset.js')
let derived: typeof import('./position-derived-values.js')
const users: string[] = []
let exchangeId: string | undefined
const passwordHash = 'fixture-not-a-login'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  if (!exchangeId) throw new Error('Missing disposable user lifecycle exchange')
  const user = await prisma.user.create({
    data: {
      email: `user-barrier-fixture-${randomUUID()}@example.invalid`,
      passwordHash,
    },
  })
  users.push(user.id)
  const account = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      name: `User barrier fixture ${randomUUID()}`,
    },
  })
  const asset = await prisma.asset.create({
    data: {
      exchangeId,
      symbol: `FIXTURE-${randomUUID()}`,
      name: 'Disposable user lifecycle asset',
    },
  })
  const data = {
    assetId: asset.id,
    openDate: new Date('2026-01-01'),
    quantity: 10,
    entryPrice: '10',
    totalBuyValue: '100',
    buyFees: '2',
    capitalAllocated: '102',
    transactions: {
      create: {
        type: 'BUY' as const,
        date: new Date('2026-01-01'),
        quantity: 10,
        price: '10',
        totalValue: '100',
        fees: '2',
      },
    },
  }
  return { user, account, asset, data, exchangeId }
}

describe.skipIf(!enabled)(
  'user lifecycle coordination on disposable localhost fixtures',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('User lifecycle tests require a localhost database')
      prisma = (await import('./prisma.js')).prisma
      deletion = await import('./account-deletion.js')
      mutations = await import('./position-mutations.js')
      lifecycle = await import('./trading-account-mutations.js')
      locks = await import('./user-lock.js')
      snapshots = await import('./portfolio-snapshot.js')
      positionService = await import('./position-service.js')
      resets = await import('./password-reset.js')
      derived = await import('./position-derived-values.js')
      exchangeId = (
        await prisma.exchange.create({
          data: {
            code: `FIXTURE-${randomUUID()}`,
            name: 'Disposable user lifecycle fixture',
            currency: 'AUD',
            countryName: 'Australia',
            countryCode: 'AU',
          },
        })
      ).id
    })
    afterEach(() => vi.restoreAllMocks())
    afterAll(async () => {
      vi.restoreAllMocks()
      try {
        if (users.length)
          await prisma.user.deleteMany({ where: { id: { in: users } } })
        if (exchangeId) {
          await prisma.asset.deleteMany({ where: { exchangeId } })
          await prisma.exchange.delete({ where: { id: exchangeId } })
        }
      } finally {
        if (prisma) await prisma.$disconnect()
      }
    })

    it('deletion waits for an in-flight disposal then revokes sessions and rejects further writes', async () => {
      const f = await fixture()
      const position = await mutations.createPosition(
        f.user.id,
        { accountId: f.account.id },
        f.data
      )
      await prisma.refreshToken.create({
        data: {
          userId: f.user.id,
          token: `fixture-${randomUUID()}`,
          expiresAt: new Date('2030-01-01'),
        },
      })
      await prisma.passwordResetToken.create({
        data: {
          userId: f.user.id,
          token: randomUUID(),
          expiresAt: new Date('2030-01-01'),
        },
      })
      const ready = deferred()
      const released = deferred()
      const recompute = positionService.recomputePositionFromTransactions
      vi.spyOn(
        positionService,
        'recomputePositionFromTransactions'
      ).mockImplementationOnce(async (...args) => {
        const result = await recompute(...args)
        ready.resolve()
        await released.promise
        return result
      })
      const closing = mutations.closePosition(f.user.id, position.id, {
        closeDate: new Date('2026-02-01'),
        quantity: 4,
        exitPrice: 12,
        fees: 1,
      })
      await ready.promise
      const deleting = deletion.scheduleUserDeletion(f.user.id, passwordHash)
      try {
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } }))
            .deletedAt
        ).toBeNull()
      } finally {
        released.resolve()
      }
      await closing
      await deleting
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: position.id },
          })
        ).quantity
      ).toBe(6)
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id } })
      ).toBe(0)
      expect(
        await prisma.passwordResetToken.count({ where: { userId: f.user.id } })
      ).toBe(0)
      await expect(
        mutations.closePosition(f.user.id, position.id, {
          closeDate: new Date('2026-03-01'),
          exitPrice: 12,
          quantity: 1,
        })
      ).rejects.toMatchObject({ status: 401 })
      await expect(
        snapshots.savePortfolioSnapshot(f.user.id, f.account.id, f.exchangeId)
      ).rejects.toMatchObject({ status: 401 })
      await expect(
        lifecycle.renameTradingAccount(f.user.id, f.account.id, 'Late rename')
      ).rejects.toMatchObject({ status: 401 })
    })

    it('a purchase waiting behind deletion is rejected without creating a parcel or default account', async () => {
      const f = await fixture()
      const ready = deferred()
      const released = deferred()
      const barrier = prisma.$transaction(async (db) => {
        await locks.lockUserLifecycle(db, f.user.id)
        await db.user.update({
          where: { id: f.user.id },
          data: {
            deletedAt: new Date('2026-01-01'),
            purgeAfter: new Date('2026-01-31'),
          },
        })
        ready.resolve()
        await released.promise
      })
      await ready.promise
      const buying = mutations.createPosition(f.user.id, {}, f.data)
      const outcome = expect(buying).rejects.toMatchObject({ status: 401 })
      released.resolve()
      await barrier
      await outcome
      expect(
        await prisma.position.count({ where: { userId: f.user.id } })
      ).toBe(0)
      expect(
        await prisma.tradingAccount.count({ where: { userId: f.user.id } })
      ).toBe(1)
    })

    it('different accounts retain concurrent write access under shared user barriers', async () => {
      const f = await fixture()
      const second = await prisma.tradingAccount.create({
        data: { userId: f.user.id, name: 'Second' },
      })
      const ready = deferred()
      const released = deferred()
      const barrier = prisma.$transaction(async (db) => {
        await locks.lockActiveUser(db, f.user.id)
        await (
          await import('./account-lock.js')
        ).lockOwnedTradingAccount(db, f.user.id, f.account.id)
        ready.resolve()
        await released.promise
      })
      await ready.promise
      try {
        await expect(
          mutations.createPosition(f.user.id, { accountId: second.id }, f.data)
        ).resolves.toMatchObject({ accountId: second.id })
      } finally {
        released.resolve()
      }
      await barrier
    })

    it('restoration and its persisted session commit together, re-enabling account writes', async () => {
      const f = await fixture()
      const state = await deletion.scheduleUserDeletion(f.user.id, passwordHash)
      const token = `restored-fixture-${randomUUID()}`
      await deletion.restoreDeletedUser(
        f.user.id,
        passwordHash,
        state.deletedAt,
        token,
        new Date('2030-01-01')
      )
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } }))
          .deletedAt
      ).toBeNull()
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id, token } })
      ).toBe(1)
      await expect(
        mutations.createPosition(f.user.id, { accountId: f.account.id }, f.data)
      ).resolves.toMatchObject({ accountId: f.account.id })
      await expect(
        deletion.restoreDeletedUser(
          f.user.id,
          passwordHash,
          state.deletedAt,
          `retry-${randomUUID()}`,
          new Date()
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id } })
      ).toBe(1)
    })

    it('a failed restoration session write leaves the user deleted', async () => {
      const f = await fixture()
      const state = await deletion.scheduleUserDeletion(f.user.id, passwordHash)
      const token = `duplicate-fixture-${randomUUID()}`
      await prisma.refreshToken.create({
        data: { userId: f.user.id, token, expiresAt: new Date('2030-01-01') },
      })
      await expect(
        deletion.restoreDeletedUser(
          f.user.id,
          passwordHash,
          state.deletedAt,
          token,
          new Date('2030-01-01')
        )
      ).rejects.toMatchObject({ code: 'P2002' })
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } }))
          .deletedAt
      ).toEqual(state.deletedAt)
    })

    it('deletion refuses authentication verified before a password change', async () => {
      const f = await fixture()
      await prisma.user.update({
        where: { id: f.user.id },
        data: { passwordHash: 'changed-fixture-hash' },
      })
      await expect(
        deletion.scheduleUserDeletion(f.user.id, passwordHash)
      ).rejects.toMatchObject({ status: 401 })
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } }))
          .deletedAt
      ).toBeNull()
    })

    it('a restore after the purge scan wins safely and is not reported as erased', async () => {
      const f = await fixture()
      await deletion.scheduleUserDeletion(
        f.user.id,
        passwordHash,
        new Date('2026-01-01')
      )
      const ready = deferred()
      const released = deferred()
      const restoring = prisma.$transaction(async (db) => {
        await locks.lockUserLifecycle(db, f.user.id)
        ready.resolve()
        await released.promise
        await db.user.update({
          where: { id: f.user.id },
          data: { deletedAt: null, purgeAfter: null },
        })
      })
      await ready.promise
      const due = prisma.user.findMany({
        where: {
          id: f.user.id,
          deletedAt: { not: null },
          purgeAfter: { lte: new Date('2026-03-01') },
        },
      })
      vi.spyOn(prisma.user, 'findMany').mockReturnValueOnce(due)
      const purging = deletion.purgeExpiredAccounts(new Date('2026-03-01'))
      try {
        expect(await due).toHaveLength(1)
      } finally {
        released.resolve()
      }
      await restoring
      expect(await purging).toEqual([])
      expect(
        await prisma.user.findUnique({ where: { id: f.user.id } })
      ).not.toBeNull()
    })

    it('deleted users cannot mint or rotate sessions after revocation', async () => {
      const f = await fixture()
      const token = `login-fixture-${randomUUID()}`
      await deletion.persistUserSession(
        f.user.id,
        passwordHash,
        token,
        new Date('2030-01-01')
      )
      await deletion.scheduleUserDeletion(f.user.id, passwordHash)
      await expect(
        deletion.persistUserSession(
          f.user.id,
          passwordHash,
          `late-${randomUUID()}`,
          new Date('2030-01-01')
        )
      ).rejects.toMatchObject({ status: 401 })
      await expect(
        deletion.rotateUserSession(
          f.user.id,
          token,
          `rotate-${randomUUID()}`,
          new Date('2030-01-01')
        )
      ).rejects.toMatchObject({ status: 401 })
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id } })
      ).toBe(0)
    })

    it('competing refreshes rotate the same token at most once', async () => {
      const f = await fixture()
      const token = `login-fixture-${randomUUID()}`
      await deletion.persistUserSession(
        f.user.id,
        passwordHash,
        token,
        new Date('2030-01-01')
      )
      const results = await Promise.allSettled([
        deletion.rotateUserSession(
          f.user.id,
          token,
          `rotate-a-${randomUUID()}`,
          new Date('2030-01-01')
        ),
        deletion.rotateUserSession(
          f.user.id,
          token,
          `rotate-b-${randomUUID()}`,
          new Date('2030-01-01')
        ),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1)
      const failure = results.find((result) => result.status === 'rejected')
      expect(failure?.status === 'rejected' && failure.reason).toMatchObject({
        status: 401,
      })
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id } })
      ).toBe(1)
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id, token } })
      ).toBe(0)
    })

    it('a failed refresh replacement rolls back old-token revocation', async () => {
      const f = await fixture()
      const old = `old-fixture-${randomUUID()}`
      const duplicate = `duplicate-fixture-${randomUUID()}`
      await deletion.persistUserSession(
        f.user.id,
        passwordHash,
        old,
        new Date('2030-01-01')
      )
      await deletion.persistUserSession(
        f.user.id,
        passwordHash,
        duplicate,
        new Date('2030-01-01')
      )
      await expect(
        deletion.rotateUserSession(
          f.user.id,
          old,
          duplicate,
          new Date('2030-01-01')
        )
      ).rejects.toMatchObject({ code: 'P2002' })
      expect(
        await prisma.refreshToken.count({
          where: { userId: f.user.id, token: old },
        })
      ).toBe(1)
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id } })
      ).toBe(2)
    })

    it('competing password reset completions change the password exactly once and revoke sessions', async () => {
      const f = await fixture()
      const token = randomUUID()
      await resets.issuePasswordReset(f.user.id, token, new Date('2030-01-01'))
      await deletion.persistUserSession(
        f.user.id,
        passwordHash,
        randomUUID(),
        new Date('2030-01-01')
      )
      const results = await Promise.allSettled([
        resets.completePasswordReset(f.user.id, token, 'first-fixture-hash'),
        resets.completePasswordReset(f.user.id, token, 'second-fixture-hash'),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { status: 400 },
      })
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: f.user.id },
      })
      expect(['first-fixture-hash', 'second-fixture-hash']).toContain(
        user.passwordHash
      )
      expect(
        await prisma.passwordResetToken.count({ where: { userId: f.user.id } })
      ).toBe(0)
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id } })
      ).toBe(0)
      await expect(
        deletion.persistUserSession(
          f.user.id,
          passwordHash,
          randomUUID(),
          new Date('2030-01-01')
        )
      ).rejects.toMatchObject({ status: 401 })
    })

    it('failed password reset transaction leaves password, reset token and session intact', async () => {
      const f = await fixture()
      const token = randomUUID()
      const session = randomUUID()
      await resets.issuePasswordReset(f.user.id, token, new Date('2030-01-01'))
      await deletion.persistUserSession(
        f.user.id,
        passwordHash,
        session,
        new Date('2030-01-01')
      )
      const transact = prisma.$transaction.bind(prisma)
      const failure = new Error('Injected failure before commit')
      vi.spyOn(prisma, '$transaction').mockImplementationOnce((callback) => {
        if (typeof callback !== 'function')
          throw new Error('Expected interactive transaction')
        return transact(async (db) => {
          await callback(db)
          throw failure
        })
      })
      await expect(
        resets.completePasswordReset(f.user.id, token, 'new-fixture-hash')
      ).rejects.toBe(failure)
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } }))
          .passwordHash
      ).toBe(passwordHash)
      expect(
        await prisma.passwordResetToken.count({
          where: { userId: f.user.id, token },
        })
      ).toBe(1)
      expect(
        await prisma.refreshToken.count({
          where: { userId: f.user.id, token: session },
        })
      ).toBe(1)
    })

    it('reset-token replacement failure rolls back invalidation of the previous token', async () => {
      const f = await fixture()
      const other = await fixture()
      const previous = randomUUID()
      const duplicate = randomUUID()
      await resets.issuePasswordReset(
        f.user.id,
        previous,
        new Date('2030-01-01')
      )
      await resets.issuePasswordReset(
        other.user.id,
        duplicate,
        new Date('2030-01-01')
      )
      await expect(
        resets.issuePasswordReset(f.user.id, duplicate, new Date('2030-01-01'))
      ).rejects.toMatchObject({ code: 'P2002' })
      expect(
        await prisma.passwordResetToken.count({
          where: { userId: f.user.id, token: previous },
        })
      ).toBe(1)
    })

    it('deletion winning the user barrier prevents late reset issuance and completion', async () => {
      const f = await fixture()
      const token = randomUUID()
      await resets.issuePasswordReset(f.user.id, token, new Date('2030-01-01'))
      const ready = deferred()
      const release = deferred()
      const deleting = prisma.$transaction(async (db) => {
        await locks.lockUserLifecycle(db, f.user.id)
        ready.resolve()
        await release.promise
        await db.user.update({
          where: { id: f.user.id },
          data: { deletedAt: new Date() },
        })
        await db.passwordResetToken.deleteMany({ where: { userId: f.user.id } })
      })
      await ready.promise
      const issuance = resets.issuePasswordReset(
        f.user.id,
        randomUUID(),
        new Date('2030-01-01')
      )
      const completion = resets.completePasswordReset(
        f.user.id,
        token,
        'late-fixture-hash'
      )
      const result = Promise.allSettled([issuance, completion])
      release.resolve()
      await deleting
      expect(await result).toMatchObject([
        { status: 'fulfilled', value: false },
        { status: 'rejected', reason: { status: 400 } },
      ])
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } }))
          .passwordHash
      ).toBe(passwordHash)
      expect(
        await prisma.passwordResetToken.count({ where: { userId: f.user.id } })
      ).toBe(0)
    })

    it('reissued and expired reset tokens cannot replace the password', async () => {
      const f = await fixture()
      const previous = randomUUID()
      const current = randomUUID()
      await resets.issuePasswordReset(
        f.user.id,
        previous,
        new Date('2030-01-01')
      )
      await resets.issuePasswordReset(
        f.user.id,
        current,
        new Date('2020-01-01')
      )
      for (const token of [previous, current])
        await expect(
          resets.completePasswordReset(f.user.id, token, 'late-fixture-hash')
        ).rejects.toMatchObject({ status: 400 })
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } }))
          .passwordHash
      ).toBe(passwordHash)
    })

    it('rejects stale background history after an acquisition edit, account move or parcel deletion', async () => {
      const f = await fixture()
      const position = await mutations.createPosition(
        f.user.id,
        { accountId: f.account.id },
        f.data
      )
      await derived.savePositionHistory(position, { maxRunUpPercent: 10 })
      await mutations.updatePositionAcquisition(
        f.user.id,
        position.id,
        { entryPrice: 20 },
        {}
      )
      await expect(
        derived.savePositionHistory(position, { maxRunUpPercent: 99 })
      ).rejects.toMatchObject({ status: 409 })
      const edited = await prisma.position.findUniqueOrThrow({
        where: { id: position.id },
      })
      const target = await prisma.tradingAccount.create({
        data: { userId: f.user.id, name: randomUUID() },
      })
      await mutations.updatePositionAcquisition(
        f.user.id,
        position.id,
        {},
        {},
        target.id
      )
      await expect(
        derived.savePositionHistory(edited, { maxRunUpPercent: 99 })
      ).rejects.toMatchObject({ status: 409 })
      await mutations.deletePosition(f.user.id, position.id)
      await expect(
        derived.savePositionHistory(edited, { maxRunUpPercent: 99 })
      ).rejects.toMatchObject({ status: 404 })
    })

    it('independent history metrics both save, but a newer live peak cannot be overwritten by an old backfill', async () => {
      const f = await fixture()
      const position = await mutations.createPosition(
        f.user.id,
        { accountId: f.account.id },
        f.data
      )
      await Promise.all([
        derived.savePositionHistory(position, { maxDrawdownPercent: 5 }),
        derived.savePositionHistory(position, { maxRunUpPercent: 10 }),
      ])
      const source = await prisma.position.findUniqueOrThrow({
        where: { id: position.id },
      })
      expect(Number(source.maxDrawdownPercent)).toBe(5)
      expect(Number(source.maxRunUpPercent)).toBe(10)
      await mutations.updatePositionAcquisition(
        f.user.id,
        position.id,
        {},
        { maxRunUpPercent: 20 }
      )
      await expect(
        derived.savePositionHistory(source, { maxRunUpPercent: 15 })
      ).rejects.toMatchObject({ status: 409 })
      expect(
        Number(
          (
            await prisma.position.findUniqueOrThrow({
              where: { id: position.id },
            })
          ).maxRunUpPercent
        )
      ).toBe(20)
    })

    it('does not overwrite a newly edited stop or save background results after user deletion', async () => {
      const f = await fixture()
      const position = await mutations.createPosition(
        f.user.id,
        { accountId: f.account.id },
        {
          ...f.data,
          stopLossPrice: 9,
          stopLossSetAt: new Date('2026-01-01'),
        }
      )
      await mutations.updatePositionAcquisition(
        f.user.id,
        position.id,
        {},
        { stopLossPrice: 8, stopLossSetAt: new Date('2026-02-01') }
      )
      await expect(
        derived.savePositionStopLossHit(position, new Date('2026-01-10'))
      ).rejects.toMatchObject({ status: 409 })
      expect(
        (
          await prisma.position.findUniqueOrThrow({
            where: { id: position.id },
          })
        ).stopLossHitAt
      ).toBeNull()
      await deletion.scheduleUserDeletion(f.user.id, passwordHash)
      await expect(
        derived.savePositionHistory(position, { maxDrawdownPercent: 99 })
      ).rejects.toMatchObject({ status: 401 })
    })

    it('purge cascades only the disposable fixture, and stale restoration fails without orphan sessions', async () => {
      const f = await fixture()
      await mutations.createPosition(
        f.user.id,
        { accountId: f.account.id },
        f.data
      )
      await snapshots.savePortfolioSnapshot(
        f.user.id,
        f.account.id,
        f.exchangeId
      )
      const state = await deletion.scheduleUserDeletion(
        f.user.id,
        passwordHash,
        new Date('2026-01-01')
      )
      vi.spyOn(prisma.user, 'findMany').mockResolvedValueOnce([f.user])
      expect(
        await deletion.purgeExpiredAccounts(new Date('2026-03-01'))
      ).toEqual([f.user.id])
      await expect(
        deletion.restoreDeletedUser(
          f.user.id,
          passwordHash,
          state.deletedAt,
          `late-fixture-${randomUUID()}`,
          new Date()
        )
      ).rejects.toMatchObject({ status: 401 })
      expect(
        await prisma.tradingAccount.count({ where: { userId: f.user.id } })
      ).toBe(0)
      expect(
        await prisma.position.count({ where: { userId: f.user.id } })
      ).toBe(0)
      expect(
        await prisma.portfolioSnapshot.count({ where: { userId: f.user.id } })
      ).toBe(0)
      expect(
        await prisma.refreshToken.count({ where: { userId: f.user.id } })
      ).toBe(0)
    })
  }
)
