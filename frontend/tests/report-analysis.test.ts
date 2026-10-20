import { File } from "node:buffer";
import { expect,it } from "vitest";
import { parseImport } from "../src/imports";
import { analyseReport } from "../src/report-analysis";

it("retains broker report dates and costs, filters sale periods and compares exact Nifty dates",async()=>{
  const csv="Symbol,Buy Date,Sell Date,Buy Value,Sell Value,Realised P&L\nA,02/01/2024,04/01/2024,1000,1200,195\nB,02/01/2024,05/01/2024,2000,1800,-210\nC,,,,,25";
  const parsed=await parseImport(new File([csv],"pnl.csv") as unknown as globalThis.File,"pnl");
  expect(parsed.summary!.realised).toBe(10);expect(parsed.summary!.entries).toHaveLength(3);
  const result=analyseReport(parsed.summary!,[{date:"2024-01-02",value:100},{date:"2024-01-04",value:110}],"2024-01-01","2024-01-04");
  expect(result.total).toBe(195);expect(result.undated).toBe(1);expect(result.comparisons[0].niftyPnl).toBeCloseTo(100);
  expect(result.curve).toEqual([{date:"2024-01-04",realised:195}]);
});
