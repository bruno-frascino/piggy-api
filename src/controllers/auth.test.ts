import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUserUniqueMock,
  createUserMock,
  updateUserMock,
  createRefreshTokenMock,
  findRefreshTokenUniqueMock,
  deleteRefreshTokenMock,
  deleteManyRefreshTokenMock,
  deleteManyPasswordResetTokenMock,
  createPasswordResetTokenMock,
  findPasswordResetTokenUniqueMock,
  deletePasswordResetTokenMock,
  hashMock,
  compareMock,
  signAccessTokenMock,
  signRefreshTokenMock,
  verifyRefreshTokenMock,
  verifyAccessTokenMock,
  refreshTokenExpiresAtMock,
} = vi.hoisted(() => ({
  findUserUniqueMock: vi.fn(),
  createUserMock: vi.fn(),
  updateUserMock: vi.fn(),
  createRefreshTokenMock: vi.fn(),
  findRefreshTokenUniqueMock: vi.fn(),
  deleteRefreshTokenMock: vi.fn(),
  deleteManyRefreshTokenMock: vi.fn(),
  deleteManyPasswordResetTokenMock: vi.fn(),
  createPasswordResetTokenMock: vi.fn(),
  findPasswordResetTokenUniqueMock: vi.fn(),
  deletePasswordResetTokenMock: vi.fn(),
  hashMock: vi.fn(),
  compareMock: vi.fn(),
  signAccessTokenMock: vi.fn(),
  signRefreshTokenMock: vi.fn(),
  verifyRefreshTokenMock: vi.fn(),
  verifyAccessTokenMock: vi.fn(),
  refreshTokenExpiresAtMock: vi.fn(),
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: findUserUniqueMock,
      create: createUserMock,
      update: updateUserMock,
    },
    refreshToken: {
      create: createRefreshTokenMock,
      findUnique: findRefreshTokenUniqueMock,
      delete: deleteRefreshTokenMock,
      deleteMany: deleteManyRefreshTokenMock,
    },
    passwordResetToken: {
      deleteMany: deleteManyPasswordResetTokenMock,
      create: createPasswordResetTokenMock,
      findUnique: findPasswordResetTokenUniqueMock,
      delete: deletePasswordResetTokenMock,
    },
  },
}))

vi.mock('bcryptjs', () => ({
  default: {
    hash: hashMock,
    compare: compareMock,
  },
}))

vi.mock('../lib/jwt.js', () => ({
  signAccessToken: signAccessTokenMock,
  signRefreshToken: signRefreshTokenMock,
  verifyRefreshToken: verifyRefreshTokenMock,
  verifyAccessToken: verifyAccessTokenMock,
  refreshTokenExpiresAt: refreshTokenExpiresAtMock,
}))

import authRouter from './auth.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  return app
}

describe('auth controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    signAccessTokenMock.mockReturnValue('access-token')
    signRefreshTokenMock.mockReturnValue('refresh-token')
    verifyAccessTokenMock.mockReturnValue({
      userId: 'u_1',
      email: 'alice@example.com',
    })
    refreshTokenExpiresAtMock.mockReturnValue(new Date('2030-01-01T00:00:00Z'))
    hashMock.mockResolvedValue('hashed-password')
    compareMock.mockResolvedValue(true)

    createRefreshTokenMock.mockResolvedValue(undefined)
    findRefreshTokenUniqueMock.mockResolvedValue(null)
    deleteRefreshTokenMock.mockResolvedValue(undefined)
    deleteManyRefreshTokenMock.mockResolvedValue({ count: 1 })

    deleteManyPasswordResetTokenMock.mockResolvedValue({ count: 0 })
    createPasswordResetTokenMock.mockResolvedValue(undefined)
    findPasswordResetTokenUniqueMock.mockResolvedValue(null)
    deletePasswordResetTokenMock.mockResolvedValue(undefined)

    updateUserMock.mockResolvedValue(undefined)
  })

  it('creates a user without explicitly setting baseCurrency', async () => {
    findUserUniqueMock.mockResolvedValue(null)
    createUserMock.mockResolvedValue({
      id: 'u_1',
      email: 'alice@example.com',
      name: 'Alice',
      baseCurrency: 'AUD',
      createdAt: new Date('2026-05-28T10:00:00Z'),
    })

    const response = await request(createApp())
      .post('/api/auth/register')
      .send({
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
    expect(createRefreshTokenMock).toHaveBeenCalledTimes(1)
  })

  it('returns 409 on duplicate email during register', async () => {
    findUserUniqueMock.mockResolvedValue({ id: 'u_1' })

    const response = await request(createApp())
      .post('/api/auth/register')
      .send({
        email: 'alice@example.com',
        password: 'password123',
      })

    expect(response.status).toBe(409)
    expect(response.body.message).toContain('Email already registered')
    expect(createUserMock).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid register payload', async () => {
    const response = await request(createApp())
      .post('/api/auth/register')
      .send({
        email: 'bad-email',
        password: 'short',
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Validation Error')
    expect(Array.isArray(response.body.details)).toBe(true)
  })

  it('logs in with valid credentials and returns safe user shape', async () => {
    findUserUniqueMock.mockResolvedValue({
      id: 'u_1',
      email: 'alice@example.com',
      name: 'Alice',
      baseCurrency: 'USD',
      passwordHash: 'hashed-password',
      createdAt: new Date('2026-05-20T00:00:00Z'),
    })

    const response = await request(createApp()).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'password123',
    })

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.data.user.email).toBe('alice@example.com')
    expect(response.body.data.user).not.toHaveProperty('passwordHash')
    expect(response.body.data.accessToken).toBe('access-token')
    expect(response.body.data.refreshToken).toBe('refresh-token')
  })

  it('returns 401 on invalid credentials at login', async () => {
    compareMock.mockResolvedValue(false)
    findUserUniqueMock.mockResolvedValue({
      id: 'u_1',
      email: 'alice@example.com',
      name: 'Alice',
      baseCurrency: 'USD',
      passwordHash: 'hashed-password',
      createdAt: new Date('2026-05-20T00:00:00Z'),
    })

    const response = await request(createApp()).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'wrong-password',
    })

    expect(response.status).toBe(401)
    expect(response.body.message).toContain('Invalid credentials')
  })

  it('returns 400 when refresh token is missing', async () => {
    const response = await request(createApp())
      .post('/api/auth/refresh')
      .send({})

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('refreshToken is required')
  })

  it('returns 401 when refresh token signature is invalid', async () => {
    verifyRefreshTokenMock.mockImplementation(() => {
      throw new Error('bad token')
    })

    const response = await request(createApp()).post('/api/auth/refresh').send({
      refreshToken: 'bad-token',
    })

    expect(response.status).toBe(401)
    expect(response.body.message).toContain('Invalid or expired refresh token')
  })

  it('returns 401 when refresh token is revoked or expired', async () => {
    verifyRefreshTokenMock.mockReturnValue({
      userId: 'u_1',
      email: 'alice@example.com',
    })
    findRefreshTokenUniqueMock.mockResolvedValue({
      token: 'stale-token',
      expiresAt: new Date(Date.now() - 1000),
    })

    const response = await request(createApp()).post('/api/auth/refresh').send({
      refreshToken: 'stale-token',
    })

    expect(response.status).toBe(401)
    expect(response.body.message).toContain('Refresh token revoked or expired')
  })

  it('rotates tokens successfully on refresh', async () => {
    verifyRefreshTokenMock.mockReturnValue({
      userId: 'u_1',
      email: 'alice@example.com',
    })
    findRefreshTokenUniqueMock.mockResolvedValue({
      token: 'old-refresh',
      expiresAt: new Date(Date.now() + 3600000),
    })
    signAccessTokenMock.mockReturnValue('new-access-token')
    signRefreshTokenMock.mockReturnValue('new-refresh-token')

    const response = await request(createApp()).post('/api/auth/refresh').send({
      refreshToken: 'old-refresh',
    })

    expect(response.status).toBe(200)
    expect(deleteRefreshTokenMock).toHaveBeenCalledWith({
      where: { token: 'old-refresh' },
    })
    expect(createRefreshTokenMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u_1',
        token: 'new-refresh-token',
      }),
    })
    expect(response.body.data.accessToken).toBe('new-access-token')
    expect(response.body.data.refreshToken).toBe('new-refresh-token')
  })

  it('logs out and revokes provided refresh token', async () => {
    const response = await request(createApp())
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer access-token')
      .send({ refreshToken: 'refresh-token' })

    expect(response.status).toBe(200)
    expect(deleteManyRefreshTokenMock).toHaveBeenCalledWith({
      where: { token: 'refresh-token' },
    })
    expect(response.body.success).toBe(true)
  })

  it('forgot-password responds generically when user does not exist', async () => {
    findUserUniqueMock.mockResolvedValue(null)

    const response = await request(createApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'missing@example.com' })

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.message).toContain('If that email is registered')
    expect(createPasswordResetTokenMock).not.toHaveBeenCalled()
  })

  it('forgot-password creates token when user exists', async () => {
    findUserUniqueMock.mockResolvedValue({
      id: 'u_1',
      email: 'alice@example.com',
    })

    const response = await request(createApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'alice@example.com' })

    expect(response.status).toBe(200)
    expect(deleteManyPasswordResetTokenMock).toHaveBeenCalledWith({
      where: { userId: 'u_1' },
    })
    expect(createPasswordResetTokenMock).toHaveBeenCalledTimes(1)
    expect(response.body.resetToken).toEqual(expect.any(String))
    expect(response.body.resetToken.length).toBe(64)
  })

  it('reset-password returns 400 for invalid token', async () => {
    findPasswordResetTokenUniqueMock.mockResolvedValue(null)

    const response = await request(createApp())
      .post('/api/auth/reset-password')
      .send({ token: 'invalid', password: 'new-password-123' })

    expect(response.status).toBe(400)
    expect(response.body.message).toContain('Invalid or expired reset token')
  })

  it('reset-password updates password and revokes active tokens', async () => {
    findPasswordResetTokenUniqueMock.mockResolvedValue({
      token: 'valid-token',
      userId: 'u_1',
      expiresAt: new Date(Date.now() + 3600000),
    })

    const response = await request(createApp())
      .post('/api/auth/reset-password')
      .send({ token: 'valid-token', password: 'new-password-123' })

    expect(response.status).toBe(200)
    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: 'u_1' },
      data: { passwordHash: expect.any(String) },
    })
    expect(deletePasswordResetTokenMock).toHaveBeenCalledWith({
      where: { token: 'valid-token' },
    })
    expect(deleteManyRefreshTokenMock).toHaveBeenCalledWith({
      where: { userId: 'u_1' },
    })
  })
})
