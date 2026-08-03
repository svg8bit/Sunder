import { BarChart3 } from "lucide-react";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { PumpTrade } from "../solana/market";

export interface LivePriceObservation {
  readonly at: number;
  readonly price: number;
}

export type CandleInterval = 1 | 15 | 60 | 300;

export interface LiveCandle {
  readonly time: UTCTimestamp;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

const MAX_RENDERED_CANDLES = 600;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function aggregateLiveCandles(
  values: readonly { readonly at: number; readonly order?: number; readonly sequence?: number; readonly price: number; readonly volume?: number }[],
  intervalSeconds: CandleInterval,
): readonly LiveCandle[] {
  const ordered = [...values]
    .filter((value) => Number.isFinite(value.at) && finitePositive(value.price))
    .sort((left, right) => left.at - right.at
      || (left.order ?? 0) - (right.order ?? 0)
      || (left.sequence ?? 0) - (right.sequence ?? 0));
  if (ordered.length === 0) return Object.freeze([]);

  const bucketWidth = intervalSeconds * 1_000;
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const value of ordered) {
    const bucket = Math.floor(value.at / bucketWidth) * intervalSeconds;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { open: value.price, high: value.price, low: value.price, close: value.price, volume: value.volume ?? 0 });
    } else {
      existing.high = Math.max(existing.high, value.price);
      existing.low = Math.min(existing.low, value.price);
      existing.close = value.price;
      existing.volume += value.volume ?? 0;
    }
  }
  return Object.freeze([...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-MAX_RENDERED_CANDLES)
    .map(([time, candle]) => Object.freeze({ time: time as UTCTimestamp, ...candle })));
}

function formatPlainDecimal(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) >= 1_000) return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
  if (Math.abs(value) >= 0.01) return new Intl.NumberFormat("en", { maximumFractionDigits: 6 }).format(value);
  return value.toFixed(12).replace(/0+$/, "");
}

function formatMarketCap(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute < 100_000) return `$${new Intl.NumberFormat("en", { maximumFractionDigits: absolute < 1_000 ? 2 : 0 }).format(value)}`;
  return `$${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: absolute < 1_000_000 ? 1 : 2 }).format(value)}`;
}

function showRecentWindow(chart: IChartApi, candleCount: number): void {
  // Start where a trading terminal is useful: the latest confirmed action.
  // Older launch/migration spikes remain one pan away instead of flattening a
  // crashed token's current candles into a one-pixel line after refresh.
  const visibleBars = 12;
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(-6, candleCount - visibleBars),
    to: candleCount + 3,
  });
}

interface LiveCandlestickChartProps {
  readonly instrumentId: string;
  readonly observations: readonly LivePriceObservation[];
  readonly trades: readonly PumpTrade[];
  readonly symbol: string;
  readonly interval: CandleInterval;
  readonly marketCapUsd?: number;
  readonly spotPriceUsd?: number;
}

export type PumpAnchor = Readonly<{ instrumentId: string; factor: number; metric: "market-cap" | "usd" }>;

export function createPumpAnchor(
  instrumentId: string,
  pumpTrades: readonly Pick<PumpTrade, "priceSol">[],
  marketCapUsd?: number,
  spotPriceUsd?: number,
): PumpAnchor | undefined {
  const latest = pumpTrades.at(-1);
  if (!latest || !finitePositive(latest.priceSol)) return undefined;
  if (finitePositive(marketCapUsd ?? 0)) {
    return Object.freeze({ instrumentId, factor: marketCapUsd! / latest.priceSol, metric: "market-cap" });
  }
  if (finitePositive(spotPriceUsd ?? 0)) {
    return Object.freeze({ instrumentId, factor: spotPriceUsd! / latest.priceSol, metric: "usd" });
  }
  return undefined;
}

export function LiveCandlestickChart({ instrumentId, observations, trades, symbol, interval, marketCapUsd, spotPriceUsd }: LiveCandlestickChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | undefined>(undefined);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | undefined>(undefined);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | undefined>(undefined);
  const pumpTrades = useMemo(() => trades
    .filter((trade) => finitePositive(trade.priceSol))
    .sort((left, right) => left.timestamp - right.timestamp || left.slot - right.slot || left.eventIndex - right.eventIndex || left.signature.localeCompare(right.signature)), [trades]);
  const source = pumpTrades.length > 0 ? "pump" : "jupiter";
  // Jupiter's token snapshot describes the current market, so calibrate it to
  // the newest confirmed reserve price. Anchoring it to the oldest event shifts
  // the whole scale whenever the token moved before the chart was mounted.
  const anchorCandidate = useMemo(
    () => createPumpAnchor(instrumentId, pumpTrades, marketCapUsd, spotPriceUsd),
    [instrumentId, marketCapUsd, pumpTrades, spotPriceUsd],
  );
  const pumpAnchorRef = useRef<PumpAnchor | undefined>(undefined);
  if (pumpAnchorRef.current?.instrumentId !== instrumentId) pumpAnchorRef.current = undefined;
  if (!pumpAnchorRef.current && anchorCandidate) pumpAnchorRef.current = anchorCandidate;
  const pumpAnchor = pumpAnchorRef.current;
  const impliedSupply = finitePositive(marketCapUsd ?? 0) && finitePositive(spotPriceUsd ?? 0) ? marketCapUsd! / spotPriceUsd! : undefined;
  const metric: "market-cap" | "usd" | "sol" = source === "pump" ? pumpAnchor?.metric ?? "sol" : impliedSupply ? "market-cap" : "usd";
  const candles = useMemo(() => aggregateLiveCandles(
    source === "pump"
      ? pumpTrades.map((trade) => ({ at: trade.timestamp, order: trade.slot, sequence: trade.eventIndex, price: trade.priceSol * (pumpAnchor?.factor ?? 1), volume: Number(trade.solAmountLamports) / 1_000_000_000 }))
      : observations.map((point) => ({ at: point.at, price: point.price * (impliedSupply ?? 1) })),
    interval,
  ), [impliedSupply, interval, observations, pumpAnchor, pumpTrades, source]);
  const latestCandles = useRef(candles);
  latestCandles.current = candles;
  const hasFitted = useRef(false);

  useEffect(() => {
    let disposed = false;
    void import("lightweight-charts").then(({ CandlestickSeries, ColorType, HistogramSeries, createChart }) => {
      if (disposed || !container.current) return;
      const nextChart = createChart(container.current, {
        autoSize: true,
        layout: {
          attributionLogo: true,
          background: { type: ColorType.Solid, color: "#090c0f" },
          textColor: "#737d88",
          fontFamily: "SFMono-Regular, Consolas, monospace",
          fontSize: 10,
        },
        grid: { vertLines: { color: "#1a2026" }, horzLines: { color: "#1a2026" } },
        crosshair: { vertLine: { color: "#57616b", labelBackgroundColor: "#20262d" }, horzLine: { color: "#57616b", labelBackgroundColor: "#20262d" } },
        rightPriceScale: {
          autoScale: true,
          borderColor: "#232a31",
          minimumWidth: 72,
          // A percentage margin below a wide MCap range can manufacture
          // negative axis labels. Volume has its own overlay scale, so MCap
          // can safely use the real observed floor.
          scaleMargins: { top: 0.12, bottom: metric === "market-cap" ? 0 : 0.18 },
        },
        timeScale: { borderColor: "#232a31", timeVisible: true, secondsVisible: interval < 60, rightOffset: 3, barSpacing: 10, minBarSpacing: 4 },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
        handleScroll: { horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true, vertTouchDrag: false },
      });
      const formatter = metric === "market-cap" ? formatMarketCap : (value: number) => `${metric === "usd" ? "$" : ""}${formatPlainDecimal(value)}`;
      const nextCandles = nextChart.addSeries(CandlestickSeries, {
        upColor: "#24d3a2",
        downColor: "#ff4f71",
        borderUpColor: "#24d3a2",
        borderDownColor: "#ff4f71",
        wickUpColor: "#24d3a2",
        wickDownColor: "#ff4f71",
        priceFormat: { type: "custom", formatter, minMove: metric === "market-cap" ? 1 : 0.000000000001 },
      });
      const nextVolume = nextChart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        lastValueVisible: false,
        priceLineVisible: false,
      });
      nextChart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      chart.current = nextChart;
      candleSeries.current = nextCandles;
      volumeSeries.current = nextVolume;
      const initial = latestCandles.current;
      nextCandles.setData([...initial]);
      nextVolume.setData(initial.map((candle) => ({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? "rgba(36,211,162,.28)" : "rgba(255,79,113,.25)" })));
      if (initial.length > 0) {
        showRecentWindow(nextChart, initial.length);
        hasFitted.current = true;
      }
    });
    return () => {
      disposed = true;
      candleSeries.current = undefined;
      volumeSeries.current = undefined;
      chart.current?.remove();
      chart.current = undefined;
      hasFitted.current = false;
    };
  }, [interval, metric]);

  useEffect(() => {
    candleSeries.current?.setData([...candles]);
    volumeSeries.current?.setData(candles.map((candle) => ({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? "rgba(36,211,162,.28)" : "rgba(255,79,113,.25)" })));
    if (!hasFitted.current && candles.length > 0) {
      if (chart.current) showRecentWindow(chart.current, candles.length);
      hasFitted.current = true;
    } else if (candles.length > 1) {
      chart.current?.timeScale().scrollToRealTime();
    }
  }, [candles]);

  const latest = candles.at(-1);
  const previous = candles.length > 1 ? candles.at(-2) : undefined;
  const change = latest && previous && previous.close > 0 ? ((latest.close - previous.close) / previous.close) * 100 : undefined;
  const unit = metric === "market-cap" ? "MCap" : metric === "usd" ? "USD" : "SOL";
  const formatValue = metric === "market-cap" ? formatMarketCap : (value: number) => `${metric === "usd" ? "$" : ""}${formatPlainDecimal(value)}`;
  const style = { "--chart-change-color": (change ?? 0) >= 0 ? "var(--mint)" : "var(--red)" } as CSSProperties;

  return (
    <figure className="market-chart market-chart--candles" style={style}>
      <div className="market-chart__legend">
        <span><i /> {symbol}/{unit} · {source === "pump" ? "confirmed Pump trades" : "live Jupiter observations"}</span>
        <b>{latest ? `${formatValue(latest.close)}${metric === "sol" ? ` ${unit}` : ""}` : "Waiting for live prices"}{change === undefined ? "" : ` · ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</b>
      </div>
      <div className="market-chart__canvas" ref={container} role="img" aria-label={`${symbol} live ${interval}-second candlestick chart built only from observed provider data`} />
      {candles.length === 0 ? <div className="market-chart__empty"><BarChart3 size={22} /><strong>Waiting for first live observation</strong><span>No historical candles are fabricated.</span></div> : null}
      <figcaption>Live OHLC only: {source === "pump" ? `${pumpTrades.length} confirmed Pump reserve-price events; empty intervals remain empty${metric === "market-cap" ? "; market-cap scale anchored once to the current Jupiter index" : ""}` : `${observations.length} Jupiter price samples`}. Pan, zoom and crosshair are interactive. <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>.</figcaption>
    </figure>
  );
}
