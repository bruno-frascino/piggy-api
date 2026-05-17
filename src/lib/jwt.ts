import jwt from 'jsonwebtoken'

export interface JwtPayload {
  userId: string
  email: string
}

const ACCESS_EXPIRES = process.env.JWT_EXPIRES_IN || '15m'
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN || '7d'

function accessSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set')
  return secret
}

function refreshSecret(): string {
  const secret = process.env.JWT_REFRESH_SECRET
  if (!secret) throw new Error('JWT_REFRESH_SECRET is not set')
  return secret
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, accessSecret(), {
    expiresIn: ACCESS_EXPIRES,
  } as jwt.SignOptions)
}

export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, refreshSecret(), {
    expiresIn: REFRESH_EXPIRES,
  } as jwt.SignOptions)
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, accessSecret()) as JwtPayload
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, refreshSecret()) as JwtPayload
}

export function refreshTokenExpiresAt(): Date {
  const match = REFRESH_EXPIRES.match(/^(\d+)d$/)
  const days = match ? parseInt(match[1], 10) : 7
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date
}
