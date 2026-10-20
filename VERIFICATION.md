# Detailed analysis verification

## Quote-refresh correction · 2026-10-20

- Reused LotBook's batch quote implementation from commit
  `f06e5b50e9102174fb7e2b7c041f0fdf3795d441`; adapter changes preserve ticker and
  previous close and honour explicit exchange selection.
- Reproduced a 19-holding refresh with a live public synthetic stock list,
  including LICI, CHEMCON, GRSE and HDFCBANK: **19 verified quotes, zero errors,
  two sequential requests, maximum concurrency one**, all with previous close.
  No private portfolio quantities, prices or statements were used.
- All **38 automated checks** pass, including the exact 3-checked / 16-cached
  screenshot scenario, 19/70-holding batch counts, rate-limit retry, nested URL
  ampersands, renamed tickers, BSE identity checks, cached/missing/expired price
  reporting, India-time scheduling, shared transport pacing, and history retry
  cooldown.
- Price refresh no longer starts a ten-year history request per holding.
  Historical requests are sequential, paced and loaded separately on Analysis.
- Both fetched and market timestamps are validated. The UI says saved prices,
  with explicit last-check counts, rather than calling all cached quotes recent.

## Passed

- Production TypeScript / Vite build.
- 24 automated checks across existing imports and analytics, new numerical
  calculations, manual-purchase reconciliation, broker detail rows, cash and
  classification handling, and market-data identity/freshness.
- Hand-calculated total returns, drawdown depth/duration/recovery, concentration,
  NAV alignment and benchmark excess returns.
- 252-observation risk gating and undefined zero-denominator outcomes.
- Seeded Gaussian Monte Carlo checked against the known one-asset normal VaR
  range; singular perfectly correlated covariance supported; non-PSD rejected.
- No merging across missing interior benchmark sessions.
- Current-quote changes affect the hypothetical current-book model without
  rewriting actual imported NAV.
- Official NSE Nifty 500 classification CSV fetched and inspected; exact
  ISIN/ticker matching only.
- Existing public quote relay successfully returned INR `^NSEI` ten-year daily
  history in a read-only endpoint smoke check.

## Still requires browser verification

The available in-app browser rejected both local preview addresses
(`127.0.0.1:5173` and `localhost:5173`) with `ERR_BLOCKED_BY_CLIENT`. Interactive
layout, chart tooltips, mobile appearance and dialog keyboard behavior have not
been visually verified. No private portfolio data was used in tests.

## Data-dependent limitations

Actual daily portfolio risk needs daily unitised NAV, not P&L totals. The current
holdings model is labelled hypothetical. Broker detail comparisons require report
columns for buy/sell dates and cost. NSE sector data is a dated snapshot; finer
classifications, benchmark constituent weights and liquidity inputs require
verified user data. Market-data availability and cadence are best effort and
limited to the visible running app. This change does not guarantee exchange-real-
time prices, reconstruct missing cash flows/corporate actions, or replace broker
tax reports.
