# Piggy API

A comprehensive stock portfolio management API built with tRPC, Prisma, and TypeScript.

## Features

- **User Management**: Create and manage user accounts
- **Exchange Management**: Support for multiple stock exchanges (NYSE, NASDAQ, etc.)
- **Stock Management**: Add and manage stocks with price history
- **Position Tracking**: Detailed position management with entry/exit tracking
- **Transaction History**: Complete transaction logging
- **Watchlist**: Monitor stocks of interest with price alerts
- **Portfolio Analytics**: Performance tracking and metrics

## Tech Stack

- **Framework**: Express.js
- **API**: tRPC for type-safe APIs
- **Database**: PostgreSQL with Prisma ORM
- **Validation**: Zod for runtime type checking
- **TypeScript**: Full type safety

## Quick Start

1. **Install dependencies**:

   ```bash
   yarn install
   ```

2. **Set up environment**:

   ```bash
   cp .env.example .env
   # Edit .env with your database URL
   ```

3. **Set up database**:

   ```bash
   yarn prisma migrate dev
   yarn prisma generate
   ```

4. **Start development server**:
   ```bash
   yarn dev
   ```

The API will be available at `http://localhost:3000`

## API Endpoints

### Health Check

- `GET /health` - Server health status

### API Information

- `GET /api` - API information and available routers

### tRPC Endpoints

All business logic is handled through tRPC at `/api/trpc/[router].[procedure]`

#### Available Routers:

1. **User Router** (`/api/trpc/user.*`)
   - `create` - Create new user
   - `list` - Get all users
   - `getById` - Get user by ID
   - `getByEmail` - Get user by email
   - `update` - Update user information
   - `getPortfolioSummary` - Get user's portfolio summary
   - `getStats` - Get user activity statistics
   - `delete` - Delete user

2. **Exchange Router** (`/api/trpc/exchange.*`)
   - `create` - Create new exchange
   - `list` - Get all exchanges
   - `getById` - Get exchange by ID
   - `getByCode` - Get exchange by code
   - `update` - Update exchange information
   - `getStats` - Get exchange statistics
   - `delete` - Delete exchange

3. **Stock Router** (`/api/trpc/stock.*`)
   - `create` - Add new stock
   - `list` - Get stocks with filtering
   - `getById` - Get stock by ID
   - `getBySymbol` - Get stock by symbol
   - `update` - Update stock information
   - `getPriceHistory` - Get price history
   - `addPriceHistory` - Add price data
   - `addBulkPriceHistory` - Bulk add price data
   - `getLatestPrice` - Get latest price
   - `getPopularStocks` - Get stocks with recent activity
   - `delete` - Delete stock

4. **Position Router** (`/api/trpc/position.*`)
   - `create` - Open new position
   - `close` - Close position
   - `list` - Get positions with filtering
   - `getById` - Get position by ID
   - `update` - Update position details
   - `delete` - Delete position
   - `openSummary` - Get open positions summary

5. **Transaction Router** (`/api/trpc/transaction.*`)
   - `create` - Create new transaction
   - `list` - Get transactions with filtering
   - `getById` - Get transaction by ID
   - `getByPosition` - Get transactions for position
   - `update` - Update transaction
   - `getSummary` - Get transaction analytics
   - `delete` - Delete transaction
   - `createBulk` - Bulk create transactions

6. **Watchlist Router** (`/api/trpc/watchlist.*`)
   - `add` - Add stock to watchlist
   - `list` - Get user's watchlist
   - `getById` - Get watchlist item details
   - `update` - Update watchlist item
   - `remove` - Remove from watchlist
   - `removeByStock` - Remove by stock ID
   - `isWatched` - Check if stock is watched
   - `getPriceAlerts` - Get price alerts
   - `getSummary` - Get watchlist summary
   - `bulkAdd` - Bulk add to watchlist

## Database Schema

The API uses a comprehensive database schema designed for stock portfolio management:

- **Users**: User accounts
- **Exchanges**: Stock exchanges (NYSE, NASDAQ, etc.)
- **Stocks**: Individual stocks/securities
- **Positions**: Trading positions with detailed tracking
- **Transactions**: Individual buy/sell transactions
- **PriceHistory**: Historical price data
- **Watchlist**: Stocks to monitor
- **PortfolioSnapshot**: Portfolio performance snapshots

## Development

### Scripts

- `yarn dev` - Start development server with hot reload
- `yarn build` - Build for production
- `yarn test` - Run tests
- `yarn lint` - Run ESLint
- `yarn format` - Format code with Prettier

### Database Commands

- `yarn prisma migrate dev` - Create and apply migration
- `yarn prisma generate` - Generate Prisma client
- `yarn prisma studio` - Open Prisma Studio
- `yarn prisma migrate reset` - Reset database

## Type Safety

This API is fully type-safe from database to API responses:

1. **Database**: Prisma generates types from schema
2. **Validation**: Zod schemas ensure runtime type safety
3. **API**: tRPC provides end-to-end type safety
4. **Client**: Generated types for frontend consumption
