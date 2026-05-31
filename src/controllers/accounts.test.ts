import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, findUniqueMock, createMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
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
      create: createMock,
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
})
