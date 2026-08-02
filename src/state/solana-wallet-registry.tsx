import type { WalletConnector, WalletSession } from "@solana/client";
import { useWalletConnection } from "@solana/react-hooks";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "sunder:solana-signing-connectors:v1";

export interface ConnectedSolanaWallet {
  readonly id: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly session: WalletSession;
}

interface SolanaWalletRegistryValue {
  readonly wallets: readonly ConnectedSolanaWallet[];
  readonly connectors: readonly WalletConnector[];
  readonly connectingConnectorId?: string;
  readonly connect: (connectorId: string) => Promise<void>;
  readonly disconnect: (walletId: string) => Promise<void>;
}

const SolanaWalletRegistryContext = createContext<SolanaWalletRegistryValue | null>(null);

function walletId(connectorId: string, session: WalletSession): string {
  return `browser:${connectorId}:${session.account.address.toString()}`;
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

export function SolanaWalletRegistryProvider({ children }: { readonly children: ReactNode }) {
  const connection = useWalletConnection();
  const [sessions, setSessions] = useState<ReadonlyMap<string, WalletSession>>(() => new Map());
  const [connectingConnectorId, setConnectingConnectorId] = useState<string>();
  const reconnectStarted = useRef(false);

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
    } finally {
      setConnectingConnectorId(undefined);
    }
  }, [connectingConnectorId, connection, remember]);

  const disconnect = useCallback(async (id: string) => {
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
  }, [connection, sessions]);

  const wallets = useMemo(() => Object.freeze([...sessions.entries()].map(([connectorId, session]) => Object.freeze({
    id: walletId(connectorId, session),
    connectorId,
    connectorName: connection.connectors.find((connector) => connector.id === connectorId)?.name ?? session.connector.name,
    session,
  }))), [connection.connectors, sessions]);

  const value = useMemo<SolanaWalletRegistryValue>(() => ({
    wallets,
    connectors: connection.connectors,
    connectingConnectorId,
    connect,
    disconnect,
  }), [connect, connectingConnectorId, connection.connectors, disconnect, wallets]);

  return <SolanaWalletRegistryContext.Provider value={value}>{children}</SolanaWalletRegistryContext.Provider>;
}

export function useSolanaWalletRegistry(): SolanaWalletRegistryValue {
  const context = useContext(SolanaWalletRegistryContext);
  if (!context) throw new Error("useSolanaWalletRegistry must be used inside SolanaWalletRegistryProvider.");
  return context;
}
