import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.RUN_ACCOUNTING_DB_TESTS === '1'
let prisma: typeof import('./prisma.js').prisma
let userId: string | undefined
let accountId: string

describe.skipIf(!enabled)(
  'opening drafts on an isolated localhost database fixture',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error(
          'Accounting integration tests require a localhost database'
        )
      prisma = (await import('./prisma.js')).prisma
      const user = await prisma.user.create({
        data: {
          email: `accounting-fixture-${randomUUID()}@example.invalid`,
          passwordHash: 'test-fixture-not-a-login',
        },
      })
      userId = user.id
      accountId = (
        await prisma.tradingAccount.create({
          data: { userId, name: 'Accounting integration fixture' },
        })
      ).id
    })
    afterAll(async () => {
      if (userId) {
        await prisma.user.delete({ where: { id: userId } })
        if (accountId)
          expect(
            await prisma.accountOpeningStatement.count({ where: { accountId } })
          ).toBe(0)
        await prisma.$disconnect()
      }
    })
    it('persists exact decimal balances and deduplicates concurrent identical saves', async () => {
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const { saveOpeningStatement, listOpeningStatements } =
        await import('./opening-statements.js')
      if (!userId) throw new Error('Missing integration fixture')
      const input = {
        openingDate: '2026-10-01',
        cashBalances: [{ currency: 'AUD', amount: '0.000000000001' }],
      }
      const preview = await previewAccountOpening(userId, accountId, input)
      const payload = { ...input, sourceFingerprint: preview.sourceFingerprint }
      const results = await Promise.all([
        saveOpeningStatement(userId, accountId, payload),
        saveOpeningStatement(userId, accountId, payload),
      ])
      expect(results[0].statement.id).toBe(results[1].statement.id)
      expect(results.map((result) => result.created).sort()).toEqual([
        false,
        true,
      ])
      expect(results[0].statement.cashBalances[0].amount).toBe('0.000000000001')
      expect(
        await prisma.accountOpeningStatement.count({ where: { accountId } })
      ).toBe(1)
      const changed = {
        ...input,
        cashBalances: [{ currency: 'AUD', amount: '10' }],
      }
      const secondPreview = await previewAccountOpening(
        userId,
        accountId,
        changed
      )
      await saveOpeningStatement(userId, accountId, {
        ...changed,
        sourceFingerprint: secondPreview.sourceFingerprint,
      })
      const page = await listOpeningStatements(userId, accountId)
      expect(page.statements.map((row) => row.version)).toEqual([2, 1])
      expect(page.statements.every((row) => row.state === 'DRAFT')).toBe(true)
      expect(await prisma.position.count({ where: { accountId } })).toBe(0)
      expect(
        await prisma.portfolioSnapshot.count({ where: { accountId } })
      ).toBe(0)
    })
    it('serializes distinct concurrent revisions without overwriting older snapshots', async () => {
      const { previewAccountOpening } =
        await import('./accounting-preview-service.js')
      const { saveOpeningStatement } = await import('./opening-statements.js')
      if (!userId) throw new Error('Missing integration fixture')
      const fixtureUserId = userId
      const previousCount = await prisma.accountOpeningStatement.count({
        where: { accountId },
      })
      const requests = [
        { currency: 'AUD', amount: '20' },
        { currency: 'AUD', amount: '30' },
      ]
      const previews = await Promise.all(
        requests.map((balance) =>
          previewAccountOpening(fixtureUserId, accountId, {
            openingDate: '2026-10-01',
            cashBalances: [balance],
          })
        )
      )
      const results = await Promise.all(
        previews.map((preview, index) =>
          saveOpeningStatement(fixtureUserId, accountId, {
            openingDate: '2026-10-01',
            cashBalances: [requests[index]],
            sourceFingerprint: preview.sourceFingerprint,
          })
        )
      )
      expect(results.map((result) => result.statement.version).sort()).toEqual([
        previousCount + 1,
        previousCount + 2,
      ])
      expect(
        results.map((result) => result.statement.cashBalances[0].amount)
      ).toEqual(['20', '30'])
      expect(
        await prisma.accountOpeningStatement.count({ where: { accountId } })
      ).toBe(previousCount + 2)
    })
  }
)
