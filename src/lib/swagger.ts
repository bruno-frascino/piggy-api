import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Piggy API',
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
        Exchange: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier',
            },
            code: {
              type: 'string',
              description: 'Exchange code (e.g., NYSE, NASDAQ)',
            },
            name: {
              type: 'string',
              description: 'Exchange full name',
            },
            country: {
              type: 'string',
              description: 'Country where exchange is located',
            },
            timezone: {
              type: 'string',
              description: 'Exchange timezone',
            },
            currency: {
              type: 'string',
              description: 'Exchange currency (3 letters)',
            },
            isActive: {
              type: 'boolean',
              description: 'Whether exchange is active',
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
            success: {
              type: 'boolean',
              example: false,
            },
            error: {
              type: 'string',
              description: 'Error message',
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
        Success: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true,
            },
            data: {
              type: 'object',
              description: 'Response data',
            },
          },
        },
      },
    },
    tags: [
      {
        name: 'Users',
        description: 'User management operations',
      },
      {
        name: 'Exchanges',
        description: 'Stock exchange operations',
      },
      {
        name: 'Stocks',
        description: 'Stock management operations',
      },
      {
        name: 'Positions',
        description: 'Trading position operations',
      },
      {
        name: 'Transactions',
        description: 'Transaction management operations',
      },
      {
        name: 'Watchlist',
        description: 'Watchlist operations',
      },
    ],
  },
  apis: ['./src/controllers/*.ts'], // Path to the API docs
}

export const specs = swaggerJsdoc(options)
export { swaggerUi }
