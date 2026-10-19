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
