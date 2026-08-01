import { autoDiscover, createClient } from "@solana/client";

const endpoint = import.meta.env.VITE_SOLANA_DEVNET_RPC_URL?.trim() || "https://api.devnet.solana.com";
const websocketEndpoint = import.meta.env.VITE_SOLANA_DEVNET_WS_URL?.trim() || "wss://api.devnet.solana.com";

export const solanaClient = createClient({
  endpoint,
  websocketEndpoint,
  walletConnectors: autoDiscover(),
});
