// Quote implementation vendored from prabhav-patel-ops/LotBook
// Revision: f06e5b50e9102174fb7e2b7c041f0fdf3795d441
// Changes: expose symbol discovery; retain ticker and previousClose metadata.
// Quote credentials and cache stay on this device, outside the exported diary.
export const MARKET_KEY = 'lotbook.market-key.v1';
export const MARKET_CACHE_KEY = 'lotbook.market-cache.v1';
export const MARKET_INTERVAL_KEY = 'lotbook.market-interval.v1';
export const MARKET_INTERVAL_MS = 60 * 60 * 1000;
export const MARKET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function marketTicker(symbol) {
  // Some broker exports append a display marker after the exchange ticker.
  const text = String(symbol || '').trim().toUpperCase().replace(/\$$/, '');
  const match = /^(?:(NSE|BSE):)?([A-Z0-9&._-]+)$/.exec(text);
  if (!match) return null;
  const suffix = /\.(NS|BO)$/.exec(match[2]);
  return { exchange: match[1] || (suffix?.[1] === 'BO' ? 'BSE' : 'NSE'), ticker: match[2].replace(/\.(NS|BO)$/, '') };
}

export function marketIntervalMs(storage) {
  const minutes = Number(storage.getItem(MARKET_INTERVAL_KEY));
  return [15, 30, 60, 120].includes(minutes) ? minutes * 60 * 1000 : MARKET_INTERVAL_MS;
}

export function readMarketCache(storage) {
  try {
    const raw = JSON.parse(storage.getItem(MARKET_CACHE_KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([symbol, quote]) =>
      marketTicker(symbol) && quote && Number.isFinite(quote.price) && quote.price > 0 &&
      typeof quote.fetchedAt === 'string' && Number.isFinite(Date.parse(quote.fetchedAt))));
  } catch { return {}; }
}

export function usableMarketQuote(quote, now = Date.now()) {
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return false;
  const age = now - Date.parse(quote.fetchedAt);
  const marketAge = quote.marketAt ? now - Date.parse(quote.marketAt) : age;
  return Number.isFinite(age) && age >= -5 * 60 * 1000 && age <= MARKET_MAX_AGE_MS &&
    Number.isFinite(marketAge) && marketAge >= -5 * 60 * 1000 && marketAge <= MARKET_MAX_AGE_MS;
}

/** Temporary keyless personal-use fallback. Only the ticker is sent to Jina/Yahoo. */
export function parseYahooQuote(payload, symbol, fetchedAt = new Date().toISOString()) {
  const wanted = marketTicker(symbol);
  const suffix = wanted?.exchange === 'BSE' ? '.BO' : '.NS';
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta;
  if (!wanted || payload?.chart?.error || meta?.symbol !== `${wanted.ticker}${suffix}` || meta?.currency !== 'INR')
    throw Error(`Yahoo quote identity or currency could not be verified for ${symbol}.`);
  const price = Number(meta.regularMarketPrice);
  const stamp = Number(meta.regularMarketTime) * 1000;
  if (!Number.isFinite(stamp) || stamp <= 0) throw Error(`Yahoo returned no market timestamp for ${symbol}.`);
  const marketAt = new Date(stamp).toISOString();
  if (!Number.isFinite(price) || price <= 0 || !usableMarketQuote({price,fetchedAt,marketAt}))
    throw Error(`Yahoo returned no usable recent market price for ${symbol}.`);
  const prior = Number(meta.chartPreviousClose ?? meta.previousClose);
  return {price,fetchedAt,marketAt,exchange:wanted.exchange,ticker:meta.symbol,previousClose:Number.isFinite(prior) && prior > 0 ? prior : null,source:'Yahoo via Jina (unofficial)'};
}

const COMPANY_NOISE = new Set(['LIMITED','LTD','THE','OF','INDIA','IND','AND','COMPANY','CO']);
const companyTokens = name => String(name || '').toUpperCase().replace(/&/g, ' AND ')
  .replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  .filter(token => !COMPANY_NOISE.has(token));
const companyKey = name => companyTokens(name).join('');
const companyAcronym = name => companyTokens(name).map(token => token[0]).join('');
const companyLegalAcronym = name => String(name || '').toUpperCase().replace(/&/g, ' AND ')
  .replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  .filter(token => !new Set(['THE','OF','INDIA','IND','AND','COMPANY','CO']).has(token))
  .map(token => token[0]).join('');
export function companyIdentityMatches(expected, actual, ticker = '') {
  const expectedKey = companyKey(expected), actualKey = companyKey(actual);
  if (!expectedKey || !actualKey) return false;
  if (actualKey.includes(expectedKey) || expectedKey.includes(actualKey)) return true;
  const expectedAcronyms = new Set([companyAcronym(expected), companyLegalAcronym(expected)].filter(value => value.length >= 2));
  const actualAcronyms = new Set([companyAcronym(actual), companyLegalAcronym(actual)].filter(value => value.length >= 2));
  const wantedTicker = marketTicker(ticker)?.ticker || String(ticker || '').toUpperCase().replace(/\$$/, '');
  return [...expectedAcronyms].some(value => actualAcronyms.has(value)) ||
    (expectedKey === wantedTicker && actualAcronyms.has(wantedTicker));
}
export async function fetchYahooFallback(symbol, fetcher = fetch, companyName = '') {
  const mapped = marketTicker(symbol);
  if (!mapped) throw Error(`Unsupported market symbol ${symbol}.`);
  const suffixes = mapped.exchange === 'BSE' ? ['.BO'] : ['.NS', '.BO'];
  let lastError;
  for (const suffix of suffixes) {
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(mapped.ticker + suffix)}?range=1d%26interval=1d`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(`https://r.jina.ai/${target}`, {
        headers:{'X-No-Cache':'true',accept:'text/plain'},signal:controller.signal,cache:'no-store',
      });
      if (!response.ok) throw Error(`Free quote relay returned ${response.status}.`);
      const text = await response.text();
      const marker = text.indexOf('Markdown Content:');
      const start = text.indexOf('{', marker);
      if (marker < 0 || start < 0 || text.length > 100000) throw Error('Free quote relay returned an unexpected format.');
      const payload = JSON.parse(text.slice(start).trim());
      if (suffix === '.BO' && mapped.exchange !== 'BSE') {
        const meta = payload?.chart?.result?.[0]?.meta;
        const actualName = meta?.longName || meta?.shortName;
        if (!companyIdentityMatches(companyName, actualName, mapped.ticker))
          throw Error(`${symbol}: BSE fallback identity could not be confirmed against the stock name.`);
      }
      return parseYahooQuote(payload, `${mapped.ticker}${suffix}`);
    } catch(error) {
      lastError = error;
    } finally { clearTimeout(timeout); }
  }
  if (lastError?.name === 'AbortError') throw Error('Free quote request timed out.');
  if (lastError instanceof TypeError || lastError instanceof SyntaxError) throw Error('Free quote relay could not be read in this browser.');
  throw lastError;
}

// Jina currently rejects longer nested Yahoo URLs even when it returns HTTP
// 200. Ten Indian symbols keep the relay URL below that failure threshold.
const YAHOO_BATCH_SIZE = 10;
const chunks = (items, size = YAHOO_BATCH_SIZE) => {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};
async function fetchYahooSpark(entries, suffix, fetcher, fetchedAt) {
  if (!entries.length) return {quotes:{}, missing:[]};
  const symbols = entries.map(entry => `${entry.ticker}${suffix}`);
  // Jina decodes the nested target URL once. Ampersands inside exchange tickers
  // therefore need a second layer so Yahoo receives them as part of the symbol.
  const encodedSymbols = symbols.map(symbol => encodeURIComponent(symbol).replace(/%26/g, '%2526')).join('%2C');
  const target = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodedSymbols}%26range=1d%26interval=1d`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(`https://r.jina.ai/${target}`, {
      headers:{'X-No-Cache':'true',accept:'text/plain'},signal:controller.signal,cache:'no-store',
    });
    if (!response.ok) throw Error(`Free quote relay returned ${response.status}.`);
    const text = await response.text();
    const marker = text.indexOf('Markdown Content:');
    const start = text.indexOf('{', marker);
    if (marker < 0 || start < 0 || text.length > 500000) throw Error('Free quote relay returned an unexpected batch format.');
    const payload = JSON.parse(text.slice(start).trim());
    if (payload?.spark?.error) throw Error('Yahoo returned a batch quote error.');
    const results = Array.isArray(payload?.spark?.result) ? payload.spark.result : [];
    const bySymbol = new Map(results.map(result => [result?.symbol, result?.response?.[0]]));
    const quotes = {}, missing = [];
    for (const entry of entries) {
      const yahooSymbol = `${entry.ticker}${suffix}`;
      const result = bySymbol.get(yahooSymbol);
      if (!result) { missing.push(entry); continue; }
      if (suffix === '.BO' && entry.verifyBse && !companyIdentityMatches(entry.companyName, result?.meta?.longName || result?.meta?.shortName, entry.ticker)) {
        missing.push(entry);
        continue;
      }
      try { quotes[entry.symbol] = parseYahooQuote({chart:{result:[result],error:null}}, yahooSymbol, fetchedAt); }
      catch { missing.push(entry); }
    }
    return {quotes, missing};
  } finally { clearTimeout(timeout); }
}

const retryPause = () => new Promise(resolve => setTimeout(resolve, 350));
async function fetchYahooSparkWithRetry(entries, suffix, fetcher, fetchedAt) {
  try { return await fetchYahooSpark(entries, suffix, fetcher, fetchedAt); }
  catch {
    await retryPause();
    return fetchYahooSpark(entries, suffix, fetcher, fetchedAt);
  }
}

export async function discoverYahooSymbol(entry, fetcher) {
  if (companyTokens(entry.companyName).length < 2) return null;
  const query = encodeURIComponent(entry.companyName).replace(/%26/g, '%2526');
  const target = `https://query1.finance.yahoo.com/v1/finance/search?q=${query}%26quotesCount=8%26newsCount=0`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(`https://r.jina.ai/${target}`, {
      headers:{'X-No-Cache':'true',accept:'text/plain'},signal:controller.signal,cache:'no-store',
    });
    if (!response.ok) return null;
    const text = await response.text();
    const marker = text.indexOf('Markdown Content:');
    const start = text.indexOf('{', marker);
    if (marker < 0 || start < 0 || text.length > 200000) return null;
    const payload = JSON.parse(text.slice(start).trim());
    const candidates = (Array.isArray(payload?.quotes) ? payload.quotes : []).map(candidate => {
      const match = /^(.+)\.(NS|BO)$/.exec(String(candidate?.symbol || '').toUpperCase());
      if (!match || candidate?.quoteType !== 'EQUITY') return null;
      const actualName = candidate.longname || candidate.shortname;
      return companyIdentityMatches(entry.companyName, actualName, match[1])
        ? {...entry,ticker:match[1],suffix:match[2] === 'BO' ? '.BO' : '.NS',verifyBse:true}
        : null;
    }).filter(Boolean);
    const preferred = entry.exchange === 'BSE' ? ['.BO','.NS'] : ['.NS','.BO'];
    return preferred.map(suffix => candidates.find(candidate => candidate.suffix === suffix)).find(Boolean) || null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

export async function fetchYahooBatchQuotes(holdings, fetcher = fetch, fetchedAt = new Date().toISOString()) {
  const entries = holdings.map(holding => {
    const mapped = marketTicker(holding?.symbol);
    return mapped ? {symbol:holding.symbol,companyName:holding.name || '',ticker:mapped.ticker,exchange:mapped.exchange,verifyBse:mapped.exchange !== 'BSE'} : null;
  }).filter(Boolean);
  const quotes = {}, unresolved = [];
  const initialGroups = [
    {suffix:'.NS', entries:entries.filter(entry => entry.exchange !== 'BSE')},
    {suffix:'.BO', entries:entries.filter(entry => entry.exchange === 'BSE').map(entry => ({...entry,verifyBse:false}))},
  ];
  for (const group of initialGroups) {
    const batches = chunks(group.entries);
    for (const batch of batches) {
      try {
        const result = await fetchYahooSparkWithRetry(batch, group.suffix, fetcher, fetchedAt);
        Object.assign(quotes, result.quotes);
        unresolved.push(...result.missing);
      } catch { unresolved.push(...batch); }
    }
  }
  const bseFallback = unresolved.filter(entry => entry.exchange !== 'BSE');
  const fallbackBatches = chunks(bseFallback);
  const stillMissing = [];
  for (const batch of fallbackBatches) {
    try {
      const result = await fetchYahooSparkWithRetry(batch, '.BO', fetcher, fetchedAt);
      Object.assign(quotes, result.quotes);
      stillMissing.push(...result.missing);
    } catch { stillMissing.push(...batch); }
  }
  stillMissing.push(...unresolved.filter(entry => entry.exchange === 'BSE'));

  // Broker statements can retain an old exchange ticker after a rename or
  // demerger. Discover the current Yahoo symbol from the company identity,
  // then verify its INR quote; no ticker-specific rename table is required.
  const discovered = [];
  const finalMissing = [];
  for (const entry of stillMissing) {
    const candidate = await discoverYahooSymbol(entry, fetcher);
    if (candidate) discovered.push(candidate);
    else finalMissing.push(entry);
  }
  for (const suffix of ['.NS','.BO']) {
    for (const batch of chunks(discovered.filter(entry => entry.suffix === suffix))) {
      try {
        const result = await fetchYahooSparkWithRetry(batch, suffix, fetcher, fetchedAt);
        Object.assign(quotes, result.quotes);
        finalMissing.push(...result.missing);
      } catch { finalMissing.push(...batch); }
    }
  }
  return {quotes, errors:finalMissing.map(entry => `${entry.symbol}: no verified NSE or BSE quote was returned`)};
}

