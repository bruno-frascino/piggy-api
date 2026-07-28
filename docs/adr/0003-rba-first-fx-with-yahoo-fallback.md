# 0003. RBA-first FX conversion with Yahoo Finance fallback

- **Status**: Accepted
- **Date**: 2026-07-24 (retro-documented 2026-07-28)

## Context

CGT calculations for non-AUD-denominated assets need a historical AUD conversion rate for
both the acquisition and disposal dates. The rate source needs to be authoritative (for a
tax document) and cover as much history as practical.

## Decision

`piggy-api/src/lib/fx-rates.ts` fetches and parses the RBA's official daily FX CSV
(`https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv`) as the primary source,
which covers 2023 onward. The RBA publishes rates as "AUD1 = X foreign", so the parser
inverts them (`1 / rate`) to get AUD-per-foreign-unit. Yahoo Finance
(`yahoo-finance2`) historical rates are used only as a fallback — for dates before 2023 or
currencies/dates the RBA feed doesn't cover. Every resolved rate is cached in `FxRateCache`
(unique on `{currency, date}`) for performance and so a regenerated report is reproducible.

## Consequences

- Reports generated for the same dates will always reproduce the same FX rate once cached,
  even if the upstream RBA/Yahoo data changes later.
- Any currency/date combination the RBA feed doesn't cover silently falls back to Yahoo —
  if Yahoo also lacks it, report generation should fail loudly rather than guess a rate.
- If RBA changes their CSV format or URL, `fx-rates.ts` parsing breaks and needs updating —
  there's no automated schema validation on that feed today.
