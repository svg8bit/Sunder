import type { WalletConnector, WalletSession } from "@solana/client";
import { useWalletConnection } from "@solana/react-hooks";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createEmbeddedWallet,
  createEmbeddedWalletSession,
  deleteEmbeddedWallet,
  exportEmbeddedWalletBackup,
  exportEmbeddedWalletPrivateKey,
  listEmbeddedWallets,
  restoreEmbeddedWalletBackup,
  type EmbeddedWalletMetadata,
} from "../solana/embedded-wallet-vault";

const STORAGE_KEY = "sunder:solana-signing-connectors:v1";
export const SOLANA_SIGNER_AVAILABLE_EVENT = "sunder:solana-signer-available";
export const SOLANA_SIGNER_SELECTION_STORAGE_KEY = "sunder:terminal-wallet-selection:v1";

export interface ConnectedSolanaWallet {
  readonly id: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly kind: "wallet-standard" | "embedded";
  readonly createdAt?: number;
  readonly session: WalletSession;
}

interface SolanaWalletRegistryValue {
  readonly wallets: readonly ConnectedSolanaWallet[];
  readonly connectors: readonly WalletConnector[];
  readonly connectingConnectorId?: string;
  readonly creatingEmbeddedWallet: boolean;
  readonly connect: (connectorId: string) => Promise<void>;
  readonly createEmbedded: () => Promise<ConnectedSolanaWallet>;
  readonly disconnect: (walletId: string) => Promise<void>;
  readonly removeEmbedded: (walletId: string) => Promise<void>;
  readonly exportEmbedded: (walletId: string) => Promise<string>;
  readonly exportEmbeddedBackup: (passphrase: string) => Promise<string>;
  readonly restoreEmbeddedBackup: (serialized: string, passphrase: string) => Promise<readonly ConnectedSolanaWallet[]>;
}

const SolanaWalletRegistryContext = createContext<SolanaWalletRegistryValue | null>(null);

function walletId(connectorId: string, session: WalletSession): string {
  return `browser:${connectorId}:${session.account.address.toString()}`;
}

function announceSignerAvailable(id: string): void {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SOLANA_SIGNER_SELECTION_STORAGE_KEY) ?? "[]");
    const current = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    window.localStorage.setItem(SOLANA_SIGNER_SELECTION_STORAGE_KEY, JSON.stringify([...new Set([...current, id])].slice(0, 100)));
  } catch { /* Selection persistence is best-effort; the in-memory event still fires. */ }
  window.dispatchEvent(new CustomEvent(SOLANA_SIGNER_AVAILABLE_EVENT, { detail: Object.freeze({ id }) }));
}

function forgetSignerSelection(id: string): void {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SOLANA_SIGNER_SELECTION_STORAGE_KEY) ?? "[]");
    const current = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    window.localStorage.setItem(SOLANA_SIGNER_SELECTION_STORAGE_KEY, JSON.stringify(current.filter((value) => value !== id).slice(0, 100)));
  } catch { /* Selection persistence is best-effort. */ }
}

function readConnectorIds(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

function persistConnectorIds(ids: readonly string[]): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set(ids)].slice(0, 12))); } catch { /* Public connector metadata may fail to persist. */ }
}

function embeddedEntry(wallet: EmbeddedWalletMetadata): ConnectedSolanaWallet {
  return Object.freeze({
    id: wallet.id,
    connectorId: wallet.id,
    connectorName: wallet.label,
    kind: "embedded",
    createdAt: wallet.createdAt,
    session: createEmbeddedWalletSession(wallet),
  });
}

export function SolanaWalletRegistryProvider({ children }: { readonly children: ReactNode }) {
  const connection = useWalletConnection();
  const [sessions, setSessions] = useState<ReadonlyMap<string, WalletSession>>(() => new Map());
  const [embeddedWallets, setEmbeddedWallets] = useState<readonly ConnectedSolanaWallet[]>([]);
  const [connectingConnectorId, setConnectingConnectorId] = useState<string>();
  const [creatingEmbeddedWallet, setCreatingEmbeddedWallet] = useState(false);
  const reconnectStarted = useRef(false);
  const embeddedCreationActive = useRef(false);

  useEffect(() => {
    let active = true;
    void listEmbeddedWallets().then((wallets) => {
      if (active) setEmbeddedWallets((current) => {
        const loaded = wallets.map(embeddedEntry);
        return Object.freeze([...current, ...loaded].filter((wallet, index, values) => values.findIndex((candidate) => candidate.id === wallet.id) === index));
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const remember = useCallback((connectorId: string, session: WalletSession) => {
    setSessions((current) => {
      const next = new Map(current);
      next.set(connectorId, session);
      return next;
    });
    persistConnectorIds([...readConnectorIds(), connectorId]);
  }, []);

  useEffect(() => {
    if (connection.status === "connected" && connection.connectorId && connection.wallet) remember(connection.connectorId, connection.wallet);
  }, [connection.connectorId, connection.status, connection.wallet, remember]);

  useEffect(() => {
    if (!connection.isReady || reconnectStarted.current) return;
    reconnectStarted.current = true;
    const stored = readConnectorIds();
    for (const connectorId of stored) {
      if (connectorId === connection.connectorId || sessions.has(connectorId)) continue;
      const connector = connection.connectors.find((candidate) => candidate.id === connectorId);
      if (!connector?.canAutoConnect || !connector.isSupported()) continue;
      void connector.connect({ autoConnect: true, allowInteractiveFallback: false }).then((session) => remember(connectorId, session)).catch(() => undefined);
    }
  }, [connection.connectorId, connection.connectors, connection.isReady, remember, sessions]);

  useEffect(() => {
    const cleanups = [...sessions.entries()].flatMap(([connectorId, session]) => session.onAccountsChanged ? [session.onAccountsChanged((accounts) => {
      const account = accounts[0];
      if (!account) {
        setSessions((current) => {
          const next = new Map(current);
          next.delete(connectorId);
          return next;
        });
        return;
      }
      setSessions((current) => {
        const existing = current.get(connectorId);
        if (!existing || existing.account.address.toString() === account.address.toString()) return current;
        const next = new Map(current);
        next.set(connectorId, Object.freeze({ ...existing, account }));
        return next;
      });
    })] : []);
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [sessions]);

  const connect = useCallback(async (connectorId: string) => {
    if (connectingConnectorId) return;
    const connector = connection.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector || !connector.isSupported()) throw new Error("The selected Wallet Standard connector is unavailable.");
    setConnectingConnectorId(connectorId);
    try {
      const session = connection.status === "connected"
        ? await connector.connect({ allowInteractiveFallback: true })
        : await connection.connect(connectorId, { allowInteractiveFallback: true });
      remember(connectorId, session);
      announceSignerAvailable(walletId(connectorId, session));
    } finally {
      setConnectingConnectorId(undefined);
    }
  }, [connectingConnectorId, connection, remember]);

  const disconnect = useCallback(async (id: string) => {
    if (id.startsWith("embedded:")) return;
    const entry = [...sessions.entries()].find(([connectorId, session]) => walletId(connectorId, session) === id);
    if (!entry) return;
    const [connectorId, session] = entry;
    if (connection.connectorId === connectorId) await connection.disconnect();
    else await session.disconnect();
    setSessions((current) => {
      const next = new Map(current);
      next.delete(connectorId);
      return next;
    });
    persistConnectorIds(readConnectorIds().filter((candidate) => candidate !== connectorId));
    forgetSignerSelection(id);
  }, [connection, sessions]);

  const createEmbedded = useCallback(async () => {
    if (embeddedCreationActive.current) throw new Error("Wallet creation is already in progress.");
    embeddedCreationActive.current = true;
    setCreatingEmbeddedWallet(true);
    try {
      const entry = embeddedEntry(await createEmbeddedWallet());
      setEmbeddedWallets((current) => Object.freeze([entry, ...current]));
      announceSignerAvailable(entry.id);
      return entry;
    } finally {
      embeddedCreationActive.current = false;
      setCreatingEmbeddedWallet(false);
    }
  }, []);

  const removeEmbedded = useCallback(async (id: string) => {
    await deleteEmbeddedWallet(id);
    setEmbeddedWallets((current) => Object.freeze(current.filter((wallet) => wallet.id !== id)));
    forgetSignerSelection(id);
  }, []);

  const exportEmbedded = useCallback((id: string) => exportEmbeddedWalletPrivateKey(id), []);
  const exportEmbeddedBackup = useCallback((passphrase: string) => exportEmbeddedWalletBackup(passphrase), []);
  const restoreEmbeddedBackup = useCallback(async (serialized: string, passphrase: string) => {
    const restored = (await restoreEmbeddedWalletBackup(serialized, passphrase)).map(embeddedEntry);
    setEmbeddedWallets((current) => Object.freeze([...restored, ...current].filter((wallet, index, values) => values.findIndex((candidate) => candidate.id === wallet.id) === index)));
    for (const entry of restored) announceSignerAvailable(entry.id);
    return Object.freeze(restored);
  }, []);

  const standardWallets = useMemo(() => Object.freeze([...sessions.entries()].map(([connectorId, session]) => Object.freeze({
    id: walletId(connectorId, session),
    connectorId,
    connectorName: connection.connectors.find((connector) => connector.id === connectorId)?.name ?? session.connector.name,
    kind: "wallet-standard" as const,
    session,
  }))), [connection.connectors, sessions]);
  const wallets = useMemo(() => Object.freeze([...embeddedWallets, ...standardWallets]), [embeddedWallets, standardWallets]);

  const value = useMemo<SolanaWalletRegistryValue>(() => ({
    wallets,
    connectors: connection.connectors,
    connectingConnectorId,
    creatingEmbeddedWallet,
    connect,
    createEmbedded,
    disconnect,
    removeEmbedded,
    exportEmbedded,
    exportEmbeddedBackup,
    restoreEmbeddedBackup,
  }), [connect, connectingConnectorId, connection.connectors, createEmbedded, creatingEmbeddedWallet, disconnect, exportEmbedded, exportEmbeddedBackup, removeEmbedded, restoreEmbeddedBackup, wallets]);

  return <SolanaWalletRegistryContext.Provider value={value}>{children}</SolanaWalletRegistryContext.Provider>;
}

export function useSolanaWalletRegistry(): SolanaWalletRegistryValue {
  const context = useContext(SolanaWalletRegistryContext);
  if (!context) throw new Error("useSolanaWalletRegistry must be used inside SolanaWalletRegistryProvider.");
  return context;
}
