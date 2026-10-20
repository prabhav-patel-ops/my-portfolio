import reference from "./nse-sector-reference.json";
import type { Holding } from "./types";

export function classifyHolding(holding: Holding): Holding {
  // Exact identifiers only. Company-name guesses can silently classify the
  // wrong security, particularly when Groww exports company names as symbols.
  const row = holding.isin
    ? reference.rows.find(r => r.isin === holding.isin)
    : reference.rows.find(r => r.symbol === holding.symbol.replace(/\.(NS|BO)$/, ""));
  return row ? { ...holding, sector: holding.sector || row.sector,
    ...(!/^[A-Z0-9&._-]+$/.test(holding.symbol) && holding.isin ? {symbol:row.symbol,exchange:"NSE" as const} : {}) } : holding;
}
export const classificationSource = reference;
