import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";
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
const WORKSPACE_STORAGE_KEY = "sunder:workspace:v1";

const auditEntrySchema = z.object({
  id: z.string().max(128),
  at: z.number().int().nonnegative(),
  category: z.enum(["configuration", "wallet", "simulation", "execution", "system"]),
  action: z.string().max(256),
  detail: z.string().max(2_048),
  state: z.enum(["local", "locked", "passed", "failed", "confirmed"]),
  network: z.enum(["solana:mainnet", "solana:devnet", "evm:mainnet", "evm:sepolia"]),
  signature: z.string().max(256).optional(),
});

const watchWalletSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(128),
  address: z.string().max(128),
  role: z.enum(["Developer", "Bundle", "Sniper", "Task", "Watch only"]),
  network: z.enum(["solana:mainnet", "solana:devnet", "evm:mainnet", "evm:sepolia"]),
});

const projectSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(128),
  symbol: z.string().max(32),
  network: z.enum(["solana:mainnet", "solana:devnet", "evm:mainnet", "evm:sepolia"]),
  status: z.enum(["Draft", "Pending confirmation", "Confirmed", "Locked"]),
  launchMode: z.enum(["Quick Deploy", "Bundle", "Snipe", "LBS", "Dev only"]),
  tokenAddress: z.string().max(128).optional(),
  signature: z.string().max(256).optional(),
  updatedAt: z.number().int().nonnegative(),
});

const workspaceStorageSchema = z.object({
  audit: z.array(auditEntrySchema).max(250),
  wallets: z.array(watchWalletSchema).max(100),
  projects: z.array(projectSchema).max(100),
});

function readWorkspace(): { readonly audit: readonly LocalAuditEntry[]; readonly wallets: readonly WatchWallet[]; readonly projects: readonly LocalProject[] } {
  if (typeof window === "undefined") return { audit: [], wallets: [], projects: [] };
  try {
    const parsed = workspaceStorageSchema.safeParse(JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "null"));
    return parsed.success ? parsed.data : { audit: [], wallets: [], projects: [] };
  } catch {
    return { audit: [], wallets: [], projects: [] };
  }
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function WorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const [stored] = useState(readWorkspace);
  const [audit, setAudit] = useState<readonly LocalAuditEntry[]>(stored.audit);
  const [wallets, setWallets] = useState<readonly WatchWallet[]>(stored.wallets);
  const [projects, setProjects] = useState<readonly LocalProject[]>(stored.projects);

  useEffect(() => {
    try { window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ audit, wallets, projects })); } catch { /* Storage policy may deny persistence. */ }
  }, [audit, projects, wallets]);

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
