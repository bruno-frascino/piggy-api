import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = {
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN,
}

async function loadJwtModule() {
  vi.resetModules()
  return import('./jwt.js')
}

describe('jwt utils', () => {
  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_ENV.JWT_SECRET
    process.env.JWT_REFRESH_SECRET = ORIGINAL_ENV.JWT_REFRESH_SECRET
    process.env.JWT_EXPIRES_IN = ORIGINAL_ENV.JWT_EXPIRES_IN
    process.env.JWT_REFRESH_EXPIRES_IN = ORIGINAL_ENV.JWT_REFRESH_EXPIRES_IN
    vi.restoreAllMocks()
  })

  it('signs and verifies access token', async () => {
    process.env.JWT_SECRET = 'test-access-secret'
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret'
    process.env.JWT_EXPIRES_IN = '15m'

    const jwtUtils = await loadJwtModule()
    const payload = { userId: 'u_1', email: 'dev@example.com' }

    const token = jwtUtils.signAccessToken(payload)
    const decoded = jwtUtils.verifyAccessToken(token)

    expect(decoded.userId).toBe(payload.userId)
    expect(decoded.email).toBe(payload.email)
  })

  it('signs and verifies refresh token', async () => {
    process.env.JWT_SECRET = 'test-access-secret'
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret'
    process.env.JWT_REFRESH_EXPIRES_IN = '7d'

    const jwtUtils = await loadJwtModule()
    const payload = { userId: 'u_2', email: 'user@example.com' }

    const token = jwtUtils.signRefreshToken(payload)
    const decoded = jwtUtils.verifyRefreshToken(token)

    expect(decoded.userId).toBe(payload.userId)
    expect(decoded.email).toBe(payload.email)
  })

  it('throws when access secret is missing', async () => {
    delete process.env.JWT_SECRET
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret'

    const jwtUtils = await loadJwtModule()

    expect(() =>
      jwtUtils.signAccessToken({ userId: 'u_3', email: 'x@example.com' })
    ).toThrow('JWT_SECRET is not set')
  })

  it('throws when refresh secret is missing', async () => {
    process.env.JWT_SECRET = 'test-access-secret'
    delete process.env.JWT_REFRESH_SECRET

    const jwtUtils = await loadJwtModule()

    expect(() =>
      jwtUtils.signRefreshToken({ userId: 'u_4', email: 'y@example.com' })
    ).toThrow('JWT_REFRESH_SECRET is not set')
  })

  it('calculates refresh token expiration using configured days', async () => {
    process.env.JWT_SECRET = 'test-access-secret'
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret'
    process.env.JWT_REFRESH_EXPIRES_IN = '3d'

    const before = Date.now()
    const jwtUtils = await loadJwtModule()
    const expiresAt = jwtUtils.refreshTokenExpiresAt().getTime()
    const after = Date.now()

    const minExpected = before + 3 * 24 * 60 * 60 * 1000
    const maxExpected = after + 3 * 24 * 60 * 60 * 1000
    expect(expiresAt).toBeGreaterThanOrEqual(minExpected)
    expect(expiresAt).toBeLessThanOrEqual(maxExpected)
  })
})
