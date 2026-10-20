import type { PortfolioState, Trade } from "./types";
import { classifyHolding } from "./classification";

export const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export function validateTrade(trade: Trade) {
  if (!/^[A-Z0-9&._-]{1,40}$/.test(trade.symbol)) throw Error("Use the exact NSE/BSE ticker, e.g. RELIANCE.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trade.date) || new Date(trade.date).toISOString().slice(0,10) !== trade.date || trade.date > todayIST()) throw Error("Enter a valid execution date, no later than today.");
  if (![trade.quantity, trade.price].every(n => Number.isFinite(n) && n > 0) || (trade.charges !== undefined && (!Number.isFinite(trade.charges) || trade.charges < 0))) throw Error("Quantity and price must be positive; charges cannot be negative.");
}
export function recordTrade(state: PortfolioState, trade: Trade): PortfolioState {
  validateTrade(trade);
  if (state.trades.some(t => t.id === trade.id)) throw Error("This entry has already been saved.");
  const holdings = state.holdings.map(h => ({ ...h }));
  let holding = holdings.find(h => h.symbol === trade.symbol);
  if (trade.side === "SELL" && (!holding || trade.quantity > holding.quantity)) throw Error("A sale cannot exceed your recorded shares.");
  if (!holding) { holding = { symbol: trade.symbol, name: trade.name || trade.symbol, quantity: 0, averagePrice: 0 }; holdings.push(holding); }
  if (trade.side === "BUY") {
    holding.averagePrice = (holding.quantity * holding.averagePrice + trade.quantity * trade.price) / (holding.quantity + trade.quantity);
    holding.quantity += trade.quantity;
  } else {
    // Removing shares at the displayed average would misstate the broker's FIFO
    // remaining cost when only a holdings snapshot (not its lots) is available.
    throw Error("Sales need a new holdings statement to verify the remaining FIFO cost. Purchase entry is available here.");
  }
  return { ...state, holdings:holdings.map(classifyHolding), trades: [...state.trades, { ...trade, source: "manual" }], pendingManualHoldings: [...(state.pendingManualHoldings || []), trade.id] };
}

export function mergeStatementTrades(imported: Trade[], existing: Trade[]) {
  const key = (t: Trade) => [t.symbol,t.date,t.side,t.quantity,t.price].join("|");
  const counts = new Map<string, number>();
  imported.forEach(t => counts.set(key(t), (counts.get(key(t)) || 0) + 1));
  return [...imported, ...existing.filter(t => t.source === "manual").filter(t => {
    const n = counts.get(key(t)) || 0;
    if (n) { counts.set(key(t), n - 1); return false; }
    return true;
  })];
}
