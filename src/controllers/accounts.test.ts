import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findManyMock,
  findUniqueMock,
  findFirstMock,
  createMock,
  updateMock,
  deleteMock,
  positionCountMock,
  snapshotCountMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  findFirstMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  positionCountMock: vi.fn(),
  snapshotCountMock: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findMany: findManyMock,
      findUnique: findUniqueMock,
      findFirst: findFirstMock,
      create: createMock,
      update: updateMock,
      delete: deleteMock,
    },
    position: {
      count: positionCountMock,
    },
    portfolioSnapshot: {
      count: snapshotCountMock,
    },
  },
}))

import accountsRouter from './accounts.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/accounts', accountsRouter)
  return app
}

describe('accounts controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    positionCountMock.mockResolvedValue(0)
    snapshotCountMock.mockResolvedValue(0)
  })

  it('lists accounts for authenticated user', async () => {
    findManyMock.mockResolvedValue([
      { id: 'a1', userId: 'u_1', name: 'Growth' },
      { id: 'a2', userId: 'u_1', name: 'Main' },
    ])

    const response = await request(createApp()).get('/api/accounts')

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.data).toHaveLength(2)
    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: 'u_1', status: 'ACTIVE' },
      orderBy: [{ name: 'asc' }],
    })
  })

  it('lists active and closed accounts when includeClosed=true', async () => {
    findManyMock.mockResolvedValue([{ id: 'a1', userId: 'u_1', name: 'Main' }])

    const response = await request(createApp()).get(
      '/api/accounts?includeClosed=true'
    )

    expect(response.status).toBe(200)
    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: 'u_1' },
      orderBy: [{ name: 'asc' }],
    })
  })

  it('returns existing account when name already exists', async () => {
    findUniqueMock.mockResolvedValue({ id: 'a1', userId: 'u_1', name: 'Main' })

    const response = await request(createApp())
      .post('/api/accounts')
      .send({ name: ' Main ' })

    expect(response.status).toBe(200)
    expect(response.body.data.name).toBe('Main')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('reopens a closed account when creating with same name', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'a1',
      userId: 'u_1',
      name: 'Main',
      status: 'CLOSED',
    })
    updateMock.mockResolvedValue({
      id: 'a1',
      userId: 'u_1',
      name: 'Main',
      status: 'ACTIVE',
      closedAt: null,
    })

    const response = await request(createApp())
      .post('/api/accounts')
      .send({ name: 'Main' })

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: {
        status: 'ACTIVE',
        closedAt: null,
      },
    })
    expect(createMock).not.toHaveBeenCalled()
  })

  it('creates account when name does not exist', async () => {
    findUniqueMock.mockResolvedValue(null)
    createMock.mockResolvedValue({ id: 'a2', userId: 'u_1', name: 'Income' })

    const response = await request(createApp())
      .post('/api/accounts')
      .send({ name: 'Income' })

    expect(response.status).toBe(201)
    expect(response.body.data.id).toBe('a2')
    expect(createMock).toHaveBeenCalledWith({
      data: {
        userId: 'u_1',
        name: 'Income',
      },
    })
  })

  it('returns validation error for empty name', async () => {
    const response = await request(createApp())
      .post('/api/accounts')
      .send({ name: '' })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Validation Error')
  })

  it('deletes an empty account owned by user', async () => {
    findFirstMock.mockResolvedValue({ id: 'a2', name: 'Income' })
    deleteMock.mockResolvedValue({ id: 'a2' })

    const response = await request(createApp()).delete('/api/accounts/a2')

    expect(response.status).toBe(200)
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'a2' } })
    expect(response.body.success).toBe(true)
  })

  it('returns 404 when deleting account not owned by user', async () => {
    findFirstMock.mockResolvedValue(null)

    const response = await request(createApp()).delete('/api/accounts/missing')

    expect(response.status).toBe(404)
    expect(response.body.message).toContain('Trading account not found')
  })

  it('returns 409 when account has positions or snapshots', async () => {
    findFirstMock.mockResolvedValue({ id: 'a2', name: 'Income' })
    positionCountMock.mockResolvedValue(1)
    snapshotCountMock.mockResolvedValue(0)

    const response = await request(createApp()).delete('/api/accounts/a2')

    expect(response.status).toBe(409)
    expect(response.body.message).toContain(
      'Account cannot be deleted while it still has positions or snapshots'
    )
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('closes account when no open positions remain', async () => {
    findFirstMock.mockResolvedValue({
      id: 'a2',
      name: 'Income',
      status: 'ACTIVE',
    })
    positionCountMock.mockResolvedValue(0)
    updateMock.mockResolvedValue({ id: 'a2', status: 'CLOSED' })

    const response = await request(createApp()).post('/api/accounts/a2/close')

    expect(response.status).toBe(200)
    expect(positionCountMock).toHaveBeenCalledWith({
      where: {
        accountId: 'a2',
        userId: 'u_1',
        status: { in: ['OPEN', 'PARTIAL'] },
      },
    })
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'a2' },
      data: {
        status: 'CLOSED',
        closedAt: expect.any(Date),
      },
    })
  })

  it('returns 409 when trying to close account with open positions', async () => {
    findFirstMock.mockResolvedValue({
      id: 'a2',
      name: 'Income',
      status: 'ACTIVE',
    })
    positionCountMock.mockResolvedValue(2)

    const response = await request(createApp()).post('/api/accounts/a2/close')

    expect(response.status).toBe(409)
    expect(response.body.message).toContain('Account still has open positions')
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('reopens a closed account explicitly', async () => {
    findFirstMock.mockResolvedValue({ id: 'a2' })
    updateMock.mockResolvedValue({ id: 'a2', status: 'ACTIVE', closedAt: null })

    const response = await request(createApp()).post('/api/accounts/a2/reopen')

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'a2' },
      data: {
        status: 'ACTIVE',
        closedAt: null,
      },
    })
  })

  it('updates account name successfully', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'a2', name: 'OldName' })
    findFirstMock.mockResolvedValueOnce(null)
    updateMock.mockResolvedValue({ id: 'a2', userId: 'u_1', name: 'NewName' })

    const response = await request(createApp())
      .patch('/api/accounts/a2')
      .send({ name: 'NewName' })

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.data.name).toBe('NewName')
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'a2' },
      data: { name: 'NewName' },
    })
  })

  it('returns 404 when updating non-existent account', async () => {
    findFirstMock.mockResolvedValue(null)

    const response = await request(createApp())
      .patch('/api/accounts/missing')
      .send({ name: 'NewName' })

    expect(response.status).toBe(404)
    expect(response.body.message).toContain('Trading account not found')
  })

  it('returns 409 when updating to a name that already exists', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'a2', name: 'OldName' })
    findFirstMock.mockResolvedValueOnce({ id: 'a3' })

    const response = await request(createApp())
      .patch('/api/accounts/a2')
      .send({ name: 'ExistingName' })

    expect(response.status).toBe(409)
    expect(response.body.message).toContain(
      'An account with this name already exists'
    )
    expect(updateMock).not.toHaveBeenCalled()
  })
})
