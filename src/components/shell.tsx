import * as Popover from "@radix-ui/react-popover";
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  ChevronDown,
  ClipboardList,
  Crosshair,
  FileClock,
  Flame,
  Gauge,
  History,
  LayoutDashboard,
  Menu,
  Plus,
  RadioTower,
  Rocket,
  Settings,
  ShieldCheck,
  Trophy,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { useNetwork } from "../state/network";
import { useWorkspace } from "../state/workspace";
import { Badge, Button, Select } from "./ui";
import { WalletControl } from "./wallet-control";

export type RouteId = "dashboard" | "launch" | "sniper" | "projects" | "wallets" | "xid" | "leaders" | "swap" | "audit" | "tracker" | "settings" | "docs";

const routes: readonly { readonly id: RouteId; readonly label: string; readonly icon: typeof Rocket; readonly primary?: boolean }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "launch", label: "Launch Studio", icon: Rocket, primary: true },
  { id: "sniper", label: "Sniper", icon: Crosshair, primary: true },
  { id: "projects", label: "Projects", icon: Boxes, primary: true },
  { id: "wallets", label: "Wallets", icon: WalletCards },
  { id: "xid", label: "XID", icon: RadioTower },
  { id: "leaders", label: "Leaders", icon: Trophy },
  { id: "swap", label: "Swap Manager", icon: Activity },
  { id: "audit", label: "Audit Trail", icon: FileClock, primary: true },
  { id: "tracker", label: "Tracker", icon: ClipboardList },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "docs", label: "Docs", icon: BookOpen, primary: true },
];

export function routeFromPath(pathname = window.location.pathname): RouteId {
  const value = pathname.replace(/^\//, "").split("/")[0];
  if (value === "meme") return "swap";
  return routes.some((route) => route.id === value) ? value as RouteId : "launch";
}

export function useAppRoute() {
  const [route, setRoute] = useState<RouteId>(routeFromPath);
  useEffect(() => {
    const listener = () => setRoute(routeFromPath());
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  const navigate = (next: RouteId) => {
    if (route === next) return;
    window.history.pushState({}, "", `/${next}`);
    setRoute(next);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  };
  return { route, navigate };
}

function Brand({ onClick }: { readonly onClick: () => void }) {
  return (
    <button className="brand" type="button" onClick={onClick} aria-label="Sunder Launch Studio">
      <span className="brand__mark"><Flame size={27} strokeWidth={1.8} /></span>
      <span>SUNDER</span>
    </button>
  );
}

function NetworkControls() {
  const { family, network, setFamily, setNetwork } = useNetwork();
  return (
    <div className="network-controls">
      <div className="family-switch" aria-label="Network family">
        <button type="button" aria-pressed={family === "solana"} className={cn(family === "solana" && "is-active")} onClick={() => setFamily("solana")}>SOL</button>
        <button type="button" aria-pressed={family === "evm"} className={cn(family === "evm" && "is-active")} onClick={() => setFamily("evm")}>EVM</button>
      </div>
      <span className="network-select-wrap">
        <span className={cn("network-dot", network.endsWith("mainnet") ? "is-mainnet" : "is-testnet")} />
        <Select aria-label="Network" value={network} onChange={(event) => setNetwork(event.target.value as typeof network)}>
          {family === "solana" ? (
            <><option value="solana:mainnet">Mainnet</option><option value="solana:devnet">Devnet</option></>
          ) : (
            <><option value="evm:mainnet">Ethereum</option><option value="evm:sepolia">Sepolia</option></>
          )}
        </Select>
        <ChevronDown className="network-select-chevron" size={15} />
      </span>
    </div>
  );
}

export function AppShell({ children, route, navigate }: { readonly children: ReactNode; readonly route: RouteId; readonly navigate: (route: RouteId) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { chain } = useNetwork();
  const { audit } = useWorkspace();
  const nav = useMemo(() => routes, []);
  const solanaExecutorProvisioned = chain.family === "solana" && Boolean(import.meta.env.VITE_SOLANA_EXECUTOR_PUBLIC_ADDRESS?.trim());
  return (
    <div className={cn("app-shell", route === "swap" && "app-shell--terminal")}>
      <header className="topbar">
        <Brand onClick={() => navigate("launch")} />
        <nav className="topnav" aria-label="Primary navigation">
          {nav.filter((item) => item.primary).map((item) => {
            const Icon = item.icon;
            return <button type="button" key={item.id} className={cn("nav-item", route === item.id && "is-active")} onClick={() => navigate(item.id)}><Icon size={17} />{item.label}</button>;
          })}
        </nav>
        <div className="topbar__actions">
          <NetworkControls />
          <Popover.Root>
            <Popover.Trigger asChild><button type="button" className="icon-button notification-button" aria-label="Notifications"><Bell size={18} />{audit.length > 0 ? <span>{Math.min(audit.length, 9)}</span> : null}</button></Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className="popover" align="end" sideOffset={9}>
                <div className="popover__heading">Notifications</div>
                {audit.length === 0 ? <p className="muted">No execution notifications. Local configuration actions will appear here.</p> : audit.slice(0, 4).map((entry) => (
                  <button type="button" className="notification" key={entry.id} onClick={() => navigate("audit")}><span className={`state-dot state-dot--${entry.state}`} /><span><strong>{entry.action}</strong><small>{entry.detail}</small></span></button>
                ))}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <WalletControl />
          <button type="button" className="icon-button mobile-menu-button" onClick={() => setMenuOpen((value) => !value)} aria-label="Toggle navigation" aria-expanded={menuOpen} aria-controls="workspace-drawer">{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </header>
      <nav className="mobile-nav" aria-label="Application sections">
        {nav.map((item) => {
          const Icon = item.icon;
          return <button type="button" key={item.id} className={cn(route === item.id && "is-active")} onClick={() => navigate(item.id)}><Icon size={18} /><span>{item.label}</span></button>;
        })}
      </nav>
      <div id="workspace-drawer" className={cn("side-drawer", menuOpen && "is-open")} aria-hidden={!menuOpen} inert={!menuOpen}>
        <div className="side-drawer__head"><span>Workspace</span><Badge tone={chain.production ? "warn" : "good"}>{chain.name}</Badge></div>
        <button type="button" onClick={() => { navigate("audit"); setMenuOpen(false); }}><Bell size={18} />Notifications{audit.length > 0 ? <Badge tone="accent">{Math.min(audit.length, 9)}</Badge> : null}</button>
        {nav.map((item) => {
          const Icon = item.icon;
          return <button type="button" key={item.id} className={cn(route === item.id && "is-active")} onClick={() => { navigate(item.id); setMenuOpen(false); }}><Icon size={18} />{item.label}</button>;
        })}
      </div>
      <main className="app-main" id="main-content">{children}</main>
      <Popover.Root>
        <Popover.Trigger asChild><Button className="quick-action" variant="primary" aria-label="Quick actions"><Plus size={17} /><span>Quick</span></Button></Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="popover quick-menu" align="end" side="top" sideOffset={10}>
            <button type="button" onClick={() => navigate("launch")}><Rocket size={16} /> Quick Deploy</button>
            <button type="button" onClick={() => navigate("sniper")}><Crosshair size={16} /> Arm Sniper</button>
            <button type="button" onClick={() => navigate("swap")}><Activity size={16} /> Swap Manager</button>
            <button type="button" onClick={() => navigate("tracker")}><History size={16} /> Track signature</button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <footer className="statusbar">
        <span><span className="statusbar__dot" /> Console online</span>
        <span><Bot size={13} /> Executor <strong>{solanaExecutorProvisioned ? "provisioned" : "not configured"}</strong></span>
        <span><ShieldCheck size={13} /> Automation <strong>{solanaExecutorProvisioned ? "funding gate" : "locked"}</strong></span>
        <span><Gauge size={13} /> RPC confirmation required</span>
      </footer>
    </div>
  );
}
