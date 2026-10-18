import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { parseImport } from "../src/imports";

describe("local Groww imports", () => {
  it("parses a holdings CSV with metadata rows", async () => {
    const csv = [
      "Holdings Statement",
      "Generated locally for test",
      "Stock Name,ISIN,Quantity,Average buy price,Closing price",
      "ALPHA LTD,INE000A01000,5,100.50,110",
      "BETA LTD,INE000B01000,2,250,240",
    ].join("\n");
    const result = await parseImport(new File([csv], "holdings.csv", { type: "text/csv" }) as unknown as globalThis.File, "holdings");
    expect(result.holdings).toHaveLength(2);
    expect(result.holdings?.[0]).toMatchObject({ symbol: "ALPHA LTD", quantity: 5, averagePrice: 100.5 });
  });

  it("derives execution price from Groww order value", async () => {
    const csv = [
      "Stock name,Symbol,Type,Quantity,Value,Exchange,Execution date and time,Order status",
      "Alpha Ltd,ALPHA,BUY,4,400,NSE,17/10/2026 10:15:00,Executed",
      "Alpha Ltd,ALPHA,SELL,1,120,NSE,18/10/2026 11:00:00,Executed",
    ].join("\n");
    const result = await parseImport(new File([csv], "orders.csv", { type: "text/csv" }) as unknown as globalThis.File, "trades");
    expect(result.trades).toHaveLength(2);
    expect(result.trades?.map(trade => trade.price)).toEqual([100, 120]);
  });
});
