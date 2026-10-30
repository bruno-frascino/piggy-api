# 0013. Exchange imports allocate sells to parcels by user-confirmed specific identification

- **Status**: Accepted
- **Date**: 2026-10-18

## Context

Crypto exchange exports (starting with Kraken) contain buys and sells of the same coin with no
link between a sell and the buy it disposes of. [ADR 0001](./0001-one-buy-per-position.md)
makes each `Position` one BUY = one CGT parcel and forbids lot reconstruction in the CGT
engine, so imports must decide which parcel(s) each sell closes.

## Decision

- Each imported order becomes one `Position` (`origin = IMPORT_TRADE`, one BUY transaction);
  imports never append to an existing Position.
- Each imported sell is **allocated** to one or more eligible parcels at import time: the
  planner pre-fills a FIFO suggestion, the user may reassign to any eligible parcel (ATO
  specific identification) on the review screen, and the committer writes one SELL
  `Transaction` per allocated parcel.
- `cgt-engine.ts` is unchanged in principle: it still treats every SELL against a Position as
  an unambiguous disposal and does no lot matching. It derives the parcel's original quantity
  from the BUY transaction (not `totalBuyValue / entryPrice`) so tiny crypto parcels prorate
  buy fees correctly.
- Eligible parcels: same account and base asset, any exchange row of the same venue, opened
  on or before the sell, with remaining quantity.

## Consequences

- The "no FIFO" statement in ADR 0001 stays true for the engine; the allocation decision lives
  in the import pipeline and is recorded in the resulting transactions.
- Re-importing is idempotent through `Position.externalRef` / `Transaction.brokerRef`.
