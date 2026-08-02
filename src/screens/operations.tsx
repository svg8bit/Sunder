import * as Tabs from "@radix-ui/react-tabs";
import { useSolanaClient } from "@solana/react-hooks";
import {
  ArrowDownUp,
  Box,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Eye,
  FileClock,
  Flame,
  Gauge,
  History,
  Info,
  KeyRound,
  LineChart,
  LoaderCircle,
  Lock,
  LockKeyhole,
  Plus,
  Rocket,
  Search,
  Send,
  Settings2,
  Shield,
  ShieldCheck,
  Timer,
  Trash2,
  Trophy,
  WalletCards,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { isAddress, isHex, TransactionReceiptNotFoundError, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { PublicKey } from "@solana/web3.js";
import safeRegex from "safe-regex2";
import { Badge, Button, EmptyState, Field, Input, Metric, Modal, Panel, Segmented, Select, Toggle } from "../components/ui";
import { EmbeddedWalletExport } from "../components/embedded-wallet-export";
import type { RouteId } from "../components/shell";
import { useNetwork } from "../state/network";
import { useSolanaWalletRegistry } from "../state/solana-wallet-registry";
import { useWorkspace, type WatchWallet } from "../state/workspace";
import { openWalletControl } from "../wallets/control-event";

function ScreenHeading({ eyebrow, title, description, actions }: { readonly eyebrow: string; readonly title: string; readonly description: string; readonly actions?: React.ReactNode }) {
  return <div className="screen-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions ? <div className="heading-actions">{actions}</div> : null}</div>;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short" }).format(timestamp);
}

function formatSolBalance(lamports: bigint | undefined): string {
  if (lamports === undefined) return "Loading…";
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${fraction} SOL`;
}

export function DashboardScreen({ navigate }: { readonly navigate: (route: RouteId) => void }) {
  const { chain, network, family } = useNetwork();
  const { projects, wallets, audit } = useWorkspace();
  const confirmedProjects = projects.filter((project) => project.status === "Confirmed" && project.network === network);
  const chainWallets = wallets.filter((wallet) => wallet.network === network);
  return (
    <div className="screen">
      <ScreenHeading eyebrow={`${family.toUpperCase()} command center`} title="Dashboard" description="Confirmed on-chain state and local drafts, kept visibly separate." actions={<Button variant="primary" onClick={() => navigate("launch")}><Plus size={16} /> New project</Button>} />
      <div className="dashboard-metrics">
        <Metric label="Confirmed launches" value={confirmedProjects.length} detail="RPC-verified only" />
        <Metric label={`Connected ${chain.nativeSymbol} balance`} value="—" detail="Connect wallet to load" />
        <Metric label="Executor readiness" value="Locked" detail="No signer policy" tone="warn" />
        <Metric label="Relay confirmations" value={audit.filter((entry) => entry.state === "confirmed" && entry.network === network).length} detail="Current session" />
      </div>
      <div className="dashboard-grid">
        <Panel className="flow-panel" title={`Net ${chain.nativeSymbol} flow`} action={<Badge tone="neutral">Not profit</Badge>}>
          <p className="panel-copy">Confirmed sells minus buys. Unvalued holdings are excluded; no synthetic chart is rendered without indexed data.</p>
          <div className="flow-summary"><div><span>Last 30 days</span><strong>0.000 {chain.nativeSymbol}</strong></div><div><span>Today</span><strong>0.000 {chain.nativeSymbol}</strong></div></div>
          <EmptyState icon={<LineChart size={24} />} title="No indexed on-chain flow" description="Configure an indexer and confirm transactions before a time series appears." action={<Button size="sm" onClick={() => navigate("settings")}>Open Settings</Button>} />
        </Panel>
        <Panel title="Project history" action={<Button size="sm" variant="ghost" onClick={() => navigate("projects")}>View projects <ChevronRight size={14} /></Button>}>
          {projects.length === 0 ? <EmptyState icon={<Boxes size={22} />} title="No projects yet" description="Validated manifests appear here as local drafts; only receipts can promote them to Confirmed." /> : <div className="project-list">{projects.slice(0, 6).map((project) => <button type="button" key={project.id} onClick={() => navigate("projects")}><span className="project-avatar">{project.symbol.slice(0, 2)}</span><span><strong>{project.name}</strong><small>{project.status} · {project.launchMode}</small></span><Badge tone={project.status === "Confirmed" ? "good" : project.status === "Locked" ? "warn" : "neutral"}>{project.network.replace(/^[^:]+:/, "")}</Badge></button>)}</div>}
        </Panel>
        <Panel title="Readiness matrix" className="dashboard-readiness">
          <div className="readiness-table compact"><div><span>Browser wallet</span><Badge tone="warn">Connect required</Badge></div><div><span>Public RPC</span><Badge tone="good">Configured</Badge></div><div><span>Persistent executor</span><Badge tone="warn">Unavailable on Vercel</Badge></div><div><span>Mainnet signer</span><Badge tone="warn">Locked</Badge></div><div><span>Watch-only wallets</span><Badge tone={chainWallets.length ? "good" : "neutral"}>{chainWallets.length}</Badge></div></div>
        </Panel>
      </div>
    </div>
  );
}

export function ProjectsScreen({ navigate }: { readonly navigate: (route: RouteId) => void }) {
  const { network, chain, explorerTransactionUrl } = useNetwork();
  const { projects } = useWorkspace();
  const [filter, setFilter] = useState<"All" | "Draft" | "Pending confirmation" | "Confirmed" | "Locked">("All");
  const [search, setSearch] = useState("");
  const visible = projects.filter((project) => project.network === network && (filter === "All" || project.status === filter) && `${project.name} ${project.symbol}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="screen">
      <ScreenHeading eyebrow="Workspace manifests" title="Projects" description="Draft, pending and receipt-confirmed launches on the selected network." actions={<Button variant="primary" onClick={() => navigate("launch")}><Rocket size={16} /> Create project</Button>} />
      <Panel className="table-panel">
        <div className="toolbar"><Segmented value={filter} onChange={setFilter} ariaLabel="Project filter" options={["All", "Draft", "Pending confirmation", "Confirmed", "Locked"].map((value) => ({ value: value as typeof filter, label: value }))} /><label className="search-input"><Search size={15} /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" /></label></div>
        {visible.length === 0 ? <EmptyState icon={<Box size={24} />} title="No matching projects" description={`No ${chain.name} project is stored in this session. A predicted address never creates a deployed project.`} action={<Button onClick={() => navigate("launch")}>Open Launch Studio</Button>} /> : (
          <div className="data-table"><div className="data-table__head"><span>Project</span><span>Mode</span><span>Status</span><span>On-chain evidence</span><span>Updated</span></div>{visible.map((project) => <div className="data-table__row" key={project.id}><span className="table-primary"><i>{project.symbol.slice(0, 2)}</i><b>{project.name}<small>{project.symbol}</small></b></span><span>{project.launchMode}</span><span><Badge tone={project.status === "Confirmed" ? "good" : project.status === "Locked" ? "warn" : "neutral"}>{project.status}</Badge></span><span>{project.signature ? <a href={explorerTransactionUrl(project.signature)} target="_blank" rel="noreferrer">Receipt <ExternalLink size={12} /></a> : <span className="muted">None</span>}</span><span>{formatTime(project.updatedAt)}</span></div>)}</div>
        )}
      </Panel>
    </div>
  );
}

function walletAddressValid(family: "solana" | "evm", address: string): boolean {
  if (family === "evm") return isAddress(address);
  try { new PublicKey(address); return true; } catch { return false; }
}

export function WalletsScreen() {
  const { family, network, chain, explorerAddressUrl } = useNetwork();
  const solanaClient = useSolanaClient();
  const signerRegistry = useSolanaWalletRegistry();
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [role, setRole] = useState<WatchWallet["role"]>("Watch only");
  const [exportWalletId, setExportWalletId] = useState<string>();
  const visible = workspace.wallets.filter((wallet) => wallet.network === network);
  const [signerBalances, setSignerBalances] = useState<Readonly<Record<string, bigint>>>({});
  const signerKey = signerRegistry.wallets.map((entry) => `${entry.id}:${entry.session.account.address.toString()}`).join("|");
  const walletHistory = useMemo(() => workspace.audit.filter((entry) => entry.network === network && (entry.category === "wallet" || entry.category === "execution")).slice(0, 20), [network, workspace.audit]);
  useEffect(() => {
    if (family !== "solana" || signerRegistry.wallets.length === 0) { setSignerBalances({}); return; }
    const controller = new AbortController();
    const refresh = async () => {
      const settled = await Promise.allSettled(signerRegistry.wallets.map(async (entry) => {
        const balance = await solanaClient.runtime.rpc.getBalance(entry.session.account.address, { commitment: "confirmed" }).send({ abortSignal: controller.signal });
        return [entry.id, balance.value] as const;
      }));
      if (!controller.signal.aborted) setSignerBalances(Object.freeze(Object.fromEntries(settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []))));
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [family, signerKey, signerRegistry.wallets, solanaClient]);
  const add = () => {
    if (!name.trim() || !walletAddressValid(family, address.trim())) { toast.error(`Enter a name and valid ${family === "solana" ? "Solana" : "EVM"} address.`); return; }
    workspace.addWallet({ name: name.trim(), address: address.trim(), role, network });
    workspace.record({ category: "configuration", action: "Watch-only wallet added", detail: `${role} · ${address.slice(0, 8)}…; no secret was stored.`, state: "local", network });
    setName(""); setAddress(""); setRole("Watch only"); setOpen(false); toast.success("Watch-only address added.");
  };
  const createSignerWallet = async () => {
    if (family !== "solana") { openWalletControl("connect"); return; }
    if (signerRegistry.creatingEmbeddedWallet) return;
    try {
      const entry = await signerRegistry.createEmbedded();
      workspace.record({ category: "wallet", action: "Embedded wallet created", detail: `${entry.connectorName} · ${entry.session.account.address.toString()}; encrypted device-local vault.`, state: "local", network });
      toast.success(`${entry.connectorName} created and saved in this browser.`);
    } catch (createError) {
      toast.error(createError instanceof Error ? createError.message : String(createError));
    }
  };
  const removeSignerWallet = async (entry: (typeof signerRegistry.wallets)[number]) => {
    try {
      if (entry.kind === "embedded") {
        if (!window.confirm(`Delete ${entry.connectorName} from this browser? Export its private key first or access is permanently lost.`)) return;
        await signerRegistry.removeEmbedded(entry.id);
        workspace.record({ category: "wallet", action: "Embedded wallet deleted", detail: `${entry.connectorName} · ${entry.session.account.address.toString()}; encrypted local record removed.`, state: "local", network });
        toast.success(`${entry.connectorName} removed from this browser.`);
        return;
      }
      await signerRegistry.disconnect(entry.id);
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : String(removeError));
    }
  };
  const exportWallet = signerRegistry.wallets.find((entry) => entry.id === exportWalletId && entry.kind === "embedded");
  return (
    <div className="screen">
      <ScreenHeading eyebrow="Self-custody inventory" title="Wallets" description="Create encrypted browser-local Solana wallets or connect a Wallet Standard provider; balances and public history persist in this browser." actions={<><Button onClick={() => setOpen(true)}><Eye size={16} /> Add watch address</Button><Button variant="primary" disabled={signerRegistry.creatingEmbeddedWallet} onClick={() => void createSignerWallet()}>{signerRegistry.creatingEmbeddedWallet ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Create wallet</Button></>} />
      <div className="custody-banner"><ShieldCheck size={22} /><div><strong>Self-custody, two signer boundaries</strong><span>Provider wallets sign in Phantom/Solflare/Backpack. Embedded wallets are generated client-side and AES-GCM encrypted in IndexedDB; export a backup before clearing site data.</span></div><Badge tone="good">No server custody</Badge></div>
      <Panel title={`${chain.name} connected signers`} action={<Badge tone={family === "solana" && signerRegistry.wallets.length > 0 ? "good" : "neutral"}>{family === "solana" ? signerRegistry.wallets.length : 0} linked</Badge>}>
        {family !== "solana" ? <EmptyState icon={<WalletCards size={24} />} title="EVM signer uses the header wallet" description="Switch to SOL to create a browser-local Solana signer, or connect the current EVM wallet from the header." /> : signerRegistry.wallets.length === 0 ? <EmptyState icon={<WalletCards size={24} />} title="No signing wallet linked" description="Create a wallet instantly in this browser. It appears here, is selected in the terminal and its confirmed SOL balance refreshes every 10 seconds." action={<Button variant="primary" disabled={signerRegistry.creatingEmbeddedWallet} onClick={() => void createSignerWallet()}><Plus size={15} /> Create wallet</Button>} /> : <div className="wallet-table">{signerRegistry.wallets.map((entry) => {
          const signerAddress = entry.session.account.address.toString();
          return <div key={entry.id}><span className="wallet-avatar">{entry.kind === "embedded" ? <KeyRound size={17} /> : <WalletCards size={17} />}</span><span><strong>{entry.connectorName}</strong><small>{signerAddress}</small></span><Badge tone="good">{entry.kind === "embedded" ? "Local signer" : "Provider signer"}</Badge><span>{formatSolBalance(signerBalances[entry.id])}</span><span className="wallet-table-actions">{entry.kind === "embedded" ? <button className="icon-button" type="button" onClick={() => setExportWalletId(entry.id)} aria-label={`Export ${entry.connectorName} private key`}><KeyRound size={15} /></button> : null}<a href={explorerAddressUrl(signerAddress)} target="_blank" rel="noreferrer" className="icon-button" aria-label={`Open ${entry.connectorName} in explorer`}><ExternalLink size={15} /></a></span><button className="icon-button" type="button" onClick={() => void removeSignerWallet(entry)} aria-label={`${entry.kind === "embedded" ? "Delete" : "Disconnect"} ${entry.connectorName}`}><Trash2 size={15} /></button></div>;
        })}</div>}
      </Panel>
      <div className="role-metrics"><Metric label="Developer" value={visible.filter((wallet) => wallet.role === "Developer").length} /><Metric label="Bundle" value={visible.filter((wallet) => wallet.role === "Bundle").length} /><Metric label="Sniper" value={visible.filter((wallet) => wallet.role === "Sniper").length} /><Metric label="Task / watch" value={visible.filter((wallet) => wallet.role === "Task" || wallet.role === "Watch only").length} /></div>
      <Panel title={`${chain.name} address inventory`} action={<Badge tone="neutral">0 secrets</Badge>}>
        {visible.length === 0 ? <EmptyState icon={<WalletCards size={24} />} title="No watch-only addresses" description="Add public addresses for transparent role planning, or connect a browser wallet for interactive signing." action={<Button onClick={() => setOpen(true)}>Add public address</Button>} /> : <div className="wallet-table">{visible.map((wallet) => <div key={wallet.id}><span className="wallet-avatar"><WalletCards size={17} /></span><span><strong>{wallet.name}</strong><small>{wallet.address}</small></span><Badge tone="accent">{wallet.role}</Badge><span className="muted">Balance loads from RPC when an indexer is configured</span><a href={explorerAddressUrl(wallet.address)} target="_blank" rel="noreferrer" className="icon-button"><ExternalLink size={15} /></a><button className="icon-button" type="button" onClick={() => workspace.removeWallet(wallet.id)} aria-label={`Remove ${wallet.name}`}><Trash2 size={15} /></button></div>)}</div>}
      </Panel>
      <Panel title="Wallet-linked history" action={<Badge tone="neutral">{walletHistory.length} local records</Badge>}>
        {walletHistory.length === 0 ? <EmptyState icon={<History size={22} />} title="No wallet history yet" description="Created or connected signers, simulations and canonically confirmed transactions will appear here with public addresses only." /> : <div className="audit-list compact">{walletHistory.map((entry) => <div key={entry.id}><span className={`status-dot status-dot--${entry.state}`} /><span><strong>{entry.action}</strong><small>{entry.detail}</small></span><Badge tone={entry.state === "confirmed" ? "good" : entry.state === "failed" ? "bad" : "neutral"}>{entry.state}</Badge><time>{formatTime(entry.at)}</time></div>)}</div>}
      </Panel>
      <Panel className="safe-replacement"><ArrowDownUp size={20} /><div><strong>Fund & Collect</strong><p>Transparent batched distribution will show exact recipients, amounts, fees and confirmations. Mixer/evasion modes are intentionally absent.</p></div><Button onClick={() => toast.info("Funding remains locked until a connected wallet and transaction preview are available.")}>Open preview</Button></Panel>
      <Modal open={open} onOpenChange={setOpen} title="Add watch-only address" description="Only a public address is accepted. Never paste a private key or seed phrase.">
        <div className="stack"><Field label="Label"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Treasury watch" /></Field><Field label={`${chain.name} public address`} hint="Public address only"><Input value={address} onChange={(event) => setAddress(event.target.value)} autoComplete="off" /></Field><Field label="Role"><Select value={role} onChange={(event) => setRole(event.target.value as WatchWallet["role"])}><option>Developer</option><option>Bundle</option><option>Sniper</option><option>Task</option><option>Watch only</option></Select></Field><div className="modal__actions"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={add}>Add address</Button></div></div>
      </Modal>
      <EmbeddedWalletExport wallet={exportWallet} open={Boolean(exportWallet)} onOpenChange={(nextOpen) => { if (!nextOpen) setExportWalletId(undefined); }} />
    </div>
  );
}

export function XidScreen() {
  const { network, chain } = useNetwork();
  const workspace = useWorkspace();
  const [accounts, setAccounts] = useState("@sunder");
  const [keywords, setKeywords] = useState("launch, token");
  const [regex, setRegex] = useState("");
  const [sample, setSample] = useState("Sunder will launch a transparent token with media.");
  const [requireMedia, setRequireMedia] = useState(true);
  const [autoApproval, setAutoApproval] = useState(false);
  const [dryResult, setDryResult] = useState<string | null>(null);
  const simulate = () => {
    if (regex && (!safeRegex(regex) || regex.length > 256)) { setDryResult("Rejected: unsafe regex."); return; }
    const words = keywords.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    const keyword = words.length === 0 || words.some((word) => sample.toLowerCase().includes(word));
    let regexMatch = true;
    try {
      regexMatch = !regex || new RegExp(regex, "iu").test(sample.slice(0, 4_096));
    } catch {
      setDryResult("Rejected: invalid regex syntax.");
      return;
    }
    const matched = keyword && regexMatch && (!requireMedia || sample.toLowerCase().includes("media"));
    const detail = matched ? "Matched dry-run rule. No deploy or transaction was created." : "No deterministic match; no action.";
    setDryResult(detail);
    workspace.record({ category: "simulation", action: "XID deterministic dry-run", detail, state: matched ? "passed" : "local", network });
  };
  return (
    <div className="screen">
      <ScreenHeading eyebrow="Event rules" title="XID" description="Deterministic X/Twitter rule builder with explicit provider and approval gates." actions={<Badge tone="warn">Live feed unconfigured</Badge>} />
      <div className="two-column">
        <div className="stack">
          <Panel title="Source & match"><Field label="Accounts" hint="Comma-separated public accounts"><Input value={accounts} onChange={(event) => setAccounts(event.target.value)} /></Field><Field label="Keywords"><Input value={keywords} onChange={(event) => setKeywords(event.target.value)} /></Field><Field label="Regex (optional)" hint="Unsafe or oversized expressions are rejected"><Input value={regex} onChange={(event) => setRegex(event.target.value)} /></Field><Toggle checked={requireMedia} onCheckedChange={setRequireMedia} label="Require media" description="Reject events that do not meet the media rule." /></Panel>
          <Panel title="Approval & risk"><Toggle checked={autoApproval} onCheckedChange={setAutoApproval} label="Automatic approval" description="Still bounded by spend/day, cooldown, allowlists, simulation and Mainnet lock." /><div className="field-row"><Field label={`Max ${chain.nativeSymbol} / deploy`}><Input defaultValue="0.10" /></Field><Field label="Deploys / day"><Input type="number" defaultValue="3" /></Field></div><div className="field-row"><Field label="Cooldown"><div className="input-unit"><Input type="number" defaultValue="300" /><span>s</span></div></Field><Field label="Approval mode"><Select defaultValue="dry"><option value="dry">Dry-run</option><option value="manual">Manual</option><option value="auto">Auto (executor gated)</option></Select></Field></div></Panel>
        </div>
        <div className="stack">
          <Panel title="Dry-run simulator" action={<Badge tone="good">No credentials needed</Badge>}><Field label="Sample provider event"><textarea className="input textarea" rows={7} value={sample} onChange={(event) => setSample(event.target.value)} /></Field><Button variant="primary" onClick={simulate}><PlayIcon /> Evaluate rule</Button>{dryResult ? <div className="dry-result"><CheckCircle2 size={18} /><span>{dryResult}</span></div> : null}</Panel>
          <Panel className="provider-lock"><LockKeyhole size={20} /><div><strong>X ingestion locked</strong><p>Configure a project-scoped provider credential in the executor. Browser local storage never receives it.</p></div></Panel>
          <Panel title="Event types"><div className="chip-grid"><Badge tone="neutral">Posts</Badge><Badge tone="neutral">Follows</Badge><Badge tone="neutral">Profile changes</Badge><Badge tone="neutral">Pool created</Badge><Badge tone="neutral">Program logs</Badge></div></Panel>
        </div>
      </div>
    </div>
  );
}

function PlayIcon() { return <Zap size={16} />; }

export function LeadersScreen() {
  const { chain } = useNetwork();
  const [privateProfile, setPrivateProfile] = useState(true);
  return <div className="screen"><ScreenHeading eyebrow="Opt-in analytics" title="Leaders" description="Public, consent-based performance metrics derived only from confirmed transactions." actions={<Toggle checked={privateProfile} onCheckedChange={setPrivateProfile} label="Private profile" description="Hide this browser profile" />} /><Panel><EmptyState icon={<Trophy size={25} />} title="No opted-in leaders" description={`PnL, volume and win rate require a verified ${chain.name} indexer plus explicit wallet consent. Nothing is fabricated for an empty leaderboard.`} /></Panel><div className="leader-metrics"><Metric label="Tracked wallets" value="0" /><Metric label="Confirmed trades" value="0" /><Metric label="Indexed volume" value={`0 ${chain.nativeSymbol}`} /><Metric label="Privacy" value={privateProfile ? "Private" : "Public"} tone={privateProfile ? "good" : "warn"} /></div></div>;
}

export function SwapManagerScreen() {
  const { family, network, chain } = useNetwork();
  const workspace = useWorkspace();
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("0.10");
  const [slippage, setSlippage] = useState("1.0");
  const [venue, setVenue] = useState<"Auto" | "V2" | "V3" | "V4">("Auto");
  const [taskOpen, setTaskOpen] = useState(false);
  const [smartSell, setSmartSell] = useState(false);
  const [autoTp, setAutoTp] = useState(false);
  const [taskMode, setTaskMode] = useState<"Exact" | "Range" | "Percentage" | "Full">("Exact");
  const simulate = () => {
    if (!token.trim()) { toast.error("Enter a token address before requesting a quote."); return; }
    const detail = `${direction} ${amount} ${chain.nativeSymbol}; local intent only. Quote provider and wallet are required.`;
    workspace.record({ category: "simulation", action: "Swap intent validated", detail, state: "passed", network });
    toast.success("Intent validated. No quote or transaction was fabricated.");
  };
  const saveTask = () => {
    workspace.record({ category: "configuration", action: "Buy Task saved locally", detail: `${taskMode} · bounded retries and jitter; executor not connected.`, state: "local", network });
    setTaskOpen(false); toast.success("Task configuration saved locally.");
  };
  return (
    <div className="screen swap-screen">
      <ScreenHeading eyebrow="Confirmed trading operations" title="Swap Manager" description="Venue-aware quotes, simulation, tasks and post-trade policies without synthetic activity." actions={<Badge tone="warn">No selected confirmed token</Badge>} />
      <div className="swap-grid">
        <div className="swap-market">
          <Panel className="token-strip"><div className="token-identity"><span>SU</span><div><strong>No token selected</strong><small>Paste a verified address</small></div></div><div className="token-stats"><span>MCap<strong>—</strong></span><span>Price<strong>—</strong></span><span>Liquidity<strong>—</strong></span><span>{chain.nativeSymbol}<strong>—</strong></span></div><Badge tone="neutral">Venue: unresolved</Badge></Panel>
          <Panel className="chart-panel" title="Chart / activity" action={<span className="muted">Confirmed indexer data only</span>}><EmptyState icon={<LineChart size={26} />} title="No market data" description="Select a confirmed token and configure an indexer. Sunder does not draw placeholder candles or fake volume." /></Panel>
          <Panel className="wallet-inventory" title="Wallet results" action={<Button size="sm" variant="danger" onClick={() => toast.warning("Sell All is locked until wallet selections and a simulated route exist.")}>Sell All</Button>}><EmptyState icon={<WalletCards size={22} />} title="No role wallets selected" description="Connected wallet and watch-only role groups remain separate; task execution requires a signer policy." /></Panel>
        </div>
        <aside className="trade-panel">
          <Panel>
            <Segmented value={direction} onChange={setDirection} ariaLabel="Trade direction" options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
            <Field label={family === "solana" ? "Token mint" : "Token contract"}><Input value={token} onChange={(event) => setToken(event.target.value)} placeholder={family === "solana" ? "Solana mint" : "0x…"} /></Field>
            {family === "evm" ? <Field label="Detected venue"><Segmented value={venue} onChange={setVenue} ariaLabel="Uniswap venue" options={["Auto", "V2", "V3", "V4"].map((value) => ({ value: value as typeof venue, label: value }))} /></Field> : null}
            <div className="quick-amounts">{["0.01", "0.05", "0.1", "0.5", "1"].map((value) => <button type="button" key={value} onClick={() => setAmount(value)}>{value}</button>)}</div>
            <Field label={direction === "buy" ? `Amount (${chain.nativeSymbol})` : "Sell percentage"}><div className="input-unit"><Input value={amount} onChange={(event) => setAmount(event.target.value)} /><span>{direction === "buy" ? chain.nativeSymbol : "%"}</span></div></Field>
            <Field label="Slippage"><div className="input-unit"><Input value={slippage} onChange={(event) => setSlippage(event.target.value)} /><span>%</span></div></Field>
            <div className="trade-actions"><Button onClick={simulate}><Gauge size={16} /> Simulate</Button><Button variant="primary" onClick={() => toast.warning("Connect a wallet, obtain a current quote and pass RPC simulation before signing.")}>{direction === "buy" ? "Buy" : "Sell"}</Button></div>
          </Panel>
          <div className="operation-buttons"><Button onClick={() => toast.info("Settings are available below.")}><Settings2 size={15} /> Settings</Button><Button onClick={() => setTaskOpen(true)}><Timer size={15} /> Buy Tasks</Button><Button onClick={() => toast.warning("Lock requires a verified token contract and simulation.")}><Lock size={15} /> Lock</Button><Button onClick={() => toast.warning("Burn is irreversible and requires an exact transaction preview.")}><Flame size={15} /> Burn</Button><Button onClick={() => toast.info("Transparent funding preview is not configured.")}><Send size={15} /> Send</Button></div>
          <Panel title="Enabled tasks">
            <Toggle checked={smartSell} onCheckedChange={setSmartSell} label="Smart Sell" description="Confirmed buy trigger + bounded sell percentage." />
            {smartSell ? <div className="task-mini-grid"><Field label="Sell % on buy"><Input defaultValue="10.5" /></Field><Field label={`Min ${chain.nativeSymbol}`}><Input defaultValue="0.1" /></Field><Field label="Min market cap"><Input defaultValue="50000" /></Field></div> : null}
            <Toggle checked={autoTp} onCheckedChange={setAutoTp} label="Auto TP" description="Receipt-driven take-profit levels; never timer-only success." />
            {autoTp ? <div className="task-mini-grid"><Field label="Trigger multiple"><Input defaultValue="2.0" /></Field><Field label="Sell %"><Input defaultValue="25" /></Field><Field label="Max attempts"><Input defaultValue="3" /></Field></div> : null}
          </Panel>
          <Panel className="honesty-panel"><Shield size={18} /><div><strong>Legitimate automation only</strong><p>Scheduled DCA, rebalancing and distribution are supported boundaries. Fake volume, candle painting and wash trading are not implemented.</p></div></Panel>
        </aside>
      </div>
      <Modal open={taskOpen} onOpenChange={setTaskOpen} title="Buy Task" description="A legitimate scheduled execution plan. It cannot create artificial volume.">
        <div className="stack"><Field label="Mode"><Segmented value={taskMode} onChange={setTaskMode} ariaLabel="Buy task mode" options={["Exact", "Range", "Percentage", "Full"].map((value) => ({ value: value as typeof taskMode, label: value }))} /></Field><div className="field-row"><Field label="Initial delay"><div className="input-unit"><Input type="number" defaultValue="0" /><span>ms</span></div></Field><Field label="Inter-wallet jitter"><div className="input-unit"><Input type="number" defaultValue="250" min="0" max="600000" /><span>ms</span></div></Field></div><div className="field-row"><Field label="Slippage BPS"><Input type="number" defaultValue="100" /></Field><Field label="Retries (0–50)"><Input type="number" min="0" max="50" defaultValue="3" /></Field></div>{family === "evm" ? <Field label="V3 fee tier (optional)"><Select defaultValue="auto"><option value="auto">Auto</option><option value="100">100</option><option value="500">500</option><option value="3000">3000</option><option value="10000">10000</option></Select></Field> : null}<Toggle checked={false} onCheckedChange={() => toast.info("Auto-start stays off until a persistent executor is configured.")} label="Auto-start on confirmed launch" description="The trigger is a confirmed receipt/account, not a predicted address." /><div className="modal__actions"><Button variant="ghost" onClick={() => setTaskOpen(false)}>Cancel</Button><Button variant="primary" onClick={saveTask}>Save task locally</Button></div></div>
      </Modal>
    </div>
  );
}

export function AuditScreen() {
  const { audit } = useWorkspace();
  const { explorerTransactionUrl } = useNetwork();
  const [filter, setFilter] = useState<"all" | "configuration" | "wallet" | "simulation" | "execution" | "system">("all");
  const visible = audit.filter((entry) => filter === "all" || entry.category === filter);
  return <div className="screen"><ScreenHeading eyebrow="Append-only session evidence" title="Audit Trail" description="Local configuration, simulations, relay attempts and on-chain confirmations use distinct states." actions={<Badge tone="good">No secrets logged</Badge>} /><Panel className="table-panel"><div className="toolbar"><Segmented value={filter} onChange={setFilter} ariaLabel="Audit filter" options={["all", "configuration", "wallet", "simulation", "execution", "system"].map((value) => ({ value: value as typeof filter, label: value }))} /></div>{visible.length === 0 ? <EmptyState icon={<FileClock size={24} />} title="No audit records" description="Run a validation, add a watch address or verify a testnet wallet transaction. No fabricated history is preloaded." /> : <div className="audit-list">{visible.map((entry) => <div key={entry.id}><span className={`audit-state audit-state--${entry.state}`}><History size={16} /></span><span><strong>{entry.action}</strong><small>{entry.detail}</small></span><Badge tone={entry.state === "confirmed" || entry.state === "passed" ? "good" : entry.state === "failed" ? "bad" : entry.state === "locked" ? "warn" : "neutral"}>{entry.state}</Badge><span className="muted">{entry.network}</span><time>{formatTime(entry.at)}</time>{entry.signature ? <a href={explorerTransactionUrl(entry.signature)} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a> : null}</div>)}</div>}</Panel></div>;
}

type TrackerResult = { readonly state: "idle" | "loading" | "found" | "missing" | "failed"; readonly detail?: string; readonly signature?: string };

export function TrackerScreen() {
  const { family, network, chain, explorerTransactionUrl } = useNetwork();
  const workspace = useWorkspace();
  const solana = useSolanaClient();
  const evmChain = network === "evm:mainnet" ? mainnet : sepolia;
  const evmClient = usePublicClient({ chainId: evmChain.id });
  const [signature, setSignature] = useState("");
  const [result, setResult] = useState<TrackerResult>({ state: "idle" });
  const track = async () => {
    const candidate = signature.trim();
    if (!candidate) return;
    setResult({ state: "loading" });
    try {
      if (family === "evm") {
        if (!isHex(candidate) || candidate.length !== 66 || !evmClient) throw new Error("Enter a 32-byte EVM transaction hash.");
        try {
          const receipt = await evmClient.getTransactionReceipt({ hash: candidate as Hex });
          const block = await evmClient.getBlock({ blockNumber: receipt.blockNumber });
          if (block.hash !== receipt.blockHash) throw new Error("Receipt block is not canonical (reorg detected).");
          const detail = `${receipt.status} receipt in canonical block ${receipt.blockNumber}.`;
          setResult({ state: "found", detail, signature: candidate });
          workspace.record({ category: "system", action: "Tracker found canonical EVM receipt", detail, state: receipt.status === "success" ? "confirmed" : "failed", network, signature: candidate });
        } catch (error) {
          if (error instanceof TransactionReceiptNotFoundError) { setResult({ state: "missing", detail: "No receipt found on the selected EVM network." }); return; }
          throw error;
        }
      } else {
        const response = await solana.runtime.rpc.getSignatureStatuses([candidate as never], { searchTransactionHistory: true }).send();
        const status = response.value[0];
        if (!status) { setResult({ state: "missing", detail: "No signature status found on the selected Solana network." }); return; }
        const detail = status.err ? `Transaction failed: ${JSON.stringify(status.err)}` : `${status.confirmationStatus ?? "processed"} at slot ${status.slot}.`;
        setResult({ state: status.err ? "failed" : "found", detail, signature: candidate });
        workspace.record({ category: "system", action: "Tracker queried Solana signature", detail, state: status.err ? "failed" : status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? "confirmed" : "local", network, signature: candidate });
      }
    } catch (error) { setResult({ state: "failed", detail: error instanceof Error ? error.message : String(error) }); }
  };
  return <div className="screen"><ScreenHeading eyebrow="RPC truth" title="Tracker" description="Query a signature or transaction hash directly on the selected network." /><div className="tracker-grid"><Panel title="Track transaction" action={<Badge tone="accent">{chain.name}</Badge>}><Field label={family === "solana" ? "Solana signature" : "EVM transaction hash"}><Input value={signature} onChange={(event) => setSignature(event.target.value)} placeholder={family === "solana" ? "Base58 signature" : "0x…"} /></Field><Button variant="primary" onClick={() => void track()} disabled={result.state === "loading"}>{result.state === "loading" ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />} Query RPC</Button>{result.state !== "idle" ? <div className={`tracker-result tracker-result--${result.state}`}>{result.state === "found" ? <CheckCircle2 size={20} /> : result.state === "loading" ? <LoaderCircle className="spin" size={20} /> : <Info size={20} />}<div><strong>{result.state}</strong><p>{result.detail}</p>{result.signature ? <a href={explorerTransactionUrl(result.signature)} target="_blank" rel="noreferrer">Open explorer <ExternalLink size={13} /></a> : null}</div></div> : null}</Panel><Panel title="Confirmation semantics"><div className="semantics-list"><div><span>Submitted</span><p>Provider accepted bytes; not success.</p></div><div><span>Processed</span><p>Observed but not yet at required depth.</p></div><div><span>Confirmed</span><p>Canonical RPC status/receipt met policy.</p></div><div><span>Finalized</span><p>Reached chain-specific finalized state.</p></div><div><span>Reorged / expired</span><p>Cannot be reported as success.</p></div></div></Panel></div></div>;
}

export function SettingsScreen() {
  const { family, chain } = useNetwork();
  const [notifications, setNotifications] = useState(true);
  const [compact, setCompact] = useState(true);
  const [protect, setProtect] = useState(true);
  return <div className="screen"><ScreenHeading eyebrow="Non-secret preferences" title="Settings" description="Chain-specific transaction defaults and truthful infrastructure readiness." /><Tabs.Root defaultValue="general" className="settings-tabs"><Tabs.List className="settings-tabs__list"><Tabs.Trigger value="general">General</Tabs.Trigger><Tabs.Trigger value="swap">Swap defaults</Tabs.Trigger><Tabs.Trigger value="relay">RPC & relays</Tabs.Trigger><Tabs.Trigger value="security">Security</Tabs.Trigger></Tabs.List><Tabs.Content value="general"><Panel title="Interface"><Toggle checked={notifications} onCheckedChange={setNotifications} label="Transaction notifications" description="Only provider/audit state, never invented confirmations." /><Toggle checked={compact} onCheckedChange={setCompact} label="Compact console density" description="Optimized for technical workflows." /><Field label="Activity filter"><Select defaultValue="confirmed"><option value="all">All states</option><option value="confirmed">Confirmed + failed</option><option value="execution">Execution only</option></Select></Field></Panel></Tabs.Content><Tabs.Content value="swap"><Panel title={`${family === "solana" ? "Solana" : "EVM"} defaults`}><div className="field-row"><Field label="Buy slippage %"><Input defaultValue="1.0" /></Field><Field label="Sell slippage %"><Input defaultValue="1.5" /></Field></div>{family === "solana" ? <div className="field-row"><Field label="Sniper tip SOL"><Input defaultValue="0.001010" /></Field><Field label="Swap tip SOL"><Input defaultValue="0.000100" /></Field></div> : <div className="field-row"><Field label="Priority fee Gwei"><Input defaultValue="1.5" /></Field><Field label="Replacement bump BPS"><Input defaultValue="1250" /></Field></div>}<div className="quick-actions-settings"><span>Quick buy</span>{["0.1", "0.25", "0.5", "1"].map((value) => <Badge key={value}>{value} {chain.nativeSymbol}</Badge>)}<span>Quick sell</span>{["25%", "50%", "75%", "100%"].map((value) => <Badge key={value}>{value}</Badge>)}</div></Panel></Tabs.Content><Tabs.Content value="relay"><Panel title="Provider readiness"><div className="readiness-table"><div><span>Standard RPC</span><Badge tone="good">Public fallback</Badge></div><div><span>{family === "solana" ? "Jito" : "Flashbots Protect"}</span><Badge tone={family === "evm" ? "good" : "warn"}>{family === "evm" ? "Official endpoint" : "Credential required"}</Badge></div><div><span>{family === "solana" ? "Nozomi / 0slot" : "Private transaction auth"}</span><Badge tone="warn">Server config required</Badge></div><div><span>Persistent executor</span><Badge tone="warn">Not on Vercel</Badge></div></div>{family === "evm" ? <Toggle checked={protect} onCheckedChange={setProtect} label="Prefer Flashbots Protect" description="Provider acceptance still requires canonical receipt confirmation." /> : null}</Panel></Tabs.Content><Tabs.Content value="security"><Panel title="Mainnet activation gates"><div className="gate-list"><span><Check size={15} /> Typed RPC configuration</span><span><Check size={15} /> Risk limits and kill switch</span><span><Lock size={15} /> External signer socket</span><span><Lock size={15} /> Relay/auth configuration</span><span><Lock size={15} /> Funding verification</span><span><Lock size={15} /> Operator confirmation</span></div><div className="custody-banner"><KeyRound size={19} /><div><strong>No private-key input fields</strong><span>Wallet Standard stays provider-owned; Solana embedded secrets are generated locally, AES-GCM encrypted in IndexedDB and revealed only through the explicit export action.</span></div></div></Panel></Tabs.Content></Tabs.Root></div>;
}

export function DocsScreen() {
  return <div className="screen docs-screen"><ScreenHeading eyebrow="Product runbook" title="Docs" description="Architecture, execution invariants, safe operating boundaries and network readiness." /><div className="docs-layout"><aside className="docs-toc"><a href="#architecture">Architecture</a><a href="#networks">Networks</a><a href="#wallets">Wallets</a><a href="#confirmation">Confirmation</a><a href="#readiness">Readiness</a><a href="#boundaries">Boundaries</a></aside><article className="docs-content"><section id="architecture"><h2>Chain-agnostic Sniper Engine</h2><p>The low-latency process normalizes events and runs a shared deterministic risk/retry/audit core. Chain adapters own quotes, transaction construction, relays, signing and confirmation semantics.</p><div className="docs-pipeline">EventSource <ChevronRight /> RuleEvaluator <ChevronRight /> QuoteAdapter <ChevronRight /> TransactionAdapter <ChevronRight /> Simulator <ChevronRight /> WalletAdapter <ChevronRight /> RelayRouter <ChevronRight /> ConfirmationAdapter</div></section><section id="networks"><h2>Production and verification networks</h2><div className="docs-grid"><Panel title="Solana"><p><strong>Mainnet:</strong> live pool discovery and direct zero-Sunder-fee Jupiter swaps with explicit selected-signer approval; persistent automation locked.</p><p><strong>Devnet:</strong> Wallet Standard self-transfer verification, Pump program boundary, standard RPC/Jito/Nozomi/0slot adapters.</p></Panel><Panel title="Ethereum / EVM"><p><strong>Mainnet:</strong> production mode, funded execution locked.</p><p><strong>Sepolia:</strong> EIP-1193 self-transfer verification, EIP-1559 simulation/replacement, receipt/reorg tracking, standard RPC/Flashbots adapters.</p></Panel></div></section><section id="wallets"><h2>Self-custody</h2><p>The web console never accepts a pasted private key or seed phrase. Solana supports Wallet Standard plus embedded signers generated and AES-GCM encrypted in this browser; explicit export is available for backup. EVM uses EIP-1193. Persistent automation uses a separate policy-limited signer over a Unix socket.</p></section><section id="confirmation"><h2>No success before chain confirmation</h2><p>A relay can return HTTP 200, an RPC can return a transaction hash, and a factory can predict an address while the transaction still fails to land. Sunder records those as submitted only. Success requires a canonical Solana signature status or EVM receipt at the configured depth; reorged, expired and reverted states fail.</p></section><section id="readiness"><h2>Production readiness matrix</h2><div className="matrix"><div className="matrix__head"><span>Capability</span><span>Solana Mainnet</span><span>Ethereum Mainnet</span><span>Test networks</span></div>{[["UI + selectors", "Implemented", "Implemented", "Implemented"],["Browser wallet", "Wallet Standard + local", "EIP-1193 / wagmi", "Executable"],["Quote / transaction", "Direct Jupiter + Pump", "Uniswap V2/V3/V4 auto-routing", "Mock/RPC tested"],["Relays", "RPC/Jito/Nozomi/0slot", "RPC/Flashbots", "Config aware"],["Persistent executor", "Locked", "Locked", "Signer required"],["On-chain verification", "Required", "Required", "Executable from wallet modal"]].map((row) => <div key={row[0]}>{row.map((value, index) => <span key={`${index}:${value}`}><Badge tone={value === "Locked" ? "warn" : index === 0 ? "neutral" : "good"}>{value}</Badge></span>)}</div>)}</div></section><section id="boundaries"><h2>Explicitly excluded</h2><p>No fake volume, candle painting, wash trading, mixer/evasion, aged-wallet marketplace, fabricated holders, or invented deploy history. Safe replacements are scheduled DCA, rebalancing, transparent distribution, deterministic strategy simulation, load testing and honest analytics.</p></section></article></div></div>;
}
