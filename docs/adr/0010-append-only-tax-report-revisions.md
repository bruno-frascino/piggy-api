# 0010. Tax reports are append-only revisions, not overwritten in place

- **Status**: Accepted
- **Date**: 2026-09-26

## Context

`POST /api/tax-reports/generate` originally upserted a single `TaxReport` row per
`(userId, financialYearStartYear, accountsKey)`. Regenerating a report for the same
financial year and account selection recomputed the figures and replaced the stored
PDF, line items and totals in place.

That is wrong for the artefact's actual purpose. A capital gains report is a record of
what was declared. Once a user has lodged a return using a generated PDF, that exact
document matters: the ATO expects capital gains records to be retained for five years
after the disposal, and Truffles may hold the only copy. Under the upsert design, editing
a position months later and hitting "Generate report" silently destroyed the evidence of
what was actually filed, with no audit trail and no way back.

The related problem is that regeneration is cheap to trigger and expensive to store.
`TaxReport.pdfData` holds the PDF bytes in-row, so naively appending a revision on every
click would grow the table without bound for no informational gain.

## Decision

Tax reports are append-only.

- The uniqueness constraint becomes
  `@@unique([userId, financialYearStartYear, accountsKey, version])`, so one
  `(FY, accountsKey)` declaration can hold many revisions.
- Regeneration stamps `supersededAt` on the current revision and inserts a new row at
  `version + 1`, inside a transaction. Prior revisions are retained and remain
  downloadable via `GET /api/tax-reports/:id/download` (filenames get a `-v{n}` suffix
  from v2 onward).
- **Invariant**: exactly one revision per `(userId, financialYearStartYear, accountsKey)`
  has `supersededAt = null`. That row is the current report. This is enforced in
  application code in `tax-reports.ts`, not by a database constraint — Postgres could
  express it as a partial unique index, but Prisma cannot model one, and adding it via raw
  SQL would be reported as schema drift on every subsequent `prisma migrate dev`.
- A `contentHash` column (sha256 over the aggregate figures plus line items) makes
  regeneration idempotent: if nothing changed, the existing revision is returned and no
  second PDF is rendered or stored.
- `GET /api/tax-reports` returns current revisions only; `?includeSuperseded=true` returns
  the full history.
- Carry-forward loss chaining in `cgt-engine.ts` filters `supersededAt: null`, so the chain
  always follows the current revision of the prior year and never a replaced one.
- Deleting the current revision promotes the highest remaining revision back to current,
  so a declaration can never be left with no current row (which would silently break the
  loss chain).

## Consequences

- Storage grows with genuine regenerations. This is the intended trade: the `contentHash`
  guard means only reports whose _figures actually changed_ cost another PDF, and that is
  exactly the case worth keeping a record of.
- `GET /tax-reports/position-usage` considers current revisions only. Flagging line items
  in a revision the user already replaced as "stale" would be noise.
- The reports UI has to distinguish revisions (`v2` badge, `Superseded` badge, and a
  "Show earlier revisions" toggle) — a plain list of reports is no longer sufficient.
- The `accountsKey` uniqueness described in ADR 0002 still holds, now with `version`
  appended to the constraint.
- Still unresolved: `TaxReport.accountIds` references accounts by ID with no foreign key,
  so a deleted Trading Account orphans the label a report displays. Deleting an account
  that appears in any generated report is currently refused for this reason. Snapshotting
  account _names_ onto the report at generation time would remove the coupling.
