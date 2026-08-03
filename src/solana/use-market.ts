import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { SOLANA_MAINNET_RPC_URL, SOLANA_MAINNET_WS_URL } from "./client";
import { fetchPumpTradeHistory, fetchPumpTradeHistoryFromApi, fetchRecentTokens, mergeConfirmedPumpTrade, mergePumpTradeHistory, parsePumpTradeHistory, parseTokenInformationList, serializePumpTradeHistory, subscribePumpTrades, type PumpTrade, type TokenInformation } from "./market";

const RECENT_CACHE_KEY = "sunder:solana-recent-tokens:v1";
const RECENT_CACHE_MAX_AGE_MS = 120_000;
const PUMP_TRADE_CACHE_KEY = "sunder:solana-pump-trades:v1";
const PUMP_TRADE_CACHE_MAX_AGE_MS = 30 * 60_000;

interface RecentTokenCache {
  readonly at: number;
  readonly tokens: readonly TokenInformation[];
}

function readRecentTokenCache(): RecentTokenCache | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_CACHE_KEY) ?? "null") as { readonly at?: unknown; readonly tokens?: unknown } | null;
    if (!value || typeof value.at !== "number" || !Number.isFinite(value.at) || Date.now() - value.at > RECENT_CACHE_MAX_AGE_MS) return undefined;
    return { at: value.at, tokens: parseTokenInformationList(value.tokens) };
  } catch {
    return undefined;
  }
}

function writeRecentTokenCache(tokens: readonly TokenInformation[]): void {
  try {
    window.localStorage.setItem(RECENT_CACHE_KEY, JSON.stringify({ at: Date.now(), tokens: tokens.slice(0, 40) }));
  } catch {
    // Storage policy and quota failures must not interrupt the live feed.
  }
}

function readPumpTradeCache(mint: string | undefined): { readonly at: number; readonly trades: readonly PumpTrade[] } | undefined {
  if (!mint) return undefined;
  try {
    const value = JSON.parse(window.localStorage.getItem(PUMP_TRADE_CACHE_KEY) ?? "null") as { readonly at?: unknown; readonly mint?: unknown; readonly trades?: unknown } | null;
    if (!value || value.mint !== mint || typeof value.at !== "number" || Date.now() - value.at > PUMP_TRADE_CACHE_MAX_AGE_MS) return undefined;
    return { at: value.at, trades: parsePumpTradeHistory(value.trades) };
  } catch {
    return undefined;
  }
}

function writePumpTradeCache(mint: string, trades: readonly PumpTrade[]): void {
  if (trades.length === 0) return;
  try {
    window.localStorage.setItem(PUMP_TRADE_CACHE_KEY, JSON.stringify({
      at: Date.now(),
      mint,
      trades: JSON.parse(serializePumpTradeHistory(trades)) as unknown,
    }));
  } catch {
    // A cache failure never interrupts the canonical live stream.
  }
}

export function useRecentTokens(enabled: boolean) {
  const [cached] = useState(readRecentTokenCache);
  return useQuery({
    queryKey: ["jupiter", "tokens", "recent"],
    queryFn: async ({ signal }) => {
      const tokens = await fetchRecentTokens(signal);
      writeRecentTokenCache(tokens);
      return tokens;
    },
    enabled,
    initialData: cached?.tokens,
    initialDataUpdatedAt: cached?.at,
    refetchInterval: enabled ? 8_000 : false,
    staleTime: 4_000,
    retry: 2,
    retryDelay: (attempt) => Math.min(3_000, 500 * 2 ** attempt),
  });
}

export function usePumpTradeStream(input: {
  readonly enabled: boolean;
  readonly mint?: string;
  readonly decimals?: number;
}) {
  const cached = useMemo(() => readPumpTradeCache(input.mint), [input.mint]);
  const [trades, setTrades] = useState<readonly PumpTrade[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "polling" | "failed">("idle");
  const history = useQuery({
    queryKey: ["solana", "pump", "trade-history", input.mint, input.decimals],
    queryFn: async ({ signal }) => {
      if (import.meta.env.PROD) {
        try {
          return await fetchPumpTradeHistoryFromApi({ mint: input.mint!, decimals: input.decimals!, signal });
        } catch (proxyError) {
          if (signal.aborted) throw proxyError;
        }
      }
      return fetchPumpTradeHistory({ mint: input.mint!, decimals: input.decimals!, rpcUrl: SOLANA_MAINNET_RPC_URL, limit: 48, signal });
    },
    enabled: input.enabled && Boolean(input.mint) && input.decimals !== undefined,
    initialData: cached?.trades,
    initialDataUpdatedAt: cached?.at,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchInterval: input.enabled && status === "polling" ? 8_000 : false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (history.data) {
      setTrades((current) => mergePumpTradeHistory(current, history.data));
      if (input.mint) writePumpTradeCache(input.mint, history.data);
    }
  }, [history.data, input.mint]);

  useEffect(() => {
    setTrades(cached?.trades ?? history.data ?? []);
    if (!input.enabled || !input.mint || input.decimals === undefined) {
      setStatus("idle");
      return;
    }
    const mint = input.mint;
    const decimals = input.decimals;
    let active = true;
    let unsubscribe: (() => Promise<void>) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let retryScheduled = false;
    const maxAttempts = 5;
    const scheduleRetry = () => {
      if (!active || retryScheduled) return;
      unsubscribe = undefined;
      if (attempts >= maxAttempts) {
        // A direct WebSocket can be blocked by a wallet browser or public RPC.
        // Keep the confirmed tape moving through the CDN-cached history route
        // instead of freezing the chart after the bounded reconnect attempts.
        setStatus("polling");
        return;
      }
      retryScheduled = true;
      setStatus("connecting");
      const delayMs = Math.min(4_000, 400 * 2 ** Math.max(0, attempts - 1));
      retryTimer = setTimeout(() => {
        retryScheduled = false;
        connect();
      }, delayMs);
    };
    function connect() {
      if (!active) return;
      attempts += 1;
      setStatus("connecting");
      void subscribePumpTrades({
        mint,
        decimals,
        websocketUrl: SOLANA_MAINNET_WS_URL,
        onDisconnect: scheduleRetry,
        onTrade: (trade) => {
          if (!active) return;
          setTrades((current) => {
            // Confirmed websocket notifications are expected in slot order.
            // Ignore a delayed event after a newer slot is already displayed
            // so a bar never appears retroactively in the chart's past.
            return mergeConfirmedPumpTrade(current, trade);
          });
        },
      }).then((stop) => {
        if (!active) return void stop();
        unsubscribe = stop;
        setStatus("live");
      }).catch(scheduleRetry);
    }
    connect();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (unsubscribe) void unsubscribe();
    };
  }, [cached?.trades, input.decimals, input.enabled, input.mint]);

  useEffect(() => {
    if (input.mint && trades.length > 0) writePumpTradeCache(input.mint, trades);
  }, [input.mint, trades]);

  return { trades, status } as const;
}
