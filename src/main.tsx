import React from "react";
import { createRoot } from "react-dom/client";
import { SolanaProvider } from "@solana/react-hooks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { Toaster } from "sonner";
import { App } from "./App";
import { evmConfig } from "./evm/config";
import { solanaClientFor } from "./solana/client";
import { NetworkProvider, useNetwork } from "./state/network";
import { WorkspaceProvider } from "./state/workspace";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 8_000 },
  },
});

function ChainProviders() {
  const { network } = useNetwork();
  const client = solanaClientFor(network);
  return (
    <SolanaProvider key={network.startsWith("solana:") ? network : "solana:standby"} client={client}>
      <App />
      <Toaster position="bottom-right" richColors closeButton />
    </SolanaProvider>
  );
}

createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={evmConfig}>
        <NetworkProvider>
          <WorkspaceProvider>
            <ChainProviders />
          </WorkspaceProvider>
        </NetworkProvider>
      </WagmiProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
