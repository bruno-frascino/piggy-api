---
applyTo: 'src/lib/{cgt-engine,fx-rates,pdf-report}.ts,src/controllers/tax-reports.ts'
---

# Tax reports (ATO Capital Gains) business rules

Full write-up: `docs/ato-capital-gains-methodology.md`. Full ADR: `docs/adr/0002-tax-report-accounts-key-scoping.md`.

- Every `Position` is created with exactly one BUY transaction and never appended to — it IS
  already a discrete CGT parcel (`openDate`/`entryPrice`/`buyFees` = acquisition
  date/cost/incidental costs). Every SELL `Transaction` against it (partial or full) is an
  unambiguous disposal of that parcel. **No FIFO lot reconstruction** is implemented or needed
  — do not add any.
- Reports are scoped by an explicit, user-picked multi-select of Trading Accounts each
  generation (`computeCapitalGainsReport` in `cgt-engine.ts`), never "all accounts" — this
  supports separate declarations (e.g. the user's own accounts vs a spouse's accounts tracked
  under one login). The exact account selection is hashed into `TaxReport.accountsKey`:
  - Unique key: `@@unique([userId, financialYearStartYear, accountsKey])`.
  - Loss carry-forward chain lookups match on the same `accountsKey` only — different account
    combinations must never cross-contaminate carry-forward losses.
- FX conversion to AUD: RBA daily rates first (`fx-rates.ts`, parses
  `https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv`, 2023+ coverage; RBA publishes
  "AUD1=Xforeign" so you must invert — `1/rate` — to get AUD-per-unit). Yahoo Finance
  (`yahoo-finance2`) is fallback only, for pre-2023 dates or RBA gaps. Results are cached in
  `FxRateCache` (`{currency, date}` unique) for performance and reproducibility.
- 50% CGT discount (individuals, held > 12 months) and loss-offset ordering (losses applied to
  non-discount gains first, then discount-eligible gains, before the 50% discount) follow the
  ATO's documented method — see the methodology doc for the full algorithm and disclaimers.
- PDFs are generated via `pdfkit` (`pdf-report.ts`) — no Chromium/Puppeteer, deliberately,
  because the VPS has only 1-2GB RAM. Bytes are stored directly in `TaxReport.pdfData`
  (Postgres `Bytes` column) — no S3/disk storage — so past reports can be re-downloaded via
  `GET /api/tax-reports/:id/download`. Email delivery is intentionally NOT implemented.
- Every report (UI and PDF) must carry a "not professional tax advice — verify with a
  registered tax agent" disclaimer.
