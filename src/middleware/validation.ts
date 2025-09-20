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

  // Prisma errors
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

  // Default error
  res.status(err.status || 500).json({
    error: err.name || 'Internal Server Error',
    message: err.message || 'Something went wrong',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  })
}
