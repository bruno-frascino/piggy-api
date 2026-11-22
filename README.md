# Piggy API

A stock/ETF/crypto portfolio tracking REST API built with Express, Prisma, and TypeScript.

## Features

- **Authentication**: Email/password signup & login with JWT access + refresh tokens (rotation), password reset flow
- **Trading Accounts**: Create, rename, close/reopen, and delete trading accounts
- **Position Tracking**: One acquisition parcel per BUY, partial/full sales, metadata and historical drawdown; financial editing/deletion is restricted for imported or cash-linked records
- **Portfolio Snapshots**: Legacy invested-capital/gain snapshots and historical curves, not yet cash-inclusive sourced portfolio valuations or TWR/XIRR
- **Kraken Imports**: Supported CSV review and parcel allocation; enum entries for other providers do not imply implemented adapters
- **Accounting Foundation (gated)**: Read-only opening previews, immutable inactive drafts, exact cash replay/evidence review, explicit reviewed per-account confirmation, capability-aware ordinary BUY/SELL routing, coordinated live trades/funding/income, audited execution and income corrections, and terminal manual voids
- **CGT Reports**: Explicit real-account selection, append-only PDF revisions and source-staleness indicators
- **Stock Search & Quotes**: Symbol search and live quotes powered by Yahoo Finance (no API key required)
- **API Documentation**: Interactive Swagger UI

## Accounting delivery boundary

See the [step-by-step foundation plan](./docs/portfolio-foundation-plan.md) for current status,
remaining increments, acceptance gates and commit order, and [ADR 0016](./docs/adr/0016-portfolio-accounting-foundation.md)
for accounting policy. The plan is the resume point for ongoing foundation work.

Opening preview/save/reconciliation does not activate an account or create spendable cash.
An authenticated, explicit confirmation can enable only one eligible active real account after
the latest clean draft, source fingerprint, issue-free inventory, funded cash replay and latest
exact user-attested statement evidence are revalidated atomically. Saved activity on the selected
draft blocks confirmation; activity on other drafts is retained, listed and audited as excluded,
never copied into the live ledger. Four explicit acknowledgements cover opening balances,
user-attested cash, excluded draft activity and unavailable performance returns without sourced
valuations. Confirmation is online-only and retry-safe; it is not called by saving a draft,
account lookup or ordinary trade entry. Do not manually provision production accounts to bypass
the release gate.
Live posting/deposits/withdrawals/funding revisions/trade corrections/voids require the matching
confirmed opening statement and active real cash ledger. Deposits and withdrawals are cash-only
audited operations; they never create synthetic trades or auto-balance a ledger. Funding
corrections/reversals append immutable cash-only postings and are constrained by full dated
replay.
Manual equity/ETF income receipts require an active confirmed ledger and user-supplied statement
figures. The ledger posts only gross income less withholding; franked/unfranked amounts and
non-cash AUD franking credits remain tax attributes, not spendable cash. Audited replacement and
terminal reversal are supported; replacement preserves asset, currency and source reference.
Reverse and record a new receipt to correct those identity fields. AMIT components, automated
estimates and crypto staking remain unsupported; do not edit or delete posted receipts
directly.
Same-currency cash-transfer posting/history uses paired immutable operations between two owned
active confirmed ledgers, one shared effective date and separate account sequences. Principal is
debited/credited atomically; an explicit fee is charged only to the sender. Principal is external
to either account but cancels across both; fees remain costs. Both dated timelines must be funded.
The transfer endpoint does not support direct edits, one-sided reversals, currency conversion,
holdings transfers or untracked endpoints.
Dedicated paired corrections can replace principal, sender fee, shared date and both sequences,
preserving accounts, currency and source reference. Both current audit heads and fresh active
ledgers are required; immutable audits and all historical slots remain retained. Reversal is
terminal and removes the original economic effect, including fees. Exact retries and funded
dated replay on both accounts are enforced.
Explicit same-account FX posting records an already executed broker conversion as linked
source debit and gross received credit, before fees in either exchanged currency. Both currency
openings must be explicit and the dated timeline including fees must remain funded. These
immutable cash-only postings are not external capital and create no holdings, live exchange,
market rate, reporting valuation or account activation. Statement amounts/reference are retained;
exact retries are supported. Dedicated audited FX corrections retain account, currency
pair/direction and source, while amounts, fees, date and sequence may change. Current
revision/audit/fingerprint, reason and funded replay in both currencies are required.
Reversal is terminal and removes the effective conversion including fees; original records,
inverse/replacement legs and historical slots remain retained. Generic funding revisions and
third-currency fees remain blocked.
Statement-supported equity/ETF reinvestment atomically records one income receipt and a new
BUY parcel in the same account/currency. Exact net income must equal consideration, explicit
fees and residual cash actually paid into the account. Historical entitlement holdings and
user-confirmed statement tax figures are required; current holdings do not determine income.
Payment and acquisition dates/sequences are retained, and full replay protects later allotment
funding. Both immutable linked operations share the normalized statement identity; exact retries
do not duplicate income or parcels. Issuer-held credits, extra funding, existing-receipt relinking
and independent income/acquisition revisions or voids are blocked. Dedicated paired corrections
retain account/asset/currency/source identity and require both review heads, a reason, funded
replay and no effective parcel sales. Terminal reversal removes both effects without a disposal;
void effective sales first. No schema change or activation is needed.
Ordinary trade entry reads the server-owned capability for the selected account and effective
date: only `LIVE_LEDGER` uses the coordinated writer, while legacy/demo accounts keep their
existing flows. Blocked, archived, unavailable and offline live writes fail closed; no account
is provisioned or activated by capability lookup or trade entry.

Manual SELL voids restore inventory and remove proceeds. Manual BUY voids require no effective
sales and exclude the acquisition from current holdings without treating it as a disposal.
Original trades/postings and terminal revision audits remain retained. Current holdings,
disposals and CGT/statistics exclude voided economic effects; saved PDF revisions do not change.
Imported corrections retain source events and fixed quantity/parcel allocations; imported
voids, financial moves and deletion are blocked. Retained void audits remain readable on archived
ledger-backed accounts, but are not a source-freshness or reconciliation assertion.

Next milestone: complete the approved stock-split/consolidation foundation before release. Its
policy and reference examples exist; user-facing corporate-action posting/history is not
implemented. Valid audited split history now permits coordinated manual BUY/SELL trades, using
split-aware parcel inventory and shared audit/cash replay; acquisitions on or before a retained
split date are rejected to protect immutable parcel effects. Other financial writes and opening confirmation remain blocked. Opening/source inventory
replays retained splits and fingerprints their evidence without changing trade cash; proposed-sale
review and dated reinvestment entitlement share the validated inventory behind the write guards.
Audited retained splits now advance the shared
source/audit chain without cash postings; unaudited records are not adopted. The internal locked,
source-fresh split writer and a terminal retroactive reversal are implemented but have no API
route. Reversal retains the original action/effects, restores affected quantities only when no
later active split or same/later affected-parcel sale depends on it, and allows corrected
source/date reuse with a new idempotency key. Later statement-backed income receipts and their
cash postings remain unchanged; receipt corrections/reversals use their separate audited flow,
still subject to the account-wide split-history write fence. Split reversal does not change cash
or acquisition records. Manual BUY/SELL is the only financial writer enabled with valid audited
split history; other financial writes remain fenced;
opening confirmation remains blocked, and cash review remains incomplete even with a current
source. Read-only realized-trade statistics and positions now use validated split-adjusted
inventory/cost without rewriting acquisition fields. Saved tax-report revisions remain
append-only when split-adjusted CGT changes. Broader
historical protections and public posting/history UI remain before release. Sourced valuations and
cash-flow-adjusted returns follow later.

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
- `GET /api/accounts/:id/opening-statements` - List retained draft and confirmed opening statements
- `GET /api/accounts/:id/opening-statements/:statementId/reconciliation` - Read-only cash/inventory/evidence review and confirmation blockers
- `POST /api/accounts/:id/opening-statements/:statementId/confirm` - Explicitly confirm one eligible draft and atomically enable its cash ledger
- `GET /api/accounts/:id/trade-capability` - Read account trade capability and available effective-date sequence; never activates an account
- `POST /api/accounts/:id/trades` - Gated atomic manual BUY/SELL and cash posting
- `POST /api/accounts/:id/cash-operations` - Gated cash-only live deposit/withdrawal with dated funding replay
- `POST /api/accounts/:id/cash-transfers` - Atomic same-currency paired cash transfer and sender-paid fee between owned active real ledgers
- `POST /api/accounts/:id/income-receipts` - Gated manual equity/ETF cash distribution; posts net cash and retains statement tax attributes
- `POST /api/accounts/:id/income-receipts/:operationId/corrections` - Audited income replacement or terminal reversal with dated cash replay
- `GET /api/accounts/:id/cash-operations` - Exact live cash replay, effective activity, source freshness, attested statement evidence and retained audits; read-only for active and archived ledger accounts
- `POST /api/accounts/:id/cash-operations/:operationId/corrections` - Audited live funding replacement or terminal reversal
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
- `POST /api/portfolio/snapshot` - Create/update today's synthetic portfolio snapshot (upsert); split-affected holdings use validated remaining acquisition cost, not a sourced valuation

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
