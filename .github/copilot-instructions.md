# Project Context & Architecture

## System Overview

Truffles is a personal stock portfolio tracker supporting equities, ETFs, and crypto across multiple exchanges.
The workspace contains two projects:

- **`piggy-api/`** — REST API backend (Node.js / Express / PostgreSQL)
- **`piggy-fe/`** — Web frontend (Next.js / React / PrimeReact)

---

## Frontend Stack (`piggy-fe/`)

| Concern       | Library / Tool                                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | Next.js 16 (App Router)                                                                                                                                                                  |
| Language      | TypeScript 6                                                                                                                                                                             |
| UI components | PrimeReact v10 + PrimeFlex v4 + Primeicons v7 (theme: `lara-light-blue`)                                                                                                                 |
| Styling       | Tailwind CSS v4 + PostCSS                                                                                                                                                                |
| Server state  | TanStack React Query v5                                                                                                                                                                  |
| HTTP client   | Axios (shared instance at `src/lib/api-client.ts`)                                                                                                                                       |
| Charts        | Chart.js + react-chartjs-2                                                                                                                                                               |
| Local state   | React `useState` for feature state; no external global state library (Zustand/Redux not used). React Context is allowed for cross-cutting UI concerns (for example toast notifications). |
| PWA           | @ducanh2912/next-pwa                                                                                                                                                                     |
| Testing       | Vitest + @testing-library/react                                                                                                                                                          |
| Linting       | ESLint + Prettier + lint-staged + Husky                                                                                                                                                  |

**Key directories:**

```
src/
  app/           # Next.js App Router pages
    auth/        # login, signup, forgot-password
    history/     # closed positions history
    reports/     # ATO capital gains tax reports (generate/list/download PDF)
  components/    # Shared UI components (PrimeReact-based)
    PageHeader.tsx, MobileTabBar.tsx  # shared page-header + mobile bottom nav
    ReportsView.tsx, GenerateReportDialog.tsx, ReportDetailDialog.tsx  # Tax Reports feature
  hooks/         # api.ts — TanStack Query hooks wrapping the API client
  lib/
    api-client.ts   # Axios instance + all API call functions
    types.ts        # Shared TypeScript interfaces (manually maintained)
    closed-trades-store.ts  # localStorage-backed store for closed trades
```

---

## Backend Stack (`piggy-api/`)

| Concern       | Library / Tool                                                             |
| ------------- | -------------------------------------------------------------------------- |
| Runtime       | Node.js (ESM modules)                                                      |
| Framework     | Express 5                                                                  |
| Language      | TypeScript 6                                                               |
| ORM           | Prisma v7 + @prisma/adapter-pg                                             |
| Database      | PostgreSQL                                                                 |
| Auth          | JWT (jsonwebtoken) + bcryptjs; refresh token rotation                      |
| Validation    | express-validator v7                                                       |
| Security      | helmet, cors, morgan                                                       |
| API docs      | Swagger UI at `/api/docs` (swagger-jsdoc + swagger-ui-express)             |
| Symbol search | Yahoo Finance public API — no key required                                 |
| PDF reports   | pdfkit (pure-JS, no Chromium — used for ATO capital gains tax report PDFs) |
| Testing       | Vitest                                                                     |
| Linting       | ESLint + Prettier + lint-staged + Husky                                    |

**Key directories:**

```
src/
  controllers/   # Route handlers (auth, users, stocks, positions, portfolio, accounts, tax-reports)
  lib/           # prisma.ts, jwt.ts, exchange-sync.ts, swagger.ts
                 # fx-rates.ts (RBA historical FX + Yahoo fallback), cgt-engine.ts, pdf-report.ts
  middleware/    # validation.ts (asyncHandler, errorHandler), auth.ts (authenticateToken)
prisma/
  schema.prisma  # Source of truth for all data models
  migrations/    # Timestamped migration history
  seed-exchanges.ts
```

**Default port:** `4000`

---

## Frontend & Backend Integration Rules

### Portfolio UX Behavior

- The dashboard is **account-first** and **position-first**.
- Users can create a position without preselecting an exchange.
- Exchange selection is derived from the selected stock symbol search result and should not require a separate manual "Add Exchange" step.
- Exchanges shown on the dashboard are discovered from the user positions for the selected account.
- When defining or implementing solutions, prefer patterns that are appropriate for a Progressive Web App: responsive layouts, touch-friendly interactions, lightweight flows, and UI patterns that work well on both mobile and desktop.
- For offline behavior: for read-only views (portfolio, history), show cached last-successful data and an explicit stale-data indicator when offline. Do not queue or auto-retry offline mutations.
- When a new feature is discussed or implemented, complete it end to end: create or update the backend and frontend together when both sides are involved.
- When a feature is removed or changed, keep both sides aligned so there are no stale or half-finished integrations.

### Tax Reports (ATO Capital Gains)

- A `Position` is created with exactly one BUY transaction and is never appended to (no "add units to an existing position" flow exists) — every Position IS already a discrete CGT parcel (`openDate`/`entryPrice`/`buyFees` = acquisition date/cost/incidental costs). Every SELL `Transaction` against it (partial or full close) is an unambiguous disposal of that specific parcel. No FIFO lot reconstruction is implemented or needed.
- Reports are scoped by an explicit, user-picked multi-select of Trading Accounts each time (`piggy-api/src/lib/cgt-engine.ts` `computeCapitalGainsReport`), not "all accounts" — this supports separate declarations (e.g. the user's own accounts vs a spouse's accounts tracked under the same login). The exact account selection is hashed into `TaxReport.accountsKey` and used both as the upsert key (`@@unique([userId, financialYearStartYear, accountsKey])`) and to find the correct prior-year report for loss carry-forward chaining — different account combinations never share a carry-forward chain.
- FX conversion to AUD uses RBA's official daily rates first (`piggy-api/src/lib/fx-rates.ts`, parses `https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv`), falling back to Yahoo Finance historical rates only when RBA doesn't cover the date (pre-2023) or currency. Results are cached in `FxRateCache` (`{currency, date}` unique) both for performance and reproducibility.
- The 50% CGT discount (individuals, held > 12 months) and loss-offset ordering (losses applied to non-discount gains first, then discount-eligible gains, before the 50% discount is applied) follow the ATO's documented method — see `piggy-api/docs/ato-capital-gains-methodology.md` for the full write-up and disclaimers.
- Generated PDFs (`piggy-api/src/lib/pdf-report.ts`, via `pdfkit` — no Chromium/Puppeteer, important given the VPS's limited RAM) are persisted as `Bytes` directly in the `TaxReport` row (no S3/disk storage) so past reports can be re-downloaded later. Email delivery is intentionally NOT implemented yet — download-only via `GET /api/tax-reports/:id/download`.
- Every report (UI and PDF) must carry a clear "not professional tax advice — verify with a registered tax agent" disclaimer.

### HTTP & API Client

- All frontend HTTP calls must go through the shared Axios instance in `src/lib/api-client.ts`.
- **Never** hardcode URLs. Use the environment variable `NEXT_PUBLIC_API_URL=http://localhost:4000/api`.
- A mock API mode is available for offline development: set `NEXT_PUBLIC_USE_MOCK_API=true`.
- When adding a new API endpoint, add a corresponding mock implementation in `src/lib/mock-api.ts` for `NEXT_PUBLIC_USE_MOCK_API=true`; if a realistic mock is not provided yet, return a clear not-implemented stub in mock mode.

### Data Contracts & Type Safety

- Both backend and frontend use **camelCase** for all JSON keys — no transformation layer needed.
- Backend Prisma models (`prisma/schema.prisma`) are the source of truth for data shapes.
- Frontend TypeScript interfaces are **manually mirrored** in `src/lib/types.ts`; update this file whenever the schema changes.
- Never use `any`; use `unknown` with type guards at system boundaries.
- All `localStorage` access must be guarded with `typeof window !== 'undefined'` and wrapped in `try/catch`; if `localStorage` is unavailable or throws, fall back to in-memory state.

### Authentication

- Protected backend routes require a Bearer JWT in the `Authorization` header.
- Access tokens are stored in `localStorage` under `authToken`.
- Refresh tokens should be stored in an `httpOnly`, `Secure`, `SameSite=Strict` cookie set by the backend.
- The Axios instance attaches it automatically via a request interceptor:
  ```ts
  const token = localStorage.getItem('authToken')
  config.headers.Authorization = `Bearer ${token}`
  ```
- On 401 responses, first attempt one refresh via `POST /api/auth/refresh`; if refresh fails, clear auth state and redirect to `/auth/login`.

### Error Handling

The backend returns errors in this shape:

```json
{ "error": "Unauthorized", "message": "Invalid or expired token" }
```

For validation errors:

```json
{ "error": "Validation Error", "details": [...] }
```

- Form-level errors on the frontend: use PrimeReact `<Message severity="error" text={...} />`.
- Global mutation feedback (success/error): use PrimeReact `<Toast>` via a context provider. Expose a `useToast()` hook that components can call to trigger toasts without prop-drilling the ref.
- If the Yahoo Finance symbol search request fails or times out (5s), the backend should return `503` with `{ "error": "Upstream Unavailable", "message": "Symbol search temporarily unavailable" }`; the frontend should display this with `<Message severity="warn" />`.

### API Documentation

- Swagger UI is served at `http://localhost:4000/api/docs` (swagger-jsdoc + swagger-ui-express).
- **Always keep Swagger docs in sync with the code.** Any backend change that affects the API surface must include a matching documentation update:
  - New route → add a `@swagger` JSDoc comment directly above the `router.METHOD(...)` call in the controller file.
  - Deleted route → remove its JSDoc comment.
  - Changed request body, query params, path params, or response shape → update the relevant `@swagger` block.
  - New tag or security scheme → update the `tags` / `securitySchemes` sections in `src/lib/swagger.ts`.
- All routes that require authentication must include `security: [{ bearerAuth: [] }]` in their JSDoc.
- JSDoc comments follow the OpenAPI 3.0 format; see existing routes in `src/controllers/` for examples.

---

## Coding Standards & Preferences

- Use **async/await** over raw Promise chains.
- Use **functional React components** with hooks only — no class components.
- Strict TypeScript: no `any`, use `unknown` + type guards at boundaries.
- Do not leave the codebase with any compilation errors after making changes.
- When changing `prisma/schema.prisma`, generate a new timestamped migration via `prisma migrate dev --name <change>`. Do not edit the existing `20260517140750_init` migration.
- For every new feature, bug fix, or behavior change, create or update unit tests in the same change set.
- Consider the task incomplete until relevant unit tests exist and pass for the modified behavior.
- Backend tests: test controllers with a mocked Prisma client.
- Frontend tests: test hooks with `QueryClientProvider` and mocked Axios; test components with `@testing-library/react`.
- Target at least 80% line coverage for newly added code.
- Do not suggest partial solutions; if a solution is proposed, implement it end to end rather than leaving disconnected backend or frontend pieces behind.
- React Query hooks live in `src/hooks/api.ts`; raw Axios calls live in `src/lib/api-client.ts`.
- Backend route handlers must be wrapped with `asyncHandler()` from `src/middleware/validation.ts`.
- All protected backend routes must use the `authenticateToken` middleware from `src/middleware/auth.ts`.
