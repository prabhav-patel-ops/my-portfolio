import type { Holding, Quote } from "./types";

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function usable(quote?: Quote) {
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return false;
  const age = Date.now() - Date.parse(quote.marketAt || quote.fetchedAt);
  return Number.isFinite(age) && age >= -300000 && age <= MAX_AGE;
}

function ticker(symbol: string, exchange: "NSE" | "BSE") {
  const clean = symbol.trim().toUpperCase().replace(/^(?:NSE|BSE):/, "").replace(/\.(?:NS|BO)$/, "").replace(/\$$/, "");
  if (!/^[A-Z0-9&._-]+$/.test(clean)) throw new Error("unsupported ticker");
  return `${clean}.${exchange === "BSE" ? "BO" : "NS"}`;
}

async function relayJson(target: string) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`https://r.jina.ai/${target}`, {
      headers: { "X-No-Cache": "true", accept: "text/plain" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`quote relay returned ${response.status}`);
    const text = await response.text();
    const marker = text.indexOf("Markdown Content:");
    const start = text.indexOf("{", Math.max(0, marker));
    if (start < 0 || text.length > 200000) throw new Error("unexpected quote response");
    return JSON.parse(text.slice(start).trim());
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchTicker(value: string): Promise<Quote> {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(value)}?range=1d%26interval=5m`;
  const payload = await relayJson(target);
  const meta = payload?.chart?.result?.[0]?.meta;
  if (payload?.chart?.error || meta?.symbol !== value || meta?.currency !== "INR") throw new Error("identity not verified");
  const price = Number(meta.regularMarketPrice);
  const previousClose = Number(meta.chartPreviousClose ?? meta.previousClose);
  const stamp = Number(meta.regularMarketTime) * 1000;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stamp)) throw new Error("no usable price");
  return {
    price,
    previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
    marketAt: new Date(stamp).toISOString(),
    fetchedAt: new Date().toISOString(),
    ticker: value,
    source: "Yahoo Finance via privacy relay",
  };
}

async function resolveTicker(holding: Holding) {
  const target = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(holding.name)}%26quotesCount=10%26newsCount=0`;
  const payload = await relayJson(target);
  const choices = (Array.isArray(payload?.quotes) ? payload.quotes : []).filter((item: { symbol?: string; currency?: string }) =>
    item?.currency === "INR" && /\.(?:NS|BO)$/.test(item.symbol || ""));
  const preferred = choices.find((item: { symbol: string }) => holding.exchange === "BSE" ? item.symbol.endsWith(".BO") : item.symbol.endsWith(".NS")) || choices[0];
  if (!preferred?.symbol) throw new Error("no verified market ticker");
  return preferred.symbol as string;
}

async function quoteHolding(holding: Holding) {
  if (!/^[A-Z0-9&._-]+$/.test(holding.symbol.trim().toUpperCase())) {
    return fetchTicker(await resolveTicker(holding));
  }
  const exchanges: ("NSE" | "BSE")[] = holding.exchange ? [holding.exchange, holding.exchange === "NSE" ? "BSE" : "NSE"] : ["NSE", "BSE"];
  let last: unknown;
  for (const exchange of exchanges) {
    try {
      return await fetchTicker(ticker(holding.symbol, exchange));
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("no verified NSE or BSE quote");
}

export async function refreshQuotes(
  holdings: Holding[],
  existing: Record<string, Quote>,
  onProgress?: (done: number, total: number) => void,
) {
  const unique = [...new Map(holdings.map(holding => [holding.symbol, holding])).values()];
  const quotes = { ...existing };
  const errors: string[] = [];
  let cursor = 0, done = 0;
  const workers = Array.from({ length: Math.min(8, unique.length) }, async () => {
    while (cursor < unique.length) {
      const holding = unique[cursor++];
      try {
        quotes[holding.symbol] = await quoteHolding(holding);
      } catch {
        if (!usable(quotes[holding.symbol])) errors.push(holding.symbol);
      } finally {
        done++;
        onProgress?.(done, unique.length);
      }
    }
  });
  await Promise.all(workers);
  return { quotes, errors, updated: unique.length - errors.length };
}
