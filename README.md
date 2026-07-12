# Piggy API

A stock/ETF/crypto portfolio tracking REST API built with Express, Prisma, and TypeScript.

## Features

- **Authentication**: Email/password signup & login with JWT access + refresh tokens (rotation), password reset flow
- **Trading Accounts**: Create, rename, close/reopen, and delete trading accounts
- **Position Tracking**: Open, update, close (fully or partially), and delete positions, with drawdown recalculation from historical prices
- **Portfolio Snapshots**: Daily portfolio snapshots and historical equity-curve data
- **Stock Search & Quotes**: Symbol search and live quotes powered by Yahoo Finance (no API key required)
- **API Documentation**: Interactive Swagger UI

## Tech Stack

- **Runtime**: Node.js (ESM modules)
- **Framework**: Express 5
- **Language**: TypeScript
- **Database**: PostgreSQL with Prisma ORM (`@prisma/adapter-pg`)
- **Auth**: JWT (`jsonwebtoken`) + `bcryptjs`, refresh token rotation
- **Validation**: `express-validator`
- **Security**: `helmet`, `cors`, `morgan`
- **API docs**: Swagger UI (`swagger-jsdoc` + `swagger-ui-express`)
- **Testing**: Vitest
- **Linting**: ESLint + Prettier + lint-staged + Husky
- **Package manager**: Yarn (see `.nvmrc` / `packageManager` field for the pinned Node/Yarn versions)

## Quick Start

1. **Install dependencies**:

   ```bash
   yarn install
   ```

2. **Set up environment**:

   ```bash
   cp .env.example .env
   # Edit .env with your database URL and JWT secrets
   # No market-data API key required for symbol search
   ```

3. **Set up database**:

   ```bash
   yarn db:migrate:dev
   yarn prisma generate
   ```

4. **Start development server**:
   ```bash
   yarn dev
   ```

The API will be available at `http://localhost:4000` (configurable via the `PORT` env var).

## API Endpoints

### Health & Info

- `GET /health` - Service health check
- `GET /api` - API info (documentation link, features)
- `GET /api/docs` - Swagger UI (interactive API documentation)

### Auth (`/api/auth`)

- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Sign in; returns `user`, `accessToken`, `refreshToken`
- `POST /api/auth/refresh` - Exchange a refresh token for a new access + refresh token pair
- `POST /api/auth/logout` - Revoke the current refresh token (requires auth)
- `POST /api/auth/forgot-password` - Request a password reset
- `POST /api/auth/reset-password` - Set a new password using a reset token

### Users (`/api/users`) — requires auth

- `GET /api/users/me` - Get the authenticated user's profile
- `PATCH /api/users/me` - Update profile (name, baseCurrency) or change password

### Stocks (`/api/stocks`)

- `GET /api/stocks/search` - Search stock symbols globally (Yahoo Finance; no auth required)
- `GET /api/stocks/quotes` - Live quotes for a comma-separated list of symbols (requires auth)

### Accounts (`/api/accounts`) — requires auth

- `GET /api/accounts` - List trading accounts (`includeClosed` query param supported)
- `POST /api/accounts` - Create (or return existing) trading account
- `PATCH /api/accounts/:id` - Rename a trading account
- `POST /api/accounts/:id/close` - Close a trading account (must have no open/partial positions)
- `POST /api/accounts/:id/reopen` - Reopen a closed trading account
- `DELETE /api/accounts/:id` - Delete an empty trading account

### Positions (`/api/positions`) — requires auth

- `GET /api/positions` - List positions (filterable by `status`, `assetType`, `exchangeCode`, `accountId`; paginated)
- `POST /api/positions` - Open a new position
- `PATCH /api/positions/:id` - Update position metadata
- `POST /api/positions/:id/close` - Close or partially close a position
- `DELETE /api/positions/:id` - Delete a position and its transactions
- `GET /api/positions/close-events` - List close events (sell transactions) with context
- `POST /api/positions/:id/recalculate-drawdown` - Recalculate max drawdown from historical prices

### Portfolio (`/api/portfolio`) — requires auth

- `GET /api/portfolio/history` - Historical portfolio snapshots (for equity-curve charting)
- `POST /api/portfolio/snapshot` - Create/update today's portfolio snapshot (upsert)

## Database Schema

Defined in `prisma/schema.prisma`:

- **User**: user accounts
- **RefreshToken** / **PasswordResetToken**: auth token tracking
- **Exchange**: stock exchanges
- **TradingAccount**: a user's trading accounts
- **Asset**: individual stocks/ETFs/crypto assets
- **PriceHistory**: historical price data per asset
- **Position**: trading positions with entry/exit tracking
- **Transaction**: individual buy/sell transactions tied to a position
- **PortfolioSnapshot**: daily portfolio performance snapshots

## Development

### Scripts

- `yarn dev` - Start development server with hot reload (runs TypeScript directly via `tsx`, no build step)
- `yarn build` - Compile to `dist/` for production (uses `tsconfig.build.json`; the root `tsconfig.json` is type-check only, `noEmit: true`)
- `yarn test` - Run tests (watch mode); `yarn test --run` / `yarn test:coverage` for CI-style single runs
- `yarn lint` / `yarn lint:fix` - Run ESLint
- `yarn format` - Format code with Prettier

### Database Commands

- `yarn db:migrate:dev` - Create/apply local migrations during development
- `yarn db:migrate:deploy` - Apply pending checked-in migrations (used in production deploys)
- `yarn db:migrate:reset` - Reset the database
- `yarn db:seed` - Run the Prisma seed script (`prisma/seed-exchanges.ts`)
- `npx prisma studio` - Open Prisma Studio

### Recommended Development DB Workflow

1. Keep all schema changes in `prisma/schema.prisma`.
2. Create migrations with `yarn db:migrate:dev` and commit the generated files under `prisma/migrations`.
3. On startup, the API auto-runs `prisma migrate deploy` when `NODE_ENV` is not `production` and `DB_AUTO_MIGRATE` is not `false` (see `.env.example`).
4. Datasource connection config for the Prisma CLI (`migrate deploy`, `generate`, etc.) lives in `prisma.config.ts` at the repo root, which reads `DATABASE_URL` from `.env`.

## Deployment

The API deploys to a DigitalOcean VPS via GitHub Actions (`.github/workflows/deploy.yml`, manually triggered via `workflow_dispatch`):

1. **Test** job: installs deps, runs the test suite.
2. **Build** job: installs deps, generates the Prisma client, compiles TypeScript, and bundles `dist/`, `prisma/`, `package.json`, `yarn.lock`, and `prisma.config.ts` into a deploy artifact.
3. **Deploy** job: uploads the bundle to the VPS via SCP, then over SSH installs production dependencies, regenerates the Prisma client, runs `prisma migrate deploy`, and starts/reloads the app via PM2.

The VPS never needs Git access to the repo — only the compiled artifact is shipped. A persistent `.env` file on the VPS (outside the deploy bundle) holds production secrets and is never overwritten by a deploy.
