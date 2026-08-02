import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";
import { CHAIN_DESCRIPTORS, type ChainDescriptor, type ChainFamily, type ChainNetworkId } from "../../packages/sniper-engine/src/index";

const STORAGE_KEY = "sunder:network-selection:v1";

const storedSelectionSchema = z.object({
  solana: z.enum(["solana:devnet", "solana:mainnet"]),
  evm: z.enum(["evm:sepolia", "evm:mainnet"]),
  family: z.enum(["solana", "evm"]),
});

type StoredSelection = z.infer<typeof storedSelectionSchema>;

const defaultSelection: StoredSelection = {
  solana: "solana:mainnet",
  evm: "evm:mainnet",
  family: "solana",
};

function readSelection(): StoredSelection {
  if (typeof window === "undefined") return defaultSelection;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    return storedSelectionSchema.parse(value);
  } catch {
    return defaultSelection;
  }
}

interface NetworkContextValue {
  readonly family: ChainFamily;
  readonly network: ChainNetworkId;
  readonly chain: ChainDescriptor;
  readonly selection: StoredSelection;
  readonly setFamily: (family: ChainFamily) => void;
  readonly setNetwork: (network: ChainNetworkId) => void;
  readonly explorerTransactionUrl: (signature: string) => string;
  readonly explorerAddressUrl: (address: string) => string;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

function persist(selection: StoredSelection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Storage can be unavailable in privacy modes; the in-memory selection remains valid.
  }
}

export function NetworkProvider({ children }: { readonly children: ReactNode }) {
  const [selection, updateSelection] = useState<StoredSelection>(readSelection);
  const network = selection[selection.family];
  const chain = CHAIN_DESCRIPTORS[network];

  const setFamily = (family: ChainFamily) => {
    updateSelection((current) => {
      const next = { ...current, family };
      persist(next);
      return next;
    });
  };

  const setNetwork = (nextNetwork: ChainNetworkId) => {
    const descriptor = CHAIN_DESCRIPTORS[nextNetwork];
    updateSelection((current) => {
      const next: StoredSelection = descriptor.family === "solana"
        ? { ...current, family: "solana", solana: nextNetwork as StoredSelection["solana"] }
        : { ...current, family: "evm", evm: nextNetwork as StoredSelection["evm"] };
      persist(next);
      return next;
    });
  };

  const value = useMemo<NetworkContextValue>(() => ({
    family: selection.family,
    network,
    chain,
    selection,
    setFamily,
    setNetwork,
    explorerTransactionUrl: (signature) => chain.family === "solana"
      ? `${chain.explorerBaseUrl}/tx/${encodeURIComponent(signature)}?cluster=${chain.production ? "mainnet-beta" : "devnet"}`
      : `${chain.explorerBaseUrl}/tx/${encodeURIComponent(signature)}`,
    explorerAddressUrl: (address) => chain.family === "solana"
      ? `${chain.explorerBaseUrl}/address/${encodeURIComponent(address)}?cluster=${chain.production ? "mainnet-beta" : "devnet"}`
      : `${chain.explorerBaseUrl}/address/${encodeURIComponent(address)}`,
  }), [chain, network, selection]);

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const context = useContext(NetworkContext);
  if (!context) throw new Error("useNetwork must be used inside NetworkProvider.");
  return context;
}
