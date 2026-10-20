import type { PortfolioState, QuoteRefresh } from "./types";
import { usable } from "./market";

export const AUTO_REFRESH_MS=5*60*1000;
export function marketIsOpen(now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Kolkata",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now).map(p=>[p.type,p.value]));
  const minutes=Number(parts.hour)*60+Number(parts.minute);
  return !["Sat","Sun"].includes(parts.weekday) && minutes>=555 && minutes<=930;
}
export function refreshNotice(result:QuoteRefresh) {
  const parts=[`${result.refreshedSymbols.length} prices checked successfully`];
  if(result.retainedSymbols.length) parts.push(`${result.retainedSymbols.length} saved prices retained after failed checks`);
  if(result.missingSymbols.length) parts.push(`${result.missingSymbols.length} holdings have no usable price`);
  return `${parts.join(" · ")}. Quotes may be delayed.`;
}
export function priceCoverage(state:PortfolioState) {
  const available=state.holdings.filter(h=>usable(state.quotes[h.symbol]));
  const last=state.quoteRefresh;
  const symbols=new Set(available.map(h=>h.symbol));
  const refreshed=last?.refreshedSymbols.filter(s=>symbols.has(s)).length || 0;
  const retained=last?.retainedSymbols.filter(s=>symbols.has(s)).length || 0;
  return { available:available.length,refreshed,retained,missing:state.holdings.length-available.length };
}
export function historyDue(state:PortfolioState,now=Date.now()) {
  const last=Date.parse(state.history?.fetchedAt || "");
  // Failed/incomplete loads get the same cooldown as successful attempts.
  if(Number.isFinite(last) && now-last<60*60*1000) return false;
  if(!state.history?.benchmark.length || state.holdings.some(h=>!state.history?.assets[h.symbol]?.length)) return true;
  const localHour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Kolkata",hour:"2-digit",hourCycle:"h23"}).format(new Date(now)));
  return localHour>=16 && (!Number.isFinite(last)||now-last>=12*60*60*1000);
}
