# 0015. Staking rewards are imported as monthly parcels

- **Status**: Accepted (transfers and staking income reporting are deferred — see below)
- **Date**: 2026-10-18

## Context

Staking/earn rewards arrive as many tiny credits. A `Position` can never be appended to
([ADR 0001](./0001-one-buy-per-position.md)), and one parcel per reward would flood the
dashboard and the CGT report.

## Decision

- Rewards are aggregated per `(account, venue, asset, Australia/Sydney calendar month)` into
  **one parcel** (`origin = STAKING_REWARD`, `externalRef = KRAKEN:staking:<ASSET>:<YYYY-MM>`)
  on the venue's AUD exchange row, opened on the **last** reward date of the month
  (conservative for the 12-month discount).
- Only **completed** months are applied. Rewards in the current month stay `DEFERRED` and are
  re-attached to the next import once the month has ended.
- Cost base = fair market value at receipt: Kraken's ledger USD value (net of the commission)
  × the RBA-first USD→AUD rate; otherwise daily close × net quantity; otherwise the user enters it.
- **Dust rule**: a completed month worth less than `IMPORT_DUST_THRESHOLD_AUD` (default A$1)
  is skipped (`SKIPPED`, `warning = DUST`), creates no position and is excluded from income.
  A later sale short by no more than the skipped dust quantity raises a non-blocking
  `DUST_SHORTFALL` and is allocated to the coins that exist, with proceeds and fees prorated.
- Reconciliation counts dust and deferred rewards as coins still held.

## Deferred

Crypto transfers (`TRANSFER_OUT`, `TRANSFERRED`, cost-base carry-over) and staking income in
the tax report ship later; until then crypto deposits/withdrawals import as UNSUPPORTED.
