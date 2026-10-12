# 0012. Demo trading accounts are immutable and excluded from tax and aggregates

- **Status**: Accepted
- **Date**: 2026-10-09

## Context

Users want somewhere to practise — open and close positions without risking real money or
polluting their real records. Positions in such a "paper" account behave exactly like real
ones, but they must never end up in an ATO capital gains report (they are not real
disposals) and they must not distort the "All accounts" views of History and Statistics,
which describe the user's real portfolio.

A mutable flag would be dangerous: flipping a real account to demo (or the reverse) after
a tax report was generated would silently change what that report's `accountsKey` refers
to, and would retroactively change the aggregates users rely on.

## Decision

- `TradingAccount.isDemo Boolean @default(false)`. It is chosen at creation
  (`POST /api/accounts`) and is **immutable**: `PATCH /api/accounts/:id` returns `400` if
  `isDemo` is present in the body. Implicit account creation (`resolveTradingAccount`,
  used when a position is opened by `accountName`) always creates real accounts.
- Demo accounts are **never eligible for tax reports**. `computeCapitalGainsReport` throws
  (surfacing as `400` from `POST /api/tax-reports/generate`) if any selected account is
  demo, and the disposals query additionally filters `account: { isDemo: false }`
  defensively. This is consistent with ADR 0002: the explicit account multi-select
  remains the only scoping mechanism, it simply cannot contain demo accounts.
- Any endpoint that aggregates positions, close events or snapshots across accounts
  **without an explicit account filter** adds `account: { isDemo: false }`: all
  `/api/statistics/*`, `GET /api/positions`, and `GET /api/positions/close-events`.
  When the caller names an account (`accountId` / `accountIds`), the filter is honoured as
  given and a demo account is returned. `GET /api/positions/close-events` gained an
  optional `accountId` query parameter so the History page can request a demo account's
  history explicitly.
- Endpoints that already require an `accountId` (`/api/portfolio/*`) are unaffected.
- Otherwise demo accounts are ordinary: same dialogs, same position lifecycle, same
  deletion/closing rules.

## Consequences

- One extra relation filter on cross-account queries; cheap with the existing
  `userId`/`accountId` indexes.
- A user who wants a real account's history to include demo trades cannot — by design.
- `TradingAccount.isDemo` is mirrored by hand in `piggy-fe/src/lib/types.ts` (ADR 0007).
