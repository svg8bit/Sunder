import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { mainnet, sepolia } from "wagmi/chains";

export const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
export const walletConnectConfigured = Boolean(walletConnectProjectId);

const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })];

if (walletConnectProjectId) {
  connectors.push(walletConnect({
    projectId: walletConnectProjectId,
    metadata: {
      name: "Sunder",
      description: "Self-custody dual-chain execution console",
      url: typeof window === "undefined" ? "https://sunder.app" : window.location.origin,
      icons: [],
    },
    showQrModal: true,
  }));
}

const mainnetRpc = import.meta.env.VITE_EVM_MAINNET_RPC_URL?.trim();
const sepoliaRpc = import.meta.env.VITE_EVM_SEPOLIA_RPC_URL?.trim();

export const evmConfig = createConfig({
  chains: [mainnet, sepolia],
  connectors,
  multiInjectedProviderDiscovery: true,
  transports: {
    [mainnet.id]: http(mainnetRpc || undefined),
    [sepolia.id]: http(sepoliaRpc || undefined),
  },
});
