import { describe, expect, it } from "vitest";
import { analysePerformance, monteCarlo, parseNavCSV, quantile, seriesStatistics } from "../src/performance";
import { blankState } from "../src/storage";
import { recordTrade, mergeStatementTrades } from "../src/transactions";
import { classifyHolding } from "../src/classification";
import type { PortfolioState, PricePoint, Trade } from "../src/types";

const series=(values:number[]):PricePoint[]=>values.map((value,i)=>({date:new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10),value}));
const buy:Trade={id:"manual-1",symbol:"RELIANCE",name:"Reliance",date:"2024-01-02",quantity:5,price:120,side:"BUY"};
function sampleState():PortfolioState {
  return {...blankState(),holdings:[{symbol:"A",name:"A",quantity:1,averagePrice:80,sector:"Tech"},{symbol:"B",name:"B",quantity:1,averagePrice:150,sector:"Bank"}],quotes:{
    A:{price:100,previousClose:90,ticker:"A.NS",source:"test",marketAt:new Date().toISOString(),fetchedAt:new Date().toISOString()},
    B:{price:200,previousClose:180,ticker:"B.NS",source:"test",marketAt:new Date().toISOString(),fetchedAt:new Date().toISOString()}},
    history:{nav:series([100,110,99,120]),benchmark:series([100,105,100,110]),assets:{A:series([100,110,99,120]),B:series([200,210,200,220])}}};
}
describe("cash-flow-safe manual purchase entry",()=>{
  it("updates quantity and weighted cost without treating a deposit as profit",()=>{
    const state={...blankState(),holdings:[{symbol:"RELIANCE",name:"Reliance",quantity:10,averagePrice:100}]};
    const result=recordTrade(state,buy);
    expect(result.holdings[0].quantity).toBe(15);expect(result.holdings[0].averagePrice).toBeCloseTo(1600/15);
    expect(result.holdings[0].sector).toBe("Oil Gas & Consumable Fuels");
    expect(result.trades[0].charges).toBeUndefined();expect(result.pendingManualHoldings).toEqual([buy.id]);
    expect(state.holdings[0].quantity).toBe(10);
  });
  it("rejects invalid inputs, impossible dates and double saves",()=>{
    expect(()=>recordTrade(blankState(),{...buy,quantity:-1})).toThrow();
    expect(()=>recordTrade(blankState(),{...buy,date:"2025-02-30"})).toThrow();
    expect(()=>recordTrade(blankState(),{...buy,date:"2099-01-01"})).toThrow();
    expect(()=>recordTrade(blankState(),{...buy,price:NaN})).toThrow();
    expect(()=>recordTrade(recordTrade(blankState(),buy),buy)).toThrow();
  });
  it("reconciles matching manual imports one-for-one, preserving extra identical entries",()=>{
    const manual={...buy,source:"manual" as const};
    const result=mergeStatementTrades([{...buy,id:"imported"}],[manual,{...manual,id:"manual2"}]);
    expect(result.map(t=>t.id)).toEqual(["imported","manual2"]);
  });
  it("matches sector by ISIN and does not fuzzy-match names",()=>{
    expect(classifyHolding({symbol:"arbitrary company name",isin:"INE002A01018",quantity:1,averagePrice:1,name:"X"}).sector).toBe("Oil Gas & Consumable Fuels");
    expect(classifyHolding({symbol:"Reliance Industries",quantity:1,averagePrice:1,name:"X"}).sector).toBeUndefined();
  });
});
describe("verified daily NAV inputs",()=>{
  it("rejects duplicates, invalid dates, invalid NAVs and totals mistaken for a supported schema",()=>{
    expect(()=>parseNavCSV("date,nav\n2024-01-01,100\n2024-01-01,101\n2024-01-03,102")).toThrow();
    expect(()=>parseNavCSV("date,nav\n2024-02-30,100\n2024-03-01,101\n2024-03-02,102")).toThrow();
    expect(()=>parseNavCSV("date,nav\n2024-01-01,100\n2024-01-02,0\n2024-01-03,102")).toThrow();
    expect(()=>parseNavCSV("date,value\n2024-01-01,100")).toThrow();
  });
  it("sorts daily history and preserves optional rupee values separately from per-unit NAV",()=>{
    const p=parseNavCSV("date,nav,portfolioValue\n2024-01-03,102,10000\n2024-01-01,100,9000\n2024-01-02,101,9500");
    expect(p[0]).toEqual({date:"2024-01-01",value:100,accountValue:9000});
  });
});
describe("risk, performance and drawdown arithmetic",()=>{
  it("computes hand-checked return and drawdown paths",()=>{
    const {metrics:m}=seriesStatistics(series([100,120,90,100,125]));
    expect(m[24].value).toBeCloseTo(25);expect(m[43].value).toBeCloseTo(-25);
    expect(m[44].value).toBeCloseTo((-25-100/6)/2);
    expect(m[45].value).toBe(1);expect(m[46].value).toBe(2);expect(m[47].value).toBe(2);
    expect(m[53].value).toBe(1);expect(m[36].value).toBe(75);expect(m[25].value).toBeNull();
  });
  it("requires 252 returns for one-year historical tail metrics",()=>{
    expect(seriesStatistics(series(Array.from({length:252},(_,i)=>100+i))).metrics[1]).toBeUndefined();
    const m=seriesStatistics(series(Array.from({length:253},(_,i)=>100*Math.exp(i%2 ? -.01:.01)))).metrics;
    expect(m[1].value).toBeCloseTo((1-Math.exp(-.02))*100);
    expect(m[6].value).toBeCloseTo(m[1].value as number);
    expect(m[8].value).toBeCloseTo(1);
  });
  it("uses interpolated quantiles and handles constant returns without infinity",()=>{
    expect(quantile([1,2,3,4,5],.05)).toBeCloseTo(1.2);
    const m=seriesStatistics(series([100,100,100,100])).metrics;
    expect(m[0].value).toBe(0);expect(m[28].value).toBeNull();expect(m[38].value).toBeNull();
    expect(m[17].value).toBeNull();expect(m[18].value).toBeNull();
  });
  it("simulates known Gaussian risk reproducibly and supports perfectly correlated assets",()=>{
    const single=monteCarlo([[.0001]],[1],10000)!;
    expect(single).toBeGreaterThan(.0158);expect(single).toBeLessThan(.0172);
    expect(monteCarlo([[.0001]],[1],10000)).toBe(single);
    const shared=monteCarlo([[.0001,.0001],[.0001,.0001]],[.5,.5],10000)!;
    expect(shared).toBeGreaterThan(.0158);expect(shared).toBeLessThan(.0172);
    expect(monteCarlo([[1,2],[2,1]],[.5,.5],100)).toBeNull();
  });
});
describe("same-period Nifty comparison and current composition",()=>{
  it("aligns identical endpoints, rebases to 100 and computes excess return",()=>{
    const s=sampleState(),r=analysePerformance(s,"actual","2024-01-02","2024-01-04",0,0);
    expect(r.curve[0].portfolio).toBe(100);expect(r.curve[0].nifty).toBe(100);expect(r.curve).toHaveLength(3);
    expect(r.portfolio.metrics[41].value).toBeCloseTo((120/110-110/105)*100);
    expect(r.portfolio.metrics[15].value).not.toBeNull();
  });
  it("blocks daily metrics across interior session gaps",()=>{
    const s=sampleState();s.history!.nav.splice(1,1);
    const r=analysePerformance(s,"actual","","2099-01-01",0,0);
    expect(r.curve).toHaveLength(0);expect(r.portfolio.metrics[0]).toBeUndefined();expect(r.coverage).toContain("Missing an interior");
  });
  it("keeps current allocation and cash metrics separate from the history window",()=>{
    const s=sampleState();s.cash=100;
    const r=analysePerformance(s,"actual","2024-01-01","2024-01-04",0,0);
    expect(r.sector.find(s=>s.name==="Bank")!.weight).toBeCloseTo(200/3);
    expect(r.portfolio.metrics[79].value).toBe(25);expect(r.portfolio.metrics[76].value).toBe(75);
    expect(r.portfolio.metrics[71].value).toBeCloseTo(5/9);expect(r.portfolio.metrics[70].value).toBeCloseTo(1.8);
    expect(r.benchmark.metrics[71]).toBeUndefined();
  });
  it("does not infer cash or allocation weights from partially priced holdings",()=>{
    const s=sampleState();delete s.quotes.B;
    const r=analysePerformance(s,"model","","2099-01-01",0,0);
    expect(r.portfolio.metrics[71].value).toBeNull();expect(r.portfolio.metrics[79]).toBeUndefined();expect(r.curve).toHaveLength(0);
  });
  it("responds to live prices in the current-holdings model, without changing actual NAV",()=>{
    const s=sampleState();const before=analysePerformance(s,"model","","2099-01-01",0,0);s.quotes.A.price=300;
    const after=analysePerformance(s,"model","","2099-01-01",0,0);
    expect(after.curve[3].portfolio).not.toBeCloseTo(before.curve[3].portfolio);
    expect(analysePerformance(s,"actual","","2099-01-01",0,0).portfolio.metrics[24].value).toBeCloseTo(20);
  });
});
