import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";
import type { ConfirmedSwapReceipt } from "../solana/jupiter";
import type { TokenInformation } from "../solana/market";

const STORAGE_KEY = "sunder:confirmed-solana-trades:v1";

const tradeSchema = z.object({
  signature: z.string().min(64).max(128),
  wallet: z.string().min(32).max(64),
  tokenMint: z.string().min(32).max(64),
  tokenName: z.string().min(1).max(128),
  tokenSymbol: z.string().min(1).max(32),
  tokenDecimals: z.number().int().min(0).max(18),
  direction: z.enum(["buy", "sell"]),
  tokenDeltaAtomic: z.string().regex(/^-?[0-9]+$/),
  walletSolDeltaLamports: z.string().regex(/^-?[0-9]+$/),
  networkFeeLamports: z.string().regex(/^[0-9]+$/),
  accountRentAndOtherLamports: z.string().regex(/^[0-9]+$/),
  inputAmountAtomic: z.string().regex(/^[0-9]+$/),
  quotedOutputAtomic: z.string().regex(/^[0-9]+$/),
  minimumOutputAtomic: z.string().regex(/^[0-9]+$/),
  route: z.array(z.string().min(1).max(128)).max(16),
  slot: z.number().int().positive(),
  confirmedAt: z.number().int().positive(),
});

export type ConfirmedTradeRecord = z.infer<typeof tradeSchema>;

export function parseStoredTrades(value: unknown): readonly ConfirmedTradeRecord[] {
  if (!Array.isArray(value)) return [];
  const records = value.slice(0, 500).flatMap((entry) => {
    const parsed = tradeSchema.safeParse(entry);
    if (!parsed.success) return [];
    Object.freeze(parsed.data.route);
    return [Object.freeze(parsed.data)];
  });
  return Object.freeze(records);
}

function readTrades(): readonly ConfirmedTradeRecord[] {
  if (typeof window === "undefined") return [];
  try {
    return parseStoredTrades(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function persist(trades: readonly ConfirmedTradeRecord[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  } catch {
    // A private browser may deny persistence; confirmed records remain in memory.
  }
}

export interface TrackedPosition {
  readonly wallet: string;
  readonly tokenMint: string;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly holdingsAtomic: bigint;
  readonly trackedCostBasisLamports: bigint;
  readonly realizedNetPnlLamports: bigint;
  readonly confirmedNetSolFlowLamports: bigint;
  readonly tradeCount: number;
  readonly hasUntrackedInventory: boolean;
}

export function deriveTrackedPosition(trades: readonly ConfirmedTradeRecord[]): TrackedPosition | undefined {
  if (trades.length === 0) return undefined;
  const ordered = [...trades].sort((left, right) => left.slot - right.slot || left.confirmedAt - right.confirmedAt || left.signature.localeCompare(right.signature));
  let holdings = 0n;
  let costBasis = 0n;
  let realized = 0n;
  let netFlow = 0n;
  let hasUntrackedInventory = false;
  for (const trade of ordered) {
    const tokenDelta = BigInt(trade.tokenDeltaAtomic);
    const solDelta = BigInt(trade.walletSolDeltaLamports);
    netFlow += solDelta;
    if (trade.direction === "buy" && tokenDelta > 0n) {
      holdings += tokenDelta;
      costBasis += solDelta < 0n ? -solDelta : 0n;
      continue;
    }
    const sold = tokenDelta < 0n ? -tokenDelta : 0n;
    if (sold === 0n) continue;
    const trackedSold = sold > holdings ? holdings : sold;
    if (sold > holdings) hasUntrackedInventory = true;
    const allocatedCost = holdings > 0n ? (costBasis * trackedSold) / holdings : 0n;
    holdings = holdings > trackedSold ? holdings - trackedSold : 0n;
    costBasis = costBasis > allocatedCost ? costBasis - allocatedCost : 0n;
    realized += (solDelta > 0n ? solDelta : 0n) - allocatedCost;
  }
  const latest = ordered.at(-1)!;
  return Object.freeze({
    wallet: latest.wallet,
    tokenMint: latest.tokenMint,
    tokenSymbol: latest.tokenSymbol,
    tokenDecimals: latest.tokenDecimals,
    holdingsAtomic: holdings,
    trackedCostBasisLamports: costBasis,
    realizedNetPnlLamports: realized,
    confirmedNetSolFlowLamports: netFlow,
    tradeCount: ordered.length,
    hasUntrackedInventory,
  });
}

interface TradingContextValue {
  readonly trades: readonly ConfirmedTradeRecord[];
  readonly recordConfirmedSwap: (receipt: ConfirmedSwapReceipt, token: TokenInformation, wallet: string) => boolean;
  readonly clearLocalHistory: () => void;
}

const TradingContext = createContext<TradingContextValue | null>(null);

export function TradingProvider({ children }: { readonly children: ReactNode }) {
  const [trades, setTrades] = useState<readonly ConfirmedTradeRecord[]>(readTrades);

  const recordConfirmedSwap = useCallback((receipt: ConfirmedSwapReceipt, token: TokenInformation, wallet: string) => {
    const parsed = tradeSchema.safeParse({
      signature: receipt.signature,
      wallet,
      tokenMint: receipt.tokenMint,
      tokenName: token.name,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      direction: receipt.direction,
      tokenDeltaAtomic: receipt.tokenDeltaAtomic.toString(),
      walletSolDeltaLamports: receipt.walletSolDeltaLamports.toString(),
      networkFeeLamports: receipt.networkFeeLamports.toString(),
      accountRentAndOtherLamports: receipt.accountRentAndOtherLamports.toString(),
      inputAmountAtomic: receipt.inputAmountAtomic.toString(),
      quotedOutputAtomic: receipt.quotedOutputAtomic.toString(),
      minimumOutputAtomic: receipt.minimumOutputAtomic.toString(),
      route: [...receipt.route],
      slot: receipt.slot,
      confirmedAt: Date.now(),
    });
    if (!parsed.success) {
      console.error("[trading-ledger] Canonical receipt could not be persisted because its bounded record was invalid.");
      return false;
    }
    Object.freeze(parsed.data.route);
    const record: ConfirmedTradeRecord = Object.freeze(parsed.data);
    setTrades((current) => {
      const next = Object.freeze([record, ...current.filter((trade) => trade.signature !== record.signature)].slice(0, 500));
      persist(next);
      return next;
    });
    return true;
  }, []);

  const clearLocalHistory = useCallback(() => {
    setTrades([]);
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* In-memory clear still succeeds. */ }
  }, []);

  const value = useMemo(() => ({ trades, recordConfirmedSwap, clearLocalHistory }), [clearLocalHistory, recordConfirmedSwap, trades]);
  return <TradingContext.Provider value={value}>{children}</TradingContext.Provider>;
}

export function useTrading(): TradingContextValue {
  const context = useContext(TradingContext);
  if (!context) throw new Error("useTrading must be used inside TradingProvider.");
  return context;
}
