import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ChainNetworkId } from "../../packages/sniper-engine/src/index";

export interface LocalAuditEntry {
  readonly id: string;
  readonly at: number;
  readonly category: "configuration" | "wallet" | "simulation" | "execution" | "system";
  readonly action: string;
  readonly detail: string;
  readonly state: "local" | "locked" | "passed" | "failed" | "confirmed";
  readonly network: ChainNetworkId;
  readonly signature?: string;
}

export interface WatchWallet {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly role: "Developer" | "Bundle" | "Sniper" | "Task" | "Watch only";
  readonly network: ChainNetworkId;
}

export interface LocalProject {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly network: ChainNetworkId;
  readonly status: "Draft" | "Pending confirmation" | "Confirmed" | "Locked";
  readonly launchMode: "Quick Deploy" | "Bundle" | "Snipe" | "LBS" | "Dev only";
  readonly tokenAddress?: string;
  readonly signature?: string;
  readonly updatedAt: number;
}

interface WorkspaceContextValue {
  readonly audit: readonly LocalAuditEntry[];
  readonly wallets: readonly WatchWallet[];
  readonly projects: readonly LocalProject[];
  readonly record: (entry: Omit<LocalAuditEntry, "id" | "at">) => void;
  readonly addWallet: (wallet: Omit<WatchWallet, "id">) => void;
  readonly removeWallet: (id: string) => void;
  readonly saveProject: (project: Omit<LocalProject, "id" | "updatedAt"> & { readonly id?: string }) => string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function WorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const [audit, setAudit] = useState<readonly LocalAuditEntry[]>([]);
  const [wallets, setWallets] = useState<readonly WatchWallet[]>([]);
  const [projects, setProjects] = useState<readonly LocalProject[]>([]);

  const record = useCallback((entry: Omit<LocalAuditEntry, "id" | "at">) => {
    setAudit((current) => [{ ...entry, id: id("audit"), at: Date.now() }, ...current].slice(0, 250));
  }, []);

  const addWallet = useCallback((wallet: Omit<WatchWallet, "id">) => {
    setWallets((current) => [...current, { ...wallet, id: id("wallet") }]);
  }, []);

  const removeWallet = useCallback((walletId: string) => {
    setWallets((current) => current.filter((wallet) => wallet.id !== walletId));
  }, []);

  const saveProject = useCallback((project: Omit<LocalProject, "id" | "updatedAt"> & { readonly id?: string }) => {
    const projectId = project.id ?? id("project");
    const next: LocalProject = { ...project, id: projectId, updatedAt: Date.now() };
    setProjects((current) => [next, ...current.filter((candidate) => candidate.id !== projectId)]);
    return projectId;
  }, []);

  const value = useMemo(() => ({ audit, wallets, projects, record, addWallet, removeWallet, saveProject }), [addWallet, audit, projects, record, removeWallet, saveProject, wallets]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  return context;
}
