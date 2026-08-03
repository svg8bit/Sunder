import { autoDiscover, createClient } from "@solana/client";
import type { ChainNetworkId } from "../../packages/sniper-engine/src/index";

function resolveHttpEndpoint(value: string | undefined, fallbackPath: string): string {
  const configured = value?.trim() || fallbackPath;
  if (/^https?:\/\//.test(configured)) return configured;
  if (typeof window !== "undefined") return new URL(configured, window.location.origin).toString();
  return "https://api.mainnet-beta.solana.com";
}

export const SOLANA_MAINNET_RPC_URL = resolveHttpEndpoint(
  import.meta.env.VITE_SOLANA_MAINNET_RPC_URL,
  import.meta.env.PROD ? "/api/solana/rpc" : "https://solana-rpc.publicnode.com",
);
export const SOLANA_MAINNET_WS_URL = import.meta.env.VITE_SOLANA_MAINNET_WS_URL?.trim() || "wss://solana-rpc.publicnode.com";

function client(endpoint: string, websocketEndpoint: string) {
  return createClient({
    endpoint,
    websocketEndpoint,
    walletConnectors: autoDiscover(),
  });
}

const devnetClient = client(
  import.meta.env.VITE_SOLANA_DEVNET_RPC_URL?.trim() || "https://api.devnet.solana.com",
  import.meta.env.VITE_SOLANA_DEVNET_WS_URL?.trim() || "wss://api.devnet.solana.com",
);

let mainnetClient: ReturnType<typeof client> | undefined;

export function solanaClientFor(network: ChainNetworkId) {
  if (network !== "solana:mainnet") return devnetClient;
  mainnetClient ??= client(
    SOLANA_MAINNET_RPC_URL,
    SOLANA_MAINNET_WS_URL,
  );
  return mainnetClient;
}
