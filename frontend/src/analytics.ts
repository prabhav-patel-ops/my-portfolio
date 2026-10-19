import type { Holding, Quote, Trade } from "./types";

const DAY_MS = 86_400_000;
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0;

export type AnalysedPosition = Holding & {
  quote?: Quote;
  invested: number;
  value: number;
  pnl: number;
  returnPct: number;
  dayPnl: number;
  dayPct: number;
  weight: number;
};

export type ClosedSale = {
  id: string;
  symbol: string;
  date: string;
  quantity: number;
  proceeds: number;
  cost: number;
  charges: number;
  net: number;
  holdingDays: number;
  chargesKnown: boolean;
};

export function analysePortfolio(holdings: Holding[], quotes: Record<string, Quote>, trades: Trade[]) {
  const positions: AnalysedPosition[] = holdings.map(holding => {
    const quote = quotes[holding.symbol];
    const invested = finite(holding.quantity * holding.averagePrice);
    const value = quote ? finite(holding.quantity * quote.price) : 0;
    const pnl = quote ? value - invested : 0;
    const returnPct = quote ? ratio(pnl, invested) * 100 : 0;
    const dayPnl = quote?.previousClose ? finite((quote.price - quote.previousClose) * holding.quantity) : 0;
    const dayPct = quote?.previousClose ? ratio(quote.price - quote.previousClose, quote.previousClose) * 100 : 0;
    return { ...holding, quote, invested, value, pnl, returnPct, dayPnl, dayPct, weight: 0 };
  });

  const priced = positions.filter(position => position.quote);
  const currentValue = priced.reduce((sum, position) => sum + position.value, 0);
  const invested = positions.reduce((sum, position) => sum + position.invested, 0);
  const quotedInvested = priced.reduce((sum, position) => sum + position.invested, 0);
  const unrealised = currentValue - quotedInvested;
  const dayPnl = priced.reduce((sum, position) => sum + position.dayPnl, 0);
  const priorValue = priced.reduce((sum, position) => sum + (position.quote?.previousClose || position.quote?.price || 0) * position.quantity, 0);
  positions.forEach(position => { position.weight = ratio(position.value, currentValue) * 100; });

  const weights = positions.filter(position => position.quote).map(position => position.weight / 100).sort((a, b) => b - a);
  const hhi = weights.reduce((sum, weight) => sum + weight * weight, 0);
  const sortedPositions = [...positions].filter(position => position.quote).sort((a, b) => b.value - a.value);
  const topWeight = (count: number) => sortedPositions.slice(0, count).reduce((sum, position) => sum + position.weight, 0);

  const lots = new Map<string, { quantity: number; price: number; charges: number; chargesKnown: boolean; date: string }[]>();
  const closedSales: ClosedSale[] = [];
  let buys = 0, sells = 0, turnover = 0, unmatchedSaleQuantity = 0, unknownChargeTrades = 0;
  const ordered = trades.map((trade, index) => ({ trade, index })).sort((a, b) => a.trade.date.localeCompare(b.trade.date) || a.index - b.index);
  for (const { trade } of ordered) {
    turnover += finite(trade.quantity * trade.price);
    if (trade.charges === undefined) unknownChargeTrades++;
    if (trade.side === "BUY") {
      const list = lots.get(trade.symbol) || [];
      list.push({ quantity: trade.quantity, price: trade.price, charges: trade.charges || 0, chargesKnown: trade.charges !== undefined, date: trade.date });
      lots.set(trade.symbol, list);
      buys++;
      continue;
    }
    sells++;
    const list = lots.get(trade.symbol) || [];
    let remaining = trade.quantity, cost = 0, buyCharges = 0, weightedDays = 0, matched = 0;
    let chargesKnown = trade.charges !== undefined;
    while (remaining > 1e-8 && list.length) {
      const lot = list[0];
      const used = Math.min(remaining, lot.quantity);
      cost += used * lot.price;
      buyCharges += lot.charges * ratio(used, lot.quantity);
      chargesKnown = chargesKnown && lot.chargesKnown;
      const days = Math.max(0, Math.round((Date.parse(`${trade.date}T00:00:00Z`) - Date.parse(`${lot.date}T00:00:00Z`)) / DAY_MS));
      weightedDays += days * used;
      matched += used;
      lot.charges -= lot.charges * ratio(used, lot.quantity);
      lot.quantity -= used;
      remaining -= used;
      if (lot.quantity < 1e-8) list.shift();
    }
    unmatchedSaleQuantity += Math.max(0, remaining);
    if (!matched) continue;
    const sellCharges = (trade.charges || 0) * ratio(matched, trade.quantity);
    const proceeds = matched * trade.price;
    const charges = buyCharges + sellCharges;
    closedSales.push({ id: trade.id, symbol: trade.symbol, date: trade.date, quantity: matched, proceeds, cost, charges, net: proceeds - cost - charges, holdingDays: weightedDays / matched, chargesKnown });
  }

  const realised = closedSales.reduce((sum, sale) => sum + sale.net, 0);
  const winners = closedSales.filter(sale => sale.net > 0);
  const losers = closedSales.filter(sale => sale.net < 0);
  const averageWin = ratio(winners.reduce((sum, sale) => sum + sale.net, 0), winners.length);
  const averageLoss = Math.abs(ratio(losers.reduce((sum, sale) => sum + sale.net, 0), losers.length));
  const realisedBySymbol = [...closedSales.reduce((map, sale) => map.set(sale.symbol, (map.get(sale.symbol) || 0) + sale.net), new Map<string, number>())]
    .map(([symbol, net]) => ({ symbol, net })).sort((a, b) => b.net - a.net);

  const contributors = [...priced].sort((a, b) => b.pnl - a.pnl);
  const gainers = priced.filter(position => position.pnl >= 0).length;
  const losersOpen = priced.filter(position => position.pnl < 0).length;
  const concentrationLevel = topWeight(3) >= 60 || (weights[0] || 0) >= .25 ? "High" : topWeight(3) >= 45 ? "Moderate" : "Balanced";

  return {
    positions,
    totals: {
      invested,
      quotedInvested,
      currentValue,
      unrealised,
      returnPct: ratio(unrealised, quotedInvested) * 100,
      dayPnl,
      dayPct: ratio(dayPnl, priorValue) * 100,
      quoted: priced.length,
      missing: positions.length - priced.length,
    },
    concentration: {
      hhi,
      effectiveHoldings: hhi ? 1 / hhi : 0,
      top1: topWeight(1),
      top3: topWeight(3),
      top5: topWeight(5),
      level: concentrationLevel,
    },
    breadth: { gainers, losers: losersOpen, gainersPct: ratio(gainers, priced.length) * 100 },
    contributors,
    trading: {
      buys,
      sells,
      turnover,
      realised,
      closedSales,
      winners: winners.length,
      losers: losers.length,
      winRate: ratio(winners.length, closedSales.length) * 100,
      averageWin,
      averageLoss,
      payoffRatio: ratio(averageWin, averageLoss),
      averageHoldingDays: ratio(closedSales.reduce((sum, sale) => sum + sale.holdingDays, 0), closedSales.length),
      longTermSales: closedSales.filter(sale => sale.holdingDays > 365).length,
      unknownChargeTrades,
      unmatchedSaleQuantity,
      realisedBySymbol,
    },
  };
}
