import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Truffles API',
      version: '1.0.0',
      description:
        'A comprehensive stock portfolio management API built with Express and Prisma',
      contact: {
        name: 'API Support',
        url: 'https://github.com/bruno-frascino/piggy-api',
      },
    },
    servers: [
      {
        url:
          process.env.NODE_ENV === 'production'
            ? 'https://your-domain.com'
            : 'http://localhost:4000',
        description:
          process.env.NODE_ENV === 'production'
            ? 'Production server'
            : 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter the access token returned by /api/auth/login',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier',
            },
            email: {
              type: 'string',
              format: 'email',
              description: 'User email address',
            },
            name: {
              type: 'string',
              description: 'User full name',
            },
            baseCurrency: {
              type: 'string',
              description: 'User portfolio base currency (3 letters)',
              example: 'USD',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Stable error category',
            },
            message: {
              type: 'string',
              description: 'Human-readable error detail',
            },
            details: {
              type: 'array',
              items: {
                type: 'object',
              },
              description: 'Detailed validation errors',
            },
          },
        },
      },
    },
    tags: [
      {
        name: 'Auth',
        description:
          'Authentication — register, login, token refresh, password reset',
      },
      {
        name: 'Users',
        description: 'User profile management',
      },
      {
        name: 'Stocks',
        description: 'Symbol search via Yahoo Finance',
      },
      {
        name: 'Positions',
        description: 'Trading position lifecycle (open, update, close, delete)',
      },
      {
        name: 'Portfolio',
        description: 'Portfolio summary, history snapshots',
      },
      {
        name: 'Accounts',
        description: 'Trading accounts per exchange (multi-account support)',
      },
      {
        name: 'TaxReports',
        description:
          'ATO capital gains tax report generation, listing, and PDF download',
      },
    ],
  },
  apis: ['./src/controllers/*.ts'], // Path to the API docs
}

export const specs = swaggerJsdoc(options)
export { swaggerUi }
