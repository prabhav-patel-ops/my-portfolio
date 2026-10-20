import type { PricePoint, ReferenceSummary } from "./types";

export function analyseReport(report: ReferenceSummary | null, benchmark: PricePoint[], start: string, end: string) {
  const rows = report?.entries || [];
  const dated = rows.filter(r => r.realised !== undefined && r.sellDate && r.sellDate >= start && r.sellDate <= end).sort((a,b) => a.sellDate!.localeCompare(b.sellDate!));
  const index = new Map(benchmark.map(p=>[p.date,p.value]));
  const monthly = new Map<string,number>();
  let cumulative=0;
  const byDay = new Map<string,number>();
  dated.forEach(r=>{const month=r.sellDate!.slice(0,7);monthly.set(month,(monthly.get(month)||0)+r.realised!);byDay.set(r.sellDate!,(byDay.get(r.sellDate!)||0)+r.realised!);});
  const curve=[...byDay].map(([date,value])=>({date,realised:cumulative+=value}));
  const comparisons=dated.flatMap(r=>{
    const buy=r.buyDate ? index.get(r.buyDate):undefined,sell=index.get(r.sellDate!);
    return buy && sell && r.buyValue && r.buyValue>0 && r.buyDate!<=r.sellDate! ? [{symbol:r.symbol,buyDate:r.buyDate!,sellDate:r.sellDate!,reportPnl:r.realised!,niftyPnl:r.buyValue*(sell/buy-1)}]:[];
  });
  return {dated,undated:rows.filter(r=>r.realised!==undefined&&!r.sellDate).length,curve,monthly:[...monthly].map(([month,realised])=>({month,realised})),comparisons,total:cumulative};
}
