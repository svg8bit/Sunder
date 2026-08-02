import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SOLANA_MAINNET_WS_URL } from "./client";
import { fetchRecentTokens, subscribePumpTrades, type PumpTrade } from "./market";

export function useRecentTokens(enabled: boolean) {
  return useQuery({
    queryKey: ["jupiter", "tokens", "recent"],
    queryFn: ({ signal }) => fetchRecentTokens(signal),
    enabled,
    refetchInterval: enabled ? 8_000 : false,
    staleTime: 4_000,
    retry: 1,
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
          setTrades((current) => Object.freeze([trade, ...current.filter((item) => item.signature !== trade.signature)].slice(0, 80)));
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
