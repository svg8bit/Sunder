import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  Crosshair,
  ExternalLink,
  Info,
  LoaderCircle,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  WalletCards,
  Wifi,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { planWalletBasket } from "../../packages/sniper-engine/src/index";
import { Badge, Button, EmptyState, Field, Input, Panel, Segmented, Select, Toggle } from "../components/ui";
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
import { deriveTrackedPosition, useTrading } from "../state/trading";
import { useWorkspace } from "../state/workspace";

type FeedFilter = "new" | "moving" | "liquid" | "pump";
type TradeDirection = "buy" | "sell";
type QuotePhase = "idle" | "quoting" | "ready" | "awaiting-signature" | "signed" | "submitted" | "processed" | "confirmed" | "failed";
type PricePoint = { readonly at: number; readonly price: number };

function shorten(value: string, left = 5, right = 4): string {
  return value.length <= left + right + 1 ? value : `${value.slice(0, left)}…${value.slice(-right)}`;
}

function formatCompact(value: number | undefined, prefix = ""): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${prefix}${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value)}`;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.0001) return `$${value.toExponential(2)}`;
  return new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 6 : 2 }).format(value);
}

function formatSigned(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSol(lamports: bigint, precision = 6): string {
  return `${formatAtomicAmount(lamports, 9, precision)} SOL`;
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
  return tokens.slice(0, 12).reduce<TokenInformation | undefined>((best, token) => {
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

function MarketChart({ points, trades, symbol }: { readonly points: readonly PricePoint[]; readonly trades: readonly PumpTrade[]; readonly symbol: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const width = Math.max(320, element.clientWidth);
      const height = Math.max(280, element.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      const context = element.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#0a0d10";
      context.fillRect(0, 0, width, height);
      const left = 18;
      const right = 62;
      const top = 20;
      const bottom = 30;
      const chartWidth = width - left - right;
      const chartHeight = height - top - bottom;
      context.strokeStyle = "#1e242a";
      context.lineWidth = 1;
      context.font = "10px SFMono-Regular, Consolas, monospace";
      context.fillStyle = "#66707a";
      for (let index = 0; index <= 5; index += 1) {
        const y = top + (chartHeight * index) / 5;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(width - right, y);
        context.stroke();
      }
      if (points.length < 2) {
        context.fillStyle = "#8f98a2";
        context.textAlign = "center";
        context.fillText("Collecting live provider observations…", left + chartWidth / 2, top + chartHeight / 2);
        return;
      }
      const prices = points.map((point) => point.price);
      const minimum = Math.min(...prices);
      const maximum = Math.max(...prices);
      const spread = maximum - minimum || Math.max(maximum * 0.02, Number.EPSILON);
      const min = minimum - spread * 0.12;
      const max = maximum + spread * 0.12;
      const start = points[0]!.at;
      const end = points.at(-1)!.at;
      const duration = Math.max(1, end - start);
      const x = (at: number) => left + ((at - start) / duration) * chartWidth;
      const y = (price: number) => top + (1 - (price - min) / (max - min)) * chartHeight;

      const gradient = context.createLinearGradient(0, top, 0, top + chartHeight);
      gradient.addColorStop(0, "rgba(255, 121, 0, .22)");
      gradient.addColorStop(1, "rgba(255, 121, 0, 0)");
      context.beginPath();
      points.forEach((point, index) => index === 0 ? context.moveTo(x(point.at), y(point.price)) : context.lineTo(x(point.at), y(point.price)));
      context.lineTo(x(points.at(-1)!.at), top + chartHeight);
      context.lineTo(x(points[0]!.at), top + chartHeight);
      context.closePath();
      context.fillStyle = gradient;
      context.fill();
      context.beginPath();
      points.forEach((point, index) => index === 0 ? context.moveTo(x(point.at), y(point.price)) : context.lineTo(x(point.at), y(point.price)));
      context.strokeStyle = "#ff8519";
      context.lineWidth = 2;
      context.stroke();

      context.textAlign = "left";
      context.fillStyle = "#8f98a2";
      for (let index = 0; index <= 4; index += 1) {
        const price = max - ((max - min) * index) / 4;
        context.fillText(formatUsd(price), width - right + 8, top + (chartHeight * index) / 4 + 3);
      }
      for (const trade of trades.slice(0, 24)) {
        if (trade.timestamp < start || trade.timestamp > end) continue;
        const nearest = points.reduce((best, point) => Math.abs(point.at - trade.timestamp) < Math.abs(best.at - trade.timestamp) ? point : best, points[0]!);
        context.beginPath();
        context.arc(x(trade.timestamp), y(nearest.price), 4, 0, Math.PI * 2);
        context.fillStyle = trade.side === "buy" ? "#57d796" : "#ff646d";
        context.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    return () => observer.disconnect();
  }, [points, trades]);

  const latest = points.at(-1)?.price;
  const first = points[0]?.price;
  const change = latest !== undefined && first ? ((latest - first) / first) * 100 : undefined;
  return (
    <figure className="market-chart">
      <div className="market-chart__legend"><span><i /> {symbol}/USD · provider observations</span><b className={(change ?? 0) >= 0 ? "is-positive" : "is-negative"}>{formatSigned(change)}</b></div>
      <canvas ref={canvas} role="img" aria-label={`${symbol} live price chart with ${points.length} Jupiter observations and ${trades.length} confirmed Pump event markers`} />
      <figcaption>Orange line: Jupiter token observations. Green/red markers: confirmed Pump program events placed at the nearest indexed price.</figcaption>
    </figure>
  );
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
  const connection = useWalletConnection();
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
  const [direction, setDirection] = useState<TradeDirection>("buy");
  const [amount, setAmount] = useState("0.05");
  const [sellPercentage, setSellPercentage] = useState(10_000);
  const [slippageBps, setSlippageBps] = useState(100);
  const [priorityProfile, setPriorityProfile] = useState<PriorityProfile>("high");
  const [fastMode, setFastMode] = useState(true);
  const [confirmedCap, setConfirmedCap] = useState(3);
  const [prepared, setPrepared] = useState<PreparedJupiterSwap>();
  const [receipt, setReceipt] = useState<ConfirmedSwapReceipt>();
  const [phase, setPhase] = useState<QuotePhase>("idle");
  const [error, setError] = useState<string>();
  const quoteAbort = useRef<AbortController | undefined>(undefined);
  const executing = useRef(false);

  const invalidateQuote = useCallback(() => {
    quoteAbort.current?.abort();
    quoteAbort.current = undefined;
    setPrepared(undefined);
    setReceipt(undefined);
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
  const visibleTokens = useMemo(() => tokens.filter((token) => {
    if (filter === "moving") return Math.abs(token.stats5m?.priceChange ?? 0) >= 3;
    if (filter === "liquid") return (token.liquidity ?? 0) >= 10_000;
    if (filter === "pump") return token.id.toLowerCase().endsWith("pump");
    return true;
  }), [filter, tokens]);

  const wallet = connection.status === "connected" ? connection.wallet : undefined;
  const walletAddress = wallet?.account.address.toString();
  const selectedTrades = useMemo(() => trading.trades.filter((trade) => trade.wallet === walletAddress && trade.tokenMint === selected?.id), [selected?.id, trading.trades, walletAddress]);
  const position = useMemo(() => deriveTrackedPosition(selectedTrades), [selectedTrades]);
  const totalFees = selectedTrades.reduce((sum, trade) => sum + BigInt(trade.networkFeeLamports) + BigInt(trade.accountRentAndOtherLamports), 0n);

  const basket = useMemo(() => {
    if (!walletAddress) return undefined;
    let totalAtomic: bigint;
    try { totalAtomic = direction === "buy" ? parseDecimalAmount(amount, 9) : 1n; } catch { return undefined; }
    try {
      return planWalletBasket({
        totalAtomic,
        maxConfirmedExecutions: confirmedCap,
        members: [
          { id: "browser-wallet", address: walletAddress, label: "Connected wallet", capability: "wallet-standard", enabled: true, weightBps: 10_000 },
          ...workspace.wallets.filter((candidate) => candidate.network === network).map((candidate) => ({ id: candidate.id, address: candidate.address, label: candidate.name, capability: "watch-only" as const, enabled: true, weightBps: 10_000 })),
        ],
      });
    } catch { return undefined; }
  }, [amount, confirmedCap, direction, network, walletAddress, workspace.wallets]);

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
    if (!selected) { toast.error("Select a live token first."); return; }
    if (!wallet || !walletAddress) { toast.error("Connect a Wallet Standard signer in the header first."); return; }
    quoteAbort.current?.abort();
    const controller = new AbortController();
    quoteAbort.current = controller;
    setPhase("quoting");
    setError(undefined);
    setReceipt(undefined);
    try {
      const amountAtomic = direction === "buy"
        ? parseDecimalAmount(amount, 9)
        : applyPercentageBps(await getWalletTokenBalanceAtomic({ rpcUrl: SOLANA_MAINNET_RPC_URL, owner: walletAddress, mint: selected.id, signal: controller.signal }), sellPercentage);
      const next = await prepareJupiterSwap({
        client,
        signal: controller.signal,
        intent: {
          direction,
          tokenMint: selected.id,
          amountAtomic,
          taker: walletAddress,
          slippageBps,
          priorityProfile,
          fastMode,
        },
      });
      if (controller.signal.aborted) return;
      setPrepared(next);
      setPhase("ready");
      workspace.record({ category: "simulation", action: "Direct Jupiter swap simulated", detail: `${direction} ${selected.symbol}; platformFeeBps=0; unsigned RPC simulation passed.`, state: "passed", network });
      toast.success("Quote built and exact unsigned transaction simulation passed.");
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
    if (!prepared || !wallet || !selected || !walletAddress) return;
    if (executing.current) return;
    executing.current = true;
    setError(undefined);
    setPhase("awaiting-signature");
    try {
      const confirmed = await executePreparedJupiterSwap({
        client,
        wallet,
        prepared,
        onState: (state: SwapExecutionState, signature?: string) => {
          setPhase(state);
          if (state === "submitted" && signature) toast.info("Submitted. Waiting for canonical RPC confirmation.");
        },
      });
      setReceipt(confirmed);
      setPhase("confirmed");
      const recorded = trading.recordConfirmedSwap(confirmed, selected, walletAddress);
      workspace.record({
        category: "execution",
        action: "Direct swap canonically confirmed",
        detail: recorded
          ? `${confirmed.direction} ${selected.symbol}; exact wallet deltas recorded; Sunder platform fee 0 bps.`
          : `${confirmed.direction} ${selected.symbol}; canonical RPC confirmation passed, but the bounded local ledger rejected the record.`,
        state: "confirmed",
        network,
        signature: confirmed.signature,
      });
      if (recorded) toast.success("Swap confirmed by RPC and exact wallet deltas recorded.");
      else toast.warning("Swap confirmed by RPC, but the local ledger rejected its bounded record. Use the explorer receipt as evidence.");
    } catch (executeError) {
      const detail = executeError instanceof Error ? executeError.message : String(executeError);
      setError(detail);
      setPhase("failed");
      workspace.record({ category: "execution", action: "Direct swap did not confirm", detail, state: "failed", network });
      toast.error(detail);
    } finally {
      executing.current = false;
    }
  };

  if (family === "evm") return <EvmTerminalBoundary />;

  const expectedOutput = prepared
    ? formatAtomicAmount(BigInt(prepared.build.outAmount), direction === "buy" ? (selected?.decimals ?? 0) : 9, 6)
    : undefined;
  const minimumOutput = prepared
    ? formatAtomicAmount(BigInt(prepared.build.otherAmountThreshold), direction === "buy" ? (selected?.decimals ?? 0) : 9, 6)
    : undefined;
  const quoteInputLamports = prepared && direction === "buy" ? prepared.intent.amountAtomic : 0n;
  const referenceVenueFee = quoteInputLamports / 100n;
  const settling = ["awaiting-signature", "signed", "submitted", "processed"].includes(phase);
  const busy = ["quoting", "awaiting-signature", "signed", "submitted", "processed"].includes(phase);

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
            {!live ? <EmptyState icon={<Radio size={21} />} title="Mainnet feed paused" description="Select Solana Mainnet to load current Jupiter-indexed pools." /> : recent.isLoading ? <div className="terminal-loading"><LoaderCircle className="spin" size={18} /> Loading live pools…</div> : recent.error ? <EmptyState icon={<AlertTriangle size={21} />} title="Provider unavailable" description={recent.error.message} action={<Button size="sm" onClick={() => void recent.refetch()}>Retry</Button>} /> : visibleTokens.length === 0 ? <EmptyState icon={<Search size={21} />} title="No matches" description="Change the filter or search a mint." /> : visibleTokens.map((token) => <TokenFeedRow key={token.id} token={token} active={token.id === selected?.id} disabled={settling} onSelect={() => setSelectedMint(token.id)} />)}
          </div>
          <footer><span>Jupiter Tokens API</span><strong>{recent.dataUpdatedAt ? `updated ${Math.max(0, Math.floor((Date.now() - recent.dataUpdatedAt) / 1_000))}s ago` : "not loaded"}</strong></footer>
        </aside>

        <main className="terminal-market">
          <div className="terminal-market__toolbar"><div><button type="button" className="is-active">Live</button><button type="button" disabled>1m</button><button type="button" disabled>5m</button></div><span><CircleDollarSign size={13} /> USD market price · no synthetic candles</span></div>
          <MarketChart points={selected ? observations[selected.id] ?? [] : []} trades={stream.trades} symbol={selected?.symbol ?? "TOKEN"} />
          <div className="terminal-market__facts">
            <div><span>Buys / sells 5m</span><strong>{selected?.stats5m?.numBuys ?? "—"} / {selected?.stats5m?.numSells ?? "—"}</strong></div>
            <div><span>Traders 5m</span><strong>{selected?.stats5m?.numTraders ?? "—"}</strong></div>
            <div><span>Organic score</span><strong>{selected?.organicScore !== undefined ? `${selected.organicScore.toFixed(0)} · ${selected.organicScoreLabel ?? "unlabelled"}` : "—"}</strong></div>
            <div><span>Pool created</span><strong>{selected?.firstPool?.createdAt ? new Date(selected.firstPool.createdAt).toLocaleString() : "—"}</strong></div>
          </div>
        </main>

        <PumpTape trades={stream.trades} status={stream.status} token={selected} />
      </div>

      <section className={`terminal-trade-dock${prepared ? " has-quote" : ""}`}>
        <div className="terminal-order-card">
          <header><div><ArrowDownUp size={16} /><strong>Direct trade</strong></div><Badge tone="good">0 bps platform</Badge></header>
          <Segmented value={direction} onChange={(value) => { if (settling) return; invalidateQuote(); setDirection(value); }} ariaLabel="Trade direction" options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
          {direction === "buy" ? <Field label="Spend" hint="Exact SOL input; network, priority and protocol fees remain visible."><div className="input-unit"><Input aria-label="Spend amount" inputMode="decimal" value={amount} disabled={settling} onChange={(event) => { invalidateQuote(); setAmount(event.target.value); }} /><span>SOL</span></div></Field> : <Field label="Sell amount" hint="Read from the connected wallet at quote time."><Segmented value={String(sellPercentage)} onChange={(value) => { if (settling) return; invalidateQuote(); setSellPercentage(Number(value)); }} ariaLabel="Sell percentage" options={[{ value: "2500", label: "25%" }, { value: "5000", label: "50%" }, { value: "7500", label: "75%" }, { value: "10000", label: "100%" }]} /></Field>}
          {direction === "buy" ? <div className="quick-amounts" aria-label="Quick SOL amounts">{["0.02", "0.05", "0.1", "0.25"].map((value) => <button type="button" key={value} disabled={settling} onClick={() => { invalidateQuote(); setAmount(value); }}>{value}</button>)}</div> : null}
          <div className="terminal-order-grid"><Field label="Slippage"><div className="input-unit"><Input aria-label="Slippage BPS" type="number" min="1" max="5000" value={slippageBps} disabled={settling} onChange={(event) => { invalidateQuote(); setSlippageBps(Math.min(5_000, Math.max(1, Math.trunc(Number(event.target.value) || 1)))); }} /><span>bps</span></div></Field><Field label="Priority"><Select aria-label="Priority profile" value={priorityProfile} disabled={settling} onChange={(event) => { invalidateQuote(); setPriorityProfile(event.target.value as PriorityProfile); }}><option value="medium">Medium</option><option value="high">High</option><option value="veryHigh">Very high</option></Select></Field></div>
          <Toggle checked={fastMode} onCheckedChange={(value) => { if (settling) return; invalidateQuote(); setFastMode(value); }} label="Fast route build" description="Still simulates unsigned and signed transactions before submission." />
          <Button variant="primary" size="lg" className="terminal-quote-button" disabled={busy || !live || !selected || !wallet} onClick={() => void prepare()}>{phase === "quoting" ? <LoaderCircle className="spin" size={17} /> : <Zap size={17} />} {phase === "ready" ? "Refresh quote" : "Build & simulate"}</Button>
          {!wallet ? <p className="terminal-wallet-note"><WalletCards size={14} /> Connect a Wallet Standard signer from the header. No keys enter Sunder.</p> : null}
        </div>

        <div className="terminal-quote-card">
          <header><div><ShieldCheck size={16} /><strong>Cost & receipt truth</strong></div><Badge tone={phase === "confirmed" ? "good" : phase === "failed" ? "bad" : phase === "ready" ? "accent" : "neutral"}>{phase.replaceAll("-", " ")}</Badge></header>
          {prepared ? <div className="terminal-quote-rows">
            <div><span>Route</span><strong>{prepared.build.routePlan.map((step) => step.swapInfo.label).join(" → ")}</strong></div>
            <div><span>Expected output</span><strong>{expectedOutput} {direction === "buy" ? selected?.symbol : "SOL"}</strong></div>
            <div><span>Minimum received</span><strong>{minimumOutput} {direction === "buy" ? selected?.symbol : "SOL"}</strong></div>
            <div><span>Network + priority estimate</span><strong>{formatSol(prepared.estimatedNetworkFeeLamports)}</strong></div>
            <div><span>Protocol / LP fee</span><strong>Included in route output</strong></div>
            <div><span>Sunder platform fee</span><strong className="is-positive">0 SOL · 0 bps</strong></div>
            {direction === "buy" ? <div><span>1% venue reference</span><strong className="is-negative">{formatSol(referenceVenueFee)} not charged</strong></div> : null}
            <div><span>Quote blockhash</span><strong>{shorten(prepared.recentBlockhash, 7, 7)}</strong></div>
          </div> : <div className="terminal-quote-empty"><Info size={20} /><div><strong>No simulated quote</strong><span>Build uses Jupiter platformFeeBps=0, then RPC simulation. The wallet is asked only after that passes.</span></div></div>}
          {error ? <div className="terminal-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div> : null}
          {prepared && phase !== "confirmed" ? <Button variant="primary" size="lg" disabled={busy || phase !== "ready"} onClick={() => void execute()}><WalletCards size={17} /> Sign and submit</Button> : null}
          {receipt ? <div className="terminal-receipt"><CheckCircle2 size={20} /><div><strong>Canonical RPC confirmation</strong><span>Slot {receipt.slot.toLocaleString()} · wallet SOL delta {formatSol(receipt.walletSolDeltaLamports)}</span><a href={explorerTransactionUrl(receipt.signature)} target="_blank" rel="noreferrer">Open transaction <ExternalLink size={12} /></a></div></div> : null}
        </div>

        <div className="terminal-account-card">
          <header><div><Crosshair size={16} /><strong>Sniper basket & net PnL</strong></div><Badge tone="warn">First {confirmedCap}</Badge></header>
          <div className="terminal-cap"><span>Canonical entry cap</span><Segmented value={String(confirmedCap)} onChange={(value) => setConfirmedCap(Number(value))} ariaLabel="Confirmed entry cap" options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]} /></div>
          <div className="terminal-wallet-basket">
            <div><span className={wallet ? "is-ready" : ""}><WalletCards size={14} /></span><span><strong>{walletAddress ? shorten(walletAddress, 6, 5) : "Browser signer"}</strong><small>{wallet ? "Interactive signing available" : "Connect required"}</small></span><Badge tone={wallet ? "good" : "warn"}>{wallet ? "Signer" : "Missing"}</Badge></div>
            {workspace.wallets.filter((candidate) => candidate.network === network).slice(0, 3).map((candidate) => <div key={candidate.id}><span><WalletCards size={14} /></span><span><strong>{candidate.name}</strong><small>{shorten(candidate.address)} · cannot sign</small></span><Badge tone="neutral">Watch only</Badge></div>)}
          </div>
          <p className="terminal-basket-note">{basket ? `${basket.steps.length} signing-capable wallet; ${basket.exclusions.length} watch-only/excess wallet(s) excluded. Browser approval is required for each interactive transaction.` : "Persistent first-three execution needs separately configured signer policies; public watch addresses are never treated as signers."}</p>
          <div className="terminal-pnl">
            <div><span>Confirmed net SOL flow</span><strong className={(position?.confirmedNetSolFlowLamports ?? 0n) >= 0n ? "is-positive" : "is-negative"}>{position ? formatSol(position.confirmedNetSolFlowLamports) : "—"}</strong></div>
            <div><span>Realized net PnL</span><strong className={(position?.realizedNetPnlLamports ?? 0n) >= 0n ? "is-positive" : "is-negative"}>{position ? formatSol(position.realizedNetPnlLamports) : "—"}</strong></div>
            <div><span>Tracked cost basis</span><strong>{position ? formatSol(position.trackedCostBasisLamports) : "—"}</strong></div>
            <div><span>Confirmed fees + rent</span><strong>{selectedTrades.length ? formatSol(totalFees) : "—"}</strong></div>
          </div>
          <p className="terminal-pnl-note">Net means exact confirmed wallet deltas. Unvalued holdings are excluded; {position?.hasUntrackedInventory ? "untracked inventory was detected, so realized PnL is partial." : "no estimated profit is presented as realized."}</p>
        </div>
      </section>
    </div>
  );
}
