import { getBase58Encoder, type Transaction } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { applyPercentageBps, formatAtomicAmount, parseDecimalAmount } from "../src/solana/amounts";
import {
  analyzeJupiterSwapReceipt,
  buildJupiterSwapUrl,
  requestJupiterBuild,
  WRAPPED_SOL_MINT,
  type JupiterBuildResponse,
  type PreparedJupiterSwap,
} from "../src/solana/jupiter";
import { decodePumpTradeLog, fetchRecentTokens, normalizePumpTradeEvent, PUMP_PROGRAM_ADDRESS, safeTokenIcon, searchTokenInformation } from "../src/solana/market";
import { deriveTrackedPosition, parseStoredTrades, type ConfirmedTradeRecord } from "../src/state/trading";

const tokenMint = "ToKeN111111111111111111111111111111111111111";
const wallet = "WaLLeT11111111111111111111111111111111111111";
const program = "11111111111111111111111111111111";

function buildManifest(): JupiterBuildResponse {
  return {
    inputMint: WRAPPED_SOL_MINT,
    outputMint: tokenMint,
    inAmount: "100000000",
    outAmount: "500000000",
    otherAmountThreshold: "495000000",
    swapMode: "ExactIn",
    slippageBps: 100,
    priceImpactPct: "0.01",
    routePlan: [{
      percent: 100,
      bps: 10_000,
      swapInfo: {
        ammKey: program,
        label: "Pump.fun",
        inputMint: WRAPPED_SOL_MINT,
        outputMint: tokenMint,
        inAmount: "100000000",
        outAmount: "500000000",
      },
    }],
    computeBudgetInstructions: [],
    setupInstructions: [],
    swapInstruction: { programId: program, accounts: [], data: "AQ==" },
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    blockhashWithMetadata: {
      blockhash: Array.from({ length: 32 }, () => 1),
      lastValidBlockHeight: 123_456,
      fetchedAt: { secs_since_epoch: 1_785_687_240, nanos_since_epoch: 325_336_819 },
    },
  };
}

function prepared(direction: "buy" | "sell" = "buy"): PreparedJupiterSwap {
  const build = buildManifest();
  return {
    intent: { direction, tokenMint, amountAtomic: 100_000_000n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: true },
    build: direction === "buy" ? build : { ...build, inputMint: tokenMint, outputMint: WRAPPED_SOL_MINT },
    transaction: {} as Transaction,
    computeUnitLimit: 200_000,
    computeUnitPriceMicroLamports: 5_000n,
    estimatedNetworkFeeLamports: 6_000n,
    preparedAt: 1,
  };
}

function trade(overrides: Partial<ConfirmedTradeRecord>): ConfirmedTradeRecord {
  return {
    signature: "s".repeat(88),
    wallet,
    tokenMint,
    tokenName: "Test token",
    tokenSymbol: "TEST",
    tokenDecimals: 6,
    direction: "buy",
    tokenDeltaAtomic: "1000000",
    walletSolDeltaLamports: "-100005000",
    networkFeeLamports: "5000",
    accountRentAndOtherLamports: "0",
    inputAmountAtomic: "100000000",
    quotedOutputAtomic: "1000000",
    minimumOutputAtomic: "990000",
    route: ["Pump.fun"],
    slot: 1,
    confirmedAt: 1,
    ...overrides,
  };
}

describe("Solana amount safety", () => {
  it("parses decimal strings without floating-point loss and applies bounded percentages", () => {
    expect(parseDecimalAmount("1.000000001", 9)).toBe(1_000_000_001n);
    expect(parseDecimalAmount("0.05", 9)).toBe(50_000_000n);
    expect(applyPercentageBps(101n, 2_500)).toBe(25n);
    expect(formatAtomicAmount(-1_234_560_000n, 9)).toBe("-1.23456");
  });

  it("rejects exponent notation, excess precision, zero and an empty percentage result", () => {
    expect(() => parseDecimalAmount("1e-3", 9)).toThrow(/without exponent/);
    expect(() => parseDecimalAmount("0.0000000001", 9)).toThrow(/at most 9/);
    expect(() => parseDecimalAmount("0", 9)).toThrow(/greater than zero/);
    expect(() => applyPercentageBps(1n, 2_500)).toThrow(/rounds down to zero/);
  });
});

describe("Jupiter direct execution boundary", () => {
  it("builds a zero-platform-fee buy URL with explicit route policy", () => {
    const url = new URL(buildJupiterSwapUrl({ direction: "buy", tokenMint, amountAtomic: 50_000_000n, taker: wallet, slippageBps: 125, priorityProfile: "veryHigh", fastMode: true }));
    expect(url.origin + url.pathname).toBe("https://api.jup.ag/swap/v2/build");
    expect(url.searchParams.get("inputMint")).toBe(WRAPPED_SOL_MINT);
    expect(url.searchParams.get("outputMint")).toBe(tokenMint);
    expect(url.searchParams.get("platformFeeBps")).toBe("0");
    expect(url.searchParams.get("wrapAndUnwrapSol")).toBe("true");
    expect(url.searchParams.get("computeUnitPricePercentile")).toBe("veryHigh");
    expect(url.searchParams.get("mode")).toBe("fast");
  });

  it("validates provider manifests and rejects malformed responses", async () => {
    const goodFetch = vi.fn(async () => new Response(JSON.stringify(buildManifest()), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const result = await requestJupiterBuild({ direction: "buy", tokenMint, amountAtomic: 100_000_000n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: false }, undefined, goodFetch);
    expect(result.routePlan[0]?.swapInfo.label).toBe("Pump.fun");
    const badFetch = vi.fn(async () => new Response(JSON.stringify({ outAmount: "500" }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestJupiterBuild({ direction: "buy", tokenMint, amountAtomic: 100n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: false }, undefined, badFetch)).rejects.toThrow(/invalid transaction manifest/);
    const mismatchedFetch = vi.fn(async () => new Response(JSON.stringify({ ...buildManifest(), inAmount: "999" }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestJupiterBuild({ direction: "buy", tokenMint, amountAtomic: 100_000_000n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: false }, undefined, mismatchedFetch)).rejects.toThrow(/does not match the requested swap intent/);
  });

  it("derives exact wallet deltas only from confirmed transaction metadata", () => {
    const result = analyzeJupiterSwapReceipt(prepared(), "x".repeat(88), {
      slot: 42,
      blockTime: 1_700_000_000,
      transaction: { message: { accountKeys: [wallet, program, WRAPPED_SOL_MINT] } },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [1_000_000_000, 0],
        postBalances: [897_955_720, 0],
        logMessages: [],
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 2, mint: tokenMint, owner: wallet, uiTokenAmount: { amount: "500000000", decimals: 6 } }],
      },
    });
    expect(result.walletSolDeltaLamports).toBe(-102_044_280n);
    expect(result.networkFeeLamports).toBe(5_000n);
    expect(result.accountRentAndOtherLamports).toBe(2_039_280n);
    expect(result.tokenDeltaAtomic).toBe(500_000_000n);
    expect(result.route).toEqual(["Pump.fun"]);
  });

  it("rejects a reverted or wallet-mismatched transaction even when it has a slot", () => {
    const base = {
      slot: 42,
      blockTime: null,
      transaction: { message: { accountKeys: [program] } },
      meta: { err: null, fee: 5_000, preBalances: [1], postBalances: [1], logMessages: [] },
    };
    expect(() => analyzeJupiterSwapReceipt(prepared(), "x".repeat(88), base)).toThrow(/expected wallet/);
    expect(() => analyzeJupiterSwapReceipt(prepared(), "x".repeat(88), { ...base, transaction: { message: { accountKeys: [wallet] } }, meta: { ...base.meta, err: { InstructionError: [1, "Custom"] } } })).toThrow(/reverted/);
  });

  it("rejects a confirmed signature whose exact token delta misses the quoted minimum", () => {
    expect(() => analyzeJupiterSwapReceipt(prepared(), "x".repeat(88), {
      slot: 43,
      blockTime: null,
      transaction: { message: { accountKeys: [wallet, WRAPPED_SOL_MINT] } },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [1_000_000_000, 0],
        postBalances: [899_995_000, 0],
        logMessages: [],
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: tokenMint, owner: wallet, uiTokenAmount: { amount: "494999999", decimals: 6 } }],
      },
    })).toThrow(/below the quoted minimum/);
  });
});

describe("live token and Pump event validation", () => {
  it("validates Jupiter recent/search payloads and sanitizes icons", async () => {
    const payload = [{
      id: tokenMint,
      name: "Test token",
      symbol: "TEST",
      decimals: 6,
      icon: "https://cdn.example/token.png",
      firstPool: { id: program, createdAt: "2026-08-02T00:00:00.000Z" },
      usdPrice: 0.00001,
      liquidity: 12_345,
      stats5m: { priceChange: 12, buyVolume: 500, sellVolume: 250 },
    }];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchRecentTokens(undefined, fetcher)).resolves.toHaveLength(1);
    await expect(searchTokenInformation(tokenMint, undefined, fetcher)).resolves.toMatchObject([{ symbol: "TEST" }]);
    expect(safeTokenIcon(payload[0]?.icon)).toBe("https://cdn.example/token.png");
    expect(safeTokenIcon("javascript:alert(1)")).toBeUndefined();
  });

  it("normalizes on-chain Pump fee and price evidence", () => {
    const event = normalizePumpTradeEvent({
      mint: tokenMint,
      user: wallet,
      solAmount: "200000000",
      tokenAmount: "1000000",
      timestamp: "1700000000",
      isBuy: true,
      fee: "2000000",
      creatorFee: "500000",
      feeBasisPoints: "100",
      creatorFeeBasisPoints: "25",
    }, { signature: "x".repeat(88), slot: 99, decimals: 6 });
    expect(event.side).toBe("buy");
    expect(event.priceSol).toBe(0.2);
    expect(event.feeBasisPoints + event.creatorFeeBasisPoints).toBe(125);
  });

  it("decodes the current official Pump TradeEvent prefix from a confirmed program-data log", () => {
    const data = new Uint8Array(225);
    data.set([189, 219, 127, 211, 78, 230, 97, 238]);
    const view = new DataView(data.buffer);
    let cursor = 8;
    const key = (value: string) => { data.set(getBase58Encoder().encode(value), cursor); cursor += 32; };
    const u64 = (value: bigint) => { view.setBigUint64(cursor, value, true); cursor += 8; };
    key(WRAPPED_SOL_MINT);
    u64(200_000_000n);
    u64(1_000_000n);
    data[cursor++] = 1;
    key(PUMP_PROGRAM_ADDRESS);
    view.setBigInt64(cursor, 1_700_000_000n, true); cursor += 8;
    u64(1n); u64(2n); u64(3n); u64(4n);
    key(PUMP_PROGRAM_ADDRESS);
    u64(100n);
    u64(2_000_000n);
    key(PUMP_PROGRAM_ADDRESS);
    u64(25n);
    u64(500_000n);
    const decoded = decodePumpTradeLog(`Program data: ${Buffer.from(data).toString("base64")}`, { signature: "z".repeat(88), slot: 101, decimals: 6 });
    expect(decoded).toMatchObject({ mint: WRAPPED_SOL_MINT, user: PUMP_PROGRAM_ADDRESS, side: "buy", feeBasisPoints: 100, creatorFeeBasisPoints: 25, priceSol: 0.2 });
    expect(decodePumpTradeLog("Program log: not an event", { signature: "z".repeat(88), slot: 101, decimals: 6 })).toBeUndefined();
  });
});

describe("confirmed net PnL ledger", () => {
  it("uses exact wallet cash flow and proportional tracked cost basis", () => {
    const position = deriveTrackedPosition([
      trade({ signature: "a".repeat(88), confirmedAt: 1, tokenDeltaAtomic: "1000000", walletSolDeltaLamports: "-100005000" }),
      trade({ signature: "b".repeat(88), confirmedAt: 2, direction: "sell", tokenDeltaAtomic: "-500000", walletSolDeltaLamports: "79995000", inputAmountAtomic: "500000" }),
    ]);
    expect(position?.holdingsAtomic).toBe(500_000n);
    expect(position?.trackedCostBasisLamports).toBe(50_002_500n);
    expect(position?.realizedNetPnlLamports).toBe(29_992_500n);
    expect(position?.confirmedNetSolFlowLamports).toBe(-20_010_000n);
    expect(position?.hasUntrackedInventory).toBe(false);
  });

  it("marks sold inventory that was not bought in the local confirmed ledger", () => {
    const position = deriveTrackedPosition([trade({ direction: "sell", tokenDeltaAtomic: "-1000000", walletSolDeltaLamports: "50000000" })]);
    expect(position?.hasUntrackedInventory).toBe(true);
    expect(position?.realizedNetPnlLamports).toBe(50_000_000n);
  });

  it("orders same-time records by canonical slot and drops only invalid stored entries", () => {
    const buy = trade({ signature: "b".repeat(88), confirmedAt: 10, slot: 100 });
    const sell = trade({ signature: "s".repeat(88), confirmedAt: 10, slot: 101, direction: "sell", tokenDeltaAtomic: "-500000", walletSolDeltaLamports: "79995000", inputAmountAtomic: "500000" });
    const position = deriveTrackedPosition([sell, buy]);
    expect(position?.hasUntrackedInventory).toBe(false);
    expect(position?.realizedNetPnlLamports).toBe(29_992_500n);
    expect(parseStoredTrades([{ ...buy, wallet: "invalid" }, buy])).toEqual([buy]);
  });
});
