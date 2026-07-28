# Glossary

Domain terms used throughout `piggy-api` and `piggy-fe`. See `docs/adr/` for the reasoning
behind decisions referenced here.

**Position** — A single holding of an asset, created with exactly one BUY transaction
(`openDate`, `entryPrice`, `buyFees`) and never appended to. See ADR 0001.

**Parcel** — Tax/CGT term for a distinct acquisition lot with its own cost base and
acquisition date. In this system, every `Position` IS a parcel (one BUY = one parcel) —
there's no separate "Parcel" entity in the schema.

**Disposal** — A SELL `Transaction` against a `Position` (partial or full). Because each
`Position` is already a single parcel, every disposal unambiguously reduces/closes that one
parcel — no FIFO/lot-matching is needed.

**Close event** — The record created when a `Position` transitions to `PARTIAL` or `CLOSED`
via a SELL transaction; surfaced to the frontend via `GET /positions/close-events` and shown
on the History page.

**accountsKey** — A deterministic hash of a sorted, user-selected set of Trading Account IDs,
stored on `TaxReport`. Scopes both the report's uniqueness
(`userId + financialYearStartYear + accountsKey`) and its loss carry-forward chain lookup.
See ADR 0002.

**Financial year** — Australian tax year, 1 July – 30 June. `TaxReport.financialYearStartYear`
is the starting calendar year (e.g. FY2025 = 1 Jul 2025 – 30 Jun 2026 → stored as `2025`).

**Exchange suffix** — The ticker suffix identifying which exchange an asset trades on (e.g.
`.AX` for ASX), used to disambiguate the same symbol across markets when resolving an
`Asset` from a stock search result.

**Drawdown (current vs max)** — `priceDrawdownPct` is the live, instantaneous
price-vs-entry drawdown; `maxDrawdownPercent` is the historical worst drawdown for a
`Position`, which only ratchets upward and persists server-side. They are always shown as
two separate columns in `HoldingsTable.tsx` — never conflate them.

**Trading account** — A `TradingAccount` row; the top-level grouping the dashboard is
organized around ("account-first" UX). A user can have several (e.g. personal vs a
spouse's), each with its own set of positions and its own eligibility for tax report
account-selection.
