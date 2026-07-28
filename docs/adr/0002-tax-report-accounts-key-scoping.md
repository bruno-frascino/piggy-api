# 0002. Tax reports scoped by explicit account multi-select (`accountsKey`)

- **Status**: Accepted
- **Date**: 2026-07-24 (retro-documented 2026-07-28)

## Context

A single login can hold multiple `TradingAccount`s that may need to be declared separately
for tax purposes — for example, the user's own accounts vs a spouse's accounts tracked under
one shared login. A naive "generate a report for all my accounts" design would conflate
these into one figure the user can't split back apart, and carry-forward losses from one
grouping could leak into an unrelated grouping.

## Decision

Every tax report generation requires an explicit, user-picked multi-select of Trading
Accounts (never an implicit "all accounts"). The exact set of selected account IDs is
sorted, joined, and hashed into `TaxReport.accountsKey`. This key is used both as part of
the uniqueness constraint (`@@unique([userId, financialYearStartYear, accountsKey])`, so
regenerating for the same account combo + year upserts rather than duplicating) and as the
lookup key for the prior-year report when chaining carry-forward losses.

## Consequences

- Different account combinations never share a carry-forward loss chain, even under the
  same user — this is correct behavior, not a limitation, given the "separate declarations"
  use case.
- The report list UI must show which accounts each report covers (not just a date), since
  a user can have multiple reports for the same financial year with different account sets.
- If the account set used for a recurring declaration changes (e.g. an account is closed),
  the carry-forward chain for that exact combination stops — this is expected; a new
  combination starts its own chain from zero.
