import { Request, Response, NextFunction } from 'express'
import { validationResult } from 'express-validator'

// Middleware to handle validation results
export const handleValidationErrors = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation Error',
      details: errors.array(),
    })
  }
  next()
}

// Middleware to validate that a string is a valid CUID
export const validateCuid = (field: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const value = req.params[field] || req.body[field]
    if (value && !/^c[^\s-]{8,}$/.test(value)) {
      return res.status(400).json({
        error: 'Invalid ID format',
        message: `${field} must be a valid CUID`,
      })
    }
    next()
  }
}

// Async handler wrapper to catch errors
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

// Error handler middleware
export const errorHandler = (
  err: Error & { code?: string; status?: number },
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error('API Error:', err)

  // Prisma known request errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      error: 'Conflict',
      message: 'A record with this data already exists',
    })
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      error: 'Not Found',
      message: 'The requested record was not found',
    })
  }

  if (err.code === 'P2003') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Referenced resource does not exist',
    })
  }

  // Any other Prisma error — never expose internal details to the client
  if (err.code && /^P\d{4}$/.test(err.code)) {
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Something went wrong. Please try again later.',
    })
  }

  // Intentional client errors (4xx) may pass their message through
  const statusCode = err.status || 500
  res.status(statusCode).json({
    error: err.name || 'Internal Server Error',
    message:
      statusCode < 500
        ? err.message || 'An error occurred'
        : 'Something went wrong. Please try again later.',
  })
}
