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
(`userId + financialYearStartYear + accountsKey + version`) and its loss carry-forward chain
lookup. See ADR 0002.

**Report revision** — Tax reports are append-only. Regenerating a report for the same
`(financialYearStartYear, accountsKey)` stores a new row with `version + 1` and stamps
`supersededAt` on the previous one, so a PDF that was already lodged is never overwritten.
Exactly one revision per key has `supersededAt = null` — the **current** revision. See ADR 0010.

**Superseded** — A tax report revision that a later regeneration replaced. Still readable and
downloadable, excluded from listings by default, and never used for carry-forward loss chaining.

**Grace period** — The 30 days between a user requesting account deletion (`User.deletedAt`)
and the data actually being erased (`User.purgeAfter`). Signing in during this window offers a
restore. See ADR 0011.

**Purge** — The irreversible hard delete of a soft-deleted user and everything cascading from
them, performed by `yarn db:purge-deleted-users` once `purgeAfter` has passed. If that job is
not scheduled, nothing is ever actually erased.

**Financial year** — Australian tax year, 1 July – 30 June. `TaxReport.financialYearStartYear`
is the starting calendar year (e.g. FY2025 = 1 Jul 2025 – 30 Jun 2026 → stored as `2025`).

**Exchange suffix** — The ticker suffix identifying which exchange an asset trades on (e.g.
`.AX` for ASX), used to disambiguate the same symbol across markets when resolving an
`Asset` from a stock search result.

**Drawdown (current vs max)** — `priceDrawdownPct` is the live, instantaneous
price-vs-entry drawdown; `maxDrawdownPercent` is the historical worst drawdown for a
`Position`, which only ratchets upward and persists server-side. They are always shown as
two separate columns in `HoldingsTable.tsx` — never conflate them.

**Max run-up (peak gain)** — The opposite of drawdown (a.k.a. MFE, maximum favorable
excursion): `maxRunUpPercent` is the highest gain vs entry price a `Position` ever reached
while held, e.g. 15% even if it was later closed at 8%. Like `maxDrawdownPercent` it only
ratchets upward and persists server-side; for closed positions the historical search is
bounded by the close date.

**Trading account** — A `TradingAccount` row; the top-level grouping the dashboard is
organized around ("account-first" UX). A user can have several (e.g. personal vs a
spouse's), each with its own set of positions and its own eligibility for tax report
account-selection.

**Demo account** — A `TradingAccount` with `isDemo = true`, chosen at creation and immutable.
Used for practice: positions open and close normally, but the account is never eligible for
tax reports and is excluded from "All accounts" aggregates (History, Statistics); its data
shows only when the account is explicitly selected. See `docs/adr/0012-demo-trading-accounts.md`.

**Venue** — A crypto exchange operator (Kraken, Binance, Coinbase). Each venue has one
`Exchange` row per quote currency (e.g. `KRAKEN` = AUD, `KRAKEN_USD` = USD) so every Exchange
keeps a single currency. See `docs/adr/0014-crypto-venues-split-by-quote-currency.md`.

**Position origin** — `Position.origin`: `MANUAL` (entered by the user), `IMPORT_TRADE`
(created from an exchange import of one order) or `STAKING_REWARD` (monthly staking parcel).
`Position.externalRef` holds the source order/month key for imported parcels (`""` for manual)
and is part of the Position unique key.

**Allocation** — The user-confirmed mapping of an imported SELL to the parcels it disposes of
(`[{ positionId, quantity }]`), pre-filled with a FIFO suggestion. See
`docs/adr/0013-exchange-imports-sell-allocation.md`.

**Import batch / Imported event** — One upload of exchange CSVs (`ImportBatch`) and the
normalised rows parsed from it (`ImportedEvent`: BUY, SELL, STAKING_REWARD, UNSUPPORTED…).
Nothing touches positions until the batch is committed. Events are de-duplicated per user by
`(source, externalId)`, so re-uploading overlapping files is safe.

**Staking parcel** — A `Position` with `origin = STAKING_REWARD` holding one calendar month
(Australia/Sydney) of one asset's rewards, valued at receipt, opened on the last reward date.
Months below the dust threshold are skipped; the current month is deferred. See
`docs/adr/0015-crypto-staking-parcels.md`.
