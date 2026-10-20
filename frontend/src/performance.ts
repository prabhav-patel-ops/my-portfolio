import Papa from "papaparse";
import type { PricePoint, PortfolioState } from "./types";
import { analysePortfolio } from "./analytics";

export const sum = (v: number[]) => v.reduce((a,b) => a+b,0);
export const mean = (v: number[]) => v.length ? sum(v)/v.length : 0;
export const variance = (v: number[]) => {const avg=mean(v);return v.length > 1 ? sum(v.map(x => (x-avg)**2))/(v.length-1) : 0;};
export const sd = (v: number[]) => Math.sqrt(variance(v));
export const cov = (a: number[], b: number[]) => {const ma=mean(a),mb=mean(b);return a.length > 1 && a.length === b.length ? sum(a.map((x,i) => (x-ma)*(b[i]-mb)))/(a.length-1) : 0;};
export const divide = (a: number, b: number): number | null => Math.abs(b) > 1e-14 && Number.isFinite(a/b) ? a/b : null;
export function quantile(values: number[], p: number) {
  const v = [...values].sort((a,b) => a-b), pos = (v.length-1)*p, i = Math.floor(pos);
  return v.length ? v[i] + (v[Math.min(i+1,v.length-1)]-v[i])*(pos-i) : 0;
}
export function parseNavCSV(text: string): PricePoint[] {
  const parsed = Papa.parse<Record<string,string>>(text, { header: true, skipEmptyLines: true, transformHeader: s => s.replace(/^\uFEFF/, "").trim().toLowerCase() });
  if (parsed.errors.length || !parsed.meta.fields?.includes("date") || !parsed.meta.fields.includes("nav")) throw Error("Use CSV columns date,nav. NAV must already exclude deposits and withdrawals (unitised NAV).");
  const seen = new Set<string>();
  const points = parsed.data.map(row => {
    const date = row.date?.trim(), value = Number(row.nav);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || date > new Date().toISOString().slice(0,10) || !Number.isFinite(value) || value <= 0 || seen.has(date)) throw Error("Each NAV needs a unique valid YYYY-MM-DD date and a positive number. Future dates are not accepted.");
    const accountValue = row.portfoliovalue?.trim() ? Number(row.portfoliovalue) : undefined;
    if(accountValue !== undefined && (!Number.isFinite(accountValue)||accountValue<=0)) throw Error("Optional portfolioValue must be a positive account market value in rupees.");
    seen.add(date); return { date, value, accountValue };
  }).sort((a,b) => a.date.localeCompare(b.date));
  if (points.length < 3 || points.length > 10000) throw Error("Supply 3–10,000 daily NAV observations.");
  return points;
}

export type MetricValue = { value: number | string | null; unit?: "%" | "₹" | "days" | "×"; note?: string };
export type MetricMap = Record<number, MetricValue>;
type CurvePoint = { date: string; portfolio: number; nifty: number; portfolioDrawdown: number; niftyDrawdown: number; highWater: number; excess: number; rolling1M: number | null; rolling3M: number | null; rolling1Y: number | null; niftyRolling1M: number | null; niftyRolling3M: number | null; niftyRolling1Y: number | null; rollingVol: number | null; niftyRollingVol: number | null; rollingSharpe: number | null; niftyRollingSharpe: number | null; rollingVaR: number | null; niftyRollingVaR: number | null; daily: number | null; niftyDaily: number | null };

export function seriesStatistics(points: PricePoint[], riskFree = 0, mar = 0) {
  const metrics: MetricMap = {};
  const set = (id: number, value: number | string | null, unit?: MetricValue["unit"], note?: string) => { metrics[id] = { value: typeof value === "number" && !Number.isFinite(value) ? null : value, unit, note }; };
  if (points.length < 3) return { metrics, returns: [] as number[], drawdowns: [] as number[] };
  const returns = points.slice(1).map((p,i) => p.value/points[i].value-1);
  const n = returns.length, avg = mean(returns), vol = sd(returns)*Math.sqrt(252);
  const dailyRf = (1+riskFree)**(1/252)-1, dailyMar = (1+mar)**(1/252)-1;
  const downside = Math.sqrt(mean(returns.map(r => Math.min(0,r-dailyMar)**2)))*Math.sqrt(252);
  const total = points[points.length-1].value/points[0].value-1;
  const days = (Date.parse(points[points.length-1].date)-Date.parse(points[0].date))/86400000;
  const cagr = days >= 365 ? (1+total)**(365/days)-1 : null;
  let peak = points[0].value, peakIndex = 0, episode: { peak: number; trough: number; depth: number; recovery?: number } | null = null;
  const episodes: { peak: number; trough: number; depth: number; recovery?: number }[] = [];
  const drawdowns = points.map((p,i) => {
    if (p.value >= peak) {
      if (episode) { episode.recovery = i; episodes.push(episode); episode = null; }
      peak = p.value; peakIndex = i;
    }
    const dd = p.value/peak-1;
    if (dd < 0) {
      if (!episode) episode = { peak: peakIndex, trough: i, depth: dd };
      if (dd < episode.depth) { episode.trough = i; episode.depth = dd; }
    }
    return dd;
  });
  if (episode) episodes.push(episode);
  const worst = [...episodes].sort((a,b) => a.depth-b.depth)[0];
  const mdd = Math.min(...drawdowns), pain = mean(drawdowns.map(Math.abs));
  const wins = returns.filter(r => r > 0), losses = returns.filter(r => r < 0);
  const monthly = new Map<string, number>();
  returns.forEach((r,i) => { const m = points[i+1].date.slice(0,7); monthly.set(m,(monthly.get(m) || 1)*(1+r)); });
  // Exclude boundary months: their full month-start/end closes may be missing.
  const months = [...monthly].filter(([m]) => m > points[0].date.slice(0,7) && m < points[points.length-1].date.slice(0,7)).map(([,v]) => v-1);
  set(0,vol*100,"%",`${n} daily returns; sample standard deviation × √252`);
  const tail = returns.slice(-252);
  if (tail.length === 252) {
    const var95 = Math.max(0,-quantile(tail,.05)), var99 = Math.max(0,-quantile(tail,.01));
    const es = Math.max(0,-mean(tail.filter(r => r <= quantile(tail,.05))));
    set(1,var95*100,"%","252-day historical loss rate; see current-value ₹ equivalent."); set(2,var99*100,"%"); set(6,es*100,"%");
    set(7,divide(var99,var95),"×"); set(8,divide(var95,es),"×");
    set(9,var95 ? (1.645*sd(tail)-var95)/var95*100 : null,"%");
  }
  if (tail.length === 252) { set(3,1.645*sd(tail)*100,"%","Zero-mean normal model; trailing 252 sessions."); set(4,2.326*sd(tail)*100,"%"); }
  set(13,vol < .15 ? "Low" : vol < .25 ? "Moderate" : vol < .35 ? "High" : "Very high");
  set(16,downside*100,"%");
  const popSD = Math.sqrt(mean(returns.map(r => (r-avg)**2)));
  set(17,popSD ? mean(returns.map(r => ((r-avg)/popSD)**3)) : null,undefined,"Population standardised third moment.");
  set(18,popSD ? mean(returns.map(r => ((r-avg)/popSD)**4))-3 : null,undefined,"Population excess fourth moment.");
  set(23,returns[n-1]*100,"%"); set(24,total*100,"%"); set(25,cagr === null ? null : cagr*100,"%","At least 365 calendar days required; actual days/365.");
  set(26,avg*100,"%","Daily arithmetic mean."); set(27,((1+total)**(1/n)-1)*100,"%","Daily geometric mean.");
  set(28,divide((avg-dailyRf)*252,vol),"×","Annualised mean daily excess return / annualised sample volatility.");
  set(29,divide((avg-dailyMar)*252,downside),"×"); set(30,cagr === null ? null : divide(cagr,-mdd),"×");
  const depths = [...episodes].sort((a,b) => a.depth-b.depth).slice(0,3).map(e => -e.depth);
  set(31,cagr === null || !depths.length ? null : cagr/(mean(depths)+.1),"×","CAGR / (mean deepest 3 episode troughs + 10%).");
  set(35,divide(sum(returns.map(r => Math.max(0,r-dailyMar))),-sum(returns.map(r => Math.min(0,r-dailyMar)))),"×");
  set(36,wins.length/n*100,"%"); set(37,`${wins.length ? (mean(wins)*100).toFixed(3)+"%" : "No wins"} / ${losses.length ? (mean(losses)*100).toFixed(3)+"%" : "No losses"}`);
  set(38,divide(sum(wins),-sum(losses)),"×"); set(39,months.length ? divide(sum(months),-sum(months.filter(r => r < 0))) : null,"×","Complete interior calendar months only.");
  set(40,"See 1M / 3M / 1Y rolling curves");
  set(42,drawdowns[drawdowns.length-1]*100,"%"); set(43,mdd*100,"%");
  set(44,drawdowns.some(d=>d<0) ? mean(drawdowns.filter(d=>d<0))*100 : 0,"%","Mean of underwater observations only.");
  const elapsed = (a: number,b: number) => (Date.parse(points[b].date)-Date.parse(points[a].date))/86400000;
  set(45,worst ? elapsed(worst.peak,worst.trough) : 0,"days","Peak to trough of worst episode; calendar days.");
  set(46,worst?.recovery !== undefined ? elapsed(worst.trough,worst.recovery) : null,"days","Worst episode; unavailable while unrecovered or no drawdown.");
  set(47,drawdowns.filter(d=>d<0).length,undefined,"Number of trading observations under water.");
  set(48,Math.sqrt(mean(drawdowns.map(d=>d*d)))*100,"%"); set(49,pain*100,"%"); set(50,cagr === null ? null : divide(cagr,pain),"×");
  let running = points[0].value;
  const underwater = points.map(p => { running = Math.max(running,p.value); return running-p.value; });
  set(51,divide(sum(underwater),sum(points.map(p=>p.value))),"×","Discrete sum(HWM − NAV) / sum(NAV), equal observation weights.");
  set(52,drawdowns[drawdowns.length-1]*100,"%"); set(53,episodes.length,undefined,"All episodes below 0%; includes ongoing episode.");
  const worstDrawdowns = [...drawdowns].sort((a,b)=>a-b).slice(0,Math.max(1,Math.ceil(drawdowns.length*.05)));
  set(54,-mean(worstDrawdowns)*100,"%","Mean worst 5% of drawdown observations.");
  set(55,(1+total)*100,undefined,"Indexed to 100 at selected start; not account rupees.");
  set(56,Math.max(...points.map(p=>p.value))/points[0].value*100); set(57,"See growth of 100 curve");
  set(58,"See rolling 30-session volatility"); set(59,"See rolling 30-session Sharpe"); set(60,"See underwater curve");
  set(61,cagr === null ? null : cagr*100,"%"); set(62,`${(Math.max(...returns)*100).toFixed(3)}% / ${(Math.min(...returns)*100).toFixed(3)}%`); set(63,`${wins.length} / ${losses.length}`,undefined,`${n-wins.length-losses.length} flat sessions.`);
  const ends = returns.map((_,i) => i+1).filter(i => i >= 252 && (i === points.length-1 || points[i+1].date.slice(0,7) !== points[i].date.slice(0,7)));
  const latestMonth = points[points.length-1].date.slice(0,7);
  const completeEnds = ends.filter(i => points[i].date.slice(0,7) < latestMonth).slice(-6);
  if (completeEnds.length === 6) set(14,mean(completeEnds.map(i=>Math.max(0,-quantile(returns.slice(i-252,i),.05))))*100,"%","Mean of trailing six completed monthly 252-session VaR loss rates.");
  return { metrics, returns, drawdowns };
}

export function analysePerformance(state: PortfolioState, mode: "actual" | "model", start: string, end: string, riskFree: number, mar: number) {
  const current = analysePortfolio(state.holdings,state.quotes,state.trades);
  const history = state.history;
  const benchmarkAll = history?.benchmark || [];
  const assetMaps = Object.fromEntries(state.holdings.map(h => [h.symbol,new Map((history?.assets[h.symbol] || []).map(p=>[p.date,p.value]))]));
  const completeValue = state.holdings.length > 0 && !current.totals.missing && current.totals.currentValue > 0;
  const navMap = new Map((history?.nav || []).map(p=>[p.date,p.value]));
  const accountValues = new Map((history?.nav || []).map(p=>[p.date,p.accountValue]));
  const validDate = (d: string) => mode === "actual" ? navMap.has(d) : completeValue && state.holdings.every(h=>assetMaps[h.symbol].has(d));
  const available = benchmarkAll.filter(p=>p.date >= start && p.date <= end);
  const first = available.findIndex(p=>validDate(p.date));
  const last = available.map(p=>validDate(p.date)).lastIndexOf(true);
  const candidates = first >= 0 ? available.slice(first,last+1) : [];
  const gap = candidates.some(p=>!validDate(p.date));
  const dates = gap ? [] : candidates;
  const anchors = Object.fromEntries(state.holdings.map(h => [h.symbol, dates.length ? assetMaps[h.symbol].get(dates[dates.length-1].date) || 0 : 0]));
  const portfolio = dates.map(p => ({ date: p.date, value: mode === "actual" ? navMap.get(p.date)! : sum(current.positions.map(h => anchors[h.symbol] ? h.value * assetMaps[h.symbol].get(p.date)!/anchors[h.symbol] : 0)) }));
  const p = seriesStatistics(portfolio,riskFree,mar), b = seriesStatistics(dates,riskFree,mar);
  if (p.returns.length) {
    const beta = divide(cov(p.returns,b.returns),variance(b.returns));
    const correlation = divide(cov(p.returns,b.returns),sd(p.returns)*sd(b.returns));
    const active = p.returns.map((r,i)=>r-b.returns[i]);
    const tracking = sd(active)*Math.sqrt(252), rfDaily = (1+riskFree)**(1/252)-1;
    const set = (map: MetricMap, id: number,value: number|null,unit?: MetricValue["unit"]) => { map[id] = {value,unit}; };
    set(p.metrics,15,beta); set(b.metrics,15,variance(b.returns) ? 1 : null);
    set(p.metrics,19,tracking*100,"%"); set(b.metrics,19,0,"%");
    set(p.metrics,20,correlation === null ? null : correlation**2); set(b.metrics,20,variance(b.returns) ? 1 : null);
    set(p.metrics,32,beta === null ? null : divide((mean(p.returns)-rfDaily)*252,beta),"×"); set(b.metrics,32,variance(b.returns) ? (mean(b.returns)-rfDaily)*252 : null,"×");
    set(p.metrics,33,beta === null ? null : (mean(p.returns)-rfDaily-beta*(mean(b.returns)-rfDaily))*252*100,"%"); set(b.metrics,33,variance(b.returns) ? 0 : null,"%");
    set(p.metrics,34,divide(mean(active)*252,tracking),"×"); set(b.metrics,34,null,"×");
    set(p.metrics,41,Number(p.metrics[24]?.value)-Number(b.metrics[24]?.value),"%"); set(b.metrics,41,0,"%");
    if(mode === "actual" && dates.every(d=>!!accountValues.get(d.date)) && state.trades.length) {
      const inPeriod=state.trades.filter(t=>t.date>dates[0].date && t.date<=dates[dates.length-1].date);
      const buys=sum(inPeriod.filter(t=>t.side==="BUY").map(t=>t.quantity*t.price));
      const sells=sum(inPeriod.filter(t=>t.side==="SELL").map(t=>t.quantity*t.price));
      p.metrics[80]={value:Math.min(buys,sells)/mean(dates.map(d=>accountValues.get(d.date)!))*100,unit:"%",note:"Recorded period buys/sells only / arithmetic mean supplied daily portfolioValue. Not annualised; requires complete execution history."};
    }
  }
  let highWater=0;
  const curve: CurvePoint[] = (portfolio.length >= 3 ? portfolio : []).map((point,i) => {
    highWater=Math.max(highWater,point.value);
    const windowP = p.returns.slice(Math.max(0,i-30),i), windowB = b.returns.slice(Math.max(0,i-30),i);
    const rolling = (series: PricePoint[],n: number) => i >= n ? (series[i].value/series[i-n].value-1)*100 : null;
    const sharp = (r: number[]) => r.length === 30 ? divide((mean(r)-((1+riskFree)**(1/252)-1))*252,sd(r)*Math.sqrt(252)) : null;
    const loss = (r: number[]) => r.length === 252 ? Math.max(0,-quantile(r,.05))*100 : null;
    return { date: point.date, portfolio: point.value/portfolio[0].value*100, nifty: dates[i].value/dates[0].value*100,
      portfolioDrawdown: p.drawdowns[i]*100, niftyDrawdown: b.drawdowns[i]*100, highWater: highWater/portfolio[0].value*100,
      excess: (point.value/portfolio[0].value-dates[i].value/dates[0].value)*100,
      rolling1M: rolling(portfolio,21), rolling3M: rolling(portfolio,63), rolling1Y: rolling(portfolio,252), niftyRolling1M: rolling(dates,21), niftyRolling3M: rolling(dates,63), niftyRolling1Y: rolling(dates,252),
      rollingVol: windowP.length===30 ? sd(windowP)*Math.sqrt(252)*100 : null, niftyRollingVol: windowB.length===30 ? sd(windowB)*Math.sqrt(252)*100 : null,
      rollingSharpe: sharp(windowP), niftyRollingSharpe: sharp(windowB), rollingVaR: loss(p.returns.slice(Math.max(0,i-252),i)), niftyRollingVaR: loss(b.returns.slice(Math.max(0,i-252),i)), daily: i ? p.returns[i-1]*100 : null, niftyDaily: i ? b.returns[i-1]*100 : null };
  });
  const sector = allocation(current.positions,"sector"), industry = allocation(current.positions,"industry"), caps = allocation(current.positions,"capSegment");
  const weights = current.positions.map(h=>h.weight/100);
  const posSet = (id: number,value: MetricValue["value"],unit?: MetricValue["unit"],note = "Current holdings snapshot; separate from selected historical window.") => { p.metrics[id]={value:completeValue ? value : null,unit,note}; };
  posSet(12,"See holding weights"); posSet(22,current.concentration.hhi); posSet(64,"See sector allocation"); posSet(65,"See industry allocation"); posSet(67,"See holding weights");
  posSet(68,`Top 5 ${current.concentration.top5.toFixed(2)}% / Top 10 ${sum([...weights].sort((a,b)=>b-a).slice(0,10))*100}%`);
  p.metrics[69]={value:state.holdings.filter(h=>h.quantity!==0).length,note:"Current snapshot."};
  posSet(70,current.concentration.effectiveHoldings); posSet(71,current.concentration.hhi);
  posSet(72,sector.some(s=>s.name==="Unclassified") ? null : sum(sector.map(s=>(s.weight/100)**2)),undefined,"Requires complete verified sector classifications.");
  posSet(75,"See market-cap allocation",undefined,"User supplied SEBI/AMFI rank bucket; never guessed from share price.");
  if (completeValue && state.cash !== undefined && state.cash >= 0) {
    const account = current.totals.currentValue+state.cash;
    posSet(76,current.totals.currentValue/account*100,"%","Recorded equities + user-entered cash only; excludes unrecorded liabilities/derivatives.");
    posSet(77,current.totals.currentValue/account*100,"%"); posSet(78,`${(current.totals.currentValue/account*100).toFixed(2)}% / 0.00%`);
    posSet(79,state.cash/account*100,"%","User-entered cash, not inferred from buy/sell proceeds.");
  }
  if (completeValue && state.holdings.every(h=>h.averageDailyVolume && h.averageDailyVolume>0)) posSet(82,sum(current.positions.map(h=>h.weight/100*h.quantity/(h.averageDailyVolume!*.1))),"days","User-supplied average daily shares traded; 10% participation rate, current positions only.");
  if (completeValue && state.benchmarkWeights) {
    const bw = new Map(state.benchmarkWeights.rows.map(r=>[r.symbol,r.weight]));
    const pw = new Map(current.positions.map(h=>[h.symbol,h.weight/100]));
    posSet(81,.5*sum([...new Set([...bw.keys(),...pw.keys()])].map(s=>Math.abs((pw.get(s)||0)-(bw.get(s)||0))))*100,"%",`Snapshot comparison with user-supplied Nifty weights dated ${state.benchmarkWeights.date}; not historical active share.`);
    posSet(66,"See sector active weights",undefined,`User-supplied Nifty weights dated ${state.benchmarkWeights.date}; requires matching classification taxonomy.`);
  }
  // Equity-only exposure cannot establish account-level exposure without cash,
  // liabilities and derivatives. Do not report a fabricated 100% account weight.
  const assetReturns = state.holdings.map(h => dates.map(d=>assetMaps[h.symbol].get(d.date)));
  const assetsComplete = dates.length >= 3 && assetReturns.every(a=>a.every(v=>typeof v === "number" && v>0));
  let matrix: { symbol: string; values: (number|null)[] }[] = [], riskContributions: {symbol:string;component:number;marginal:number}[] = [];
  if (assetsComplete && completeValue) {
    const r = assetReturns.map(a=>a.slice(1).map((v,i)=>v!/a[i]!-1));
    const covariance = r.map(a=>r.map(b=>cov(a,b)));
    matrix = state.holdings.map((h,i)=>({symbol:h.symbol, values:r.map((_,j)=>divide(covariance[i][j],sd(r[i])*sd(r[j])))}));
    const pairwise = matrix.flatMap((row,i)=>row.values.slice(i+1)).filter((v):v is number=>v!==null);
    const wCov = weights.map((_,i)=>sum(weights.map((w,j)=>w*covariance[i][j])));
    const basketSD = Math.sqrt(Math.max(0,sum(weights.map((w,i)=>w*wCov[i]))));
    posSet(73,divide(sum(weights.map((w,i)=>w*sd(r[i]))),basketSD),"×","Current weights; covariance over the selected common session window.");
    posSet(74,pairwise.length ? mean(pairwise) : null); posSet(21,"See correlation heatmap");
    if (r[0].length >= 252) {
      const trailingCov = r.map(a=>r.map(b=>cov(a.slice(-252),b.slice(-252))));
      const wc = weights.map((_,i)=>sum(weights.map((w,j)=>w*trailingCov[i][j])));
      const sigma = Math.sqrt(Math.max(0,sum(weights.map((w,i)=>w*wc[i]))));
      if (sigma > 0) {
        riskContributions = state.holdings.map((h,i)=>({symbol:h.symbol,component:1.645*weights[i]*wc[i]/sigma*current.totals.currentValue,marginal:1.645*wc[i]/sigma*current.totals.currentValue}));
        posSet(10,"See current-book component VaR (₹)",undefined,"Euler components sum to current-book zero-mean normal VaR; 252 daily asset returns.");
        posSet(11,"See current-book marginal VaR (₹)",undefined,"Derivative per unit of weight, fixed portfolio value; 1 percentage point = displayed amount / 100.");
      }
      const mc = monteCarlo(trailingCov,weights,10000);
      posSet(5,mc === null ? null : mc*current.totals.currentValue,"₹","Current-book covariance model, 252 daily asset returns; 10,000 correlated normal zero-mean scenarios, fixed seed. Model estimate, not a guarantee or inherently more robust.");
    }
  }
  return { current, portfolio: p, benchmark: b, curve, sector, industry, caps, matrix, riskContributions, completeValue,
    coverage: gap ? "Missing an interior trading session: daily metrics are blocked. Fill the gap rather than treating a multi-day return as a daily return." : dates.length < 3 ? "Need at least 3 shared daily observations and verified Nifty 50 history." : `${dates[0].date} → ${dates[dates.length-1].date} · ${dates.length-1} matched daily return observations.`,
    missingHistory: state.holdings.filter(h=>!history?.assets[h.symbol]?.length).map(h=>h.symbol) };
}

export function allocation(positions: {value:number; sector?:string;industry?:string;capSegment?:string}[],field: "sector"|"industry"|"capSegment") {
  const groups = new Map<string,number>();
  positions.forEach(h=>groups.set(h[field] || "Unclassified",(groups.get(h[field] || "Unclassified") || 0)+h.value));
  const total = sum(positions.map(h=>h.value));
  return [...groups].map(([name,value])=>({name,value,weight:total ? value/total*100 : 0})).sort((a,b)=>b.value-a.value);
}

export function monteCarlo(covariance: number[][], weights: number[], count: number) {
  const n = weights.length, l = Array.from({length:n},()=>Array(n).fill(0) as number[]);
  for (let i=0;i<n;i++) for(let j=0;j<=i;j++) {
    const residual = covariance[i][j]-sum(l[i].slice(0,j).map((v,k)=>v*l[j][k]));
    if(i===j) { if(residual < -1e-10) return null; l[i][j]=Math.sqrt(Math.max(0,residual)); }
    else if(l[j][j] > 1e-14) l[i][j]=residual/l[j][j]; else if(Math.abs(residual)>1e-10) return null;
  }
  let seed=1729;
  const uniform=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return (seed+.5)/4294967296;};
  const normal=()=>Math.sqrt(-2*Math.log(uniform()))*Math.cos(2*Math.PI*uniform());
  const projected=weights.map((_,j)=>sum(weights.map((w,i)=>w*l[i][j])));
  const simulations = Array.from({length:count},()=>sum(projected.map(v=>v*normal())));
  return Math.max(0,-quantile(simulations,.05));
}

export function parseBenchmarkWeights(text: string) {
  const p=Papa.parse<Record<string,string>>(text,{header:true,skipEmptyLines:true,transformHeader:h=>h.trim().toLowerCase()});
  if(p.errors.length || !["date","symbol","weight"].every(h=>p.meta.fields?.includes(h))) throw Error("Use date,symbol,weight,sector,industry. Weight is a fraction (0.05 = 5%). Supply the complete Nifty 50 constituents.");
  const dates=new Set(p.data.map(r=>r.date)), symbols=new Set(p.data.map(r=>r.symbol?.trim().toUpperCase()));
  const date=p.data[0]?.date;
  if(!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || dates.size!==1 || symbols.size!==p.data.length || p.data.length!==50) throw Error("Need exactly 50 unique symbols on one valid as-of date.");
  const rows=p.data.map(r=>({symbol:r.symbol.trim().toUpperCase(),weight:Number(r.weight),sector:r.sector?.trim(),industry:r.industry?.trim()}));
  if(rows.some(r=>!r.symbol || !Number.isFinite(r.weight) || r.weight<=0 || r.weight>1) || Math.abs(sum(rows.map(r=>r.weight))-1)>.001) throw Error("Constituent weights must be positive fractions summing to 1 (±0.001).");
  return {date,rows};
}
