import { afterEach,describe,expect,it,vi } from "vitest";
import { fetchDailyHistory,marketFetch,refreshQuotes,usable } from "../src/market";
import { historyDue,marketIsOpen,priceCoverage,refreshNotice } from "../src/market-status";
import { blankState } from "../src/storage";
import type { Holding,Quote } from "../src/types";

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const holdings=(n:number):Holding[]=>Array.from({length:n},(_,i)=>({symbol:`TEST${i}`,name:`Company ${i} Limited`,quantity:1,averagePrice:80}));
const relay=(data:unknown)=>new Response(`Title:\n\nMarkdown Content:\n${JSON.stringify(data)}`);
const symbols=(url:string)=>decodeURIComponent(decodeURIComponent(url.split("symbols=")[1].split("%26range")[0])).split(",");
const result=(symbol:string,name="Verified Company Limited")=>({symbol,response:[{meta:{symbol,currency:"INR",longName:name,regularMarketPrice:100,chartPreviousClose:95,regularMarketTime:Math.floor(Date.now()/1000)}}]});
const spark=(s:string[])=>relay({spark:{result:s.map(symbol=>result(symbol)),error:null}});
const cached=():Quote=>({price:91,previousClose:90,marketAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),ticker:"A.NS",source:"cached"});

describe("LotBook batching reused by MyPortfolio",()=>{
  it("refreshes the screenshot-sized 19-holding book in two sequential requests",async()=>{
    const requested:string[]=[],progress:number[]=[];let active=0,maxActive=0;
    const fetcher=(async(input)=>{
      const url=String(input);requested.push(url);active++;maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setTimeout(resolve,1));active--;
      return spark(symbols(url));
    }) as typeof fetch;
    const r=await refreshQuotes(holdings(19),{},done=>progress.push(done),fetcher);
    expect(requested).toHaveLength(2);expect(requested.map(url=>symbols(url).length)).toEqual([10,9]);expect(maxActive).toBe(1);
    expect(r.updated).toBe(19);expect(r.errors).toEqual([]);expect(r.retainedSymbols).toEqual([]);expect(r.missingSymbols).toEqual([]);
    expect(r.quotes.TEST0.previousClose).toBe(95);expect(r.quotes.TEST0.ticker).toBe("TEST0.NS");expect(progress).toEqual([0,19]);
  });
  it("keeps the existing LotBook 70-holding, seven-request guarantee",async()=>{
    let requests=0;const fetcher=(async(input)=>{requests++;return spark(symbols(String(input)));}) as typeof fetch;
    const r=await refreshQuotes(holdings(70),{},undefined,fetcher);
    expect(requests).toBe(7);expect(r.updated).toBe(70);
  });
  it("retries a rate-limited batch once and succeeds without per-stock requests",async()=>{
    const requested:string[]=[];
    const fetcher=(async(input)=>{requested.push(String(input));return requested.length===1?new Response("rate limited",{status:429}):spark(symbols(String(input)));}) as typeof fetch;
    const r=await refreshQuotes(holdings(19),{},undefined,fetcher);
    expect(r.updated).toBe(19);expect(requested).toHaveLength(3);expect(requested[1]).toBe(requested[0]);
  });
  it("keeps ampersands inside ticker names through the nested relay URL",async()=>{
    let requested="";const fetcher=(async(input)=>{requested=String(input);return spark(symbols(requested));}) as typeof fetch;
    const r=await refreshQuotes([{symbol:"M&M",name:"Mahindra & Mahindra",quantity:1,averagePrice:1}],{},undefined,fetcher);
    expect(requested).toContain("M%2526M.NS");expect(r.updated).toBe(1);expect(r.quotes["M&M"].ticker).toBe("M&M.NS");
  });
  it("honours an explicit BSE listing without guessing a same-named NSE listing",async()=>{
    const requested:string[]=[];const fetcher=(async(input)=>{requested.push(String(input));return spark(symbols(String(input)));}) as typeof fetch;
    const r=await refreshQuotes([{symbol:"NSDL",exchange:"BSE",name:"National Securities Depository Limited",quantity:1,averagePrice:1}],{},undefined,fetcher);
    expect(requested).toHaveLength(1);expect(requested[0]).toContain("NSDL.BO");expect(r.quotes.NSDL.ticker).toBe("NSDL.BO");
  });
  it("verifies company identity before accepting a BSE fallback",async()=>{
    const fetcher=(async(input)=>{
      const url=String(input);
      if(url.includes("/search")) return relay({quotes:[]});
      return relay({spark:{result:symbols(url).filter(s=>s.endsWith(".BO")).map(s=>result(s,"Unrelated Widgets Limited")),error:null}});
    }) as typeof fetch;
    const r=await refreshQuotes([{symbol:"ABC",name:"Verified Pharma Limited",quantity:1,averagePrice:1}],{},undefined,fetcher);
    expect(r.updated).toBe(0);expect(r.missingSymbols).toEqual(["ABC"]);
  });
  it("retains renamed security resolution from LotBook",async()=>{
    const fetcher=(async(input)=>{
      const url=String(input);
      if(url.includes("/search"))return relay({quotes:[{symbol:"CURRENT.NS",quoteType:"EQUITY",longname:"Verified Pharma Limited"}]});
      return relay({spark:{result:symbols(url).filter(s=>s==="CURRENT.NS").map(s=>result(s,"Verified Pharma Limited")),error:null}});
    }) as typeof fetch;
    const r=await refreshQuotes([{symbol:"OLD",name:"Verified Pharma Limited",quantity:1,averagePrice:1}],{},undefined,fetcher);
    expect(r.updated).toBe(1);expect(r.quotes.OLD.ticker).toBe("CURRENT.NS");
  });
});

describe("honest refresh status and scheduling",()=>{
  it("paces quote and history traffic through a single shared transport",async()=>{
    vi.useFakeTimers();const starts:number[]=[];
    vi.stubGlobal("fetch",vi.fn(async()=>{starts.push(Date.now());return new Response("ok");}));
    const work=Promise.all([marketFetch("https://example.test/quotes"),marketFetch("https://example.test/history"),marketFetch("https://example.test/quotes2")]);
    await vi.advanceTimersByTimeAsync(11000);await work;
    expect(starts).toHaveLength(3);expect(starts[1]-starts[0]).toBeGreaterThanOrEqual(3500);expect(starts[2]-starts[1]).toBeGreaterThanOrEqual(3500);
  });
  it("separates successfully checked, retained, missing and expired prices",async()=>{
    const h=holdings(4),old=cached();
    const fetcher=(async(input)=>{
      const url=String(input);if(url.includes("/search"))return relay({quotes:[]});
      return relay({spark:{result:symbols(url).filter(s=>s==="TEST0.NS").map(s=>result(s)),error:null}});
    }) as typeof fetch;
    const r=await refreshQuotes(h,{TEST1:old,TEST2:{...old,marketAt:"2020-01-01T00:00:00Z",fetchedAt:"2020-01-01T00:00:00Z"}},undefined,fetcher);
    expect(r.refreshedSymbols).toEqual(["TEST0"]);expect(r.retainedSymbols).toEqual(["TEST1"]);expect(r.missingSymbols).toEqual(["TEST2","TEST3"]);
    expect(r.quotes.TEST1).toEqual(old);expect(r.quotes.TEST2).toBeUndefined();
    expect(refreshNotice(r)).toBe("1 prices checked successfully · 1 saved prices retained after failed checks · 2 holdings have no usable price. Quotes may be delayed.");
    const coverage=priceCoverage({...blankState(),holdings:h,quotes:r.quotes,quoteRefresh:r});
    expect(coverage).toEqual({available:2,refreshed:1,retained:1,missing:2});
  });
  it("rejects a stale fetch timestamp even when the market timestamp looks current",()=>{
    expect(usable({...cached(),fetchedAt:"2020-01-01T00:00:00Z"})).toBe(false);
  });
  it("does not instantly retry incomplete history after every price refresh",()=>{
    const now=Date.now();const state={...blankState(),holdings:holdings(19),history:{nav:[],benchmark:[],assets:{},fetchedAt:new Date(now).toISOString(),errors:["TEST0"]}};
    expect(historyDue(state,now+5*60*1000)).toBe(false);expect(historyDue(state,now+61*60*1000)).toBe(true);
  });
  it("uses India time for regular weekday market hours",()=>{
    expect(marketIsOpen(new Date("2026-10-20T03:44:00Z"))).toBe(false);
    expect(marketIsOpen(new Date("2026-10-20T03:45:00Z"))).toBe(true);
    expect(marketIsOpen(new Date("2026-10-20T10:01:00Z"))).toBe(false);
    expect(marketIsOpen(new Date("2026-10-18T05:00:00Z"))).toBe(false);
  });
  it("keeps all history parameters and ampersands correctly nested",async()=>{
    vi.stubGlobal("window",{setTimeout,clearTimeout});let requested="";
    const fetcher=(async(input)=>{requested=String(input);return relay({chart:{result:[{meta:{symbol:"M&M.NS",currency:"INR"},timestamp:[Date.parse("2026-10-01")/1000],indicators:{adjclose:[{adjclose:[100]}]}}],error:null}});}) as typeof fetch;
    expect(await fetchDailyHistory("M&M.NS",fetcher)).toEqual([{date:"2026-10-01",value:100}]);
    expect(requested).toContain("M%2526M.NS?range=10y%26interval=1d");
  });
});
