import type { Holding, Quote, PricePoint, HistoryState } from "./types";
import { discoverYahooSymbol, fetchYahooBatchQuotes, marketTicker, usableMarketQuote } from "./vendor/lotbook-market.js";

export function usable(quote?: Quote) {
  return usableMarketQuote(quote);
}

// Quotes and optional history share one paced transport, so opening Analysis
// cannot burst dozens of requests into the same anonymous relay allowance.
let requestQueue: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;
export const marketFetch: typeof fetch = (input, init) => {
  const request = requestQueue.then(async () => {
    const wait = Math.max(0,nextRequestAt-Date.now());
    if (wait) await new Promise(resolve=>setTimeout(resolve,wait));
    nextRequestAt=Date.now()+3500;
    return fetch(input,init);
  });
  requestQueue=request.catch(()=>undefined);
  return request;
};

function ticker(symbol: string, exchange: "NSE" | "BSE") {
  const clean = symbol.trim().toUpperCase().replace(/^(?:NSE|BSE):/, "").replace(/\.(?:NS|BO)$/, "").replace(/\$$/, "");
  if (!/^[A-Z0-9&._-]+$/.test(clean)) throw new Error("unsupported ticker");
  return `${clean}.${exchange === "BSE" ? "BO" : "NS"}`;
}

async function relayJson(target: string, fetcher: typeof fetch = marketFetch) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(`https://r.jina.ai/${target}`, {
      headers: { "X-No-Cache": "true", accept: "text/plain" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`quote relay returned ${response.status}`);
    const text = await response.text();
    const marker = text.indexOf("Markdown Content:");
    const start = text.indexOf("{", Math.max(0, marker));
    if (marker < 0 || start < 0 || text.length > 4000000) throw new Error("unexpected market response");
    return JSON.parse(text.slice(start).trim());
  } finally {
    window.clearTimeout(timer);
  }
}

export async function refreshQuotes(
  holdings: Holding[],
  existing: Record<string, Quote>,
  onProgress?: (done: number, total: number) => void,
  fetcher: typeof fetch = marketFetch,
) {
  const unique = [...new Map(holdings.map(holding => [holding.symbol, holding])).values()];
  const quotes = { ...existing };
  const errors: string[] = [];
  const requested = new Map<string,string[]>();
  const batch: {symbol:string;name:string}[]=[];
  onProgress?.(0,unique.length);
  for (const holding of unique) {
    let mapped = marketTicker(holding.symbol);
    let requestSymbol: string;
    if (mapped) {
      // Explicit listing information takes precedence over an implicit NSE
      // default. Keep the user's original symbol as the portfolio/cache key.
      const explicit=/^(NSE|BSE):|\.(NS|BO)\$?$/i.test(holding.symbol);
      const exchange=explicit?mapped.exchange:holding.exchange || mapped.exchange;
      requestSymbol=`${exchange}:${mapped.ticker}`;
    } else {
      const discovered=await discoverYahooSymbol({symbol:holding.symbol,companyName:holding.name,ticker:"",exchange:holding.exchange || "NSE"},fetcher);
      if (!discovered) {errors.push(holding.symbol);continue;}
      requestSymbol=`${discovered.suffix===".BO"?"BSE":"NSE"}:${discovered.ticker}`;
    }
    const originals=requested.get(requestSymbol) || [];
    originals.push(holding.symbol);requested.set(requestSymbol,originals);
    if (originals.length===1) batch.push({symbol:requestSymbol,name:holding.name});
  }
  const result = await fetchYahooBatchQuotes(batch,fetcher);
  const refreshedSymbols: string[]=[];
  for (const [requestSymbol,originals] of requested) {
    const quote=result.quotes[requestSymbol];
    for (const symbol of originals) {
      if (quote) {quotes[symbol]=quote;refreshedSymbols.push(symbol);}
      else errors.push(symbol);
    }
  }
  const retainedSymbols=errors.filter(symbol=>usable(quotes[symbol]));
  const missingSymbols=errors.filter(symbol=>!usable(quotes[symbol]));
  missingSymbols.forEach(symbol=>delete quotes[symbol]);
  onProgress?.(unique.length,unique.length);
  return { quotes, errors, updated:refreshedSymbols.length, refreshedSymbols,retainedSymbols,missingSymbols,attemptedAt:new Date().toISOString() };
}

export async function fetchDailyHistory(symbol: string,fetcher: typeof fetch = marketFetch): Promise<PricePoint[]> {
  const encoded=encodeURIComponent(symbol).replace(/%26/g,"%2526");
  const payload = await relayJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=10y%26interval=1d`,fetcher);
  const result = payload?.chart?.result?.[0];
  if (payload?.chart?.error || result?.meta?.symbol !== symbol || result?.meta?.currency !== "INR") throw Error("Historical ticker identity could not be verified.");
  const prices = symbol === "^NSEI" ? result.indicators?.quote?.[0]?.close : result.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(prices) || !Array.isArray(result.timestamp)) throw Error("No verified daily closes.");
  const now = new Date();
  const ist = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  // Keep risk calculations on completed sessions, never an intraday candle.
  const afterClose = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now).replace(":", "")) >= 1600;
  return result.timestamp.flatMap((stamp: number, i: number) => {
    const date = new Date(stamp * 1000).toISOString().slice(0, 10), value = prices[i];
    return date <= ist && (date < ist || afterClose) && typeof value === "number" && Number.isFinite(value) && value > 0 ? [{ date, value }] : [];
  });
}

export async function refreshHistory(holdings: Holding[], quotes: Record<string, Quote>, existing?: HistoryState,onProgress?:(done:number,total:number)=>void,fetcher:typeof fetch=marketFetch): Promise<HistoryState> {
  const next: HistoryState = { nav: existing?.nav || [], navFile: existing?.navFile, benchmark: existing?.benchmark || [], assets: { ...existing?.assets }, fetchedAt: new Date().toISOString(), errors: [] };
  const jobs = [{ key: "^NSEI", ticker: "^NSEI" }];
  for (const h of holdings) {
    try {jobs.push({key:h.symbol,ticker:quotes[h.symbol]?.ticker || ticker(h.symbol,h.exchange || "NSE")});}
    catch {next.errors!.push(h.symbol);}
  }
  let done=0;
  for (const job of jobs) {
      try {
        const points = await fetchDailyHistory(job.ticker,fetcher);
        if (points.length < 2) throw Error("Insufficient history");
        if (job.key === "^NSEI") next.benchmark = points; else next.assets[job.key] = points;
      } catch { next.errors!.push(job.key); }
      onProgress?.(++done,jobs.length);
  }
  return next;
}
