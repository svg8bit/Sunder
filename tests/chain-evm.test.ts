import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, type Address, type Hex } from "viem";
import {
  EVM_DEPLOYMENTS,
  EvmVenueQuoteAdapter,
  EvmVenueTransactionAdapter,
  EvmConfirmationAdapter,
  FlashbotsProtectRelayAdapter,
  UniswapV2QuoteAdapter,
  UniswapV2TransactionAdapter,
  UniswapV3QuoteAdapter,
  UniswapV3TransactionAdapter,
  UniswapV4QuoteAdapter,
  UniswapV4TransactionAdapter,
  type EvmBlock,
  type EvmCallRequest,
  type EvmReceipt,
  type EvmRpc,
} from "../packages/chain-evm/src/index.js";
import { CHAIN_DESCRIPTORS, type QuoteRequest, type SignedTransaction, type SniperRule, type TransactionDraft } from "../packages/sniper-engine/src/index.js";

const account = "0x0000000000000000000000000000000000000001" as Address;
const tokenIn = "0x0000000000000000000000000000000000000002" as Address;
const tokenOut = "0x0000000000000000000000000000000000000003" as Address;
const hash = `0x${"a".repeat(64)}` as Hex;
const UNIVERSAL_ROUTER_EXECUTE_ABI = [{
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [
    { name: "commands", type: "bytes" },
    { name: "inputs", type: "bytes[]" },
    { name: "deadline", type: "uint256" },
  ],
  outputs: [],
}] as const;
const V4_COMMAND_INPUT_ABI = [{ type: "bytes", name: "actions" }, { type: "bytes[]", name: "params" }] as const;
const CURRENCY_AMOUNT_ABI = [{ type: "address", name: "currency" }, { type: "uint256", name: "amount" }] as const;

function testRule(): SniperRule {
  return {
    id: "rule",
    name: "rule",
    enabled: true,
    networks: ["evm:sepolia"],
    eventKinds: ["manual"],
    accounts: [],
    keywords: [],
    requireMedia: false,
    allowTargets: [],
    denyTargets: [],
    maxSpendAtomic: 10n ** 18n,
    maxDailySpendAtomic: 10n ** 19n,
    maxSlippageBps: 200,
    maxPriceImpactBps: 500,
    cooldownMs: 0,
    maxAttempts: 3,
  };
}

function event() {
  return {
    id: "event",
    source: "manual" as const,
    kind: "manual" as const,
    network: "evm:sepolia" as const,
    receivedAt: Date.now(),
    target: tokenOut,
    account,
    attributes: { tokenIn, feeTier: 3_000 },
  };
}

function rpc(overrides: Partial<EvmRpc> = {}): EvmRpc {
  return {
    quoteExactInputSingle: vi.fn(async ({ amountIn }) => ({ amountOut: amountIn * 2n, gasEstimate: 90_000n })),
    quoteV2ExactInput: vi.fn(async ({ amountIn }) => ({ amountOut: amountIn * 2n })),
    quoteV4ExactInputSingle: vi.fn(async ({ amountIn }) => ({ amountOut: amountIn * 2n, gasEstimate: 95_000n })),
    getTransactionCount: vi.fn(async () => 7),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })),
    estimateGas: vi.fn(async () => 100_000n),
    call: vi.fn(async (_request: EvmCallRequest) => undefined),
    getBlockNumber: vi.fn(async () => 100n),
    getFinalizedBlockNumber: vi.fn(async () => null),
    getReceipt: vi.fn(async () => null),
    getBlock: vi.fn(async (number) => ({ number, hash: `0x${"b".repeat(64)}` as Hex, transactions: [] })),
    ...overrides,
  };
}

function quoteRequest(): QuoteRequest {
  return {
    chain: CHAIN_DESCRIPTORS["evm:sepolia"],
    event: event(),
    rule: testRule(),
    inputAmountAtomic: 1_000_000n,
  };
}

async function draft(evmRpc: EvmRpc, previous?: TransactionDraft, replacementBumpBps = 1_250): Promise<TransactionDraft> {
  const quote = await new UniswapV3QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc }).quote(quoteRequest());
  return new UniswapV3TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc }).build({
    chain: CHAIN_DESCRIPTORS["evm:sepolia"],
    event: event(),
    quote,
    feePolicy: { kind: "eip1559", gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, replacementBumpBps },
    idempotencyKey: previous ? "replacement" : "initial",
    previous,
  });
}

function signed(transaction: TransactionDraft, transactionHash: Hex = hash): SignedTransaction {
  return { draft: transaction, signature: transactionHash, wireTransaction: `0x${"1".repeat(256)}`, signedAt: Date.now() };
}

describe("Uniswap EVM adapters", () => {
  it("pins current official V2 Router02 and Universal Router V2.1.1 deployments", () => {
    expect(EVM_DEPLOYMENTS["evm:mainnet"].uniswapV2Router02).toBe("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D");
    expect(EVM_DEPLOYMENTS["evm:sepolia"].uniswapV2Router02).toBe("0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3");
    expect(EVM_DEPLOYMENTS["evm:mainnet"].universalRouter).toBe("0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA");
    expect(EVM_DEPLOYMENTS["evm:sepolia"].universalRouter).toBe("0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468");
  });

  it("quotes with a small probe and applies the rule slippage guard", async () => {
    const evmRpc = rpc();
    const quote = await new UniswapV3QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc }).quote(quoteRequest());
    expect(quote.expectedOutputAmount).toBe(2_000_000n);
    expect(quote.minimumOutputAmount).toBe(1_960_000n);
    expect(quote.priceImpactBps).toBe(0);
    expect(evmRpc.quoteExactInputSingle).toHaveBeenCalledTimes(2);
  });

  it("rejects non-integer or out-of-range slippage before minimum-output arithmetic", async () => {
    const adapter = new UniswapV3QuoteAdapter({ network: "evm:sepolia", rpc: rpc() });
    for (const maxSlippageBps of [-1, 10_000.5, 10_001, Number.NaN]) {
      await expect(adapter.quote({
        ...quoteRequest(),
        rule: { ...testRule(), maxSlippageBps },
      })).rejects.toThrow(/integer from 0 to 10000/);
    }
  });

  it("preserves nonce and bumps EIP-1559 fees for replacement", async () => {
    const evmRpc = rpc();
    const initial = await draft(evmRpc);
    const replacement = await draft(evmRpc, initial);
    expect(initial.lifetime).toMatchObject({ kind: "evm-nonce", nonce: 7 });
    expect(replacement.lifetime).toMatchObject({ kind: "evm-nonce", nonce: 7 });
    expect(initial.feePolicy).toMatchObject({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n, replacementBumpBps: 1_250 });
    expect(replacement.feePolicy).toMatchObject({ maxFeePerGas: 113n, maxPriorityFeePerGas: 3n, replacementBumpBps: 1_250 });
    expect(evmRpc.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it("uses eth_call plus estimateGas and returns a truthful simulation failure", async () => {
    const okRpc = rpc();
    const transaction = await draft(okRpc);
    const adapter = new UniswapV3TransactionAdapter({ network: "evm:sepolia", rpc: okRpc });
    await expect(adapter.simulate(transaction)).resolves.toMatchObject({ ok: true, unitsConsumed: 100_000n });

    const failingRpc = rpc({ call: vi.fn(async () => { throw new Error("execution reverted: STF"); }) });
    const failingAdapter = new UniswapV3TransactionAdapter({ network: "evm:sepolia", rpc: failingRpc });
    await expect(failingAdapter.simulate(transaction)).resolves.toMatchObject({ ok: false, error: "execution reverted: STF" });
  });

  it("routes V2 and V4 through their own verified quote and transaction encoders", async () => {
    const evmRpc = rpc();
    const v2Router = EVM_DEPLOYMENTS["evm:sepolia"].uniswapV2Router02;
    const v2Request: QuoteRequest = {
      ...quoteRequest(),
      event: { ...event(), attributes: { ...event().attributes, venue: "v2" } },
    };
    const v2Quote = await new UniswapV2QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc, router: v2Router }).quote(v2Request);
    const v2Draft = await new UniswapV2TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc, router: v2Router }).build({
      chain: CHAIN_DESCRIPTORS["evm:sepolia"],
      event: v2Request.event,
      quote: v2Quote,
      feePolicy: { kind: "eip1559", gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, replacementBumpBps: 1_250 },
      idempotencyKey: "v2",
    });
    expect(v2Quote.provider).toBe("uniswap-v2-router-02");
    expect(v2Draft.instructions[0]).toMatchObject({ program: v2Router, action: "uniswap-v2-exact-tokens-for-tokens" });

    const v4Request: QuoteRequest = {
      ...quoteRequest(),
      event: { ...event(), attributes: { ...event().attributes, venue: "v4", tickSpacing: 60 } },
    };
    const v4Quote = await new UniswapV4QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc }).quote(v4Request);
    const v4Draft = await new UniswapV4TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc }).build({
      chain: CHAIN_DESCRIPTORS["evm:sepolia"],
      event: v4Request.event,
      quote: v4Quote,
      feePolicy: { kind: "eip1559", gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, replacementBumpBps: 1_250 },
      idempotencyKey: "v4",
    });
    expect(v4Quote.provider).toBe("uniswap-v4-quoter");
    expect(v4Draft.instructions[0]).toMatchObject({
      program: EVM_DEPLOYMENTS["evm:sepolia"].universalRouter,
      action: "uniswap-v4-exact-input-single",
    });
    const serialized = JSON.parse(v4Draft.unsignedPayload) as { readonly data: Hex };
    const execute = decodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI, data: serialized.data });
    const commandInput = execute.args?.[1][0];
    if (!commandInput) throw new Error("V4 Universal Router command input is missing.");
    const [actions, parameters] = decodeAbiParameters(V4_COMMAND_INPUT_ABI, commandInput);
    const [, settleMaximum] = decodeAbiParameters(CURRENCY_AMOUNT_ABI, parameters[1] ?? "0x");
    const [, takeMinimum] = decodeAbiParameters(CURRENCY_AMOUNT_ABI, parameters[2] ?? "0x");
    expect(actions).toBe("0x060c0f");
    expect(settleMaximum).toBe(v4Quote.inputAmountAtomic);
    expect(takeMinimum).toBe(v4Quote.minimumOutputAmount);
  });

  it("maps the V3 provider id to the V3 transaction adapter exactly", async () => {
    const evmRpc = rpc();
    const v3Quote = await new UniswapV3QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc }).quote(quoteRequest());
    const transaction = await new EvmVenueTransactionAdapter({
      network: "evm:sepolia",
      venues: {
        v2: new UniswapV2TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc }),
        v3: new UniswapV3TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc }),
        v4: new UniswapV4TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc }),
      },
    }).build({
      chain: CHAIN_DESCRIPTORS["evm:sepolia"],
      event: event(),
      quote: v3Quote,
      feePolicy: { kind: "eip1559", gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, replacementBumpBps: 1_250 },
      idempotencyKey: "v3-provider-routing",
    });

    expect(transaction.instructions[0]?.action).toBe("uniswap-v3-exact-input-single");
  });

  it("rejects invalid wrapped-native V2 endpoints and out-of-range V4 tick spacing", async () => {
    const evmRpc = rpc();
    const v2 = new UniswapV2QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc });
    await expect(v2.quote({
      ...quoteRequest(),
      event: { ...event(), attributes: { ...event().attributes, venue: "v2", nativeInput: true } },
    })).rejects.toThrow(/must start with the network wrapped-native token/);
    await expect(v2.quote({
      ...quoteRequest(),
      event: { ...event(), attributes: { ...event().attributes, venue: "v2", nativeOutput: true } },
    })).rejects.toThrow(/must end with the network wrapped-native token/);

    const v4 = new UniswapV4QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc });
    for (const tickSpacing of [0, -1, 32_768]) {
      await expect(v4.quote({
        ...quoteRequest(),
        event: { ...event(), attributes: { ...event().attributes, venue: "v4", tickSpacing } },
      })).rejects.toThrow(/integer from 1 to 32767/);
    }
  });

  it("auto-selects the best viable venue and keeps its transaction encoder", async () => {
    const evmRpc = rpc({
      quoteV2ExactInput: vi.fn(async ({ amountIn }) => ({ amountOut: amountIn * 3n })),
    });
    const v2Router = EVM_DEPLOYMENTS["evm:sepolia"].uniswapV2Router02;
    const quotes = {
      v2: new UniswapV2QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc, router: v2Router }),
      v3: new UniswapV3QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc }),
      v4: new UniswapV4QuoteAdapter({ network: "evm:sepolia", rpc: evmRpc }),
    } as const;
    const transactions = {
      v2: new UniswapV2TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc, router: v2Router }),
      v3: new UniswapV3TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc }),
      v4: new UniswapV4TransactionAdapter({ network: "evm:sepolia", rpc: evmRpc }),
    } as const;
    const request: QuoteRequest = {
      ...quoteRequest(),
      event: { ...event(), attributes: { ...event().attributes, venue: "auto", tickSpacing: 60 } },
    };
    const quote = await new EvmVenueQuoteAdapter({ network: "evm:sepolia", venues: quotes }).quote(request);
    const transaction = await new EvmVenueTransactionAdapter({ network: "evm:sepolia", venues: transactions }).build({
      chain: CHAIN_DESCRIPTORS["evm:sepolia"],
      event: request.event,
      quote,
      feePolicy: { kind: "eip1559", gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, replacementBumpBps: 1_250 },
      idempotencyKey: "auto",
    });
    expect(quote.provider).toBe("uniswap-v2-router-02");
    expect(transaction.instructions[0]?.action).toContain("uniswap-v2");
  });
});

describe("EVM receipt confirmation", () => {
  it("requires canonical receipt depth and recognizes finalized blocks", async () => {
    const evmRpc = rpc({
      getBlockNumber: vi.fn(async () => 101n),
      getFinalizedBlockNumber: vi.fn(async () => 100n),
      getReceipt: vi.fn(async (): Promise<EvmReceipt> => ({ transactionHash: hash, blockNumber: 100n, blockHash: `0x${"b".repeat(64)}` as Hex, status: "success" })),
    });
    const transaction = await draft(evmRpc);
    const result = await new EvmConfirmationAdapter({ network: "evm:sepolia", rpc: evmRpc, confirmations: 2, pollIntervalMs: 0 }).track(signed(transaction));
    expect(result).toMatchObject({ confirmed: true, state: "finalized" });
  });

  it("rejects a receipt whose block hash is no longer canonical", async () => {
    const receipt: EvmReceipt = { transactionHash: hash, blockNumber: 100n, blockHash: `0x${"c".repeat(64)}` as Hex, status: "success" };
    const evmRpc = rpc({ getReceipt: vi.fn(async () => receipt) });
    const transaction = await draft(evmRpc);
    const result = await new EvmConfirmationAdapter({ network: "evm:sepolia", rpc: evmRpc, pollIntervalMs: 0 }).track(signed(transaction));
    expect(result).toMatchObject({ confirmed: false, state: "reorged" });
  });

  it("tracks a nonce replacement before confirming the replacement receipt", async () => {
    const replacementHash = `0x${"d".repeat(64)}` as Hex;
    let receiptCalls = 0;
    let headCalls = 0;
    const blocks = new Map<bigint, EvmBlock>([
      [100n, { number: 100n, hash: `0x${"b".repeat(64)}` as Hex, transactions: [] }],
      [101n, { number: 101n, hash: `0x${"c".repeat(64)}` as Hex, transactions: [{ hash: replacementHash, from: account, nonce: 7 }] }],
      [102n, { number: 102n, hash: `0x${"e".repeat(64)}` as Hex, transactions: [] }],
    ]);
    const evmRpc = rpc({
      getBlockNumber: vi.fn(async () => (++headCalls === 1 ? 101n : 102n)),
      getReceipt: vi.fn(async (candidate: Hex): Promise<EvmReceipt | null> => {
        receiptCalls += 1;
        if (candidate !== replacementHash || receiptCalls < 2) return null;
        return { transactionHash: replacementHash, blockNumber: 101n, blockHash: blocks.get(101n)?.hash ?? hash, status: "success" };
      }),
      getBlock: vi.fn(async (number) => blocks.get(number) ?? { number, hash, transactions: [] }),
    });
    const transaction = await draft(evmRpc);
    const result = await new EvmConfirmationAdapter({ network: "evm:sepolia", rpc: evmRpc, confirmations: 2, pollIntervalMs: 0 }).track(signed(transaction));
    expect(result).toMatchObject({ confirmed: true, state: "confirmed", signature: replacementHash });
    expect(result.observations.some((observation) => observation.state === "replaced" && observation.replacementHash === replacementHash)).toBe(true);
  });
});

describe("Flashbots Protect relay", () => {
  it("treats provider acceptance only as a relay receipt", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hash }), { status: 200, headers: { "content-type": "application/json" } }));
    const relay = new FlashbotsProtectRelayAdapter({ network: "evm:sepolia", endpoint: EVM_DEPLOYMENTS["evm:sepolia"].flashbotsProtect, fetcher });
    const transaction = await draft(rpc());
    const receipt = await relay.submit(signed(transaction));
    expect(receipt).toMatchObject({ accepted: true, responseId: hash });
    expect("confirmed" in receipt).toBe(false);
  });

  it("fails closed on its bounded request deadline", async () => {
    const fetcher: typeof fetch = vi.fn(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const rejectForAbort = () => reject(new DOMException("Request timed out", "TimeoutError"));
      if (init?.signal?.aborted) rejectForAbort();
      else init?.signal?.addEventListener("abort", rejectForAbort, { once: true });
    }));
    const relay = new FlashbotsProtectRelayAdapter({ network: "evm:sepolia", endpoint: EVM_DEPLOYMENTS["evm:sepolia"].flashbotsProtect, fetcher, timeoutMs: 1 });
    const receipt = await relay.submit(signed(await draft(rpc())));
    expect(receipt).toMatchObject({ accepted: false });
    expect(receipt.error).toContain("TimeoutError");
  });
});
