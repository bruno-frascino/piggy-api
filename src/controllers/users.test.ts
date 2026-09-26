import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUniqueMock,
  updateMock,
  compareMock,
  hashMock,
  deleteManyRefreshTokenMock,
  deleteManyPasswordResetTokenMock,
  transactionMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  compareMock: vi.fn(),
  hashMock: vi.fn(),
  deleteManyRefreshTokenMock: vi.fn(),
  deleteManyPasswordResetTokenMock: vi.fn(),
  transactionMock: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'u_1', email: 'alice@example.com' }
    next()
  },
}))

vi.mock('bcryptjs', () => ({
  default: {
    compare: compareMock,
    hash: hashMock,
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
    refreshToken: { deleteMany: deleteManyRefreshTokenMock },
    passwordResetToken: { deleteMany: deleteManyPasswordResetTokenMock },
    $transaction: transactionMock,
  },
}))

import usersRouter from './users.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/users', usersRouter)
  return app
}

describe('users controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    compareMock.mockResolvedValue(true)
    hashMock.mockResolvedValue('hashed-next-password')
    transactionMock.mockResolvedValue([])
    updateMock.mockResolvedValue({
      id: 'u_1',
      email: 'alice@example.com',
      name: 'Alice',
      baseCurrency: 'USD',
      updatedAt: new Date('2026-05-31T00:00:00Z'),
    })
  })

  it('returns current user profile', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'u_1',
      email: 'alice@example.com',
      name: 'Alice',
      baseCurrency: 'AUD',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const response = await request(createApp()).get('/api/users/me')

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.data.email).toBe('alice@example.com')
  })

  it('returns 404 when profile is missing', async () => {
    findUniqueMock.mockResolvedValue(null)

    const response = await request(createApp()).get('/api/users/me')

    expect(response.status).toBe(404)
    expect(response.body.message).toContain('User not found')
  })

  it('updates profile fields and normalizes base currency', async () => {
    const response = await request(createApp()).patch('/api/users/me').send({
      name: 'Alice Smith',
      baseCurrency: 'aud',
    })

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'u_1' },
      data: {
        name: 'Alice Smith',
        baseCurrency: 'AUD',
      },
      select: {
        id: true,
        email: true,
        name: true,
        baseCurrency: true,
        updatedAt: true,
      },
    })
  })

  it('requires currentPassword when setting newPassword', async () => {
    const response = await request(createApp()).patch('/api/users/me').send({
      newPassword: 'new-password-123',
    })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('currentPassword is required')
  })

  it('returns 401 when current password is wrong', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'u_1',
      passwordHash: 'stored-hash',
    })
    compareMock.mockResolvedValue(false)

    const response = await request(createApp()).patch('/api/users/me').send({
      currentPassword: 'bad-pass',
      newPassword: 'new-password-123',
    })

    expect(response.status).toBe(401)
    expect(response.body.message).toContain('Current password is incorrect')
  })

  it('updates password hash when current password is valid', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'u_1',
      passwordHash: 'stored-hash',
    })

    const response = await request(createApp()).patch('/api/users/me').send({
      currentPassword: 'old-password-123',
      newPassword: 'new-password-123',
    })

    expect(response.status).toBe(200)
    expect(hashMock).toHaveBeenCalledWith('new-password-123', 12)
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'u_1' },
      data: {
        passwordHash: 'hashed-next-password',
      },
      select: {
        id: true,
        email: true,
        name: true,
        baseCurrency: true,
        updatedAt: true,
      },
    })
  })

  describe('DELETE /me', () => {
    it('schedules deletion and revokes every session', async () => {
      findUniqueMock.mockResolvedValue({
        id: 'u_1',
        passwordHash: 'stored-hash',
      })

      const response = await request(createApp()).delete('/api/users/me').send({
        currentPassword: 'old-password-123',
      })

      expect(response.status).toBe(200)
      expect(response.body.data.deletedAt).toEqual(expect.any(String))

      const purgeAfter = new Date(response.body.data.purgeAfter).getTime()
      const deletedAt = new Date(response.body.data.deletedAt).getTime()
      expect(purgeAfter - deletedAt).toBe(30 * 24 * 60 * 60 * 1000)

      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'u_1' },
        data: { deletedAt: expect.any(Date), purgeAfter: expect.any(Date) },
      })
      expect(deleteManyRefreshTokenMock).toHaveBeenCalledWith({
        where: { userId: 'u_1' },
      })
      expect(deleteManyPasswordResetTokenMock).toHaveBeenCalledWith({
        where: { userId: 'u_1' },
      })
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })

    it('returns 401 when the password is wrong', async () => {
      findUniqueMock.mockResolvedValue({
        id: 'u_1',
        passwordHash: 'stored-hash',
      })
      compareMock.mockResolvedValue(false)

      const response = await request(createApp()).delete('/api/users/me').send({
        currentPassword: 'nope',
      })

      expect(response.status).toBe(401)
      expect(response.body.message).toContain('Current password is incorrect')
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('requires currentPassword', async () => {
      const response = await request(createApp())
        .delete('/api/users/me')
        .send({})

      expect(response.status).toBe(400)
      expect(transactionMock).not.toHaveBeenCalled()
    })
  })
})
