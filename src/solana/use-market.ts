import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SOLANA_MAINNET_WS_URL } from "./client";
import { fetchRecentTokens, mergeConfirmedPumpTrade, parseTokenInformationList, subscribePumpTrades, type PumpTrade, type TokenInformation } from "./market";

const RECENT_CACHE_KEY = "sunder:solana-recent-tokens:v1";
const RECENT_CACHE_MAX_AGE_MS = 120_000;

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
  const [trades, setTrades] = useState<readonly PumpTrade[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "failed">("idle");

  useEffect(() => {
    setTrades([]);
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
        setStatus("failed");
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
  }, [input.decimals, input.enabled, input.mint]);

  return { trades, status } as const;
}
