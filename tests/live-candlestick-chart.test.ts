import { describe, expect, it } from "vitest";
import { aggregateLiveCandles } from "../src/components/live-candlestick-chart";

describe("live candlestick aggregation", () => {
  it("builds chronological OHLCV buckets only from observed prices", () => {
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
});
