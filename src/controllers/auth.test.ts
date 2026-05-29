import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUniqueMock,
  createUserMock,
  createRefreshTokenMock,
  signAccessTokenMock,
  signRefreshTokenMock,
  refreshTokenExpiresAtMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createUserMock: vi.fn(),
  createRefreshTokenMock: vi.fn(),
  signAccessTokenMock: vi.fn(),
  signRefreshTokenMock: vi.fn(),
  refreshTokenExpiresAtMock: vi.fn(),
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
      create: createUserMock,
    },
    refreshToken: {
      create: createRefreshTokenMock,
    },
  },
}))

vi.mock('../lib/jwt.js', () => ({
  signAccessToken: signAccessTokenMock,
  signRefreshToken: signRefreshTokenMock,
  verifyRefreshToken: vi.fn(),
  refreshTokenExpiresAt: refreshTokenExpiresAtMock,
}))

import authRouter from './auth.js'

describe('auth register', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    signAccessTokenMock.mockReturnValue('access-token')
    signRefreshTokenMock.mockReturnValue('refresh-token')
    refreshTokenExpiresAtMock.mockReturnValue(new Date('2030-01-01T00:00:00Z'))
    createRefreshTokenMock.mockResolvedValue(undefined)
  })

  it('creates a user without explicitly setting baseCurrency', async () => {
    findUniqueMock.mockResolvedValue(null)
    createUserMock.mockResolvedValue({
      id: 'u_1',
      email: 'alice@example.com',
      name: 'Alice',
      baseCurrency: 'AUD',
      createdAt: new Date('2026-05-28T10:00:00Z'),
    })

    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)

    const response = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })

    expect(response.status).toBe(201)
    expect(response.body.data.user.baseCurrency).toBe('AUD')

    expect(createUserMock).toHaveBeenCalledTimes(1)
    const createArgs = createUserMock.mock.calls[0]?.[0] as {
      data: Record<string, unknown>
    }

    expect(createArgs.data).toMatchObject({
      email: 'alice@example.com',
      name: 'Alice',
    })
    expect(createArgs.data.passwordHash).toEqual(expect.any(String))
    expect(createArgs.data).not.toHaveProperty('baseCurrency')
  })
})
