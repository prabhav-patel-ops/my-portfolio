export type Holding = {
  symbol: string;
  name: string;
  quantity: number;
  averagePrice: number;
  isin?: string;
  exchange?: "NSE" | "BSE";
  sector?: string;
};

export type Trade = {
  id: string;
  symbol: string;
  name: string;
  date: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  isin?: string;
  charges?: number;
};

export type ReferenceSummary = {
  fileName: string;
  importedAt: string;
  realised: number;
  unrealised: number;
  shortTerm?: number;
  longTerm?: number;
};

export type Quote = {
  price: number;
  previousClose: number | null;
  marketAt: string;
  fetchedAt: string;
  ticker: string;
  source: string;
};

export type PortfolioState = {
  version: 1;
  profile: string;
  holdings: Holding[];
  trades: Trade[];
  pnl: ReferenceSummary | null;
  capitalGains: ReferenceSummary | null;
  quotes: Record<string, Quote>;
  imports: Partial<Record<"holdings" | "trades" | "pnl" | "capital-gains", { fileName: string; importedAt: string; rows: number }>>;
  privacy: boolean;
};

export type ImportKind = "holdings" | "trades" | "pnl" | "capital-gains";

export type ImportResult = {
  kind: ImportKind;
  fileName: string;
  holdings?: Holding[];
  trades?: Trade[];
  summary?: ReferenceSummary;
  warnings: string[];
};
