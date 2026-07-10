import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'

const { verifyAccessTokenMock } = vi.hoisted(() => ({
  verifyAccessTokenMock: vi.fn(),
}))

const { findUniqueMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
}))

vi.mock('../lib/jwt.js', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}))

import { authenticateToken } from './auth.js'

type MockResponse = {
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
}

function createMockResponse(): MockResponse {
  const res: Partial<MockResponse> = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res as MockResponse
}

describe('authenticateToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findUniqueMock.mockResolvedValue({ id: 'user_1' })
  })

  it('returns 401 when authorization header is missing', async () => {
    const req = { headers: {} } as unknown as Request
    const res = createMockResponse() as unknown as Response
    const next = vi.fn() as unknown as NextFunction

    await authenticateToken(req, res, next)

    const resMock = res as unknown as MockResponse
    expect(resMock.status).toHaveBeenCalledWith(401)
    expect(resMock.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'No token provided',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when token verification fails', async () => {
    verifyAccessTokenMock.mockImplementation(() => {
      throw new Error('bad token')
    })

    const req = {
      headers: { authorization: 'Bearer invalid-token' },
    } as unknown as Request
    const res = createMockResponse() as unknown as Response
    const next = vi.fn() as unknown as NextFunction

    await authenticateToken(req, res, next)

    const resMock = res as unknown as MockResponse
    expect(verifyAccessTokenMock).toHaveBeenCalledWith('invalid-token')
    expect(resMock.status).toHaveBeenCalledWith(401)
    expect(resMock.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('attaches user payload and calls next() for valid token', async () => {
    verifyAccessTokenMock.mockReturnValue({
      userId: 'user_1',
      email: 'dev@example.com',
    })

    const req = {
      headers: { authorization: 'Bearer valid-token' },
    } as unknown as Request
    const res = createMockResponse() as unknown as Response
    const next = vi.fn() as unknown as NextFunction

    await authenticateToken(req, res, next)

    expect(verifyAccessTokenMock).toHaveBeenCalledWith('valid-token')
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      select: { id: true },
    })
    expect(req.user).toEqual({
      userId: 'user_1',
      email: 'dev@example.com',
    })
    expect(next).toHaveBeenCalledTimes(1)
    expect((res as unknown as MockResponse).status).not.toHaveBeenCalled()
  })
})
