import { useMemo, useRef, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { analysePortfolio } from "./analytics";
import { parseImport } from "./imports";
import { refreshQuotes } from "./market";
import { blankState, downloadBackup, loadState, restoreBackup, saveState } from "./storage";
import type { ImportKind, PortfolioState } from "./types";

type View = "overview" | "analysis" | "holdings" | "activity" | "import" | "settings";
const COLORS = ["#7457ff", "#15c7a3", "#ff8a5b", "#3f8cff", "#f6c85f", "#dd5b9f"];
const money = (value: number, hidden = false) => hidden ? "••••" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
const number = (value: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 4 }).format(value);
const percent = (value: number, hidden = false) => hidden ? "••••" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const plainPercent = (value: number, hidden = false) => hidden ? "••••" : `${value.toFixed(2)}%`;
const ratioText = (value: number) => Number.isFinite(value) && value > 0 ? `${value.toFixed(2)}×` : "—";

function save(next: PortfolioState, setState: (state: PortfolioState) => void) {
  saveState(next);
  setState(next);
}

export default function App() {
  const [state, setState] = useState(loadState);
  const [view, setView] = useState<View>("overview");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"value" | "return" | "name">("value");
  const [filter, setFilter] = useState<"all" | "profit" | "loss">("all");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [pendingClear, setPendingClear] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const analysis = useMemo(() => analysePortfolio(state.holdings, state.quotes, state.trades), [state.holdings, state.quotes, state.trades]);
  const rows = analysis.positions;
  const totals = {
    invested: analysis.totals.invested,
    current: analysis.totals.currentValue,
    pnl: analysis.totals.unrealised,
    day: analysis.totals.dayPnl,
    returnPct: analysis.totals.returnPct,
    quoted: analysis.totals.quoted,
  };
  const tradeStats = analysis.trading;
  const visible = useMemo(() => rows
    .filter(row => !search || `${row.symbol} ${row.name}`.toLowerCase().includes(search.toLowerCase()))
    .filter(row => filter === "all" || (filter === "profit" ? row.pnl >= 0 && !!row.quote : row.pnl < 0 && !!row.quote))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "return" ? b.returnPct - a.returnPct : b.value - a.value),
  [rows, search, filter, sort]);

  const allocation = useMemo(() => rows.filter(row => row.quote).map(row => ({ name: row.symbol, value: row.value })).sort((a, b) => b.value - a.value), [rows]);
  const insights = useMemo(() => {
    const notes: string[] = [];
    if (!state.holdings.length) return notes;
    notes.push(`${analysis.totals.quoted} of ${state.holdings.length} holdings are priced; ${analysis.totals.missing} are excluded from market-value analytics.`);
    notes.push(`${analysis.concentration.level} concentration: the three largest priced positions represent ${state.privacy ? "••••" : `${analysis.concentration.top3.toFixed(1)}%`} of current value.`);
    if (analysis.contributors[0]) notes.push(`${analysis.contributors[0].symbol} is the largest unrealised contributor at ${money(analysis.contributors[0].pnl, state.privacy)}.`);
    const worst = analysis.contributors[analysis.contributors.length - 1];
    if (worst && worst.pnl < 0) notes.push(`${worst.symbol} is the largest unrealised detractor at ${money(worst.pnl, state.privacy)}.`);
    if (analysis.trading.closedSales.length) notes.push(`FIFO trading outcomes show a ${state.privacy ? "••••" : `${analysis.trading.winRate.toFixed(1)}%`} win rate across ${analysis.trading.closedSales.length} matched sales.`);
    return notes;
  }, [analysis, state.holdings.length, state.privacy]);

  async function importFile(kind: ImportKind, file?: File) {
    if (!file) return;
    setBusy(true); setNotice("");
    try {
      const result = await parseImport(file, kind);
      const importedAt = new Date().toISOString();
      const next: PortfolioState = { ...state, imports: { ...state.imports } };
      if (kind === "holdings") {
        const tradeSymbols = new Map(state.trades.filter(trade => trade.isin).map(trade => [trade.isin, trade.symbol]));
        next.holdings = (result.holdings || []).map(holding => ({
          ...holding,
          symbol: holding.isin && tradeSymbols.has(holding.isin) ? tradeSymbols.get(holding.isin)! : holding.symbol,
        }));
        next.quotes = {};
        next.imports.holdings = { fileName: file.name, importedAt, rows: next.holdings.length };
      } else if (kind === "trades") {
        next.trades = result.trades || [];
        const tradeSymbols = new Map(next.trades.filter(trade => trade.isin).map(trade => [trade.isin, trade.symbol]));
        next.holdings = next.holdings.map(holding => ({
          ...holding,
          symbol: holding.isin && tradeSymbols.has(holding.isin) ? tradeSymbols.get(holding.isin)! : holding.symbol,
        }));
        next.imports.trades = { fileName: file.name, importedAt, rows: next.trades.length };
      } else {
        const summary = result.summary || null;
        if (kind === "pnl") next.pnl = summary;
        else next.capitalGains = summary;
        next.imports[kind] = { fileName: file.name, importedAt, rows: summary ? 1 : 0 };
      }
      save(next, setState);
      setNotice(`${file.name} imported locally. Existing ${kind} data on this device was replaced.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import failed.");
    } finally { setBusy(false); }
  }

  async function updatePrices() {
    if (!state.holdings.length) return setNotice("Import a current Holdings Statement first.");
    setBusy(true); setProgress(`Checking 0 of ${state.holdings.length}`);
    try {
      const result = await refreshQuotes(state.holdings, state.quotes, (done, total) => setProgress(`Checking ${done} of ${total}`));
      save({ ...state, quotes: result.quotes }, setState);
      setNotice(result.errors.length
        ? `${result.updated} prices updated. ${result.errors.length} could not be verified: ${result.errors.slice(0, 4).join(", ")}${result.errors.length > 4 ? "…" : ""}`
        : `All ${result.updated} market prices updated.`);
    } catch {
      setNotice("The free quote relay is temporarily unavailable. Your last saved prices were kept.");
    } finally { setBusy(false); setProgress(""); }
  }

  if (!state.profile) {
    return <main className="welcome">
      <div className="orb one" /><div className="orb two" />
      <section className="welcome-card">
        <div className="brand-mark">MP</div>
        <p className="kicker">PRIVATE PORTFOLIO INTELLIGENCE</p>
        <h1>Your investments,<br />finally in focus.</h1>
        <p>Import Groww statements, follow live market values and understand your trading book. Everything personal stays in this browser.</p>
        <form onSubmit={event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const name = String(form.get("name") || "").trim();
          if (name) save({ ...state, profile: name }, setState);
        }}>
          <label>Your name<input name="name" required maxLength={60} placeholder="Enter your name" autoFocus /></label>
          <button>Enter MyPortfolio <span>→</span></button>
        </form>
        <div className="privacy-line"><span>●</span> No account. No broker login. No cloud database.</div>
      </section>
    </main>;
  }

  const nav: { id: View; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "◈" },
    { id: "analysis", label: "Analysis", icon: "⌁" },
    { id: "holdings", label: "Holdings", icon: "▥" },
    { id: "activity", label: "Activity", icon: "↗" },
    { id: "import", label: "Import", icon: "⇧" },
    { id: "settings", label: "Settings", icon: "☰" },
  ];

  return <div className="app-shell">
    <header className="topbar">
      <button className="logo-button" onClick={() => setView("overview")}><span>MP</span><b>MyPortfolio</b></button>
      <div className="top-actions">
        <button className="privacy-button" onClick={() => save({ ...state, privacy: !state.privacy }, setState)} aria-pressed={state.privacy}>
          {state.privacy ? "◉ Hidden" : "◎ Hide"}
        </button>
        <span className="avatar">{state.profile[0].toUpperCase()}</span>
      </div>
    </header>

    <aside className="sidebar">
      <div className="side-brand"><span>MP</span><div><b>MyPortfolio</b><small>LOCAL ANALYTICS</small></div></div>
      <nav>{nav.map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i>{item.icon}</i>{item.label}</button>)}</nav>
      <div className="local-note"><span>●</span><b>Local save</b><small>Your files never reach GitHub.</small></div>
    </aside>

    <main className="workspace">
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}

      {view === "overview" && <>
        <div className="hero-row">
          <div><p className="kicker">GOOD {new Date().getHours() < 12 ? "MORNING" : new Date().getHours() < 18 ? "AFTERNOON" : "EVENING"}, {state.profile.toUpperCase()}</p><h1>Your portfolio at a glance</h1><p>{totals.quoted} of {state.holdings.length} holdings have a recent market price.</p></div>
          <button className="primary" onClick={updatePrices} disabled={busy}>{busy ? progress || "Updating…" : "↻ Update live prices"}</button>
        </div>
        {!state.holdings.length && <section className="empty-hero"><div className="empty-art">⇧</div><h2>Start with your current holdings</h2><p>Upload the Groww Holdings Statement. It is read on this device and immediately becomes your private dashboard.</p><button className="primary" onClick={() => setView("import")}>Import statements</button></section>}
        {!!state.holdings.length && <>
          <section className="metric-grid">
            <article className="metric violet"><span>Portfolio value</span><strong>{money(totals.current, state.privacy)}</strong><small>{totals.quoted < rows.length ? `Partial · ${rows.length - totals.quoted} awaiting price` : "At latest available prices"}</small></article>
            <article className="metric mint"><span>Invested</span><strong>{money(totals.invested, state.privacy)}</strong><small>From current holdings statement</small></article>
            <article className={`metric ${totals.pnl >= 0 ? "positive" : "negative"}`}><span>Unrealised return</span><strong>{money(totals.pnl, state.privacy)}</strong><small>{percent(totals.returnPct, state.privacy)}</small></article>
            <article className={`metric ${totals.day >= 0 ? "positive" : "negative"}`}><span>1D movement</span><strong>{money(totals.day, state.privacy)}</strong><small>Where previous close is available</small></article>
          </section>
          <section className="dashboard-grid">
            <article className="panel chart-panel"><div className="panel-title"><div><p className="kicker">ALLOCATION</p><h2>What you own</h2></div><span>{rows.length} holdings</span></div>
              <div className="donut-wrap"><ResponsiveContainer width="100%" height={260}><PieChart><Pie data={allocation.slice(0, 12)} dataKey="value" nameKey="name" innerRadius={70} outerRadius={108} paddingAngle={2}>{allocation.slice(0, 12).map((_, index) => <Cell key={index} fill={COLORS[index % COLORS.length]} />)}</Pie><Tooltip formatter={(value) => money(Number(value ?? 0), state.privacy)} /></PieChart></ResponsiveContainer><div className="donut-center"><b>{allocation.length}</b><small>priced</small></div></div>
            </article>
            <article className="panel movers"><div className="panel-title"><div><p className="kicker">SIGNAL</p><h2>Largest positions</h2></div><button onClick={() => setView("holdings")}>See all</button></div>
              {rows.filter(row => row.quote).sort((a, b) => b.value - a.value).slice(0, 5).map(row => <div className="mini-row" key={row.symbol}><span className="stock-badge">{row.symbol.slice(0, 2)}</span><div><b>{row.symbol}</b><small>{row.name}</small></div><strong>{money(row.value, state.privacy)}<small className={row.pnl >= 0 ? "gain" : "loss"}>{percent(row.returnPct, state.privacy)}</small></strong></div>)}
            </article>
          </section>
        </>}
      </>}

      {view === "analysis" && <>
        <div className="hero-row analysis-hero"><div><p className="kicker">PORTFOLIO INTELLIGENCE</p><h1>Detailed analysis</h1><p>Performance, concentration, attribution and trading behaviour calculated locally from your latest imports.</p></div><button className="primary" onClick={updatePrices} disabled={busy}>{busy ? progress || "Updating…" : "↻ Refresh analysis prices"}</button></div>
        {!state.holdings.length && <section className="empty-hero"><div className="empty-art">⌁</div><h2>Analysis begins with your holdings</h2><p>Import the current Holdings Statement and Order History to build a complete analytical view.</p><button className="primary" onClick={() => setView("import")}>Import statements</button></section>}
        {!!state.holdings.length && <>
          <section className="metric-grid analysis-metrics">
            <article className={`metric ${analysis.totals.unrealised >= 0 ? "positive" : "negative"}`}><span>Total unrealised result</span><strong>{money(analysis.totals.unrealised, state.privacy)}</strong><small>{percent(analysis.totals.returnPct, state.privacy)} on priced cost</small></article>
            <article className={`metric ${analysis.totals.dayPnl >= 0 ? "positive" : "negative"}`}><span>Latest market movement</span><strong>{money(analysis.totals.dayPnl, state.privacy)}</strong><small>{percent(analysis.totals.dayPct, state.privacy)} versus previous close</small></article>
            <article className="metric violet"><span>Effective diversification</span><strong>{state.privacy ? "••••" : analysis.concentration.effectiveHoldings.toFixed(1)}</strong><small>{analysis.positions.length} holdings · HHI {state.privacy ? "••••" : analysis.concentration.hhi.toFixed(3)}</small></article>
            <article className={`metric ${analysis.trading.realised >= 0 ? "positive" : "negative"}`}><span>FIFO realised estimate</span><strong>{state.trades.length ? money(analysis.trading.realised, state.privacy) : "—"}</strong><small>{analysis.trading.closedSales.length} matched sales · {analysis.trading.unknownChargeTrades} with unknown charges</small></article>
          </section>

          <section className="analysis-grid">
            <article className="panel analysis-card"><div className="panel-title"><div><p className="kicker">DIAGNOSIS</p><h2>What the numbers say</h2></div><span>{analysis.concentration.level}</span></div><div className="insight-list">{insights.map((insight, index) => <div key={index}><i>{index + 1}</i><p>{insight}</p></div>)}</div></article>
            <article className="panel analysis-card"><div className="panel-title"><div><p className="kicker">CONCENTRATION</p><h2>How exposed you are</h2></div><span>{analysis.concentration.level}</span></div><div className="concentration-list">{[
              ["Largest holding", analysis.concentration.top1],
              ["Top 3 holdings", analysis.concentration.top3],
              ["Top 5 holdings", analysis.concentration.top5],
            ].map(([label, value]) => <div key={String(label)}><div><b>{label}</b><span>{plainPercent(Number(value), state.privacy)}</span></div><div className="analysis-bar"><i style={{ width: `${Math.min(100, Number(value))}%` }} /></div></div>)}</div><p className="analysis-note">Effective holdings converts concentration into an intuitive count. A portfolio with ten equally weighted stocks has an effective count of ten; concentrated weights reduce it.</p></article>
          </section>

          <section className="panel attribution-panel"><div className="panel-title"><div><p className="kicker">ATTRIBUTION</p><h2>What is driving your result</h2></div><span>{analysis.totals.quoted} priced positions</span></div><div className="attribution-grid"><div><h3>Largest contributors</h3>{analysis.contributors.slice(0, 5).map(position => <div className="analysis-row" key={`best-${position.symbol}`}><div><b>{position.symbol}</b><small>{plainPercent(position.weight, state.privacy)} of portfolio</small></div><span className={position.pnl >= 0 ? "gain" : "loss"}><b>{money(position.pnl, state.privacy)}</b><small>{percent(position.returnPct, state.privacy)}</small></span></div>)}</div><div><h3>Largest detractors</h3>{analysis.contributors.slice(-5).reverse().map(position => <div className="analysis-row" key={`worst-${position.symbol}`}><div><b>{position.symbol}</b><small>{plainPercent(position.weight, state.privacy)} of portfolio</small></div><span className={position.pnl >= 0 ? "gain" : "loss"}><b>{money(position.pnl, state.privacy)}</b><small>{percent(position.returnPct, state.privacy)}</small></span></div>)}</div></div></section>

          <section className="analysis-grid">
            <article className="panel analysis-card"><div className="panel-title"><div><p className="kicker">PORTFOLIO BREADTH</p><h2>Winners versus losers</h2></div><span>{analysis.totals.quoted} priced</span></div><div className="breadth-score"><strong>{state.privacy ? "••••" : `${analysis.breadth.gainers}/${analysis.totals.quoted}`}</strong><span>positions currently profitable</span></div><div className="breadth-track"><i style={{ width: `${analysis.breadth.gainersPct}%` }} /></div><div className="split-facts"><span><b>{analysis.breadth.gainers}</b> in profit</span><span><b>{analysis.breadth.losers}</b> in loss</span><span><b>{analysis.totals.missing}</b> unpriced</span></div></article>
            <article className="panel analysis-card"><div className="panel-title"><div><p className="kicker">TRADING QUALITY</p><h2>FIFO outcome profile</h2></div><span>{analysis.trading.closedSales.length} sales</span></div>{analysis.trading.closedSales.length ? <div className="fact-grid"><div><small>Win rate</small><b>{plainPercent(analysis.trading.winRate, state.privacy)}</b></div><div><small>Payoff ratio</small><b>{state.privacy ? "••••" : ratioText(analysis.trading.payoffRatio)}</b></div><div><small>Average win</small><b className="gain">{money(analysis.trading.averageWin, state.privacy)}</b></div><div><small>Average loss</small><b className="loss">{money(-analysis.trading.averageLoss, state.privacy)}</b></div><div><small>Average holding</small><b>{state.privacy ? "••••" : `${analysis.trading.averageHoldingDays.toFixed(0)} days`}</b></div><div><small>Turnover</small><b>{money(analysis.trading.turnover, state.privacy)}</b></div></div> : <p className="analysis-note roomy">Import Stocks Order History to calculate realised outcomes, win rate, payoff ratio, turnover and average holding period.</p>}</article>
          </section>

          {!!analysis.trading.realisedBySymbol.length && <section className="panel attribution-panel"><div className="panel-title"><div><p className="kicker">REALISED ATTRIBUTION</p><h2>Trading result by stock</h2></div><span>FIFO estimate</span></div><div className="realised-grid">{analysis.trading.realisedBySymbol.slice(0, 12).map(item => <div className="analysis-row" key={item.symbol}><b>{item.symbol}</b><span className={item.net >= 0 ? "gain" : "loss"}>{money(item.net, state.privacy)}</span></div>)}</div></section>}

          <section className="analysis-grid">
            <article className="panel analysis-card"><div className="panel-title"><div><p className="kicker">BROKER REFERENCES</p><h2>P&amp;L and capital gains</h2></div><span>Imported reports</span></div><div className="reference-stack"><div><span>Broker realised P&amp;L</span><b>{state.pnl ? money(state.pnl.realised, state.privacy) : "Not imported"}</b></div><div><span>Broker unrealised P&amp;L</span><b>{state.pnl ? money(state.pnl.unrealised, state.privacy) : "Not imported"}</b></div><div><span>Short-term capital gains</span><b>{state.capitalGains?.shortTerm !== undefined ? money(state.capitalGains.shortTerm, state.privacy) : "Not imported"}</b></div><div><span>Long-term capital gains</span><b>{state.capitalGains?.longTerm !== undefined ? money(state.capitalGains.longTerm, state.privacy) : "Not imported"}</b></div></div><p className="analysis-note">These figures are displayed exactly as broker references. MyPortfolio does not present them as a tax return or final liability.</p></article>
            <article className="panel analysis-card limitation-card"><div className="panel-title"><div><p className="kicker">DATA QUALITY</p><h2>What can and cannot be concluded</h2></div><span>{analysis.totals.quoted === state.holdings.length ? "Complete prices" : "Partial prices"}</span></div><ul><li>Market-value analytics cover {analysis.totals.quoted} of {state.holdings.length} holdings.</li><li>{analysis.trading.unmatchedSaleQuantity ? `${number(analysis.trading.unmatchedSaleQuantity)} sold shares could not be matched to imported buys.` : "Every analysed sale was matched to an earlier imported buy."}</li><li>{analysis.trading.unknownChargeTrades} trade records have unknown charges, so FIFO realised P&amp;L may be provisional.</li><li>Sharpe, Sortino, beta, volatility and maximum drawdown require a trustworthy daily portfolio history. They are intentionally not inferred from one current quote.</li></ul></article>
          </section>
        </>}
      </>}

      {view === "holdings" && <>
        <div className="hero-row"><div><p className="kicker">MARKET BOOK</p><h1>Your holdings</h1><p>Current cost and market value from the latest statement and quotes.</p></div><button className="primary" onClick={updatePrices} disabled={busy}>{busy ? progress || "Updating…" : "↻ Refresh prices"}</button></div>
        <section className="controls"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search company or symbol" /><select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="value">Sort by value</option><option value="return">Sort by return</option><option value="name">Sort by name</option></select><div className="segmented">{(["all", "profit", "loss"] as const).map(value => <button className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{value === "all" ? "All" : value === "profit" ? "In profit" : "In loss"}</button>)}</div></section>
        <section className="holdings-list">
          {visible.map(row => <article className="holding-row" key={row.symbol}><span className="stock-badge large">{row.symbol.slice(0, 2)}</span><div className="holding-name"><b>{row.name}</b><small>{row.symbol} · {number(row.quantity)} shares</small><em>{row.quote ? `Price ${money(row.quote.price, state.privacy)} · ${new Date(row.quote.marketAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : "Price not refreshed yet"}</em></div><div className="holding-cost"><small>Avg. cost</small><b>{money(row.averagePrice, state.privacy)}</b></div><div className="holding-value"><b>{row.quote ? money(row.value, state.privacy) : "—"}</b><small className={row.pnl >= 0 ? "gain" : "loss"}>{row.quote ? `${money(row.pnl, state.privacy)} · ${percent(row.returnPct, state.privacy)}` : "Awaiting quote"}</small></div></article>)}
          {!visible.length && <div className="empty-list">No holdings match this view.</div>}
        </section>
      </>}

      {view === "activity" && <>
        <div className="hero-row"><div><p className="kicker">TRADING BOOK</p><h1>Activity & realised results</h1><p>Calculated locally from imported executed orders using FIFO for this analytical view.</p></div></div>
        <section className="metric-grid compact"><article className="metric violet"><span>Executed orders</span><strong>{state.trades.length}</strong><small>{tradeStats.buys} buys · {tradeStats.sells} sells</small></article><article className={`metric ${tradeStats.realised >= 0 ? "positive" : "negative"}`}><span>FIFO realised estimate</span><strong>{money(tradeStats.realised, state.privacy)}</strong><small>Before incomplete or unknown charges</small></article><article className="metric mint"><span>Groww P&L reference</span><strong>{state.pnl ? money(state.pnl.realised, state.privacy) : "—"}</strong><small>{state.pnl ? state.pnl.fileName : "Upload P&L report"}</small></article></section>
        <section className="panel trade-table"><div className="panel-title"><div><p className="kicker">RECENT EXECUTIONS</p><h2>Trading history</h2></div></div>{state.trades.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100).map(trade => <div className="trade-row" key={trade.id}><span className={trade.side === "BUY" ? "buy" : "sell"}>{trade.side}</span><div><b>{trade.symbol}</b><small>{trade.date}</small></div><div><b>{number(trade.quantity)} × {money(trade.price, state.privacy)}</b><small>{money(trade.quantity * trade.price, state.privacy)}</small></div></div>)}{!state.trades.length && <div className="empty-list">Import Stocks Order History to build this view.</div>}</section>
      </>}

      {view === "import" && <>
        <div className="hero-row"><div><p className="kicker">LOCAL IMPORT</p><h1>Bring your Groww statements</h1><p>Files are parsed in this browser. Uploading replaces only that statement category.</p></div></div>
        <div className="privacy-banner"><span>◉</span><div><b>Private by architecture</b><p>No statement, account number, holding, trade or amount is uploaded to GitHub or a database. Only stock tickers are sent when you request prices.</p></div></div>
        <section className="upload-grid">
          {([
            ["holdings", "Current holdings", "Groww Holdings Statement", "Builds market value and unrealised returns."],
            ["trades", "Order history", "Stocks Order History", "Builds the trading book and FIFO realised estimate."],
            ["pnl", "P&L reference", "Stocks P&L Report", "Keeps Groww's realised/unrealised figures for comparison."],
            ["capital-gains", "Capital gains", "Capital Gains Report", "Keeps the broker's tax classification as reference."],
          ] as [ImportKind, string, string, string][]).map(([kind, title, expected, description]) => {
            const record = state.imports[kind];
            return <article className="upload-card" key={kind}><div className="upload-icon">{kind === "holdings" ? "▥" : kind === "trades" ? "↗" : kind === "pnl" ? "≈" : "§"}</div><div><h2>{title}</h2><p>{description}</p><small>Use: {expected} (.xlsx or .csv)</small></div><label className="upload-button">{busy ? "Please wait…" : record ? "Replace file" : "Choose file"}<input type="file" accept=".xlsx,.xls,.csv" disabled={busy} onChange={event => { void importFile(kind, event.target.files?.[0]); event.target.value = ""; }} /></label>{record && <div className="imported"><span>✓</span><div><b>{record.rows} rows saved locally</b><small>{record.fileName}</small></div></div>}</article>;
          })}
        </section>
      </>}

      {view === "settings" && <>
        <div className="hero-row"><div><p className="kicker">YOUR SPACE</p><h1>Privacy & data</h1><p>Manage the only copy of your portfolio data: the one on this device.</p></div></div>
        <section className="settings-grid">
          <article className="panel setting"><h2>Local backup</h2><p>Download a complete local JSON copy before clearing browser data or changing phones. The exported file is not encrypted, so store it privately.</p><div><button className="secondary" onClick={() => downloadBackup(state)}>Download backup</button><label className="secondary">Restore backup<input ref={fileRef} type="file" accept=".json" onChange={async event => { try { const file = event.target.files?.[0]; if (file) save(await restoreBackup(file), setState); setNotice("Backup restored on this device."); } catch (error) { setNotice(error instanceof Error ? error.message : "Restore failed."); } event.target.value = ""; }} /></label></div></article>
          <article className="panel setting"><h2>Install on your phone</h2><p>In Chrome on Android, open the browser menu and choose “Install app” or “Add to Home screen”. On iPhone, use Safari → Share → Add to Home Screen.</p><div className="status-chip">✓ Installable PWA</div></article>
          <article className="panel setting danger-zone"><h2>Clear this device</h2><p>Removes your profile, imports, holdings, trades and cached quotes from this browser. The public GitHub app contains none of them.</p>{pendingClear ? <div className="confirm-row"><button className="danger-button" onClick={() => { localStorage.clear(); setState(blankState()); setPendingClear(false); }}>Yes, clear everything</button><button className="secondary" onClick={() => setPendingClear(false)}>Cancel</button></div> : <button className="danger-button" onClick={() => setPendingClear(true)}>Clear local portfolio</button>}</article>
        </section>
      </>}
    </main>

    <nav className="mobile-nav">{nav.map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}</nav>
  </div>;
}
