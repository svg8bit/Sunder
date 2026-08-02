import type { WalletSession } from "@solana/client";
import { useSolanaClient } from "@solana/react-hooks";
import { address as solanaAddress } from "@solana/kit";
import {
  AlertTriangle,
  ArrowDownUp,
  BarChart3,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  History,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Move,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  WalletCards,
  Wifi,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge, Button, EmptyState, Field, Input, Panel, Segmented, Select, Toggle } from "../components/ui";
import { FloatingPanel, resetTerminalPanelLayout } from "../components/floating-panel";
import { EmbeddedWalletExport } from "../components/embedded-wallet-export";
import { LiveCandlestickChart, type CandleInterval } from "../components/live-candlestick-chart";
import { applyPercentageBps, formatAtomicAmount, parseDecimalAmount } from "../solana/amounts";
import { SOLANA_MAINNET_RPC_URL } from "../solana/client";
import {
  executePreparedJupiterSwap,
  getWalletTokenBalanceAtomic,
  prepareJupiterSwap,
  type ConfirmedSwapReceipt,
  type PreparedJupiterSwap,
  type PriorityProfile,
  type SwapExecutionState,
} from "../solana/jupiter";
import { safeTokenIcon, searchTokenInformation, type PumpTrade, type TokenInformation } from "../solana/market";
import { usePumpTradeStream, useRecentTokens } from "../solana/use-market";
import { useNetwork } from "../state/network";
import { SOLANA_SIGNER_AVAILABLE_EVENT, SOLANA_SIGNER_SELECTION_STORAGE_KEY, useSolanaWalletRegistry } from "../state/solana-wallet-registry";
import { deriveTrackedPosition, useTrading } from "../state/trading";
import { useWorkspace } from "../state/workspace";

type FeedFilter = "new" | "moving" | "liquid" | "pump";
type TradeDirection = "buy" | "sell";
type TradeMode = "market" | "limit" | "advanced";
type QuotePhase = "idle" | "quoting" | "ready" | "awaiting-signature" | "signed" | "submitted" | "processed" | "confirmed" | "failed";
type PricePoint = { readonly at: number; readonly price: number };
type PreparedWalletSwap = { readonly walletId: string; readonly connectorName: string; readonly wallet: WalletSession; readonly prepared: PreparedJupiterSwap };
type ConfirmedWalletSwap = { readonly walletId: string; readonly connectorName: string; readonly receipt: ConfirmedSwapReceipt };

function shorten(value: string, left = 5, right = 4): string {
  return value.length <= left + right + 1 ? value : `${value.slice(0, left)}…${value.slice(-right)}`;
}

function formatCompact(value: number | undefined, prefix = ""): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${prefix}${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value)}`;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.0001) {
    const fraction = value.toFixed(14).split(".")[1] ?? "";
    const zeroCount = fraction.match(/^0+/)?.[0].length ?? 0;
    const subscript = String(zeroCount).replace(/[0-9]/g, (digit) => "₀₁₂₃₄₅₆₇₈₉"[Number(digit)] ?? digit);
    const significant = fraction.slice(zeroCount, zeroCount + 4).replace(/0+$/, "") || "0";
    return `$0.0${subscript}${significant}`;
  }
  return new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 6 : 2 }).format(value);
}

function formatSigned(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSol(lamports: bigint, precision = 6): string {
  return `${formatAtomicAmount(lamports, 9, precision)} SOL`;
}

function formatHistoryTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function tokenAge(token: TokenInformation): string {
  if (!token.firstPool?.createdAt) return "unknown";
  const createdAt = Date.parse(token.firstPool.createdAt);
  if (!Number.isFinite(createdAt)) return "unknown";
  const age = Math.max(0, Date.now() - createdAt);
  if (age < 60_000) return `${Math.floor(age / 1_000)}s`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  return `${Math.floor(age / 3_600_000)}h`;
}

function sourceLabel(token: TokenInformation): string {
  return token.id.toLowerCase().endsWith("pump") ? "Pump.fun" : "Jupiter indexed";
}

function activeRecentToken(tokens: readonly TokenInformation[]): TokenInformation | undefined {
  const recent = tokens.slice(0, 24);
  const pumpTokens = recent.filter((token) => token.id.toLowerCase().endsWith("pump"));
  const candidates = pumpTokens.length > 0 ? pumpTokens : recent;
  return candidates.reduce<TokenInformation | undefined>((best, token) => {
    const volume = (token.stats5m?.buyVolume ?? 0) + (token.stats5m?.sellVolume ?? 0);
    const bestVolume = (best?.stats5m?.buyVolume ?? 0) + (best?.stats5m?.sellVolume ?? 0);
    return !best || volume > bestVolume ? token : best;
  }, undefined);
}

function copy(value: string): void {
  if (!navigator.clipboard?.writeText) { toast.error("Clipboard is unavailable in this context."); return; }
  void navigator.clipboard.writeText(value).then(() => toast.success("Address copied."), () => toast.error("Clipboard permission was denied."));
}

function tokenImage(token: TokenInformation, className: string) {
  const icon = safeTokenIcon(token.icon);
  return icon
    ? <img className={className} src={icon} alt="" loading="lazy" referrerPolicy="no-referrer" />
    : <span className={className}>{token.symbol.slice(0, 2).toUpperCase()}</span>;
}

function slippagePercentToBps(value: string): number {
  const percent = Number(value.replace(",", "."));
  if (!Number.isFinite(percent)) return 100;
  return Math.min(5_000, Math.max(1, Math.round(percent * 100)));
}

function TokenFeedRow({ token, active, disabled, onSelect }: { readonly token: TokenInformation; readonly active: boolean; readonly disabled?: boolean; readonly onSelect: () => void }) {
  const change = token.stats5m?.priceChange;
  return (
    <button type="button" className={`terminal-token-row${active ? " is-active" : ""}`} disabled={disabled} onClick={onSelect} aria-pressed={active}>
      {tokenImage(token, "terminal-token-row__icon")}
      <span className="terminal-token-row__identity"><strong>{token.symbol}</strong><small>{token.name}</small></span>
      <span><strong>{formatUsd(token.usdPrice)}</strong><small>{tokenAge(token)}</small></span>
      <span className={(change ?? 0) >= 0 ? "is-positive" : "is-negative"}><strong>{formatSigned(change)}</strong><small>{formatCompact(token.stats5m?.buyVolume, "$")} vol</small></span>
    </button>
  );
}

function PumpTape({ trades, status, token }: { readonly trades: readonly PumpTrade[]; readonly status: "idle" | "connecting" | "live" | "failed"; readonly token?: TokenInformation }) {
  return (
    <aside className="terminal-tape" aria-label="Live Pump trade tape">
      <header><div><Radio size={14} /><strong>Live trades</strong></div><Badge tone={status === "live" ? "good" : status === "failed" ? "bad" : "neutral"}>{status}</Badge></header>
      <div className="terminal-tape__labels"><span>Side / SOL</span><span>Tokens</span><span>Trader</span><span>Age</span></div>
      <div className="terminal-tape__body">
        {trades.length === 0 ? (
          <div className="terminal-tape__empty"><Wifi size={20} /><strong>{status === "failed" ? "WebSocket unavailable" : "Waiting for Pump events"}</strong><span>{token ? `No confirmed ${token.symbol} trades observed in this session.` : "Select a token."}</span></div>
        ) : trades.map((trade) => (
          <a key={`${trade.signature}:${trade.slot}`} className={`terminal-tape__row is-${trade.side}`} href={`https://solscan.io/tx/${encodeURIComponent(trade.signature)}`} target="_blank" rel="noreferrer">
            <span><b>{trade.side === "buy" ? "B" : "S"}</b>{formatAtomicAmount(trade.solAmountLamports, 9, 3)}</span>
            <span>{formatCompact(Number(trade.tokenAmountAtomic) / 10 ** (token?.decimals ?? 6))}</span>
            <span>{shorten(trade.user, 3, 3)}</span>
            <span>{Math.max(0, Math.floor((Date.now() - trade.timestamp) / 1_000))}s</span>
          </a>
        ))}
      </div>
      {trades[0] ? <footer><span>Protocol + creator fee</span><strong>{((trades[0].feeBasisPoints + trades[0].creatorFeeBasisPoints) / 100).toFixed(2)}%</strong></footer> : null}
    </aside>
  );
}

function EvmTerminalBoundary() {
  const { network, chain } = useNetwork();
  return (
    <div className="screen terminal-boundary-screen">
      <div className="screen-heading"><div><span className="eyebrow">Direct trading / EVM</span><h1>Swap Manager</h1><p>The Solana terminal is live first. The EVM chain adapters remain available without pretending a venue route exists.</p></div><Badge tone="warn">Provider required</Badge></div>
      <div className="terminal-boundary-grid">
        <Panel title={`${chain.name} execution boundary`} action={<Badge tone="warn">Unconfigured</Badge>}>
          <div className="terminal-boundary-copy"><AlertTriangle size={24} /><div><strong>No EVM quote provider is configured in this browser deployment.</strong><p>Uniswap V2/V3/V4-aware adapters, EIP-1559 simulation, nonce replacement, private submission and canonical receipt tracking stay implemented behind the shared engine. A green trade state will not be fabricated.</p></div></div>
          <div className="readiness-table compact"><div><span>Network</span><strong>{network}</strong></div><div><span>Browser wallet</span><strong>Self-custody</strong></div><div><span>Quote / swap route</span><Badge tone="warn">RPC + provider required</Badge></div><div><span>Sunder platform fee</span><Badge tone="good">0 bps</Badge></div></div>
        </Panel>
        <Panel title="Solana-first release"><EmptyState icon={<Zap size={24} />} title="Open SOL · Mainnet" description="Live new-token discovery and direct zero-platform-fee Jupiter swaps are available in the Solana Mainnet terminal." /></Panel>
      </div>
    </div>
  );
}

export function TradingTerminalScreen() {
  const { family, network, explorerAddressUrl, explorerTransactionUrl, setFamily, setNetwork } = useNetwork();
  const client = useSolanaClient();
  const walletRegistry = useSolanaWalletRegistry();
  const workspace = useWorkspace();
  const trading = useTrading();
  const live = network === "solana:mainnet";
  const recent = useRecentTokens(live);
  const [filter, setFilter] = useState<FeedFilter>("new");
  const [manualTokens, setManualTokens] = useState<readonly TokenInformation[]>([]);
  const [pinnedToken, setPinnedToken] = useState<TokenInformation>();
  const [selectedMint, setSelectedMint] = useState<string>();
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [observations, setObservations] = useState<Readonly<Record<string, readonly PricePoint[]>>>({});
  const [candleInterval, setCandleInterval] = useState<CandleInterval>(1);
  const [direction, setDirection] = useState<TradeDirection>("buy");
  const [tradeMode, setTradeMode] = useState<TradeMode>("market");
  const [preset, setPreset] = useState<"1" | "2" | "3">("1");
  const [amount, setAmount] = useState("0.05");
  const [sellPercentage, setSellPercentage] = useState(10_000);
  const [slippagePercent, setSlippagePercent] = useState("1");
  const [priorityProfile, setPriorityProfile] = useState<PriorityProfile>("high");
  const [fastMode, setFastMode] = useState(true);
  const [mevMode, setMevMode] = useState<"standard" | "private">("standard");
  const [walletSearch, setWalletSearch] = useState("");
  const [showWatchOnly, setShowWatchOnly] = useState(true);
  const [walletTab, setWalletTab] = useState<"wallets" | "history">("wallets");
  const [exportWalletId, setExportWalletId] = useState<string>();
  const [selectedWalletIds, setSelectedWalletIds] = useState<readonly string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SOLANA_SIGNER_SELECTION_STORAGE_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string").slice(0, 100) : [];
    } catch { return []; }
  });
  const [signerBalances, setSignerBalances] = useState<Readonly<Record<string, bigint>>>({});
  const [watchBalances, setWatchBalances] = useState<Readonly<Record<string, bigint>>>({});
  const [preparedBasket, setPreparedBasket] = useState<readonly PreparedWalletSwap[]>([]);
  const [confirmedBasket, setConfirmedBasket] = useState<readonly ConfirmedWalletSwap[]>([]);
  const [phase, setPhase] = useState<QuotePhase>("idle");
  const [error, setError] = useState<string>();
  const quoteAbort = useRef<AbortController | undefined>(undefined);
  const executing = useRef(false);

  const invalidateQuote = useCallback(() => {
    quoteAbort.current?.abort();
    quoteAbort.current = undefined;
    setPreparedBasket([]);
    setConfirmedBasket([]);
    setPhase("idle");
    setError(undefined);
  }, []);

  const tokens = useMemo(() => {
    // Keep the selected instrument stable when it ages out of the rolling
    // `/recent` window. Current provider data still wins while it is present.
    const values = [...(recent.data ?? []), ...manualTokens, ...(pinnedToken ? [pinnedToken] : [])];
    return values.filter((token, index) => values.findIndex((candidate) => candidate.id === token.id) === index);
  }, [manualTokens, pinnedToken, recent.data]);
  const selected = tokens.find((token) => token.id === selectedMint);

  useEffect(() => {
    const fallback = activeRecentToken(tokens);
    if (fallback && (!selectedMint || !tokens.some((token) => token.id === selectedMint))) setSelectedMint(fallback.id);
  }, [selectedMint, tokens]);

  useEffect(() => {
    if (selected && selected !== pinnedToken) setPinnedToken(selected);
  }, [pinnedToken, selected]);

  useEffect(() => {
    const activeMints = new Set(tokens.map((token) => token.id));
    setObservations((current) => {
      const retained = Object.entries(current).filter(([mint]) => activeMints.has(mint));
      return retained.length === Object.keys(current).length ? current : Object.freeze(Object.fromEntries(retained));
    });
  }, [tokens]);

  useEffect(() => {
    if (!selected?.usdPrice || !Number.isFinite(selected.usdPrice)) return;
    const at = selected.updatedAt ? Date.parse(selected.updatedAt) : Date.now();
    const timestamp = Number.isFinite(at) ? at : Date.now();
    setObservations((current) => {
      const existing = current[selected.id] ?? [];
      const last = existing.at(-1);
      if (last?.at === timestamp && last.price === selected.usdPrice) return current;
      return { ...current, [selected.id]: Object.freeze([...existing, { at: timestamp, price: selected.usdPrice! }].slice(-180)) };
    });
  }, [selected]);

  useEffect(() => {
    invalidateQuote();
  }, [direction, invalidateQuote, selectedMint]);

  useEffect(() => () => quoteAbort.current?.abort(), []);

  const stream = usePumpTradeStream({ enabled: live && Boolean(selected), mint: selected?.id, decimals: selected?.decimals });
  const networkWallets = useMemo(() => workspace.wallets.filter((candidate) => candidate.network === network), [network, workspace.wallets]);
  const watchWalletKey = networkWallets.map((candidate) => `${candidate.id}:${candidate.address}`).join("|");
  const signingWalletKey = walletRegistry.wallets.map((candidate) => `${candidate.id}:${candidate.session.account.address.toString()}`).join("|");

  useEffect(() => {
    try { window.localStorage.setItem(SOLANA_SIGNER_SELECTION_STORAGE_KEY, JSON.stringify(selectedWalletIds)); } catch { /* Storage policy may deny persistence. */ }
  }, [selectedWalletIds]);

  useEffect(() => {
    const selectAvailableSigner = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.id !== "string") return;
      setSelectedWalletIds((current) => current.includes(event.detail.id) ? current : Object.freeze([...current, event.detail.id]));
    };
    window.addEventListener(SOLANA_SIGNER_AVAILABLE_EVENT, selectAvailableSigner);
    return () => window.removeEventListener(SOLANA_SIGNER_AVAILABLE_EVENT, selectAvailableSigner);
  }, []);

  useEffect(() => {
    if (!live || walletRegistry.wallets.length === 0) { setSignerBalances({}); return; }
    const controller = new AbortController();
    const refresh = async () => {
      const settled = await Promise.allSettled(walletRegistry.wallets.map(async (candidate) => {
        const response = await client.runtime.rpc.getBalance(candidate.session.account.address, { commitment: "confirmed" }).send({ abortSignal: controller.signal });
        return [candidate.id, response.value] as const;
      }));
      if (controller.signal.aborted) return;
      setSignerBalances(Object.freeze(Object.fromEntries(settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []))));
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [client, live, signingWalletKey, walletRegistry.wallets]);

  useEffect(() => {
    if (!live || networkWallets.length === 0) { setWatchBalances({}); return; }
    const controller = new AbortController();
    const refresh = async () => {
      const settled = await Promise.allSettled(networkWallets.map(async (candidate) => {
        const response = await client.runtime.rpc.getBalance(solanaAddress(candidate.address), { commitment: "confirmed" }).send({ abortSignal: controller.signal });
        return [candidate.id, response.value] as const;
      }));
      if (controller.signal.aborted) return;
      const next = Object.fromEntries(settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
      setWatchBalances(Object.freeze(next));
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [client, live, networkWallets, watchWalletKey]);

  const visibleTokens = useMemo(() => tokens.filter((token) => {
    if (filter === "moving") return Math.abs(token.stats5m?.priceChange ?? 0) >= 3;
    if (filter === "liquid") return (token.liquidity ?? 0) >= 10_000;
    if (filter === "pump") return token.id.toLowerCase().endsWith("pump");
    return true;
  }), [filter, tokens]);

  const selectedSigners = useMemo(() => walletRegistry.wallets.filter((candidate) => selectedWalletIds.includes(candidate.id)), [selectedWalletIds, walletRegistry.wallets]);
  const selectedSignerAddresses = useMemo(() => new Set(selectedSigners.map((candidate) => candidate.session.account.address.toString())), [selectedSigners]);
  const visibleWallets = useMemo(() => networkWallets.filter((candidate) => {
    const query = walletSearch.trim().toLowerCase();
    return showWatchOnly && (!query || `${candidate.name} ${candidate.address} ${candidate.role}`.toLowerCase().includes(query));
  }), [networkWallets, showWatchOnly, walletSearch]);
  const selectedTrades = useMemo(() => trading.trades.filter((trade) => selectedSignerAddresses.has(trade.wallet) && trade.tokenMint === selected?.id), [selected?.id, selectedSignerAddresses, trading.trades]);
  const position = useMemo(() => deriveTrackedPosition(selectedTrades), [selectedTrades]);
  const walletHistory = useMemo(() => workspace.audit
    .filter((entry) => entry.network === network && (entry.category === "wallet" || entry.category === "execution"))
    .slice(0, 30), [network, workspace.audit]);
  const totalFees = selectedTrades.reduce((sum, trade) => sum + BigInt(trade.networkFeeLamports) + BigInt(trade.accountRentAndOtherLamports), 0n);

  useEffect(() => {
    invalidateQuote();
  }, [invalidateQuote, selectedWalletIds]);

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!search.trim() || searching) return;
    setSearching(true);
    try {
      const results = await searchTokenInformation(search);
      if (!results[0]) throw new Error("No Jupiter-indexed token matched the query.");
      setManualTokens((current) => Object.freeze([...results.slice(0, 20), ...current].filter((token, index, values) => values.findIndex((candidate) => candidate.id === token.id) === index).slice(0, 40)));
      setSelectedMint(results[0].id);
    } catch (searchError) {
      toast.error(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      setSearching(false);
    }
  };

  const prepare = async () => {
    if (!live) { toast.error("Direct swaps are enabled only on Solana Mainnet."); return; }
    if (tradeMode === "limit") { toast.error("Limit orders require the persistent executor. Open Sniper to arm them."); return; }
    if (mevMode === "private") { toast.error("Private relay is not configured in this browser deployment. Select Standard RPC or configure the executor."); return; }
    if (!selected) { toast.error("Select a live token first."); return; }
    if (walletRegistry.wallets.length === 0) { toast.error("Create or connect at least one signing wallet first."); return; }
    if (selectedSigners.length === 0) { toast.error("Select at least one connected signer in the Wallets panel."); return; }
    quoteAbort.current?.abort();
    const controller = new AbortController();
    quoteAbort.current = controller;
    setPhase("quoting");
    setError(undefined);
    setConfirmedBasket([]);
    try {
      const buyAmountAtomic = direction === "buy" ? parseDecimalAmount(amount, 9) : undefined;
      const slippageBps = slippagePercentToBps(slippagePercent);
      const next = await Promise.all(selectedSigners.map(async (entry): Promise<PreparedWalletSwap> => {
        const taker = entry.session.account.address.toString();
        const amountAtomic = buyAmountAtomic ?? applyPercentageBps(await getWalletTokenBalanceAtomic({ rpcUrl: SOLANA_MAINNET_RPC_URL, owner: taker, mint: selected.id, signal: controller.signal }), sellPercentage);
        const prepared = await prepareJupiterSwap({
          client,
          signal: controller.signal,
          intent: { direction, tokenMint: selected.id, amountAtomic, taker, slippageBps, priorityProfile, fastMode },
        });
        return Object.freeze({ walletId: entry.id, connectorName: entry.connectorName, wallet: entry.session, prepared });
      }));
      if (controller.signal.aborted) return;
      setPreparedBasket(Object.freeze(next));
      setPhase("ready");
      workspace.record({ category: "simulation", action: "Wallet basket simulated", detail: `${direction} ${selected.symbol} for ${next.length} signer(s); platformFeeBps=0; every unsigned RPC simulation passed.`, state: "passed", network });
      toast.success(`${next.length} wallet transaction${next.length === 1 ? "" : "s"} built and simulated.`);
    } catch (prepareError) {
      if (controller.signal.aborted) return;
      const detail = prepareError instanceof Error ? prepareError.message : String(prepareError);
      setError(detail);
      setPhase("failed");
      workspace.record({ category: "simulation", action: "Direct swap preparation failed", detail, state: "failed", network });
      toast.error(detail);
    } finally {
      if (quoteAbort.current === controller) quoteAbort.current = undefined;
    }
  };

  const execute = async () => {
    if (preparedBasket.length === 0 || !selected) return;
    if (executing.current) return;
    const alreadyConfirmed = new Set(confirmedBasket.map((entry) => entry.walletId));
    const pendingBasket = preparedBasket.filter((entry) => !alreadyConfirmed.has(entry.walletId));
    if (pendingBasket.length === 0) return;
    executing.current = true;
    setError(undefined);
    setPhase("awaiting-signature");
    let activeEntry: PreparedWalletSwap | undefined;
    try {
      for (const entry of pendingBasket) {
        activeEntry = entry;
        const confirmed = await executePreparedJupiterSwap({
          client,
          wallet: entry.wallet,
          prepared: entry.prepared,
          onState: (state: SwapExecutionState, signature?: string) => {
            setPhase(state === "confirmed" ? "processed" : state);
            if (state === "submitted" && signature) toast.info(`${entry.connectorName} submitted. Waiting for canonical RPC confirmation.`);
          },
        });
        const result = Object.freeze({ walletId: entry.walletId, connectorName: entry.connectorName, receipt: confirmed });
        setConfirmedBasket((current) => Object.freeze([...current, result]));
        const walletAddress = entry.wallet.account.address.toString();
        const recorded = trading.recordConfirmedSwap(confirmed, selected, walletAddress);
        workspace.record({
          category: "execution",
          action: "Basket swap canonically confirmed",
          detail: recorded
            ? `${entry.connectorName}: ${confirmed.direction} ${selected.symbol}; exact wallet deltas recorded; Sunder platform fee 0 bps.`
            : `${entry.connectorName}: canonical RPC confirmation passed, but the bounded local ledger rejected the record.`,
          state: "confirmed",
          network,
          signature: confirmed.signature,
        });
        try {
          const balance = await client.runtime.rpc.getBalance(entry.wallet.account.address, { commitment: "confirmed" }).send();
          setSignerBalances((current) => Object.freeze({ ...current, [entry.walletId]: balance.value }));
        } catch { /* The 10-second balance poll remains the fallback. */ }
      }
      setPhase("confirmed");
      toast.success(`${preparedBasket.length}/${preparedBasket.length} wallet swaps confirmed by RPC.`);
    } catch (executeError) {
      const detail = executeError instanceof Error ? executeError.message : String(executeError);
      setError(detail);
      setPhase("failed");
      workspace.record({ category: "execution", action: "Wallet basket stopped", detail: `${activeEntry?.connectorName ?? "Signer"}: ${detail}`, state: "failed", network });
      toast.error(`${activeEntry?.connectorName ?? "Signer"}: ${detail}`);
    } finally {
      executing.current = false;
    }
  };

  if (family === "evm") return <EvmTerminalBoundary />;

  const prepared = preparedBasket[0]?.prepared;
  const expectedOutput = preparedBasket.length > 0
    ? formatAtomicAmount(preparedBasket.reduce((sum, entry) => sum + BigInt(entry.prepared.build.outAmount), 0n), direction === "buy" ? (selected?.decimals ?? 0) : 9, 6)
    : undefined;
  const minimumOutput = preparedBasket.length > 0
    ? formatAtomicAmount(preparedBasket.reduce((sum, entry) => sum + BigInt(entry.prepared.build.otherAmountThreshold), 0n), direction === "buy" ? (selected?.decimals ?? 0) : 9, 6)
    : undefined;
  const quoteInputLamports = direction === "buy" ? preparedBasket.reduce((sum, entry) => sum + entry.prepared.intent.amountAtomic, 0n) : 0n;
  const referenceVenueFee = quoteInputLamports / 100n;
  const estimatedNetworkFeeLamports = preparedBasket.reduce((sum, entry) => sum + entry.prepared.estimatedNetworkFeeLamports, 0n);
  const latestConfirmed = confirmedBasket.at(-1)?.receipt;
  const pendingPreparedCount = Math.max(0, preparedBasket.length - confirmedBasket.length);
  const settling = ["awaiting-signature", "signed", "submitted", "processed"].includes(phase);
  const busy = ["quoting", "awaiting-signature", "signed", "submitted", "processed"].includes(phase);
  const activeWalletCount = walletRegistry.wallets.length + networkWallets.length;
  const selectedSignerBalanceLamports = selectedSigners.reduce((sum, candidate) => sum + (signerBalances[candidate.id] ?? 0n), 0n);
  const selectedSignerBalanceLoading = selectedSigners.some((candidate) => signerBalances[candidate.id] === undefined);
  const selectedBalanceLamports = selectedSignerBalanceLamports
    + networkWallets.reduce((sum, candidate) => selectedWalletIds.includes(candidate.id) ? sum + (watchBalances[candidate.id] ?? 0n) : sum, 0n);
  const displayedWalletIds = [...walletRegistry.wallets.map((candidate) => candidate.id), ...visibleWallets.map((candidate) => candidate.id)];
  const selectedWalletCount = selectedSigners.length + networkWallets.filter((candidate) => selectedWalletIds.includes(candidate.id)).length;
  const allDisplayedSelected = displayedWalletIds.length > 0 && displayedWalletIds.every((id) => selectedWalletIds.includes(id));
  const toggleWalletSelection = (walletId: string) => setSelectedWalletIds((current) => current.includes(walletId)
    ? Object.freeze(current.filter((id) => id !== walletId))
    : Object.freeze([...current, walletId]));
  const toggleAllDisplayed = () => setSelectedWalletIds((current) => allDisplayedSelected
    ? Object.freeze(current.filter((id) => !displayedWalletIds.includes(id)))
    : Object.freeze([...new Set([...current, ...displayedWalletIds])]));
  const openWalletInventory = () => {
    window.history.pushState({}, "", "/wallets");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const openSniperTasks = () => {
    window.history.pushState({}, "", "/sniper");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const createSignerWallet = async () => {
    if (walletRegistry.creatingEmbeddedWallet) return;
    try {
      const entry = await walletRegistry.createEmbedded();
      const walletAddress = entry.session.account.address.toString();
      workspace.record({ category: "wallet", action: "Embedded wallet created", detail: `${entry.connectorName} · ${walletAddress}; encrypted device-local vault.`, state: "local", network });
      toast.success(`${entry.connectorName} created, saved in this browser and selected for trading.`);
    } catch (createError) {
      toast.error(createError instanceof Error ? createError.message : String(createError));
    }
  };
  const removeSignerWallet = async (entry: (typeof walletRegistry.wallets)[number]) => {
    if (entry.kind === "embedded") {
      if (!window.confirm(`Delete ${entry.connectorName} from this browser? Export its private key first or access is permanently lost.`)) return;
      try {
        await walletRegistry.removeEmbedded(entry.id);
        setSelectedWalletIds((current) => Object.freeze(current.filter((id) => id !== entry.id)));
        workspace.record({ category: "wallet", action: "Embedded wallet deleted", detail: `${entry.connectorName} · ${entry.session.account.address.toString()}; encrypted local record removed.`, state: "local", network });
        toast.success(`${entry.connectorName} removed from this browser.`);
      } catch (removeError) {
        toast.error(removeError instanceof Error ? removeError.message : String(removeError));
      }
      return;
    }
    await walletRegistry.disconnect(entry.id);
    setSelectedWalletIds((current) => Object.freeze(current.filter((id) => id !== entry.id)));
  };
  const exportWallet = walletRegistry.wallets.find((entry) => entry.id === exportWalletId && entry.kind === "embedded");

  return (
    <div className="screen screen--edge trading-terminal-screen">
      <div className="terminal-heading">
        <div><span className="eyebrow">SOLANA LIVE TERMINAL</span><h1>Swap Manager</h1><p>New launches, confirmed Pump trades and direct Jupiter execution with no Sunder platform fee.</p></div>
        <div className="heading-actions"><Badge tone={live ? "good" : "warn"}>{live ? <><Wifi size={12} /> Mainnet data live</> : "Select Mainnet"}</Badge><Badge tone="good">Sunder fee 0 bps</Badge>{!live ? <Button size="sm" variant="primary" onClick={() => { setFamily("solana"); setNetwork("solana:mainnet"); }}>Open Solana Mainnet</Button> : null}</div>
      </div>

      <section className="terminal-token-strip" aria-label="Selected token market stats" aria-busy={!selected}>
        <div className="terminal-token-strip__identity">
          {selected ? tokenImage(selected, "terminal-token-strip__icon") : <span className="terminal-token-strip__icon">··</span>}
          <span>
            <strong>{selected?.name ?? (live ? "Loading live pools" : "Select Solana Mainnet")} <b>{selected?.symbol ?? "—"}</b></strong>
            <small>{selected ? <><button type="button" onClick={() => copy(selected.id)}>{shorten(selected.id, 7, 6)} <Copy size={11} /></button> · {sourceLabel(selected)}</> : "Jupiter Tokens V2 · no synthetic market state"}</small>
          </span>
        </div>
        <div><span>Price</span><strong>{formatUsd(selected?.usdPrice)}</strong></div>
        <div><span>Liquidity</span><strong>{formatCompact(selected?.liquidity, "$")}</strong></div>
        <div><span>Market cap</span><strong>{formatCompact(selected?.mcap, "$")}</strong></div>
        <div><span>Holders</span><strong>{formatCompact(selected?.holderCount)}</strong></div>
        <div><span>5m volume</span><strong>{selected ? formatCompact((selected.stats5m?.buyVolume ?? 0) + (selected.stats5m?.sellVolume ?? 0), "$") : "—"}</strong></div>
        <div><span>5m change</span><strong className={(selected?.stats5m?.priceChange ?? 0) >= 0 ? "is-positive" : "is-negative"}>{formatSigned(selected?.stats5m?.priceChange)}</strong></div>
        {selected ? <a href={explorerAddressUrl(selected.id)} target="_blank" rel="noreferrer" aria-label={`Open ${selected.symbol} in explorer`}><ExternalLink size={16} /></a> : <span className="terminal-token-strip__explorer-placeholder" aria-hidden="true"><ExternalLink size={16} /></span>}
      </section>

      <div className="terminal-workspace">
        <aside className="terminal-feed">
          <header><div><strong>Pulse</strong><Badge tone="accent">New pools</Badge></div><button type="button" className="icon-button" onClick={() => void recent.refetch()} disabled={recent.isFetching} aria-label="Refresh new tokens"><RefreshCw className={recent.isFetching ? "spin" : ""} size={15} /></button></header>
          <form className="terminal-search" onSubmit={(event) => void submitSearch(event)}><Search size={14} /><Input aria-label="Search token or paste mint" value={search} disabled={settling} onChange={(event) => setSearch(event.target.value)} placeholder="Token or mint" /><button type="submit" disabled={searching || settling} aria-label="Search Jupiter tokens">{searching ? <LoaderCircle className="spin" size={14} /> : "↵"}</button></form>
          <Segmented value={filter} onChange={setFilter} ariaLabel="Token feed filter" options={[{ value: "new", label: "New" }, { value: "moving", label: "Moving" }, { value: "liquid", label: "Liquid" }, { value: "pump", label: "Pump" }]} />
          <div className="terminal-feed__labels"><span>Token</span><span>Price / age</span><span>5m / vol</span></div>
          <div className="terminal-feed__body">
            {!live ? <EmptyState icon={<Radio size={21} />} title="Mainnet feed paused" description="Select Solana Mainnet to load current Jupiter-indexed pools." /> : recent.isLoading ? <div className="terminal-loading"><LoaderCircle className="spin" size={18} /> Loading live pools…</div> : recent.error && !recent.data?.length ? <EmptyState icon={<AlertTriangle size={21} />} title="Provider unavailable" description={recent.error.message} action={<Button size="sm" onClick={() => void recent.refetch()}>Retry</Button>} /> : visibleTokens.length === 0 ? <EmptyState icon={<Search size={21} />} title="No matches" description="Change the filter or search a mint." /> : visibleTokens.map((token) => <TokenFeedRow key={token.id} token={token} active={token.id === selected?.id} disabled={settling} onSelect={() => setSelectedMint(token.id)} />)}
          </div>
          <footer><span>Jupiter Tokens API</span><strong>{recent.error && recent.data?.length ? "cached · provider retrying" : recent.dataUpdatedAt ? `updated ${Math.max(0, Math.floor((Date.now() - recent.dataUpdatedAt) / 1_000))}s ago` : "not loaded"}</strong></footer>
        </aside>

        <main className="terminal-market">
          <div className="terminal-market__toolbar">
            <div>{([{ value: 1, label: "1s" }, { value: 15, label: "15s" }, { value: 60, label: "1m" }, { value: 300, label: "5m" }] as const).map((option) => <button type="button" key={option.value} className={candleInterval === option.value ? "is-active" : ""} onClick={() => setCandleInterval(option.value)}>{option.label}</button>)}</div>
            <span><BarChart3 size={13} /> Live OHLC · observed data only</span>
            <button type="button" className="terminal-layout-reset" onClick={resetTerminalPanelLayout} title="Reset floating panels"><Move size={13} /> Reset panels</button>
          </div>
          <LiveCandlestickChart instrumentId={selected?.id ?? "none"} observations={selected ? observations[selected.id] ?? [] : []} trades={stream.trades} symbol={selected?.symbol ?? "TOKEN"} interval={candleInterval} marketCapUsd={selected?.mcap ?? selected?.fdv} spotPriceUsd={selected?.usdPrice} />
          <div className="terminal-market__facts">
            <div><span>Buys / sells 5m</span><strong>{selected?.stats5m?.numBuys ?? "—"} / {selected?.stats5m?.numSells ?? "—"}</strong></div>
            <div><span>Traders 5m</span><strong>{selected?.stats5m?.numTraders ?? "—"}</strong></div>
            <div><span>Organic score</span><strong>{selected?.organicScore !== undefined ? `${selected.organicScore.toFixed(0)} · ${selected.organicScoreLabel ?? "unlabelled"}` : "—"}</strong></div>
            <div><span>Pool created</span><strong>{selected?.firstPool?.createdAt ? new Date(selected.firstPool.createdAt).toLocaleString() : "—"}</strong></div>
          </div>
        </main>

        <PumpTape trades={stream.trades} status={stream.status} token={selected} />
      </div>

      <div className="terminal-floating-layer" aria-label="Movable trading workspace">
        <FloatingPanel
          id="trade"
          className="terminal-trade-panel"
          title={<><ArrowDownUp size={15} /><strong>Trade {selected?.symbol ?? "token"}</strong></>}
          action={<Badge tone="good">0% Sunder fee</Badge>}
        >
          <div className="terminal-floating-panel__body">
            <Segmented value={direction} onChange={(value) => { if (settling) return; invalidateQuote(); setDirection(value); }} ariaLabel="Trade direction" options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
            <div className="terminal-trade-modes" role="tablist" aria-label="Order type">
              {(["market", "limit", "advanced"] as const).map((mode) => <button key={mode} type="button" role="tab" aria-selected={tradeMode === mode} className={tradeMode === mode ? "is-active" : ""} onClick={() => { invalidateQuote(); setTradeMode(mode); }}>{mode === "advanced" ? "Adv." : mode[0]!.toUpperCase() + mode.slice(1)}</button>)}
            </div>

            {tradeMode === "limit" ? (
              <div className="terminal-mode-lock"><LockKeyhole size={17} /><div><strong>Persistent limit route</strong><span>Arm price rules in Sniper after its signer/RPC readiness gates pass. No browser order is faked.</span></div><button type="button" onClick={() => { window.history.pushState({}, "", "/sniper"); window.dispatchEvent(new PopStateEvent("popstate")); }}>Open Sniper</button></div>
            ) : (
              <>
                {direction === "buy" ? <Field label="Amount / wallet"><div className="input-unit"><Input aria-label="Spend amount in SOL per wallet" inputMode="decimal" value={amount} disabled={settling} onChange={(event) => { invalidateQuote(); setAmount(event.target.value); }} /><span>SOL</span></div></Field> : <Field label="Sell amount / wallet"><Segmented value={String(sellPercentage)} onChange={(value) => { if (settling) return; invalidateQuote(); setSellPercentage(Number(value)); }} ariaLabel="Sell percentage per wallet" options={[{ value: "2500", label: "25%" }, { value: "5000", label: "50%" }, { value: "7500", label: "75%" }, { value: "10000", label: "100%" }]} /></Field>}
                {direction === "buy" ? <div className="quick-amounts" aria-label="Quick SOL amounts">{["0.01", "0.05", "0.1", "0.25"].map((value) => <button type="button" key={value} disabled={settling} className={amount === value ? "is-active" : ""} onClick={() => { invalidateQuote(); setAmount(value); }}>{value}</button>)}</div> : null}

                <div className="terminal-trade-settings">
                  <Field label="Slippage"><div className="input-unit"><Input aria-label="Slippage percent" inputMode="decimal" value={slippagePercent} disabled={settling} onChange={(event) => { invalidateQuote(); setSlippagePercent(event.target.value); }} /><span>%</span></div></Field>
                  <Field label="Priority"><Select aria-label="Priority profile" value={priorityProfile} disabled={settling} onChange={(event) => { invalidateQuote(); setPriorityProfile(event.target.value as PriorityProfile); }}><option value="medium">Medium</option><option value="high">High</option><option value="veryHigh">Very high</option></Select></Field>
                  <Field label="MEV"><Select aria-label="MEV submission mode" value={mevMode} disabled={settling} onChange={(event) => { invalidateQuote(); setMevMode(event.target.value as typeof mevMode); }}><option value="standard">Standard RPC</option><option value="private">Private relay · locked</option></Select></Field>
                </div>

                {tradeMode === "advanced" ? <Toggle checked={fastMode} onCheckedChange={(value) => { if (settling) return; invalidateQuote(); setFastMode(value); }} label="Fast route build" description="Unsigned and signed simulations still run before submission." /> : null}
                <div className="terminal-trade-wallet-state"><span><Users size={13} /> {selectedSigners.length} signing wallet{selectedSigners.length === 1 ? "" : "s"} selected</span><span>{selectedSignerBalanceLoading ? "Balance…" : formatSol(selectedSignerBalanceLamports, 4)}</span></div>

                <Button variant="primary" size="lg" className="terminal-quote-button" disabled={busy || !live || !selected || selectedSigners.length === 0 || mevMode === "private" || confirmedBasket.length > 0} onClick={() => void prepare()}>{phase === "quoting" ? <LoaderCircle className="spin" size={17} /> : <Zap size={17} />} {phase === "ready" ? "Refresh basket" : `Build & simulate ${direction}${selectedSigners.length > 0 ? ` · ${selectedSigners.length}` : ""}`}</Button>
                {walletRegistry.wallets.length === 0 ? <button type="button" className="terminal-connect-inline" disabled={walletRegistry.creatingEmbeddedWallet} onClick={() => void createSignerWallet()}>{walletRegistry.creatingEmbeddedWallet ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Create signing wallet</button> : selectedSigners.length === 0 ? <p className="terminal-wallet-note"><WalletCards size={14} /> Select at least one signer in the Wallets panel.</p> : <p className="terminal-wallet-note"><ShieldCheck size={14} /> Amount applies to each selected signer; every wallet confirms separately.</p>}

                {prepared ? <div className="terminal-quote-rows terminal-quote-rows--compact">
                  <div><span>Route</span><strong>{prepared.build.routePlan.map((step) => step.swapInfo.label).join(" → ")}</strong></div>
                  <div><span>Expected</span><strong>{expectedOutput} {direction === "buy" ? selected?.symbol : "SOL"}</strong></div>
                  <div><span>Minimum</span><strong>{minimumOutput} {direction === "buy" ? selected?.symbol : "SOL"}</strong></div>
                  <div><span>Wallet transactions</span><strong>{preparedBasket.length}</strong></div>
                  <div><span>Network + priority</span><strong>{formatSol(estimatedNetworkFeeLamports)}</strong></div>
                  <div><span>Sunder fee</span><strong className="is-positive">0 SOL</strong></div>
                  {direction === "buy" ? <div><span>1% competitor fee saved</span><strong className="is-positive">{formatSol(referenceVenueFee)}</strong></div> : null}
                </div> : null}
                {error ? <div className="terminal-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div> : null}
                {pendingPreparedCount > 0 ? <Button variant="primary" size="lg" disabled={busy || (phase !== "ready" && phase !== "failed")} onClick={() => void execute()}><WalletCards size={17} /> {phase === "failed" ? `Retry ${pendingPreparedCount} pending` : `Sign ${pendingPreparedCount} and submit`}</Button> : null}
                {latestConfirmed ? <div className="terminal-receipt"><CheckCircle2 size={20} /><div><strong>{confirmedBasket.length}/{preparedBasket.length} confirmed by RPC</strong><span>Latest slot {latestConfirmed.slot.toLocaleString()} · {formatSol(latestConfirmed.walletSolDeltaLamports)}</span><a href={explorerTransactionUrl(latestConfirmed.signature)} target="_blank" rel="noreferrer">Open latest receipt <ExternalLink size={12} /></a></div></div> : null}
              </>
            )}

            <div className="terminal-presets"><button type="button" className={preset === "1" ? "is-active" : ""} onClick={() => setPreset("1")}>Preset 1</button><button type="button" className={preset === "2" ? "is-active" : ""} onClick={() => setPreset("2")}>Preset 2</button><button type="button" className={preset === "3" ? "is-active" : ""} onClick={() => setPreset("3")}>Preset 3</button></div>
            <div className="terminal-token-info"><div><span>Top 10</span><strong>—</strong></div><div><span>Dev</span><strong>—</strong></div><div><span>Snipers</span><strong>—</strong></div><div><span>Holders</span><strong>{formatCompact(selected?.holderCount)}</strong></div><div><span>Liquidity</span><strong>{formatCompact(selected?.liquidity, "$")}</strong></div><div><span>Organic</span><strong>{selected?.organicScore === undefined ? "—" : selected.organicScore.toFixed(0)}</strong></div></div>
          </div>
        </FloatingPanel>

        <FloatingPanel
          id="wallets"
          className="terminal-wallet-panel"
          title={<><WalletCards size={15} /><strong>Wallets</strong></>}
          action={<Badge tone={selectedSigners.length > 0 ? "good" : "warn"}>{selectedSigners.length > 0 ? `${selectedSigners.length} signer${selectedSigners.length === 1 ? "" : "s"}` : "Select signer"}</Badge>}
        >
          <div className="terminal-floating-panel__body">
            <div className="terminal-wallet-tabs"><button type="button" onClick={() => { setWalletTab("wallets"); setDirection("buy"); }}>Spot</button><button type="button" className={walletTab === "wallets" ? "is-active" : ""} onClick={() => setWalletTab("wallets")}>Wallets</button><button type="button" onClick={openSniperTasks}>Tasks</button><button type="button" className={walletTab === "history" ? "is-active" : ""} onClick={() => setWalletTab("history")}>History</button></div>
            {walletTab === "wallets" ? <>
              <div className="terminal-wallet-summary"><span><strong>{activeWalletCount} wallets active</strong><b>{selectedSignerBalanceLoading ? "Balance…" : formatSol(selectedBalanceLamports, 4)}</b></span><span>{selectedWalletCount} selected · {selectedSigners.length} can sign</span></div>
              <div className="terminal-wallet-toolbar">
                <label><Search size={13} /><input value={walletSearch} onChange={(event) => setWalletSearch(event.target.value)} placeholder="Name or address" /></label>
                <button type="button" className={showWatchOnly ? "is-active" : ""} onClick={() => setShowWatchOnly((value) => !value)} title="Show watch-only wallets"><Eye size={14} /></button>
                <button type="button" disabled={walletRegistry.creatingEmbeddedWallet} onClick={() => void createSignerWallet()}>{walletRegistry.creatingEmbeddedWallet ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Create wallet</button>
                <button type="button" onClick={openWalletInventory}><Settings2 size={14} /></button>
              </div>
              <div className="terminal-wallet-table">
                <div className="terminal-wallet-table__head"><input type="checkbox" checked={allDisplayedSelected} onChange={toggleAllDisplayed} aria-label="Select all displayed wallets" /><span>Wallet</span><span>Balance</span><span>Holdings</span><span>Actions</span></div>
                {walletRegistry.wallets.map((entry) => {
                  const walletAddress = entry.session.account.address.toString();
                  const selectedForTrading = selectedWalletIds.includes(entry.id);
                  return <div className="terminal-wallet-row is-signer" key={entry.id}>
                    <input type="checkbox" checked={selectedForTrading} onChange={() => toggleWalletSelection(entry.id)} aria-label={`Select ${entry.connectorName} signing wallet for trading`} />
                    <span><i>{entry.kind === "embedded" ? <KeyRound size={14} /> : <WalletCards size={14} />}</i><b>{entry.connectorName}<small>{shorten(walletAddress, 6, 5)}</small></b></span>
                    <strong>{signerBalances[entry.id] === undefined ? "…" : formatSol(signerBalances[entry.id] ?? 0n, 4)}</strong>
                    <Badge tone="good">Signer</Badge>
                    <span>{entry.kind === "embedded" ? <button type="button" onClick={() => setExportWalletId(entry.id)} aria-label={`Export ${entry.connectorName} private key`} title="Export private key"><KeyRound size={13} /></button> : null}<a href={explorerAddressUrl(walletAddress)} target="_blank" rel="noreferrer" aria-label={`Open ${entry.connectorName} wallet in explorer`}><ExternalLink size={13} /></a><button type="button" onClick={() => void removeSignerWallet(entry)} aria-label={`${entry.kind === "embedded" ? "Delete" : "Disconnect"} ${entry.connectorName}`}><Trash2 size={13} /></button></span>
                  </div>;
                })}
                {walletRegistry.wallets.length === 0 ? <button type="button" className="terminal-wallet-connect-row" disabled={walletRegistry.creatingEmbeddedWallet} onClick={() => void createSignerWallet()}><Plus size={15} /><span><strong>Create a signing wallet</strong><small>Generated locally · encrypted in this browser · immediately selected</small></span></button> : null}
                {visibleWallets.map((candidate) => <div className="terminal-wallet-row" key={candidate.id}>
                  <input type="checkbox" checked={selectedWalletIds.includes(candidate.id)} onChange={() => toggleWalletSelection(candidate.id)} aria-label={`Select ${candidate.name} for monitoring`} />
                  <span><i><Eye size={14} /></i><b>{candidate.name}<small>{shorten(candidate.address, 6, 5)}</small></b></span>
                  <strong>{watchBalances[candidate.id] === undefined ? "—" : formatSol(watchBalances[candidate.id] ?? 0n, 4)}</strong>
                  <Badge tone="neutral">Watch</Badge>
                  <span><a href={explorerAddressUrl(candidate.address)} target="_blank" rel="noreferrer" aria-label={`Open ${candidate.name} in explorer`}><ExternalLink size={13} /></a><button type="button" onClick={() => { workspace.removeWallet(candidate.id); setSelectedWalletIds((current) => Object.freeze(current.filter((id) => id !== candidate.id))); }} aria-label={`Remove ${candidate.name}`}><Trash2 size={13} /></button></span>
                </div>)}
                {walletRegistry.wallets.length === 0 && visibleWallets.length === 0 ? <div className="terminal-wallet-empty"><WalletCards size={18} /><span>No signer yet. Create one locally or connect Phantom from the header.</span></div> : null}
              </div>
              <p className="terminal-wallet-safety"><ShieldCheck size={13} /> Trades fan out only to selected signers. Embedded keys are AES-GCM encrypted in this browser; export a backup before clearing site data.</p>
              <div className="terminal-pnl">
                <div><span>Confirmed net SOL flow</span><strong className={(position?.confirmedNetSolFlowLamports ?? 0n) >= 0n ? "is-positive" : "is-negative"}>{position ? formatSol(position.confirmedNetSolFlowLamports) : "—"}</strong></div>
                <div><span>Realized net PnL</span><strong className={(position?.realizedNetPnlLamports ?? 0n) >= 0n ? "is-positive" : "is-negative"}>{position ? formatSol(position.realizedNetPnlLamports) : "—"}</strong></div>
                <div><span>Tracked cost basis</span><strong>{position ? formatSol(position.trackedCostBasisLamports) : "—"}</strong></div>
                <div><span>Confirmed fees + rent</span><strong>{selectedTrades.length ? formatSol(totalFees) : "—"}</strong></div>
              </div>
              <p className="terminal-pnl-note">PnL uses exact confirmed wallet deltas; unvalued inventory is never reported as realized profit.</p>
            </> : <div className="terminal-wallet-history" aria-label="Wallet-linked history">
              <header><span><History size={14} /><strong>Wallet-linked history</strong></span><Badge tone="neutral">{walletHistory.length} records</Badge></header>
              {walletHistory.length === 0 ? <div className="terminal-wallet-history__empty"><History size={19} /><strong>No wallet history yet</strong><span>Connecting a real signer or receiving a canonical transaction result creates a browser-local record.</span></div> : walletHistory.map((entry) => <div className="terminal-wallet-history__row" key={entry.id}>
                <span className={`status-dot status-dot--${entry.state}`} />
                <span><strong>{entry.action}</strong><small>{entry.detail}</small><time>{formatHistoryTime(entry.at)}</time></span>
                {entry.signature ? <a href={explorerTransactionUrl(entry.signature)} target="_blank" rel="noreferrer" aria-label="Open confirmed transaction"><ExternalLink size={13} /></a> : <Badge tone={entry.state === "confirmed" ? "good" : entry.state === "failed" ? "bad" : "neutral"}>{entry.state}</Badge>}
              </div>)}
              <p><ShieldCheck size={13} /> History stores public addresses and receipts. Embedded secret material stays encrypted in the device-local browser vault and is never uploaded.</p>
            </div>}
          </div>
        </FloatingPanel>
      </div>
      <EmbeddedWalletExport wallet={exportWallet} open={Boolean(exportWallet)} onOpenChange={(nextOpen) => { if (!nextOpen) setExportWalletId(undefined); }} />
    </div>
  );
}
