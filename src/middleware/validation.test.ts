import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { asyncHandler, errorHandler, validateCuid } from './validation.js'

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

function nextSpy(): NextFunction {
  return vi.fn() as unknown as NextFunction
}

describe('validateCuid', () => {
  it('calls next for valid CUID in params', () => {
    const req = {
      params: { id: 'cm95w6x2f0001ab1cd2ef3456' },
      body: {},
    } as unknown as Request
    const res = createMockResponse() as unknown as Response
    const next = nextSpy()

    validateCuid('id')(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((res as unknown as MockResponse).status).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid CUID', () => {
    const req = {
      params: { id: 'bad-id' },
      body: {},
    } as unknown as Request
    const res = createMockResponse() as unknown as Response
    const next = nextSpy()

    validateCuid('id')(req, res, next)

    const resMock = res as unknown as MockResponse
    expect(resMock.status).toHaveBeenCalledWith(400)
    expect(resMock.json).toHaveBeenCalledWith({
      error: 'Invalid ID format',
      message: 'id must be a valid CUID',
    })
    expect(next).not.toHaveBeenCalled()
  })
})

describe('asyncHandler', () => {
  it('forwards rejected errors to next()', async () => {
    const req = {} as Request
    const res = {} as Response
    const next = vi.fn()
    const failure = new Error('boom')

    const wrapped = asyncHandler(async () => {
      throw failure
    })

    wrapped(req, res, next)
    await Promise.resolve()

    expect(next).toHaveBeenCalledWith(failure)
  })

  it('does not call next with error when handler resolves', async () => {
    const req = {} as Request
    const res = {} as Response
    const next = vi.fn()

    const wrapped = asyncHandler(async () => {
      return 'ok'
    })

    wrapped(req, res, next)
    await Promise.resolve()

    expect(next).not.toHaveBeenCalled()
  })
})

describe('errorHandler', () => {
  const originalEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
    vi.restoreAllMocks()
  })

  it('maps Prisma P2002 to 409 conflict', () => {
    const err = Object.assign(new Error('duplicate'), { code: 'P2002' })
    const req = {} as Request
    const res = createMockResponse() as unknown as Response

    errorHandler(err, req, res, vi.fn())

    const resMock = res as unknown as MockResponse
    expect(resMock.status).toHaveBeenCalledWith(409)
    expect(resMock.json).toHaveBeenCalledWith({
      error: 'Conflict',
      message: 'A record with this data already exists',
    })
  })

  it('maps Prisma P2025 to 404 not found', () => {
    const err = Object.assign(new Error('missing'), { code: 'P2025' })
    const req = {} as Request
    const res = createMockResponse() as unknown as Response

    errorHandler(err, req, res, vi.fn())

    const resMock = res as unknown as MockResponse
    expect(resMock.status).toHaveBeenCalledWith(404)
    expect(resMock.json).toHaveBeenCalledWith({
      error: 'Not Found',
      message: 'The requested record was not found',
    })
  })

  it('sanitizes 500 errors in development mode', () => {
    process.env.NODE_ENV = 'development'
    const err = new Error('debug me')
    const req = {} as Request
    const res = createMockResponse() as unknown as Response

    errorHandler(err, req, res, vi.fn())

    const resMock = res as unknown as MockResponse
    expect(resMock.status).toHaveBeenCalledWith(500)
    const payload = resMock.json.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload.error).toBe('Error')
    expect(payload.message).toBe(
      'Something went wrong. Please try again later.'
    )
    expect(payload.stack).toBeUndefined()
  })

  it('omits stack outside development mode', () => {
    process.env.NODE_ENV = 'test'
    const err = new Error('hidden stack')
    const req = {} as Request
    const res = createMockResponse() as unknown as Response

    errorHandler(err, req, res, vi.fn())

    const payload = (res as unknown as MockResponse).json.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined
    expect(payload).toBeDefined()
    expect(payload?.stack).toBeUndefined()
  })
})
