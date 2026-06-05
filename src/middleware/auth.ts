import { Request, Response, NextFunction } from 'express'
import { verifyAccessToken, JwtPayload } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload
    }
  }
}

export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers['authorization']
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return res
      .status(401)
      .json({ error: 'Unauthorized', message: 'No token provided' })
  }

  let payload: JwtPayload
  try {
    payload = verifyAccessToken(token)
  } catch {
    return res
      .status(401)
      .json({ error: 'Unauthorized', message: 'Invalid or expired token' })
  }

  // Verify the user still exists in the database (handles stale tokens after
  // data resets or account deletion without leaking internal error details).
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true },
    })
    if (!user) {
      return res
        .status(401)
        .json({
          error: 'Unauthorized',
          message: 'Session expired. Please log in again.',
        })
    }
  } catch {
    console.error(
      'Auth middleware: DB lookup failed for userId',
      payload.userId
    )
    return res
      .status(503)
      .json({
        error: 'Service Unavailable',
        message: 'Unable to verify session. Please try again.',
      })
  }

  req.user = payload
  next()
}
