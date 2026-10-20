# MyPortfolio

An installable, privacy-first portfolio dashboard for Groww statements.

## What it does

- Imports current holdings, Stocks Order History, P&L and Capital Gains files locally.
- Replaces only the matching statement category when a newer file is imported.
- Values the trading book with free Yahoo Finance quotes, trying NSE and BSE automatically.
- Shows portfolio value, invested cost, unrealised return, one-day movement, allocation and recent executions.
- Provides detailed local analysis: concentration and HHI, effective diversification, top-position exposure, contributor/detractor attribution, portfolio breadth, FIFO realised results, win rate, payoff ratio, turnover, average holding period and broker P&L/capital-gains references.
- Explains data coverage and does not fabricate Sharpe, beta, volatility or drawdown without a trustworthy daily portfolio history.
- Keeps the entire portfolio in browser storage with backup, restore, privacy mode and clear-data controls.
- Works as a mobile Progressive Web App from GitHub Pages.

## Detailed analysis

The Analysis page includes all 83 metrics from the supplied metrics reference,
with calculated values, methods and explicit missing-data reasons. It provides
growth-of-100, high-water mark, drawdown, daily/excess return, rolling 1/3/12-month
return, 30-session volatility/Sharpe, and 252-session historical VaR curves.
Portfolio and Nifty 50 statistics share the exact same completed daily dates.
Missing interior sessions block daily metrics rather than turning multi-day
changes into daily returns. CAGR requires at least 365 calendar days; historical
tail estimates require 252 daily returns. Undefined ratios remain unavailable.

Two performance sources are deliberately separate:

- **Actual daily unitised NAV**: import `date,nav`, optionally `portfolioValue`
  (rupee account value for turnover). Confirm the NAV excludes external deposits
  and withdrawals. Live quotes do not rewrite imported historical observations.
- **Current-holdings historical model**: adjusted stock-price ratios, anchored at
  the selected window's end and scaled using current quote values. This is an
  explicitly hypothetical backcast of the current book, not past account returns.
  It omits historical trading, cash, fees and taxes. Current weights change when
  quotes refresh.

The benchmark is Yahoo's `^NSEI` **price** index, not Nifty TRI. Dividend-adjusted
stock histories can have a different return basis. The app discloses this instead
of claiming a total-return comparison. See [NSE's explanation](https://www.niftyindices.com/resources/index-concepts/total-return-index).
Risk-free rate and minimum acceptable return are editable assumptions, defaulting
to 0%; daily equivalents use `(1 + annual rate)^(1/252) - 1`.

Current-book component and marginal VaR use a 252-session covariance matrix.
Component contributions sum to zero-mean parametric VaR; marginal amounts are
per unit of portfolio weight at fixed value. Monte Carlo uses 10,000 correlated
normal scenarios, semidefinite Cholesky and a fixed reproducible seed. These are
model estimates, not claims that normal simulation captures all tail risk.

Sector, industry, holding-weight, cap-segment and cumulative-concentration charts
are current snapshots. Broad sectors are seeded from the official NSE Nifty 500
CSV's `Industry` groups, verified on 2026-10-20, with exact ISIN/ticker matching.
This is a dated bundled snapshot, not a live classification service. Unknown
positions stay Unclassified. Detailed industries, cap buckets and daily share
volume are user-verifiable fields. Partial price coverage blocks complete-book
allocation statistics. Stale quotes older than seven days are excluded; retained
quotes keep their timestamps and failed refreshes are not counted as successes.

Optional classification CSV columns:
`symbol,sector,industry,capsegment,averagedailyvolume`.
Cap segment must be `Large`, `Mid` or `Small`; volume is shares/day. Liquidity
assumes 10% participation. Cash must be entered explicitly. Exposure statistics
cover recorded equities and cash, excluding unrecorded derivatives/liabilities.

Optional benchmark constituent CSV columns:
`date,symbol,weight,sector,industry`, with 50 unique constituents on one date,
fractional weights summing to 1 (±0.001). This enables current-snapshot active
share and sector active weights; the supplied snapshot date stays visible.
Industry/sector taxonomies must match. Historical constituent allocation is not
inferred from today's constituents.

P&L/capital-gains imports now retain supported detail rows for monthly and
cumulative realised-rupee curves. A same-lot Nifty comparison requires explicit
purchase/sale dates and purchase cost plus exact Nifty closes. It is a
close-price opportunity estimate, excluding index dividends and trading costs.
Reports are never added together. Re-import reports saved by older app versions
to retain detail rows; older saved summary totals remain readable.

## Record a purchase

Use **Record purchase** from any page to enter an executed broker purchase,
following LotBook's symbol/date/quantity/price/optional-charges flow. This updates
the current holding quantity and weighted purchase cost immediately. No broker
order is placed. Blank charges remain unknown, rather than becoming known zero.
The app does not automatically synchronise LotBook's separate diary.

Later holdings imports explicitly confirm they include pending manual purchases.
Later order-history imports reconcile identical manual executions one-for-one
after confirmation; unmatched manual entries remain. If otherwise identical
same-day entries are separate executions, reconcile them before confirming.
Manual sales are not offered because a holdings snapshot alone cannot establish
remaining FIFO cost accurately.

Prices refresh every five minutes while the app is visible, unless disabled.
Daily history refreshes on initial/missing coverage and after 4pm IST once the
cache is older than 12 hours. Risk curves exclude an in-progress daily candle.
No updates run while the app is closed. Free data and the relay can be delayed
or unavailable; the app shows coverage and failure information.

## Privacy model

The repository and hosted site contain no portfolio, statement or account data. Statement files are parsed inside the user's browser and are not uploaded. Holdings and trades remain in that browser's local storage. A quote refresh sends only a public stock ticker or company name to Yahoo Finance through a read-only relay.

Because browser storage is device-specific, export a backup before clearing site data or changing devices.

## Run locally

```bash
cd frontend
npm install
npm run dev
```

Production checks:

```bash
npm test
npm run build
npm audit
```

## Deployment

GitHub Actions builds `frontend/` and publishes `frontend/dist/` to GitHub Pages. No user data is part of the build.
