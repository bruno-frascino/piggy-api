# Piggy API

A stock/ETF/crypto portfolio tracking REST API built with Express, Prisma, and TypeScript.

## Features

- **Authentication**: Email/password signup & login with JWT access + refresh tokens (rotation), password reset flow
- **Trading Accounts**: Create, rename, close/reopen, and delete trading accounts
- **Position Tracking**: One acquisition parcel per BUY, partial/full sales, metadata and historical drawdown; financial editing/deletion is restricted for imported or cash-linked records
- **Portfolio Snapshots**: Legacy invested-capital/gain snapshots and historical curves, not yet cash-inclusive sourced portfolio valuations or TWR/XIRR
- **Kraken Imports**: Supported CSV review and parcel allocation; enum entries for other providers do not imply implemented adapters
- **Accounting Foundation (gated)**: Read-only opening previews, immutable inactive drafts, exact cash replay/evidence review, coordinated live trades, audited execution corrections and terminal manual voids
- **CGT Reports**: Explicit real-account selection, append-only PDF revisions and source-staleness indicators
- **Stock Search & Quotes**: Symbol search and live quotes powered by Yahoo Finance (no API key required)
- **API Documentation**: Interactive Swagger UI

## Accounting delivery boundary

See the [step-by-step foundation plan](./docs/portfolio-foundation-plan.md) for current status,
remaining increments, acceptance gates and commit order, and [ADR 0016](./docs/adr/0016-portfolio-accounting-foundation.md)
for accounting policy. The plan is the resume point for ongoing foundation work.

Opening preview/save/reconciliation does not activate an account or create spendable cash.
Live posting/corrections/voids require an already provisioned, matching confirmed opening
statement and active real cash ledger. There is no user-facing provisioning flow; do not
manually provision production accounts to bypass the release gate.

Manual SELL voids restore inventory and remove proceeds. Manual BUY voids require no effective
sales and exclude the acquisition from current holdings without treating it as a disposal.
Original trades/postings and terminal revision audits remain retained. Current holdings,
disposals and CGT/statistics exclude voided economic effects; saved PDF revisions do not change.
Imported corrections retain source events and fixed quantity/parcel allocations; imported
voids, financial moves and deletion are blocked. Retained void audits remain readable on archived
ledger-backed accounts, but are not a source-freshness or reconciliation assertion.

Next milestones: live funding, funding revisions, balances/activity/evidence review, ordinary
ledger trade-entry routing, then reviewed per-account confirmation. Income/transfers, sourced
valuations and cash-flow-adjusted returns follow later. Existing demos remain legacy practice
accounts, excluded from real aggregates and tax.

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
- `POST /api/auth/restore` - Cancel a pending account deletion and sign in

### Users (`/api/users`) — requires auth

- `GET /api/users/me` - Get the authenticated user's profile
- `PATCH /api/users/me` - Update profile (name, baseCurrency) or change password
- `DELETE /api/users/me` - Schedule the account for deletion (password-confirmed, 30-day grace period)

### Stocks (`/api/stocks`)

- `GET /api/stocks/search` - Search stock symbols globally (Yahoo Finance; no auth required)
- `GET /api/stocks/quotes` - Live quotes for a comma-separated list of symbols (requires auth)

### Accounts (`/api/accounts`) — requires auth

- `GET /api/accounts` - List trading accounts (`includeClosed` query param supported)
- `POST /api/accounts` - Create (or return existing) trading account
- `PATCH /api/accounts/:id` - Rename a trading account
- `POST /api/accounts/:id/close` - Close a trading account (must have no open/partial positions)
- `POST /api/accounts/:id/reopen` - Reopen a closed trading account
- `DELETE /api/accounts/:id` - Delete a trading account (refused if it still has positions or is used by a tax report; derived snapshots cascade)

### Accounting (`/api/accounts/:id`) — requires auth

- `POST /api/accounts/:id/opening-preview` - Read-only opening holdings/cash preview
- `POST /api/accounts/:id/opening-statements` - Save a reviewed inactive opening draft
- `GET /api/accounts/:id/opening-statements` - List retained opening drafts
- `GET /api/accounts/:id/opening-statements/:statementId/reconciliation` - Inactive cash/inventory/evidence review; never activation-ready
- `POST /api/accounts/:id/trades` - Gated atomic manual BUY/SELL and cash posting
- `POST /api/accounts/:id/trades/:transactionId/corrections` - Audited live manual SELL date/sequence/price/fee correction
- `POST /api/accounts/:id/trades/:transactionId/acquisition-corrections` - Audited live manual BUY date/sequence/quantity/price/fee correction
- `POST /api/accounts/:id/imported-executions/:eventId/corrections` - Restricted source-preserving live Kraken execution correction
- `POST /api/accounts/:id/trades/:transactionId/voids` - Terminal audited live manual trade void
- `GET /api/accounts/:id/trades/voids` - Paginated retained void audits, including archived accounts

This is a selected route summary. See [generated API surface](./context/api-surface.md) and
Swagger at `/api/docs` for complete draft cash/evidence/staging routes, request shapes,
eligibility and error responses. Draft deposits/withdrawals are not a live funding API.

### Positions (`/api/positions`) — requires auth

- `GET /api/positions` - List effective positions (filterable by `status`, `assetType`, `exchangeCode`, `accountId`; paginated); voided acquisitions/transactions excluded
- `POST /api/positions` - Open a new position
- `PATCH /api/positions/:id` - Update position metadata
- `POST /api/positions/:id/close` - Close or partially close a position
- `DELETE /api/positions/:id` - Delete an eligible legacy manual position; imported/cash-linked/voided records are protected
- `GET /api/positions/close-events` - List effective close events (sell transactions) with context; excludes voided economic effects
- `PATCH /api/positions/close-events/:id` - Edit a recorded close event
- `POST /api/positions/:id/recalculate-drawdown` - Recalculate max drawdown from historical prices

### Portfolio (`/api/portfolio`) — requires auth

- `GET /api/portfolio/history` - Historical portfolio snapshots (for equity-curve charting)
- `GET /api/portfolio/realized-pnl` - Realized profit and loss over a date range
- `POST /api/portfolio/snapshot` - Create/update today's portfolio snapshot (upsert)

### Tax Reports (`/api/tax-reports`) — requires auth

- `POST /api/tax-reports/generate` - Generate an ATO capital gains report for a financial year + explicit account selection. Append-only: supersedes the previous revision rather than overwriting it
- `GET /api/tax-reports` - List reports (current revisions only; `includeSuperseded` query param supported)
- `GET /api/tax-reports/:id` - Report metadata plus per-disposal line items
- `GET /api/tax-reports/:id/download` - Download the persisted PDF
- `GET /api/tax-reports/position-usage` - Map each position to the reports including it, with a staleness flag
- `DELETE /api/tax-reports/:id` - Delete a report revision

### Statistics (`/api/statistics`) — requires auth

- `GET /api/statistics/summary` - Headline trading stats (win rate, expectancy, profit factor, …)
- `GET /api/statistics/timeseries` - Performance over time
- `GET /api/statistics/distributions` - Return/holding-period distributions
- `GET /api/statistics/risk` - Risk metrics
- `GET /api/statistics/breakdowns` - Breakdowns by account, exchange, asset type, etc.
- `GET /api/statistics/closed-trades` - Closed trades behind the statistics, with filters

### Screener (`/api/screener`) — requires auth

- `GET /api/screener` - Run a screen over available assets
- `GET /api/screener/upcoming-dividends` - Upcoming dividend events
- `GET /api/screener/saved-screens` - List saved filter sets
- `POST /api/screener/saved-screens` - Save a filter set
- `DELETE /api/screener/saved-screens/:id` - Delete a saved filter set

### Watchlists (`/api/watchlists`) — requires auth

- `GET /api/watchlists` - List watchlists
- `POST /api/watchlists` - Create a watchlist
- `GET /api/watchlists/:id` - Get a watchlist and its items
- `PATCH /api/watchlists/:id` - Rename a watchlist
- `DELETE /api/watchlists/:id` - Delete a watchlist
- `POST /api/watchlists/:id/items` - Add an asset to a watchlist
- `DELETE /api/watchlists/:id/items/:itemId` - Remove an asset from a watchlist

## Database Schema

Defined in `prisma/schema.prisma`:

- **User**: user accounts (soft-deleted via `deletedAt`/`purgeAfter`)
- **RefreshToken** / **PasswordResetToken**: auth token tracking
- **Exchange**: stock exchanges
- **TradingAccount**: a user's trading accounts
- **Asset**: individual stocks/ETFs/crypto assets
- **PriceHistory**: historical price data per asset
- **Position**: trading positions with entry/exit tracking
- **Transaction**: individual buy/sell transactions tied to a position
- **PortfolioSnapshot**: daily portfolio performance snapshots
- **TaxReport**: generated ATO capital gains reports, stored as append-only revisions
- **FxRateCache**: cached foreign-currency-to-AUD daily rates (RBA, Yahoo fallback), unique per `{currency, date}`
- **Watchlist** / **WatchlistItem**: named per-user watchlists and the assets in them
- **SavedScreen**: a user's saved screener filter sets
- **AccountOpeningStatement** and child cash/parcel records: immutable opening revisions and source snapshots
- **DraftCashOperation** / revisions, postings and evidence: inactive scenarios and user-attested reconciliation history
- **AccountCashLedger** / **AccountCashOperation** / **AccountCashOperationRevision**: gated live source-linked cash history and immutable correction/void postings

`Position.voidedAt` and `Transaction.voidedAt` are economic-inactivity markers validated
against terminal manual void audits, not user deletion markers. See the
[generated data model](./context/data-model.md) for all persisted fields and relationships.

## Development

### Scripts

- `yarn dev` - Start development server with hot reload (runs TypeScript directly via `tsx`, no build step)
- `yarn build` - Compile to `dist/` for production (uses `tsconfig.build.json`; the root `tsconfig.json` is type-check only, `noEmit: true`)
- `yarn test` - Run tests (watch mode); `yarn test --run` / `yarn test:coverage` for CI-style single runs
- `yarn lint` / `yarn lint:fix` - Run ESLint
- `yarn format` - Format code with Prettier

### Database Commands

- `yarn db:wipe` - Preview a data-only reset (does not connect to the database)
- `yarn db:wipe --confirm` - Permanently clear all application data, including all users,
  account opening statements and balances, and draft accounting data,
  while preserving exchanges, the database schema, and Prisma migration history.
  Uses `DATABASE_URL` from the environment or `.env`. Stop the API and other writers
  and take a backup first; this bypasses the user-deletion grace period and cannot
  be undone without a backup. All tables are truncated in one atomic statement,
  without `CASCADE`; unexpected foreign-key dependencies cause the reset to fail.
  There are no seeded symbols: assets, price history, and FX cache are cleared,
  and symbol search continues to use Yahoo Finance. Register a new user afterward.

- `yarn db:migrate:dev` - Create/apply local migrations during development
- `yarn db:migrate:deploy` - Apply pending checked-in migrations (used in production deploys)
- `yarn db:migrate:reset` - Reset the database
- `yarn db:seed` - Run the Prisma seed script (`prisma/seed-exchanges.ts`)
- `yarn db:purge-deleted-users` - Hard-delete users past their 30-day deletion grace period (schedule this in production — see `docs/deployment.md`)
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
