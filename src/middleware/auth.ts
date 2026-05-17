import { Request, Response, NextFunction } from 'express'
import { verifyAccessToken, JwtPayload } from '../lib/jwt.js'

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload
    }
  }
}

export function authenticateToken(
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

  try {
    req.user = verifyAccessToken(token)
    next()
  } catch {
    return res
      .status(401)
      .json({ error: 'Unauthorized', message: 'Invalid or expired token' })
  }
}
