import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDailyHistory, refreshQuotes } from "../src/market";
import { analysePortfolio } from "../src/analytics";

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const environment=()=>{vi.stubGlobal("window",{setTimeout,clearTimeout});};
describe("market data identity and freshness",()=>{
  it("excludes today's incomplete daily candle and missing prices",async()=>{
    environment();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-20T08:00:00Z"));
    const payload={chart:{result:[{meta:{symbol:"^NSEI",currency:"INR"},timestamp:[1792368000,1792454400,1792540800],indicators:{quote:[{close:[100,null,102]}]}}]}};
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(`Markdown Content:\n${JSON.stringify(payload)}`)));
    const points=await fetchDailyHistory("^NSEI",fetch);expect(points).toEqual([{date:"2026-10-19",value:100}]);
  });
  it("rejects a historical response for another instrument",async()=>{
    environment();vi.stubGlobal("fetch",vi.fn(async()=>new Response(`Markdown Content:\n${JSON.stringify({chart:{result:[{meta:{symbol:"WRONG",currency:"USD"}}]}})}`)));
    await expect(fetchDailyHistory("^NSEI",fetch)).rejects.toThrow("identity");
  });
  it("does not claim a cached quote was freshly updated when requests fail",async()=>{
    environment();vi.stubGlobal("fetch",vi.fn(async()=>new Response("unavailable",{status:503})));
    const cached={price:100,previousClose:90,marketAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),ticker:"A.NS",source:"test"};
    const result=await refreshQuotes([{symbol:"A",name:"A",quantity:1,averagePrice:80}],{A:cached},undefined,fetch);
    expect(result.updated).toBe(0);expect(result.errors).toEqual(["A"]);expect(result.quotes.A).toEqual(cached);
  });
  it("does not count expired or invalid cached quotes as priced holdings",()=>{
    const result=analysePortfolio([{symbol:"A",name:"A",quantity:1,averagePrice:80}],{A:{price:100,previousClose:90,marketAt:"2020-01-01T00:00:00Z",fetchedAt:"2020-01-01T00:00:00Z",ticker:"A.NS",source:"test"}},[]);
    expect(result.totals.missing).toBe(1);expect(result.totals.currentValue).toBe(0);
  });
});
