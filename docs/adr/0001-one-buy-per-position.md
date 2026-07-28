# 0001. One BUY transaction per Position — no FIFO lot reconstruction

- **Status**: Accepted
- **Date**: 2026-07-24 (retro-documented 2026-07-28)

## Context

Capital gains reporting needs to match disposals (sells) back to specific acquisition
lots/parcels with their own cost base and acquisition date, per ATO rules. Many brokerage
systems solve this with FIFO (or specific-identification) lot tracking across many BUY
transactions accumulated into one holding.

## Decision

In this system, a `Position` is created with exactly **one** BUY transaction
(`openDate`/`entryPrice`/`buyFees`) and is never appended to — there is no "add units to an
existing position" flow anywhere in the UI or API. Each `Position` therefore already IS a
discrete CGT parcel. Every SELL `Transaction` recorded against it (partial or full close) is
an unambiguous disposal of that specific parcel — there is no ambiguity to resolve and no
FIFO/lot-matching algorithm to implement.

If a user buys more of the same symbol, they open a **new, separate** `Position`.

## Consequences

- Simplifies the CGT engine (`piggy-api/src/lib/cgt-engine.ts`) enormously — no lot queue,
  no partial-consumption bookkeeping across positions.
- The dashboard will show multiple positions for the same symbol/exchange if bought at
  different times — this is intentional, not a bug, and lets weekly velocity / drawdown
  metrics stay per-parcel meaningful.
- If a future requirement needs true FIFO/lot-blending, it would need a new data model
  concept (e.g. a Lot entity separate from Position) — this ADR should be revisited then.
