import { describe, expect, it } from "vitest";
import { aggregateLiveCandles, createPumpAnchor, createSupplyMarketCapFactor } from "../src/components/live-candlestick-chart";
import { mergeConfirmedPumpTrade, type PumpTrade } from "../src/solana/market";

function pumpTrade(signature: string, slot: number, timestamp: number): PumpTrade {
  return {
    signature,
    eventIndex: 0,
    slot,
    timestamp,
    mint: "mint",
    user: "user",
    side: "buy",
    solAmountLamports: 1n,
    tokenAmountAtomic: 1n,
    feeLamports: 0n,
    creatorFeeLamports: 0n,
    feeBasisPoints: 0,
    creatorFeeBasisPoints: 0,
    virtualSolReservesLamports: 1n,
    virtualTokenReservesAtomic: 1n,
    priceSol: 1,
  };
}

describe("live candlestick aggregation", () => {
  it("builds chronological OHLCV buckets only from observed trades", () => {
    const candles = aggregateLiveCandles([
      { at: 32_900, price: 4, volume: 2 },
      { at: 30_100, price: 2, volume: 1 },
      { at: 31_400, price: 5, volume: 3 },
      { at: 45_100, price: 3, volume: 4 },
    ], 15);

    expect(candles).toEqual([
      { time: 30, open: 2, high: 5, low: 2, close: 4, volume: 6 },
      { time: 45, open: 3, high: 3, low: 3, close: 3, volume: 4 },
    ]);
  });

  it("drops invalid observations instead of inventing replacement candles", () => {
    expect(aggregateLiveCandles([
      { at: Number.NaN, price: 2 },
      { at: 1_000, price: 0 },
      { at: 2_000, price: Number.POSITIVE_INFINITY },
    ], 1)).toEqual([]);
  });

  it("uses confirmed slot order inside the same second instead of reversing the candle", () => {
    expect(aggregateLiveCandles([
      { at: 10_000, order: 102, price: 3 },
      { at: 10_000, order: 100, price: 1 },
      { at: 10_000, order: 101, price: 2 },
    ], 1)).toEqual([{ time: 10, open: 1, high: 3, low: 1, close: 3, volume: 0 }]);
  });

  it("keeps empty intervals empty instead of fabricating zero-volume trades", () => {
    expect(aggregateLiveCandles([
      { at: 10_100, order: 100, price: 2, volume: 1 },
      { at: 13_100, order: 103, price: 5, volume: 3 },
    ], 1)).toEqual([
      { time: 10, open: 2, high: 2, low: 2, close: 2, volume: 1 },
      { time: 13, open: 5, high: 5, low: 5, close: 5, volume: 3 },
    ]);
  });

  it("keeps multiple confirmed events from the same transaction in log order", () => {
    const current = [{ ...pumpTrade("same", 102, 10_000), eventIndex: 0, priceSol: 1 }];
    const merged = mergeConfirmedPumpTrade(current, { ...pumpTrade("same", 102, 10_000), eventIndex: 7, priceSol: 2 });
    expect(merged.map((trade) => [trade.eventIndex, trade.priceSol])).toEqual([[7, 2], [0, 1]]);
  });

  it("does not insert a delayed confirmed slot behind the live chart watermark", () => {
    const current = [pumpTrade("new", 102, 10_200), pumpTrade("old", 101, 10_100)];
    expect(mergeConfirmedPumpTrade(current, pumpTrade("late", 100, 10_000))).toBe(current);
    expect(mergeConfirmedPumpTrade(current, pumpTrade("next", 103, 10_300)).map((trade) => trade.slot)).toEqual([103, 102, 101]);
  });

  it("anchors the current market snapshot to the newest confirmed reserve price", () => {
    const anchor = createPumpAnchor("mint", [{ priceSol: 2 }, { priceSol: 4 }], 12_000, 0.000012);
    expect(anchor).toEqual({ instrumentId: "mint", factor: 3_000, metric: "market-cap" });
    expect(2 * anchor!.factor).toBe(6_000);
    expect(4 * anchor!.factor).toBe(12_000);
  });

  it("derives a stable market-cap scale from indexed supply and SOL/USD", () => {
    const factor = createSupplyMarketCapFactor(806_391.443523, 72.5763465628178);
    expect(factor).toBeCloseTo(58_524_944.8704, 3);
    expect(createSupplyMarketCapFactor(undefined, 72)).toBeUndefined();
  });
});
