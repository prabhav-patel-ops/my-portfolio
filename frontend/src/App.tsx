import { useMemo, useRef, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { parseImport } from "./imports";
import { refreshQuotes } from "./market";
import { blankState, downloadBackup, loadState, restoreBackup, saveState } from "./storage";
import type { ImportKind, PortfolioState, Trade } from "./types";

type View = "overview" | "holdings" | "activity" | "import" | "settings";
const COLORS = ["#7457ff", "#15c7a3", "#ff8a5b", "#3f8cff", "#f6c85f", "#dd5b9f"];
const money = (value: number, hidden = false) => hidden ? "••••" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
const number = (value: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 4 }).format(value);
const percent = (value: number, hidden = false) => hidden ? "••••" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

function analyseTrades(trades: Trade[]) {
  const lots = new Map<string, { quantity: number; price: number; charges: number }[]>();
  let realised = 0, buys = 0, sells = 0;
  [...trades].sort((a, b) => a.date.localeCompare(b.date)).forEach(trade => {
    const list = lots.get(trade.symbol) || [];
    if (trade.side === "BUY") {
      list.push({ quantity: trade.quantity, price: trade.price, charges: trade.charges || 0 });
      lots.set(trade.symbol, list);
      buys++;
      return;
    }
    let remaining = trade.quantity;
    while (remaining > 0 && list.length) {
      const lot = list[0];
      const used = Math.min(remaining, lot.quantity);
      realised += used * (trade.price - lot.price);
      lot.quantity -= used;
      remaining -= used;
      if (lot.quantity < 1e-8) list.shift();
    }
    realised -= trade.charges || 0;
    sells++;
  });
  return { realised, buys, sells };
}

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

  const rows = useMemo(() => state.holdings.map(holding => {
    const quote = state.quotes[holding.symbol];
    const invested = holding.quantity * holding.averagePrice;
    const value = quote ? holding.quantity * quote.price : 0;
    const pnl = quote ? value - invested : 0;
    const returnPct = quote && invested ? pnl / invested * 100 : 0;
    const day = quote?.previousClose ? (quote.price - quote.previousClose) * holding.quantity : 0;
    return { ...holding, quote, invested, value, pnl, returnPct, day };
  }), [state.holdings, state.quotes]);

  const totals = useMemo(() => {
    const invested = rows.reduce((sum, row) => sum + row.invested, 0);
    const quoted = rows.filter(row => row.quote);
    const current = quoted.reduce((sum, row) => sum + row.value, 0);
    const quotedInvested = quoted.reduce((sum, row) => sum + row.invested, 0);
    const pnl = current - quotedInvested;
    const day = quoted.reduce((sum, row) => sum + row.day, 0);
    return { invested, current, pnl, day, returnPct: quotedInvested ? pnl / quotedInvested * 100 : 0, quoted: quoted.length };
  }, [rows]);

  const tradeStats = useMemo(() => analyseTrades(state.trades), [state.trades]);
  const visible = useMemo(() => rows
    .filter(row => !search || `${row.symbol} ${row.name}`.toLowerCase().includes(search.toLowerCase()))
    .filter(row => filter === "all" || (filter === "profit" ? row.pnl >= 0 && !!row.quote : row.pnl < 0 && !!row.quote))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "return" ? b.returnPct - a.returnPct : b.value - a.value),
  [rows, search, filter, sort]);

  const allocation = useMemo(() => rows.filter(row => row.quote).map(row => ({ name: row.symbol, value: row.value })).sort((a, b) => b.value - a.value), [rows]);

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
          <article className="panel setting"><h2>Local backup</h2><p>Download a complete encrypted-at-rest-by-your-device JSON copy before clearing browser data or changing phones.</p><div><button className="secondary" onClick={() => downloadBackup(state)}>Download backup</button><label className="secondary">Restore backup<input ref={fileRef} type="file" accept=".json" onChange={async event => { try { const file = event.target.files?.[0]; if (file) save(await restoreBackup(file), setState); setNotice("Backup restored on this device."); } catch (error) { setNotice(error instanceof Error ? error.message : "Restore failed."); } event.target.value = ""; }} /></label></div></article>
          <article className="panel setting"><h2>Install on your phone</h2><p>In Chrome on Android, open the browser menu and choose “Install app” or “Add to Home screen”. On iPhone, use Safari → Share → Add to Home Screen.</p><div className="status-chip">✓ Installable PWA</div></article>
          <article className="panel setting danger-zone"><h2>Clear this device</h2><p>Removes your profile, imports, holdings, trades and cached quotes from this browser. The public GitHub app contains none of them.</p>{pendingClear ? <div className="confirm-row"><button className="danger-button" onClick={() => { localStorage.clear(); setState(blankState()); setPendingClear(false); }}>Yes, clear everything</button><button className="secondary" onClick={() => setPendingClear(false)}>Cancel</button></div> : <button className="danger-button" onClick={() => setPendingClear(true)}>Clear local portfolio</button>}</article>
        </section>
      </>}
    </main>

    <nav className="mobile-nav">{nav.map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}</nav>
  </div>;
}
