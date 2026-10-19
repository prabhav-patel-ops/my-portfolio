import { describe, expect, it } from "vitest";
import { analysePortfolio } from "../src/analytics";

describe("portfolio analytics", () => {
  it("calculates value, concentration and effective holdings", () => {
    const result = analysePortfolio([
      { symbol: "AAA", name: "A", quantity: 10, averagePrice: 80 },
      { symbol: "BBB", name: "B", quantity: 5, averagePrice: 100 },
    ], {
      AAA: { price: 100, previousClose: 90, marketAt: "2026-10-19T10:00:00Z", fetchedAt: "2026-10-19T10:00:00Z", ticker: "AAA.NS", source: "test" },
      BBB: { price: 200, previousClose: 200, marketAt: "2026-10-19T10:00:00Z", fetchedAt: "2026-10-19T10:00:00Z", ticker: "BBB.NS", source: "test" },
    }, []);
    expect(result.totals.currentValue).toBe(2000);
    expect(result.totals.unrealised).toBe(700);
    expect(result.concentration.top1).toBe(50);
    expect(result.concentration.effectiveHoldings).toBe(2);
    expect(result.totals.dayPnl).toBe(100);
  });

  it("builds FIFO sale quality metrics and protects unknown costs", () => {
    const result = analysePortfolio([], {}, [
      { id: "b1", symbol: "AAA", name: "A", date: "2025-01-01", side: "BUY", quantity: 10, price: 100, charges: 10 },
      { id: "s1", symbol: "AAA", name: "A", date: "2025-02-01", side: "SELL", quantity: 5, price: 120, charges: 5 },
      { id: "s2", symbol: "AAA", name: "A", date: "2025-03-01", side: "SELL", quantity: 5, price: 90 },
    ]);
    expect(result.trading.closedSales).toHaveLength(2);
    expect(result.trading.winners).toBe(1);
    expect(result.trading.losers).toBe(1);
    expect(result.trading.winRate).toBe(50);
    expect(result.trading.unknownChargeTrades).toBe(1);
    expect(result.trading.realised).toBe(35);
  });
});
