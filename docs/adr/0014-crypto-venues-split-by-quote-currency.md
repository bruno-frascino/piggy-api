# 0014. Crypto venues are split into one Exchange row per quote currency

- **Status**: Accepted
- **Date**: 2026-10-18

## Context

The dashboard tabs, CGT FX conversion, statistics, history page and `mappers.ts` all assume
**one Exchange = one currency**. Crypto venues trade the same coin against several quote
currencies (Kraken BTC/AUD and BTC/USD).

## Decision

Model each venue as one `Exchange` row per supported quote currency (AUD, USD):
`KRAKEN` (AUD), `KRAKEN_USD`, `BINANCE` (USD), `BINANCE_AUD`, `COINBASE` (USD),
`COINBASE_AUD`. Existing codes keep their meaning. The registry lives in
`src/lib/crypto/venues.ts`; `GET /api/exchanges` exposes `isCrypto` derived from it.
Crypto `Asset.symbol` is `BASE-QUOTE` (e.g. `BTC-AUD`), matching Yahoo Finance.

## Consequences

- No multi-currency Exchange handling is needed anywhere downstream.
- Coins are fungible within a venue, so sells may draw on parcels from any of the venue's
  exchange rows (`sameVenueExchangeCodes`).
- `normalizeCode` in `exchange-sync.ts` allows codes up to 20 characters.
- Display names read `Kraken (AUD)`, `Kraken (USD)`, etc.

## Manual Kraken purchases

The dashboard remains account-first and position-first. Add Position offers Shares / ETFs
and Crypto; crypto purchases choose Kraken and a payment currency (AUD or USD), then a coin.
Users do not create an Exchange or type internal symbols. Common coin names and Kraken ticker
aliases (including XBT -> BTC) resolve to a canonical market through authenticated
`GET /api/exchanges/kraken/assets?quote=AUD&q=bitcoin`. Names not in the common-name dictionary
remain searchable by ticker. The public spot catalogue is cached for ten minutes; it is not
a guarantee of regional trading eligibility or a complete archive of delisted markets.

Creating or changing a Kraken instrument validates its market and quote currency. Crypto venues
infer `CRYPTO` when omitted; an explicit incompatible classification is rejected. An unchanged
historical instrument remains editable without an upstream catalogue request. Catalogue outages
return 503 rather than an empty success. Historical CSV imports retain their existing path.

Only a successful save switches the dashboard to the new purchase's venue. Both OPEN and PARTIAL
parcels participate in discovery, and the client paginates discovery and holdings. Post-import
links select the imported account and prefer its Kraken venue; History links include all dates.

Quantity and per-unit price inputs retain up to twelve decimal places, fees up to eight, matching
the storage precision. Fiat totals remain stored at their existing cent precision. Closing tiny
parcels uses scale-relative floating-point tolerance, not an absolute epsilon that could erase a
small balance. Live crypto quotes use the crypto pricing pipeline with AUD FX fallback; missing
quotes are explicitly identified in the UI and daily changes remain unavailable.

Each manual purchase is a separate BUY parcel. Manual entries and later CSV imports are not
silently merged: the form warns users to import instead if those purchases will be in a CSV.
