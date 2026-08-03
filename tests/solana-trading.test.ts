import { getBase58Encoder, type Transaction } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { applyPercentageBps, formatAtomicAmount, parseDecimalAmount } from "../src/solana/amounts";
import {
  analyzeJupiterSwapReceipt,
  buildJupiterSwapUrl,
  getWalletTokenBalanceAtomic,
  isJupiterBlockhashValid,
  requestJupiterBuild,
  WRAPPED_SOL_MINT,
  type JupiterBuildResponse,
  type PreparedJupiterSwap,
} from "../src/solana/jupiter";
import { decodePumpAmmTradeLog, decodePumpTradeLog, fetchPumpTradeHistory, fetchRecentTokens, normalizePumpTradeEvent, parsePumpTradeHistory, PUMP_PROGRAM_ADDRESS, safeTokenIcon, searchTokenInformation, serializePumpTradeHistory } from "../src/solana/market";
import { solanaStageError, stringifySolanaRpcValue } from "../src/solana/rpc-errors";
import { deriveTrackedPosition, parseStoredTrades, type ConfirmedTradeRecord } from "../src/state/trading";

const tokenMint = "ToKeN111111111111111111111111111111111111111";
const wallet = "WaLLeT11111111111111111111111111111111111111";
const program = "11111111111111111111111111111111";

function pumpTradeLog(mint = WRAPPED_SOL_MINT): string {
  const data = new Uint8Array(225);
  data.set([189, 219, 127, 211, 78, 230, 97, 238]);
  const view = new DataView(data.buffer);
  let cursor = 8;
  const key = (value: string) => { data.set(getBase58Encoder().encode(value), cursor); cursor += 32; };
  const u64 = (value: bigint) => { view.setBigUint64(cursor, value, true); cursor += 8; };
  key(mint);
  u64(200_000_000n);
  u64(1_000_000n);
  data[cursor++] = 1;
  key(PUMP_PROGRAM_ADDRESS);
  view.setBigInt64(cursor, 1_700_000_000n, true); cursor += 8;
  u64(3_000_000_000n); u64(1_000_000_000_000n); u64(3n); u64(4n);
  key(PUMP_PROGRAM_ADDRESS);
  u64(100n);
  u64(2_000_000n);
  key(PUMP_PROGRAM_ADDRESS);
  u64(25n);
  u64(500_000n);
  return `Program data: ${Buffer.from(data).toString("base64")}`;
}

function pumpAmmTradeLog(side: "buy" | "sell" = "sell"): string {
  const data = new Uint8Array(side === "buy" ? 480 : 417);
  data.set(side === "buy" ? [103, 244, 82, 31, 44, 245, 119, 119] : [62, 47, 55, 10, 165, 3, 220, 42]);
  const view = new DataView(data.buffer);
  let cursor = 8;
  const key = () => { data.set(getBase58Encoder().encode(PUMP_PROGRAM_ADDRESS), cursor); cursor += 32; };
  const u64 = (value: bigint) => { view.setBigUint64(cursor, value, true); cursor += 8; };
  view.setBigInt64(cursor, 1_700_000_000n, true); cursor += 8;
  u64(1_000_000n); // base amount
  u64(3_500_000n); // max/min quote amount
  u64(10_000_000n); // user base reserves
  u64(1_000_000_000n); // user quote reserves
  u64(1_000_000_000n); // pool base reserves (1,000 tokens at 6 decimals)
  u64(3_000_000_000n); // pool quote reserves (3 SOL)
  u64(3_000_000n); // actual quote amount
  u64(20n); u64(600n); // LP fee BPS + lamports
  u64(5n); u64(150n); // protocol fee BPS + lamports
  u64(3_000_600n); // quote with/without LP fee
  u64(3_000_750n); // user quote amount
  for (let index = 0; index < 7; index += 1) key();
  u64(25n); u64(750n); // creator fee BPS + lamports
  return `Program data: ${Buffer.from(data).toString("base64")}`;
}

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
    recentBlockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4zLSyd7X1",
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
  it("uses canonical blockhash validity instead of comparing a provider slot with block height", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { readonly method: string; readonly params: readonly unknown[] };
      expect(request.method).toBe("isBlockhashValid");
      expect(request.params).toEqual([prepared().recentBlockhash, { commitment: "confirmed" }]);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { context: { slot: 436_916_282 }, value: true },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(isJupiterBlockhashValid({
      rpcUrl: "https://rpc.example",
      blockhash: prepared().recentBlockhash,
      fetcher,
    })).resolves.toBe(true);
  });

  it("builds a zero-platform-fee buy URL with explicit route policy", () => {
    const url = new URL(buildJupiterSwapUrl({ direction: "buy", tokenMint, amountAtomic: 50_000_000n, taker: wallet, slippageBps: 125, priorityProfile: "veryHigh", fastMode: true }));
    expect(url.origin + url.pathname).toBe("https://api.jup.ag/swap/v2/build");
    expect(url.searchParams.get("inputMint")).toBe(WRAPPED_SOL_MINT);
    expect(url.searchParams.get("outputMint")).toBe(tokenMint);
    expect(url.searchParams.get("platformFeeBps")).toBe("0");
    expect(url.searchParams.get("wrapAndUnwrapSol")).toBe("true");
    expect(url.searchParams.get("computeUnitPricePercentile")).toBe("veryHigh");
    expect(url.searchParams.get("mode")).toBe("fast");
    const sell = new URL(buildJupiterSwapUrl({ direction: "sell", tokenMint, amountAtomic: 1_000_000n, taker: wallet, slippageBps: 75, priorityProfile: "medium", fastMode: false }));
    expect(sell.searchParams.get("inputMint")).toBe(tokenMint);
    expect(sell.searchParams.get("outputMint")).toBe(WRAPPED_SOL_MINT);
    expect(() => buildJupiterSwapUrl({ direction: "buy", tokenMint, amountAtomic: 1n, taker: wallet, slippageBps: 0, priorityProfile: "medium", fastMode: false })).toThrow(/\[1, 5000\]/);
  });

  it("validates provider manifests and rejects malformed responses", async () => {
    const goodFetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(buildManifest()), { status: 200, headers: { "content-type": "application/json" } }));
    const goodFetch = goodFetchMock as unknown as typeof fetch;
    const result = await requestJupiterBuild({ direction: "buy", tokenMint, amountAtomic: 100_000_000n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: false }, undefined, goodFetch);
    expect(result.routePlan[0]?.swapInfo.label).toBe("Pump.fun");
    const badFetch = vi.fn(async () => new Response(JSON.stringify({ outAmount: "500" }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestJupiterBuild({ direction: "buy", tokenMint, amountAtomic: 100n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: false }, undefined, badFetch)).rejects.toThrow(/invalid transaction manifest/);
    const mismatchedFetch = vi.fn(async () => new Response(JSON.stringify({ ...buildManifest(), inAmount: "999" }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestJupiterBuild({ direction: "buy", tokenMint, amountAtomic: 100_000_000n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: false }, undefined, mismatchedFetch)).rejects.toThrow(/does not match the requested swap intent/);
    const tippedFetch = vi.fn(async () => new Response(JSON.stringify({ ...buildManifest(), tipInstruction: { programId: program, accounts: [], data: "AQ==" } }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestJupiterBuild({ direction: "buy", tokenMint, amountAtomic: 100_000_000n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: false }, undefined, tippedFetch)).rejects.toThrow(/unexpected tip instruction/);
    expect(goodFetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries one transient Jupiter failure and preserves a valid manifest", async () => {
    const fetcherMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(buildManifest()), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await requestJupiterBuild(
      { direction: "buy", tokenMint, amountAtomic: 100_000_000n, taker: wallet, slippageBps: 100, priorityProfile: "high", fastMode: false },
      undefined,
      fetcherMock as unknown as typeof fetch,
    );
    expect(result.outAmount).toBe("500000000");
    expect(fetcherMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a second read-only RPC for a canonical sell balance", async () => {
    const primary = "https://primary-rpc.example";
    const fallback = "https://fallback-rpc.example";
    const fetcherMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === primary) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "20337803603" } } } } } }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(getWalletTokenBalanceAtomic({
      rpcUrl: primary,
      fallbackRpcUrls: [fallback],
      owner: wallet,
      mint: tokenMint,
      fetcher: fetcherMock as unknown as typeof fetch,
    })).resolves.toBe(20_337_803_603n);
    expect(fetcherMock.mock.calls.map(([input]) => String(input))).toEqual([primary, fallback]);
  });

  it("renders bigint RPC failures safely and gives a bounded pre-submit timeout state", () => {
    expect(stringifySolanaRpcValue({ InstructionError: [1n, { Custom: 7n }] })).toBe('{"InstructionError":["1",{"Custom":"7"}]}');
    expect(solanaStageError("Token balance lookup", new DOMException("signal timed out", "TimeoutError")).message)
      .toMatch(/timed out before submission.*No transaction was sent/);
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

  it("accepts only an exact sell debit and verifies minimum SOL proceeds net of the network fee", () => {
    const evidence = {
      slot: 44,
      blockTime: null,
      transaction: { message: { accountKeys: [wallet, program] } },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [1_000_000_000, 0],
        postBalances: [1_499_995_000, 0],
        logMessages: [],
        preTokenBalances: [{ accountIndex: 1, mint: tokenMint, owner: wallet, uiTokenAmount: { amount: "200000000", decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 1, mint: tokenMint, owner: wallet, uiTokenAmount: { amount: "100000000", decimals: 6 } }],
      },
    };
    expect(analyzeJupiterSwapReceipt(prepared("sell"), "x".repeat(88), evidence)).toMatchObject({ tokenDeltaAtomic: -100_000_000n, walletSolDeltaLamports: 499_995_000n });
    expect(() => analyzeJupiterSwapReceipt(prepared("sell"), "x".repeat(88), {
      ...evidence,
      meta: { ...evidence.meta, postTokenBalances: [{ ...evidence.meta.postTokenBalances[0]!, uiTokenAmount: { amount: "99999999", decimals: 6 } }] },
    })).toThrow(/does not match the requested input/);
    expect(() => analyzeJupiterSwapReceipt(prepared("sell"), "x".repeat(88), {
      ...evidence,
      meta: { ...evidence.meta, postBalances: [1_494_994_999, 0] },
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
    const fetcherMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const fetcher = fetcherMock as unknown as typeof fetch;
    await expect(fetchRecentTokens(undefined, fetcher)).resolves.toHaveLength(1);
    await expect(searchTokenInformation(tokenMint, undefined, fetcher)).resolves.toMatchObject([{ symbol: "TEST" }]);
    expect(fetcherMock).toHaveBeenNthCalledWith(1, "https://lite-api.jup.ag/tokens/v2/recent", expect.objectContaining({ credentials: "omit" }));
    expect(fetcherMock).toHaveBeenNthCalledWith(2, `https://lite-api.jup.ag/tokens/v2/search?query=${tokenMint}`, expect.objectContaining({ credentials: "omit" }));
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
      virtualSolReserves: "3000000000",
      virtualTokenReserves: "1000000000000",
    }, { signature: "x".repeat(88), slot: 99, decimals: 6 });
    expect(event.side).toBe("buy");
    expect(event.eventIndex).toBe(0);
    expect(event.priceSol).toBe(0.000003);
    expect(event.virtualSolReservesLamports).toBe(3_000_000_000n);
    expect(event.feeBasisPoints + event.creatorFeeBasisPoints).toBe(125);
  });

  it("decodes the current official Pump TradeEvent prefix from a confirmed program-data log", () => {
    const decoded = decodePumpTradeLog(pumpTradeLog(), { signature: "z".repeat(88), eventIndex: 17, slot: 101, decimals: 6 });
    expect(decoded).toMatchObject({ mint: WRAPPED_SOL_MINT, user: PUMP_PROGRAM_ADDRESS, side: "buy", eventIndex: 17, feeBasisPoints: 100, creatorFeeBasisPoints: 25, priceSol: 0.000003 });
    expect(decodePumpTradeLog("Program log: not an event", { signature: "z".repeat(88), slot: 101, decimals: 6 })).toBeUndefined();
  });

  it("decodes the official graduated Pump AMM buy/sell prefix with reserve-price OHLC", () => {
    const decoded = decodePumpAmmTradeLog(pumpAmmTradeLog("sell"), {
      signature: "a".repeat(88),
      eventIndex: 3,
      slot: 102,
      decimals: 6,
      mint: tokenMint,
    });
    expect(decoded).toMatchObject({ mint: tokenMint, user: PUMP_PROGRAM_ADDRESS, side: "sell", eventIndex: 3, feeBasisPoints: 25, creatorFeeBasisPoints: 25, priceSol: 0.003 });
    const restored = parsePumpTradeHistory(JSON.parse(serializePumpTradeHistory([decoded!]))) as readonly typeof decoded[];
    expect(restored[0]?.tokenAmountAtomic).toBe(1_000_000n);
    expect(restored[0]?.virtualSolReservesLamports).toBe(3_000_000_000n);
  });

  it("backfills graduated Pump AMM events instead of losing the chart after refresh", async () => {
    const signature = "y".repeat(88);
    const fetcherMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { readonly method: string };
      if (request.method === "getSignaturesForAddress") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ signature, slot: 102, err: null }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { slot: 102, meta: { logMessages: [pumpAmmTradeLog("sell")] } } }), { status: 200 });
    });
    const history = await fetchPumpTradeHistory({ mint: tokenMint, decimals: 6, rpcUrl: "https://rpc.example", fetcher: fetcherMock as unknown as typeof fetch });
    expect(history).toMatchObject([{ signature, mint: tokenMint, side: "sell", priceSol: 0.003 }]);
  });

  it("backfills bounded confirmed Pump transactions for real historical candles", async () => {
    const signature = "z".repeat(88);
    const fetcherMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { readonly method: string };
      if (request.method === "getSignaturesForAddress") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ signature, slot: 101, err: null }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { slot: 101, meta: { logMessages: [pumpTradeLog()] } } }), { status: 200 });
    });
    const history = await fetchPumpTradeHistory({ mint: WRAPPED_SOL_MINT, decimals: 6, rpcUrl: "https://rpc.example", fetcher: fetcherMock as unknown as typeof fetch });
    expect(history).toMatchObject([{ signature, slot: 101, priceSol: 0.000003 }]);
    expect(fetcherMock).toHaveBeenCalledTimes(2);
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
    expect(position?.realizedNetPnlLamports).toBe(0n);
  });

  it("prorates proceeds when a sell mixes tracked and untracked inventory", () => {
    const position = deriveTrackedPosition([
      trade({ signature: "a".repeat(88), tokenDeltaAtomic: "500000", walletSolDeltaLamports: "-50000000" }),
      trade({ signature: "b".repeat(88), slot: 2, confirmedAt: 2, direction: "sell", tokenDeltaAtomic: "-1000000", walletSolDeltaLamports: "120000000" }),
    ]);
    expect(position?.hasUntrackedInventory).toBe(true);
    expect(position?.realizedNetPnlLamports).toBe(10_000_000n);
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
