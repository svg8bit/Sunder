import { autoDiscover, createClient } from "@solana/client";
import type { ChainNetworkId } from "../../packages/sniper-engine/src/index";

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
    import.meta.env.VITE_SOLANA_MAINNET_RPC_URL?.trim() || "https://solana-rpc.publicnode.com",
    import.meta.env.VITE_SOLANA_MAINNET_WS_URL?.trim() || "wss://solana-rpc.publicnode.com",
  );
  return mainnetClient;
}
