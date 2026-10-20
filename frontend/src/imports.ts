import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { Holding, ImportKind, ImportResult, ReferenceSummary, ReferenceEntry, Trade } from "./types";

type Cell = string | number | Date | null | undefined;
type Row = Cell[];

const normalize = (value: Cell) =>
  String(value ?? "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[_.-]+/g, " ").replace(/\s+/g, " ");
const aliases: Record<string, string[]> = {
  symbol: ["symbol", "trading symbol", "stock symbol", "stock", "scrip", "stock name", "scrip name", "security", "company name"],
  name: ["stock name", "company name", "security name", "scrip name", "name"],
  quantity: ["quantity", "qty", "holding quantity", "shares", "trade quantity", "executed quantity", "filled quantity"],
  averagePrice: ["avg price", "average price", "avg buy price", "average buy price", "average purchase price", "avg cost", "average cost", "buy price"],
  date: ["trade date", "execution date", "executed date", "transaction date", "date", "execution date and time"],
  side: ["buy/sell", "buy / sell", "buy sell", "trade type", "transaction type", "order side", "side", "type"],
  price: ["trade price", "execution price", "executed price", "average execution price", "price", "unit price", "rate"],
  tradeValue: ["trade value", "gross trade value", "executed value", "value"],
  charges: ["total charges", "charges", "transaction charges", "fees"],
  exchange: ["exchange", "stock exchange"],
  isin: ["isin", "isin code"],
  realised: ["realised p&l", "realized p&l", "realised profit", "realized profit"],
  unrealised: ["unrealised p&l", "unrealized p&l", "unrealised profit", "unrealized profit"],
  buyDate: ["buy date", "purchase date", "date of acquisition"],
  sellDate: ["sell date", "sale date", "date of sale", "date of transfer"],
  buyValue: ["buy value", "purchase value", "cost of acquisition", "buy amount"],
  sellValue: ["sell value", "sale value", "sale consideration", "sell amount"],
};

function numberValue(value: Cell): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replace(/^(?:₹|INR\s*|Rs\.?\s*)/i, "").replace(/[(),]/g, m => m === "(" ? "-" : "");
  if (!text) return null;
  const parsed = Number(text.replace(/\)$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: Cell): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "number" && value > 1) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const text = String(value ?? "").trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(text);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return null;
}

function findColumn(headers: Row, field: string): number {
  const keys = headers.map(normalize);
  return (aliases[field] || []).map(alias => keys.indexOf(alias)).find(index => index >= 0) ?? -1;
}

function headerScore(row: Row, kind: ImportKind) {
  const fields = kind === "holdings" ? ["symbol", "quantity", "averagePrice"] :
    kind === "trades" ? ["symbol", "date", "side", "quantity", "price", "tradeValue"] :
    ["symbol", "realised", "unrealised"];
  return fields.filter(field => findColumn(row, field) >= 0).length;
}

function bestTable(sheets: { name: string; rows: Row[] }[], kind: ImportKind) {
  let best: { rows: Row[]; header: number; score: number; sheet: string } | null = null;
  for (const sheet of sheets) {
    for (let index = 0; index < Math.min(sheet.rows.length, 80); index++) {
      const score = headerScore(sheet.rows[index], kind);
      if (!best || score > best.score) best = { rows: sheet.rows, header: index, score, sheet: sheet.name };
    }
  }
  return best;
}

function cleanSymbol(value: Cell) {
  return String(value ?? "").trim().toUpperCase().replace(/^(?:NSE|BSE):/, "").replace(/\.(?:NS|BO)$/, "").replace(/\$$/, "");
}

async function workbookRows(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error("File must be smaller than 20 MB.");
  if (/\.csv$/i.test(file.name)) {
    const parsed = Papa.parse<Row>(await file.text(), { skipEmptyLines: false });
    if (parsed.errors.length) throw new Error("The CSV could not be read cleanly. Export it again and retry.");
    return [{ name: "CSV", rows: parsed.data }];
  }
  if (!/\.xlsx?$/i.test(file.name)) throw new Error("Use a Groww Excel or CSV export.");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return workbook.SheetNames.map(name => ({
    name,
    rows: XLSX.utils.sheet_to_json<Row>(workbook.Sheets[name], { header: 1, defval: "", blankrows: false }),
  }));
}

export async function parseImport(file: File, kind: ImportKind): Promise<ImportResult> {
  const sheets = await workbookRows(file);
  const table = bestTable(sheets, kind);
  if (!table) throw new Error("No table was found in this file.");
  const headers = table.rows[table.header];
  const rows = table.rows.slice(table.header + 1).filter(row => row.some(cell => String(cell ?? "").trim()));
  const warnings: string[] = [];

  if (kind === "holdings") {
    const symbolAt = findColumn(headers, "symbol");
    const quantityAt = findColumn(headers, "quantity");
    const averageAt = findColumn(headers, "averagePrice");
    const nameAt = findColumn(headers, "name");
    const exchangeAt = findColumn(headers, "exchange");
    const isinAt = findColumn(headers, "isin");
    if (symbolAt < 0 || quantityAt < 0 || averageAt < 0) throw new Error("Holdings needs Stock/Symbol, Quantity and Average Price columns.");
    const holdings: Holding[] = [];
    rows.forEach(row => {
      const symbol = cleanSymbol(row[symbolAt]);
      const quantity = numberValue(row[quantityAt]);
      const averagePrice = numberValue(row[averageAt]);
      if (!symbol || !quantity || quantity <= 0 || averagePrice === null || averagePrice < 0) return;
      const exchangeRaw = normalize(row[exchangeAt]).toUpperCase();
      holdings.push({
        symbol,
        name: String(row[nameAt] || row[symbolAt]).trim() || symbol,
        quantity,
        averagePrice,
        isin: isinAt >= 0 ? String(row[isinAt] ?? "").trim() || undefined : undefined,
        exchange: exchangeRaw === "BSE" ? "BSE" : exchangeRaw === "NSE" ? "NSE" : undefined,
      });
    });
    if (!holdings.length) throw new Error("No valid holdings were found. Use Groww's current Holdings Statement.");
    return { kind, fileName: file.name, holdings, warnings };
  }

  if (kind === "trades") {
    const symbolAt = findColumn(headers, "symbol");
    const nameAt = findColumn(headers, "name");
    const dateAt = findColumn(headers, "date");
    const sideAt = findColumn(headers, "side");
    const quantityAt = findColumn(headers, "quantity");
    const priceAt = findColumn(headers, "price");
    const valueAt = findColumn(headers, "tradeValue");
    const chargesAt = findColumn(headers, "charges");
    const isinAt = findColumn(headers, "isin");
    if ([symbolAt, dateAt, sideAt, quantityAt].some(index => index < 0) || (priceAt < 0 && valueAt < 0)) {
      throw new Error("Order History needs Symbol, Trade Date, Buy/Sell, Quantity and Price or Trade Value.");
    }
    const trades: Trade[] = [];
    rows.forEach((row, index) => {
      const symbol = cleanSymbol(row[symbolAt]);
      const date = dateValue(row[dateAt]);
      const sideText = normalize(row[sideAt]);
      const side = /buy/.test(sideText) ? "BUY" : /sell/.test(sideText) ? "SELL" : null;
      const quantity = numberValue(row[quantityAt]);
      const directPrice = priceAt >= 0 ? numberValue(row[priceAt]) : null;
      const total = valueAt >= 0 ? numberValue(row[valueAt]) : null;
      const price = directPrice && directPrice > 0 ? directPrice : quantity && total ? Math.abs(total / quantity) : null;
      if (!symbol || !date || !side || !quantity || quantity <= 0 || !price || price <= 0) return;
      trades.push({
        id: `${date}-${symbol}-${side}-${index}-${quantity}-${price}`,
        symbol,
        name: String(row[nameAt] || row[symbolAt]).trim() || symbol,
        date,
        side,
        quantity,
        price,
        isin: isinAt >= 0 ? String(row[isinAt] ?? "").trim() || undefined : undefined,
        charges: chargesAt >= 0 && String(row[chargesAt] ?? "").trim() !== "" ? Math.max(0, numberValue(row[chargesAt]) ?? 0) : undefined,
      });
    });
    if (!trades.length) throw new Error("No executed trades were found. Upload Stocks Order History, not the P&L report.");
    return { kind, fileName: file.name, trades, warnings };
  }

  // A Groww P&L file contains separate realised and unrealised tables, and may
  // repeat them at Trade Level and Scrip Level. Prefer Trade Level and scan each
  // section exactly once. Capital-gains files similarly repeat headers for tax
  // term sections, so a single "best header" is not sufficient.
  const candidateSheets = kind === "pnl" && sheets.some(sheet => /trade\s*level/i.test(sheet.name))
    ? sheets.filter(sheet => /trade\s*level/i.test(sheet.name))
    : sheets;
  let realised = 0, unrealised = 0, shortTerm = 0, longTerm = 0, reportRows = 0;
  const entries: ReferenceEntry[] = [];
  for (const sheet of candidateSheets) {
    for (let headerIndex = 0; headerIndex < sheet.rows.length; headerIndex++) {
      const headers = sheet.rows[headerIndex];
      const symbolAt = findColumn(headers, "symbol");
      const realisedAt = findColumn(headers, "realised");
      const unrealisedAt = findColumn(headers, "unrealised");
      if (symbolAt < 0 || (realisedAt < 0 && unrealisedAt < 0)) continue;
      const context = sheet.rows.slice(Math.max(0, headerIndex - 4), headerIndex).flat().map(normalize).join(" ");
      const term = /short\s*term/.test(context) ? "short" : /long\s*term/.test(context) ? "long" : "";
      for (let rowIndex = headerIndex + 1; rowIndex < sheet.rows.length; rowIndex++) {
        const row = sheet.rows[rowIndex];
        if (findColumn(row, "symbol") >= 0 && (findColumn(row, "realised") >= 0 || findColumn(row, "unrealised") >= 0)) break;
        const symbol = cleanSymbol(row[symbolAt]);
        if (!symbol || /^(?:TOTAL|SUBTOTAL|GRAND TOTAL)$/.test(symbol)) continue;
        const r = realisedAt >= 0 ? numberValue(row[realisedAt]) : null;
        const u = unrealisedAt >= 0 ? numberValue(row[unrealisedAt]) : null;
        const reportDate = (field: string) => {
          const at = findColumn(headers,field), d = at >= 0 ? dateValue(row[at]) : null;
          return d && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d ? d : undefined;
        };
        const reportValue = (field: string) => { const at=findColumn(headers,field);return at>=0?numberValue(row[at])??undefined:undefined; };
        if (r!==null || u!==null) entries.push({symbol,realised:r??undefined,unrealised:u??undefined,buyDate:reportDate("buyDate"),sellDate:reportDate("sellDate"),buyValue:reportValue("buyValue"),sellValue:reportValue("sellValue"),term:term||undefined});
        if (r !== null) {
          realised += r;
          if (term === "short") shortTerm += r;
          if (term === "long") longTerm += r;
          reportRows++;
        }
        if (u !== null) { unrealised += u; reportRows++; }
      }
    }
  }
  if (!reportRows) throw new Error("No supported realised/unrealised P&L rows were found.");
  const summary: ReferenceSummary = {
    fileName: file.name,
    importedAt: new Date().toISOString(),
    realised: Math.round(realised * 100) / 100,
    unrealised: Math.round(unrealised * 100) / 100,
    entries,
    ...(shortTerm ? { shortTerm: Math.round(shortTerm * 100) / 100 } : {}),
    ...(longTerm ? { longTerm: Math.round(longTerm * 100) / 100 } : {}),
  };
  return { kind, fileName: file.name, summary, warnings };
}
