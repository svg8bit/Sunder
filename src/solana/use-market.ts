import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
    let active = true;
    let unsubscribe: (() => Promise<void>) | undefined;
    setStatus("connecting");
    void subscribePumpTrades({
      mint: input.mint,
      decimals: input.decimals,
      websocketUrl: import.meta.env.VITE_SOLANA_MAINNET_WS_URL?.trim() || "wss://solana-rpc.publicnode.com",
      onDisconnect: () => { if (active) setStatus("failed"); },
      onTrade: (trade) => {
        if (!active) return;
        setTrades((current) => Object.freeze([trade, ...current.filter((item) => item.signature !== trade.signature)].slice(0, 80)));
      },
    }).then((stop) => {
      if (!active) return void stop();
      unsubscribe = stop;
      setStatus("live");
    }).catch(() => {
      if (active) setStatus("failed");
    });
    return () => {
      active = false;
      if (unsubscribe) void unsubscribe();
    };
  }, [input.decimals, input.enabled, input.mint]);

  return { trades, status } as const;
}
