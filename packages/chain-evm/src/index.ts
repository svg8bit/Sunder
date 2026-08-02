import {
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToHex,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import {
  CHAIN_DESCRIPTORS,
  HealthWeightedRelayRouter,
  HttpRelayAdapter,
  type ChainAdapter,
  type ChainNetworkId,
  type ConfirmationAdapter,
  type ConfirmationObservation,
  type ConfirmationResult,
  type EvmFeePolicy,
  type Quote,
  type QuoteAdapter,
  type QuoteRequest,
  type RelayAdapter,
  type RelayHealth,
  type RelayReceipt,
  type SignedTransaction,
  type SimulationResult,
  type TransactionAdapter,
  type TransactionDraft,
  type WalletAdapter,
} from "../../sniper-engine/src/index.js";

export type EvmNetworkId = "evm:sepolia" | "evm:mainnet";

// Universal Router V2.1.1 addresses are pinned to Uniswap/universal-router commit fa3f856951967abd7e0cf33901f6cead31eb5469.
export const EVM_DEPLOYMENTS = Object.freeze({
  "evm:mainnet": Object.freeze({
    chainId: 1,
    uniswapV2Router02: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address,
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as Address,
    v4Quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203" as Address,
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address,
    universalRouter: "0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA" as Address,
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
    flashbotsProtect: "https://rpc.flashbots.net/fast",
  }),
  "evm:sepolia": Object.freeze({
    chainId: 11_155_111,
    uniswapV2Router02: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3" as Address,
    quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3" as Address,
    v4Quoter: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227" as Address,
    swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as Address,
    universalRouter: "0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468" as Address,
    wrappedNative: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as Address,
    flashbotsProtect: "https://rpc-sepolia.flashbots.net/",
  }),
});

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const SWAP_ROUTER_02_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const UNISWAP_V2_ROUTER_02_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactETHForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactTokensForETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const V4_QUOTER_ABI = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "exactAmount", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

const UNIVERSAL_ROUTER_ABI = [{
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

export interface EvmCallRequest {
  readonly account: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly nonce?: number;
}

export interface EvmReceipt {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly status: "success" | "reverted";
}

export interface EvmBlockTransaction {
  readonly hash: Hex;
  readonly from: Address;
  readonly nonce: number;
}

export interface EvmBlock {
  readonly number: bigint;
  readonly hash: Hex;
  readonly transactions: readonly EvmBlockTransaction[];
}

export type EvmVenue = "v2" | "v3" | "v4";

export interface V4PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

export interface EvmRpc {
  quoteExactInputSingle(input: {
    readonly quoter: Address;
    readonly account?: Address;
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountIn: bigint;
    readonly fee: number;
  }, signal?: AbortSignal): Promise<{ readonly amountOut: bigint; readonly gasEstimate: bigint }>;
  quoteV2ExactInput(input: {
    readonly router: Address;
    readonly amountIn: bigint;
    readonly path: readonly Address[];
  }, signal?: AbortSignal): Promise<{ readonly amountOut: bigint }>;
  quoteV4ExactInputSingle(input: {
    readonly quoter: Address;
    readonly account?: Address;
    readonly poolKey: V4PoolKey;
    readonly zeroForOne: boolean;
    readonly amountIn: bigint;
    readonly hookData: Hex;
  }, signal?: AbortSignal): Promise<{ readonly amountOut: bigint; readonly gasEstimate: bigint }>;
  getTransactionCount(account: Address, signal?: AbortSignal): Promise<number>;
  estimateFeesPerGas(signal?: AbortSignal): Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }>;
  estimateGas(request: EvmCallRequest, signal?: AbortSignal): Promise<bigint>;
  call(request: EvmCallRequest, signal?: AbortSignal): Promise<void>;
  getBlockNumber(signal?: AbortSignal): Promise<bigint>;
  getFinalizedBlockNumber(signal?: AbortSignal): Promise<bigint | null>;
  getReceipt(hash: Hex, signal?: AbortSignal): Promise<EvmReceipt | null>;
  getBlock(blockNumber: bigint, signal?: AbortSignal): Promise<EvmBlock>;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ViemEvmRpc implements EvmRpc {
  readonly #client;

  constructor(network: EvmNetworkId, rpcUrl: string) {
    this.#client = createPublicClient({
      chain: network === "evm:mainnet" ? mainnet : sepolia,
      transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }),
    });
  }

  async quoteExactInputSingle(input: {
    readonly quoter: Address;
    readonly account?: Address;
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountIn: bigint;
    readonly fee: number;
  }, signal?: AbortSignal): Promise<{ readonly amountOut: bigint; readonly gasEstimate: bigint }> {
    abortIfNeeded(signal);
    const data = encodeFunctionData({
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        fee: input.fee,
        sqrtPriceLimitX96: 0n,
      }],
    });
    const response = await this.#client.call({
      account: input.account,
      to: input.quoter,
      data,
      requestOptions: { signal },
    });
    if (!response.data) throw new Error("Uniswap V3 QuoterV2 returned empty response data.");
    const [amountOut, , , gasEstimate] = decodeFunctionResult({
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      data: response.data,
    });
    return { amountOut, gasEstimate };
  }

  async quoteV2ExactInput(input: {
    readonly router: Address;
    readonly amountIn: bigint;
    readonly path: readonly Address[];
  }, signal?: AbortSignal): Promise<{ readonly amountOut: bigint }> {
    abortIfNeeded(signal);
    const data = encodeFunctionData({
      abi: UNISWAP_V2_ROUTER_02_ABI,
      functionName: "getAmountsOut",
      args: [input.amountIn, [...input.path]],
    });
    const response = await this.#client.call({
      to: input.router,
      data,
      requestOptions: { signal },
    });
    if (!response.data) throw new Error("Uniswap V2 Router02 returned empty response data.");
    const amounts = decodeFunctionResult({
      abi: UNISWAP_V2_ROUTER_02_ABI,
      functionName: "getAmountsOut",
      data: response.data,
    });
    const amountOut = amounts.at(-1);
    if (amountOut === undefined) throw new Error("Uniswap V2 returned an empty amount path.");
    return { amountOut };
  }

  async quoteV4ExactInputSingle(input: {
    readonly quoter: Address;
    readonly account?: Address;
    readonly poolKey: V4PoolKey;
    readonly zeroForOne: boolean;
    readonly amountIn: bigint;
    readonly hookData: Hex;
  }, signal?: AbortSignal): Promise<{ readonly amountOut: bigint; readonly gasEstimate: bigint }> {
    abortIfNeeded(signal);
    if (input.amountIn > (1n << 128n) - 1n) throw new Error("Uniswap V4 exact input exceeds uint128.");
    const data = encodeFunctionData({
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey: input.poolKey,
        zeroForOne: input.zeroForOne,
        exactAmount: input.amountIn,
        hookData: input.hookData,
      }],
    });
    const response = await this.#client.call({
      account: input.account,
      to: input.quoter,
      data,
      requestOptions: { signal },
    });
    if (!response.data) throw new Error("Uniswap V4 Quoter returned empty response data.");
    const [amountOut, gasEstimate] = decodeFunctionResult({
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      data: response.data,
    });
    return { amountOut, gasEstimate };
  }

  async getTransactionCount(account: Address, signal?: AbortSignal): Promise<number> {
    abortIfNeeded(signal);
    return this.#client.getTransactionCount({ address: account, blockTag: "pending" });
  }

  async estimateFeesPerGas(signal?: AbortSignal): Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }> {
    abortIfNeeded(signal);
    const fees = await this.#client.estimateFeesPerGas({ type: "eip1559" });
    if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
      throw new Error("The provider did not return an EIP-1559 fee estimate.");
    }
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }

  async estimateGas(request: EvmCallRequest, signal?: AbortSignal): Promise<bigint> {
    abortIfNeeded(signal);
    return this.#client.estimateGas(request);
  }

  async call(request: EvmCallRequest, signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    await this.#client.call({ ...request, requestOptions: { signal } });
  }

  async getBlockNumber(signal?: AbortSignal): Promise<bigint> {
    abortIfNeeded(signal);
    return this.#client.getBlockNumber({ cacheTime: 0 });
  }

  async getFinalizedBlockNumber(signal?: AbortSignal): Promise<bigint | null> {
    abortIfNeeded(signal);
    try {
      const block = await this.#client.getBlock({ blockTag: "finalized", includeTransactions: false });
      return block.number;
    } catch {
      return null;
    }
  }

  async getReceipt(hash: Hex, signal?: AbortSignal): Promise<EvmReceipt | null> {
    abortIfNeeded(signal);
    try {
      const receipt = await this.#client.getTransactionReceipt({ hash });
      return {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        status: receipt.status,
      };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  }

  async getBlock(blockNumber: bigint, signal?: AbortSignal): Promise<EvmBlock> {
    abortIfNeeded(signal);
    const block = await this.#client.getBlock({ blockNumber, includeTransactions: true });
    if (!block.hash) throw new Error(`Block ${blockNumber} has no canonical hash.`);
    return {
      number: block.number,
      hash: block.hash,
      transactions: Object.freeze(block.transactions
        .filter((transaction): transaction is Exclude<typeof transaction, Hex> => typeof transaction !== "string")
        .map((transaction) => ({ hash: transaction.hash, from: transaction.from, nonce: transaction.nonce }))),
    };
  }
}

function requireAddress(value: string | undefined, label: string): Address {
  if (!value || !isAddress(value)) throw new Error(`${label} is not a valid EVM address.`);
  return getAddress(value);
}

function feeTier(attributes: QuoteRequest["event"]["attributes"]): number {
  const raw = attributes.feeTier ?? 3_000;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (![100, 500, 3_000, 10_000].includes(parsed)) {
    throw new Error("Uniswap V3 feeTier must be 100, 500, 3000, or 10000.");
  }
  return parsed;
}

function quotePriceImpactBps(inputAmount: bigint, outputAmount: bigint, probeInput: bigint, probeOutput: bigint): number {
  if (inputAmount <= 0n || outputAmount <= 0n || probeInput <= 0n || probeOutput <= 0n) return 10_000;
  const baselineOutput = (probeOutput * inputAmount) / probeInput;
  if (baselineOutput <= 0n || outputAmount >= baselineOutput) return 0;
  return Number(((baselineOutput - outputAmount) * 10_000n) / baselineOutput);
}

function minimumOutput(amountOut: bigint, maxSlippageBps: number): bigint {
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) {
    throw new Error("maxSlippageBps must be an integer from 0 to 10000.");
  }
  return amountOut * BigInt(10_000 - maxSlippageBps) / 10_000n;
}

function requestedVenue(attributes: QuoteRequest["event"]["attributes"]): EvmVenue | "auto" | undefined {
  const raw = attributes.resolvedVenue ?? attributes.venue;
  if (raw === undefined || raw === "") return undefined;
  const normalized = String(raw).toLowerCase().replace(/^uniswap[-_ ]?/, "");
  if (normalized === "auto") return "auto";
  if (normalized === "v2" || normalized === "2") return "v2";
  if (normalized === "v3" || normalized === "3") return "v3";
  if (normalized === "v4" || normalized === "4") return "v4";
  throw new Error(`Unsupported EVM venue ${String(raw)}. Expected auto, V2, V3, or V4.`);
}

function venueFromQuote(quote: Quote): EvmVenue | undefined {
  switch (quote.provider) {
    case "uniswap-v2-router-02": return "v2";
    case "uniswap-v3-quoter-v2": return "v3";
    case "uniswap-v4-quoter": return "v4";
    default: return undefined;
  }
}

function v2Path(
  attributes: QuoteRequest["event"]["attributes"],
  tokenIn: Address,
  tokenOut: Address,
  wrappedNative: Address,
): readonly Address[] {
  const raw = attributes.path;
  const values = raw === undefined
    ? [tokenIn, tokenOut]
    : String(raw).split(/[,>]/).map((value) => value.trim()).filter(Boolean).map((value) => requireAddress(value, "V2 path address"));
  if (values.length < 2 || values.length > 5) throw new Error("Uniswap V2 path must contain 2 to 5 addresses.");
  if (values[0]?.toLowerCase() !== tokenIn.toLowerCase() || values.at(-1)?.toLowerCase() !== tokenOut.toLowerCase()) {
    throw new Error("Uniswap V2 path endpoints must match tokenIn and tokenOut.");
  }
  const nativeInput = attributes.nativeInput === true;
  const nativeOutput = attributes.nativeOutput === true;
  if (nativeInput && nativeOutput) throw new Error("A V2 swap cannot use native ETH as both input and output.");
  if (nativeInput && values[0]?.toLowerCase() !== wrappedNative.toLowerCase()) {
    throw new Error("A native-input V2 path must start with the network wrapped-native token.");
  }
  if (nativeOutput && values.at(-1)?.toLowerCase() !== wrappedNative.toLowerCase()) {
    throw new Error("A native-output V2 path must end with the network wrapped-native token.");
  }
  return Object.freeze(values);
}

function tickSpacingAttribute(value: string | number | boolean | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32_767) {
    throw new Error("V4 tickSpacing must be an integer from 1 to 32767.");
  }
  return parsed;
}

function hexAttribute(value: string | number | boolean | undefined, label: string, fallback: Hex = "0x"): Hex {
  if (value === undefined || value === "") return fallback;
  const candidate = String(value);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(candidate)) throw new Error(`${label} must be even-length hex bytes.`);
  return candidate as Hex;
}

function v4Pool(input: QuoteRequest | Parameters<TransactionAdapter["build"]>[0]): {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly poolKey: V4PoolKey;
  readonly zeroForOne: boolean;
  readonly hookData: Hex;
} {
  const tokenIn = requireAddress(String(input.event.attributes.tokenIn ?? ""), "tokenIn");
  const tokenOut = requireAddress(input.event.target ?? String(input.event.attributes.tokenOut ?? ""), "tokenOut");
  const currencyIn = input.event.attributes.nativeInput === true ? zeroAddress : tokenIn;
  const currencyOut = input.event.attributes.nativeOutput === true ? zeroAddress : tokenOut;
  if (currencyIn.toLowerCase() === currencyOut.toLowerCase()) throw new Error("Uniswap V4 currencies must differ.");
  const currency0 = BigInt(currencyIn) < BigInt(currencyOut) ? currencyIn : currencyOut;
  const currency1 = currency0 === currencyIn ? currencyOut : currencyIn;
  const poolKey = Object.freeze({
    currency0,
    currency1,
    fee: feeTier(input.event.attributes),
    tickSpacing: tickSpacingAttribute(input.event.attributes.tickSpacing),
    hooks: input.event.attributes.hooks === undefined
      ? zeroAddress
      : requireAddress(String(input.event.attributes.hooks), "V4 hooks"),
  });
  return Object.freeze({
    tokenIn,
    tokenOut,
    poolKey,
    zeroForOne: currencyIn.toLowerCase() === currency0.toLowerCase(),
    hookData: hexAttribute(input.event.attributes.hookData, "V4 hookData"),
  });
}

export class UniswapV2QuoteAdapter implements QuoteAdapter {
  readonly id = "uniswap-v2-router-02";
  readonly networks: readonly ChainNetworkId[];
  readonly #rpc: EvmRpc;
  readonly #router?: Address;

  constructor(options: { readonly network: EvmNetworkId; readonly rpc: EvmRpc; readonly router?: Address }) {
    this.networks = Object.freeze([options.network]);
    this.#rpc = options.rpc;
    this.#router = options.router ?? EVM_DEPLOYMENTS[options.network].uniswapV2Router02;
  }

  async quote(request: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
    if (!this.#router) throw new Error(`Uniswap V2 Router02 is not officially configured for ${request.chain.name}.`);
    const tokenIn = requireAddress(String(request.event.attributes.tokenIn ?? ""), "tokenIn");
    const tokenOut = requireAddress(request.event.target ?? String(request.event.attributes.tokenOut ?? ""), "tokenOut");
    const wrappedNative = EVM_DEPLOYMENTS[request.chain.id as EvmNetworkId].wrappedNative;
    const path = v2Path(request.event.attributes, tokenIn, tokenOut, wrappedNative);
    const result = await this.#rpc.quoteV2ExactInput({ router: this.#router, amountIn: request.inputAmountAtomic, path }, signal);
    const probeInput = request.inputAmountAtomic > 1_000n ? request.inputAmountAtomic / 1_000n : 1n;
    const probe = probeInput === request.inputAmountAtomic
      ? result
      : await this.#rpc.quoteV2ExactInput({ router: this.#router, amountIn: probeInput, path }, signal);
    if (result.amountOut <= 0n) throw new Error("Uniswap V2 returned a zero-output quote.");
    const now = Date.now();
    return Object.freeze({
      id: `uniswap-v2:${path.join(":")}:${now}`,
      chain: request.chain,
      inputAmountAtomic: request.inputAmountAtomic,
      expectedOutputAmount: result.amountOut,
      minimumOutputAmount: minimumOutput(result.amountOut, request.rule.maxSlippageBps),
      priceImpactBps: quotePriceImpactBps(request.inputAmountAtomic, result.amountOut, probeInput, probe.amountOut),
      route: Object.freeze<string[]>([...path, "Uniswap V2 Router02"]),
      receivedAt: now,
      expiresAt: now + 12_000,
      provider: this.id,
    });
  }
}

export class UniswapV4QuoteAdapter implements QuoteAdapter {
  readonly id = "uniswap-v4-quoter";
  readonly networks: readonly ChainNetworkId[];
  readonly #rpc: EvmRpc;
  readonly #quoter: Address;

  constructor(options: { readonly network: EvmNetworkId; readonly rpc: EvmRpc; readonly quoter?: Address }) {
    this.networks = Object.freeze([options.network]);
    this.#rpc = options.rpc;
    this.#quoter = options.quoter ?? EVM_DEPLOYMENTS[options.network].v4Quoter;
  }

  async quote(request: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
    if (request.chain.family !== "evm") throw new Error("UniswapV4QuoteAdapter requires an EVM network.");
    const pool = v4Pool(request);
    const account = request.event.account ? requireAddress(request.event.account, "Wallet address") : undefined;
    const result = await this.#rpc.quoteV4ExactInputSingle({
      quoter: this.#quoter,
      account,
      poolKey: pool.poolKey,
      zeroForOne: pool.zeroForOne,
      amountIn: request.inputAmountAtomic,
      hookData: pool.hookData,
    }, signal);
    const probeInput = request.inputAmountAtomic > 1_000n ? request.inputAmountAtomic / 1_000n : 1n;
    const probe = probeInput === request.inputAmountAtomic
      ? result
      : await this.#rpc.quoteV4ExactInputSingle({
        quoter: this.#quoter,
        account,
        poolKey: pool.poolKey,
        zeroForOne: pool.zeroForOne,
        amountIn: probeInput,
        hookData: pool.hookData,
      }, signal);
    if (result.amountOut <= 0n) throw new Error("Uniswap V4 returned a zero-output quote.");
    const now = Date.now();
    return Object.freeze({
      id: `uniswap-v4:${pool.poolKey.currency0}:${pool.poolKey.currency1}:${pool.poolKey.fee}:${now}`,
      chain: request.chain,
      inputAmountAtomic: request.inputAmountAtomic,
      expectedOutputAmount: result.amountOut,
      minimumOutputAmount: minimumOutput(result.amountOut, request.rule.maxSlippageBps),
      priceImpactBps: quotePriceImpactBps(request.inputAmountAtomic, result.amountOut, probeInput, probe.amountOut),
      route: Object.freeze([`${pool.tokenIn} -> ${pool.tokenOut}`, `Uniswap V4 fee=${pool.poolKey.fee} tick=${pool.poolKey.tickSpacing}`]),
      receivedAt: now,
      expiresAt: now + 12_000,
      provider: this.id,
    });
  }
}

export class EvmVenueQuoteAdapter implements QuoteAdapter {
  readonly id = "evm-uniswap-v2-v3-v4-router";
  readonly networks: readonly ChainNetworkId[];
  readonly #venues: Readonly<Record<EvmVenue, QuoteAdapter>>;
  readonly #defaultVenue: EvmVenue;

  constructor(options: {
    readonly network: EvmNetworkId;
    readonly venues: Readonly<Record<EvmVenue, QuoteAdapter>>;
    readonly defaultVenue?: EvmVenue;
  }) {
    this.networks = Object.freeze([options.network]);
    this.#venues = options.venues;
    this.#defaultVenue = options.defaultVenue ?? "v3";
  }

  async quote(request: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
    const selected = requestedVenue(request.event.attributes);
    if (selected && selected !== "auto") return this.#venues[selected].quote(request, signal);
    if (selected === undefined) return this.#venues[this.#defaultVenue].quote(request, signal);

    const attempts = (Object.entries(this.#venues) as [EvmVenue, QuoteAdapter][]).map(async ([venue, adapter]) => {
      try {
        return { venue, quote: await adapter.quote(request, signal) };
      } catch (error) {
        return { venue, error: errorMessage(error) };
      }
    });
    const results = await Promise.all(attempts);
    const viable = results.filter((result): result is { venue: EvmVenue; quote: Quote } => "quote" in result)
      .map((result) => result.quote)
      .toSorted((left, right) => left.expectedOutputAmount > right.expectedOutputAmount ? -1 : left.expectedOutputAmount < right.expectedOutputAmount ? 1 : 0);
    const best = viable[0];
    if (!best) {
      throw new Error(`No Uniswap venue returned a valid quote: ${results.map((result) => `${result.venue}=${"error" in result ? result.error : "unavailable"}`).join("; ")}`);
    }
    return best;
  }
}

export class UniswapV3QuoteAdapter implements QuoteAdapter {
  readonly id = "uniswap-v3-quoter-v2";
  readonly networks: readonly ChainNetworkId[];
  readonly #rpc: EvmRpc;
  readonly #quoter: Address;

  constructor(options: { readonly network: EvmNetworkId; readonly rpc: EvmRpc; readonly quoter?: Address }) {
    this.networks = Object.freeze([options.network]);
    this.#rpc = options.rpc;
    this.#quoter = options.quoter ?? EVM_DEPLOYMENTS[options.network].quoterV2;
  }

  async quote(request: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
    if (request.chain.family !== "evm") throw new Error("UniswapV3QuoteAdapter requires an EVM network.");
    const tokenIn = requireAddress(String(request.event.attributes.tokenIn ?? ""), "tokenIn");
    const tokenOut = requireAddress(request.event.target ?? String(request.event.attributes.tokenOut ?? ""), "tokenOut");
    const accountValue = request.event.account;
    const account = accountValue ? requireAddress(accountValue, "Wallet address") : undefined;
    const fee = feeTier(request.event.attributes);
    const quote = await this.#rpc.quoteExactInputSingle({
      quoter: this.#quoter,
      account,
      tokenIn,
      tokenOut,
      amountIn: request.inputAmountAtomic,
      fee,
    }, signal);
    const probeInput = request.inputAmountAtomic > 1_000n ? request.inputAmountAtomic / 1_000n : 1n;
    const probe = probeInput === request.inputAmountAtomic
      ? quote
      : await this.#rpc.quoteExactInputSingle({
        quoter: this.#quoter,
        account,
        tokenIn,
        tokenOut,
        amountIn: probeInput,
        fee,
      }, signal);
    if (quote.amountOut <= 0n) throw new Error("Uniswap returned a zero-output quote.");
    const now = Date.now();
    const minimumOutputAmount = minimumOutput(quote.amountOut, request.rule.maxSlippageBps);
    return Object.freeze({
      id: `uniswap:${tokenIn}:${tokenOut}:${fee}:${now}`,
      chain: request.chain,
      inputAmountAtomic: request.inputAmountAtomic,
      expectedOutputAmount: quote.amountOut,
      minimumOutputAmount,
      priceImpactBps: quotePriceImpactBps(request.inputAmountAtomic, quote.amountOut, probeInput, probe.amountOut),
      route: Object.freeze([`${tokenIn} -> ${tokenOut}`, `Uniswap V3 ${fee / 10_000}%`]),
      receivedAt: now,
      expiresAt: now + 12_000,
      provider: this.id,
    });
  }
}

interface SerializedEvmDraft {
  readonly account: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: string;
  readonly gas: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly nonce: number;
  readonly builtAtBlock: string;
}

function parseSerializedDraft(transaction: TransactionDraft): SerializedEvmDraft {
  const parsed: unknown = JSON.parse(transaction.unsignedPayload);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid EVM transaction payload.");
  const candidate = parsed as Partial<Record<keyof SerializedEvmDraft, unknown>>;
  if (
    typeof candidate.account !== "string"
    || typeof candidate.to !== "string"
    || typeof candidate.data !== "string"
    || typeof candidate.value !== "string"
    || typeof candidate.gas !== "string"
    || typeof candidate.maxFeePerGas !== "string"
    || typeof candidate.maxPriorityFeePerGas !== "string"
    || typeof candidate.nonce !== "number"
    || typeof candidate.builtAtBlock !== "string"
  ) throw new Error("Incomplete EVM transaction payload.");
  return {
    account: requireAddress(candidate.account, "account"),
    to: requireAddress(candidate.to, "router"),
    data: candidate.data as Hex,
    value: candidate.value,
    gas: candidate.gas,
    maxFeePerGas: candidate.maxFeePerGas,
    maxPriorityFeePerGas: candidate.maxPriorityFeePerGas,
    nonce: candidate.nonce,
    builtAtBlock: candidate.builtAtBlock,
  };
}

function bump(value: bigint, basisPoints: number): bigint {
  return value + (value * BigInt(Math.max(1, basisPoints)) + 9_999n) / 10_000n;
}

async function buildEvmDraft(options: {
  readonly input: Parameters<TransactionAdapter["build"]>[0];
  readonly rpc: EvmRpc;
  readonly account: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly action: string;
  readonly accounts: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<TransactionDraft> {
  const { input, rpc, account, to, data, value, action, accounts, signal } = options;
  if (input.chain.family !== "evm" || input.feePolicy.kind !== "eip1559") {
    throw new Error("EVM transaction construction requires an EIP-1559 fee policy.");
  }
  const previousFee = input.previous?.feePolicy.kind === "eip1559" ? input.previous.feePolicy : undefined;
  const networkFees = await rpc.estimateFeesPerGas(signal);
  const requested = input.feePolicy;
  let maxFeePerGas = requested.maxFeePerGas > 0n ? requested.maxFeePerGas : networkFees.maxFeePerGas;
  let maxPriorityFeePerGas = requested.maxPriorityFeePerGas > 0n
    ? requested.maxPriorityFeePerGas
    : networkFees.maxPriorityFeePerGas;
  if (previousFee) {
    const replacementBumpBps = Math.max(1_250, requested.replacementBumpBps);
    maxFeePerGas = [maxFeePerGas, bump(previousFee.maxFeePerGas, replacementBumpBps)].toSorted((left, right) => left < right ? 1 : -1)[0] ?? maxFeePerGas;
    maxPriorityFeePerGas = [maxPriorityFeePerGas, bump(previousFee.maxPriorityFeePerGas, replacementBumpBps)].toSorted((left, right) => left < right ? 1 : -1)[0] ?? maxPriorityFeePerGas;
  }
  if (maxPriorityFeePerGas <= 0n || maxFeePerGas < maxPriorityFeePerGas) {
    throw new Error("EIP-1559 fees require maxFeePerGas >= maxPriorityFeePerGas > 0.");
  }
  const previousLifetime = input.previous?.lifetime.kind === "evm-nonce" ? input.previous.lifetime : undefined;
  const nonce = previousLifetime?.nonce ?? await rpc.getTransactionCount(account, signal);
  const estimateRequest: EvmCallRequest = { account, to, data, value, maxFeePerGas, maxPriorityFeePerGas, nonce };
  const estimatedGas = await rpc.estimateGas(estimateRequest, signal);
  const requestedGas = requested.gasLimit > 0n ? requested.gasLimit : estimatedGas * 120n / 100n;
  if (requestedGas < estimatedGas) throw new Error(`Configured gas limit ${requestedGas} is below estimate ${estimatedGas}.`);
  const builtAtBlock = await rpc.getBlockNumber(signal);
  const feePolicy: EvmFeePolicy = Object.freeze({
    kind: "eip1559",
    gasLimit: requestedGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    replacementBumpBps: Math.max(1_250, requested.replacementBumpBps),
  });
  const payload: SerializedEvmDraft = {
    account,
    to,
    data,
    value: value.toString(),
    gas: requestedGas.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    nonce,
    builtAtBlock: builtAtBlock.toString(),
  };
  return Object.freeze({
    idempotencyKey: input.idempotencyKey,
    chain: input.chain,
    eventId: input.event.id,
    quoteId: input.quote.id,
    lifetime: Object.freeze({
      kind: "evm-nonce",
      nonce,
      validUntilBlock: builtAtBlock + 25n,
      replacementOf: previousLifetime ? input.previous?.idempotencyKey : undefined,
    }),
    feePolicy,
    instructions: Object.freeze([Object.freeze({
      program: to,
      action,
      accounts: Object.freeze([...accounts]),
      dataDigest: keccak256(data),
    })]),
    unsignedPayload: JSON.stringify(payload),
    createdAt: Date.now(),
  });
}

async function simulateEvmDraft(rpc: EvmRpc, transaction: TransactionDraft, signal?: AbortSignal): Promise<SimulationResult> {
  if (transaction.chain.family !== "evm" || transaction.feePolicy.kind !== "eip1559") {
    throw new Error("Expected an EIP-1559 transaction.");
  }
  const payload = parseSerializedDraft(transaction);
  const request: EvmCallRequest = {
    account: payload.account,
    to: payload.to,
    data: payload.data,
    value: BigInt(payload.value),
    gas: BigInt(payload.gas),
    maxFeePerGas: BigInt(payload.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(payload.maxPriorityFeePerGas),
    nonce: payload.nonce,
  };
  try {
    await rpc.call(request, signal);
    const estimatedGas = await rpc.estimateGas(request, signal);
    return Object.freeze({
      ok: true,
      simulatedAt: Date.now(),
      unitsConsumed: estimatedGas,
      estimatedFeeAtomic: estimatedGas * transaction.feePolicy.maxFeePerGas,
      logs: Object.freeze(["eth_call passed", `estimateGas=${estimatedGas}`]),
      accountDiff: Object.freeze({}),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      simulatedAt: Date.now(),
      unitsConsumed: 0n,
      estimatedFeeAtomic: 0n,
      logs: Object.freeze([]),
      accountDiff: Object.freeze({}),
      error: errorMessage(error),
    });
  }
}

export class UniswapV3TransactionAdapter implements TransactionAdapter {
  readonly id = "uniswap-v3-swap-router-02";
  readonly networks: readonly ChainNetworkId[];
  readonly #rpc: EvmRpc;
  readonly #router: Address;

  constructor(options: { readonly network: EvmNetworkId; readonly rpc: EvmRpc; readonly router?: Address }) {
    this.networks = Object.freeze([options.network]);
    this.#rpc = options.rpc;
    this.#router = options.router ?? EVM_DEPLOYMENTS[options.network].swapRouter02;
  }

  async build(input: Parameters<TransactionAdapter["build"]>[0], signal?: AbortSignal): Promise<TransactionDraft> {
    if (input.chain.family !== "evm" || input.feePolicy.kind !== "eip1559") {
      throw new Error("UniswapV3TransactionAdapter requires an EIP-1559 transaction.");
    }
    const account = requireAddress(input.event.account, "Wallet address");
    const tokenIn = requireAddress(String(input.event.attributes.tokenIn ?? ""), "tokenIn");
    const tokenOut = requireAddress(input.event.target ?? String(input.event.attributes.tokenOut ?? ""), "tokenOut");
    const data = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn,
        tokenOut,
        fee: feeTier(input.event.attributes),
        recipient: account,
        amountIn: input.quote.inputAmountAtomic,
        amountOutMinimum: input.quote.minimumOutputAmount,
        sqrtPriceLimitX96: 0n,
      }],
    });
    const value = tokenIn.toLowerCase() === EVM_DEPLOYMENTS[input.chain.id as EvmNetworkId].wrappedNative.toLowerCase()
      && input.event.attributes.nativeInput === true
      ? input.quote.inputAmountAtomic
      : 0n;
    return buildEvmDraft({ input, rpc: this.#rpc, account, to: this.#router, data, value, action: "uniswap-v3-exact-input-single", accounts: [account, tokenIn, tokenOut], signal });
  }

  async simulate(transaction: TransactionDraft, signal?: AbortSignal): Promise<SimulationResult> {
    return simulateEvmDraft(this.#rpc, transaction, signal);
  }
}

function deadlineSeconds(attributes: QuoteRequest["event"]["attributes"]): bigint {
  const requested = Number(attributes.deadlineSeconds ?? 180);
  if (!Number.isSafeInteger(requested) || requested < 30 || requested > 1_800) {
    throw new Error("EVM swap deadlineSeconds must be an integer from 30 to 1800.");
  }
  return BigInt(Math.floor(Date.now() / 1_000) + requested);
}

export class UniswapV2TransactionAdapter implements TransactionAdapter {
  readonly id = "uniswap-v2-router-02";
  readonly networks: readonly ChainNetworkId[];
  readonly #rpc: EvmRpc;
  readonly #router?: Address;

  constructor(options: { readonly network: EvmNetworkId; readonly rpc: EvmRpc; readonly router?: Address }) {
    this.networks = Object.freeze([options.network]);
    this.#rpc = options.rpc;
    this.#router = options.router ?? EVM_DEPLOYMENTS[options.network].uniswapV2Router02;
  }

  async build(input: Parameters<TransactionAdapter["build"]>[0], signal?: AbortSignal): Promise<TransactionDraft> {
    if (!this.#router) throw new Error(`Uniswap V2 Router02 is not officially configured for ${input.chain.name}.`);
    if (input.chain.family !== "evm" || input.feePolicy.kind !== "eip1559") {
      throw new Error("UniswapV2TransactionAdapter requires an EIP-1559 transaction.");
    }
    const account = requireAddress(input.event.account, "Wallet address");
    const tokenIn = requireAddress(String(input.event.attributes.tokenIn ?? ""), "tokenIn");
    const tokenOut = requireAddress(input.event.target ?? String(input.event.attributes.tokenOut ?? ""), "tokenOut");
    const wrappedNative = EVM_DEPLOYMENTS[input.chain.id as EvmNetworkId].wrappedNative;
    const path = v2Path(input.event.attributes, tokenIn, tokenOut, wrappedNative);
    const deadline = deadlineSeconds(input.event.attributes);
    const nativeInput = input.event.attributes.nativeInput === true;
    const nativeOutput = input.event.attributes.nativeOutput === true;
    const data = nativeInput
      ? encodeFunctionData({
        abi: UNISWAP_V2_ROUTER_02_ABI,
        functionName: "swapExactETHForTokens",
        args: [input.quote.minimumOutputAmount, [...path], account, deadline],
      })
      : nativeOutput
        ? encodeFunctionData({
          abi: UNISWAP_V2_ROUTER_02_ABI,
          functionName: "swapExactTokensForETH",
          args: [input.quote.inputAmountAtomic, input.quote.minimumOutputAmount, [...path], account, deadline],
        })
        : encodeFunctionData({
          abi: UNISWAP_V2_ROUTER_02_ABI,
          functionName: "swapExactTokensForTokens",
          args: [input.quote.inputAmountAtomic, input.quote.minimumOutputAmount, [...path], account, deadline],
        });
    return buildEvmDraft({
      input,
      rpc: this.#rpc,
      account,
      to: this.#router,
      data,
      value: nativeInput ? input.quote.inputAmountAtomic : 0n,
      action: nativeInput ? "uniswap-v2-exact-eth-for-tokens" : nativeOutput ? "uniswap-v2-exact-tokens-for-eth" : "uniswap-v2-exact-tokens-for-tokens",
      accounts: [account, ...path],
      signal,
    });
  }

  simulate(transaction: TransactionDraft, signal?: AbortSignal): Promise<SimulationResult> {
    return simulateEvmDraft(this.#rpc, transaction, signal);
  }
}

const V4_SWAP_PARAM = [{
  type: "tuple",
  name: "params",
  components: [
    {
      type: "tuple",
      name: "poolKey",
      components: [
        { type: "address", name: "currency0" },
        { type: "address", name: "currency1" },
        { type: "uint24", name: "fee" },
        { type: "int24", name: "tickSpacing" },
        { type: "address", name: "hooks" },
      ],
    },
    { type: "bool", name: "zeroForOne" },
    { type: "uint128", name: "amountIn" },
    { type: "uint128", name: "amountOutMinimum" },
    { type: "uint256", name: "minHopPriceX36" },
    { type: "bytes", name: "hookData" },
  ],
}] as const;

export class UniswapV4TransactionAdapter implements TransactionAdapter {
  readonly id = "uniswap-v4-universal-router";
  readonly networks: readonly ChainNetworkId[];
  readonly #rpc: EvmRpc;
  readonly #router: Address;

  constructor(options: { readonly network: EvmNetworkId; readonly rpc: EvmRpc; readonly router?: Address }) {
    this.networks = Object.freeze([options.network]);
    this.#rpc = options.rpc;
    this.#router = options.router ?? EVM_DEPLOYMENTS[options.network].universalRouter;
  }

  async build(input: Parameters<TransactionAdapter["build"]>[0], signal?: AbortSignal): Promise<TransactionDraft> {
    if (input.chain.family !== "evm" || input.feePolicy.kind !== "eip1559") {
      throw new Error("UniswapV4TransactionAdapter requires an EIP-1559 transaction.");
    }
    if (input.quote.inputAmountAtomic > (1n << 128n) - 1n || input.quote.minimumOutputAmount > (1n << 128n) - 1n) {
      throw new Error("Uniswap V4 exact input/output minimum exceeds uint128.");
    }
    const account = requireAddress(input.event.account, "Wallet address");
    const pool = v4Pool(input);
    const swapInput = encodeAbiParameters(V4_SWAP_PARAM, [{
      poolKey: pool.poolKey,
      zeroForOne: pool.zeroForOne,
      amountIn: input.quote.inputAmountAtomic,
      amountOutMinimum: input.quote.minimumOutputAmount,
      minHopPriceX36: 0n,
      hookData: pool.hookData,
    }]);
    const currencyIn = pool.zeroForOne ? pool.poolKey.currency0 : pool.poolKey.currency1;
    const currencyOut = pool.zeroForOne ? pool.poolKey.currency1 : pool.poolKey.currency0;
    const settleInput = encodeAbiParameters(
      [{ type: "address", name: "currency" }, { type: "uint256", name: "amount" }],
      [currencyIn, input.quote.inputAmountAtomic],
    );
    const takeInput = encodeAbiParameters(
      [{ type: "address", name: "currency" }, { type: "uint256", name: "minimumAmount" }],
      [currencyOut, input.quote.minimumOutputAmount],
    );
    const v4CommandInput = encodeAbiParameters(
      [{ type: "bytes", name: "actions" }, { type: "bytes[]", name: "params" }],
      ["0x060c0f", [swapInput, settleInput, takeInput]],
    );
    const data = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: ["0x10", [v4CommandInput], deadlineSeconds(input.event.attributes)],
    });
    const nativeInput = currencyIn.toLowerCase() === zeroAddress;
    return buildEvmDraft({
      input,
      rpc: this.#rpc,
      account,
      to: this.#router,
      data,
      value: nativeInput ? input.quote.inputAmountAtomic : 0n,
      action: "uniswap-v4-exact-input-single",
      accounts: [account, pool.tokenIn, pool.tokenOut, pool.poolKey.hooks],
      signal,
    });
  }

  simulate(transaction: TransactionDraft, signal?: AbortSignal): Promise<SimulationResult> {
    return simulateEvmDraft(this.#rpc, transaction, signal);
  }
}

export class EvmVenueTransactionAdapter implements TransactionAdapter {
  readonly id = "evm-uniswap-v2-v3-v4-transaction-router";
  readonly networks: readonly ChainNetworkId[];
  readonly #venues: Readonly<Record<EvmVenue, TransactionAdapter>>;
  readonly #defaultVenue: EvmVenue;

  constructor(options: {
    readonly network: EvmNetworkId;
    readonly venues: Readonly<Record<EvmVenue, TransactionAdapter>>;
    readonly defaultVenue?: EvmVenue;
  }) {
    this.networks = Object.freeze([options.network]);
    this.#venues = options.venues;
    this.#defaultVenue = options.defaultVenue ?? "v3";
  }

  build(input: Parameters<TransactionAdapter["build"]>[0], signal?: AbortSignal): Promise<TransactionDraft> {
    const requested = requestedVenue(input.event.attributes);
    const quoted = venueFromQuote(input.quote);
    const selected = requested === undefined ? quoted ?? this.#defaultVenue : requested === "auto" ? quoted : requested;
    if (!selected) throw new Error("Auto venue quote did not identify a V2, V3, or V4 transaction adapter.");
    if (quoted && requested && requested !== "auto" && quoted !== requested) {
      throw new Error(`Quote venue ${quoted} does not match requested venue ${requested}.`);
    }
    return this.#venues[selected].build(input, signal);
  }

  simulate(transaction: TransactionDraft, signal?: AbortSignal): Promise<SimulationResult> {
    const action = transaction.instructions[0]?.action ?? "";
    const venue: EvmVenue = action.includes("v2") ? "v2" : action.includes("v4") ? "v4" : "v3";
    return this.#venues[venue].simulate(transaction, signal);
  }
}

export class CallbackEvmWalletAdapter implements WalletAdapter {
  readonly id: string;
  readonly kind: WalletAdapter["kind"];
  readonly networks: readonly ChainNetworkId[];
  readonly #sign: (transaction: TransactionDraft, signal?: AbortSignal) => Promise<SignedTransaction>;

  constructor(options: {
    readonly id: string;
    readonly kind: "eip1193" | "encrypted-external";
    readonly networks: readonly EvmNetworkId[];
    readonly sign: (transaction: TransactionDraft, signal?: AbortSignal) => Promise<SignedTransaction>;
  }) {
    this.id = options.id;
    this.kind = options.kind;
    this.networks = Object.freeze([...options.networks]);
    this.#sign = options.sign;
  }

  sign(transaction: TransactionDraft, signal?: AbortSignal): Promise<SignedTransaction> {
    return this.#sign(transaction, signal);
  }
}

export class EvmConfirmationAdapter implements ConfirmationAdapter {
  readonly id = "evm-receipt-finality";
  readonly networks: readonly ChainNetworkId[];
  readonly #rpc: EvmRpc;
  readonly #confirmations: bigint;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly network: EvmNetworkId;
    readonly rpc: EvmRpc;
    readonly confirmations?: number;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
  }) {
    this.networks = Object.freeze([options.network]);
    this.#rpc = options.rpc;
    this.#confirmations = BigInt(Math.max(1, options.confirmations ?? 2));
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async track(transaction: SignedTransaction, signal?: AbortSignal): Promise<ConfirmationResult> {
    if (transaction.draft.lifetime.kind !== "evm-nonce") {
      throw new Error("EvmConfirmationAdapter requires an EVM nonce lifetime.");
    }
    const lifetime = transaction.draft.lifetime;
    const payload = parseSerializedDraft(transaction.draft);
    const observations: ConfirmationObservation[] = [{
      state: "submitted",
      observedAt: Date.now(),
      transactionHash: transaction.signature,
    }];
    let trackedHash = transaction.signature as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(trackedHash)) {
      return {
        confirmed: false,
        state: "failed",
        signature: transaction.signature,
        observations,
        finishedAt: Date.now(),
        error: "The EVM signer did not return a 32-byte transaction hash.",
      };
    }
    let lastScannedBlock = BigInt(payload.builtAtBlock) - 1n;
    let canonicalReceipt: EvmReceipt | null = null;
    const startedAt = Date.now();
    while (!signal?.aborted && Date.now() - startedAt < this.#timeoutMs) {
      const head = await this.#rpc.getBlockNumber(signal);
      const receipt = await this.#rpc.getReceipt(trackedHash, signal);
      if (receipt) {
        if (receipt.status === "reverted") {
          observations.push({ state: "failed", observedAt: Date.now(), blockOrSlot: receipt.blockNumber, blockHash: receipt.blockHash, transactionHash: receipt.transactionHash, error: "Transaction execution reverted." });
          return { confirmed: false, state: "failed", signature: trackedHash, observations, finishedAt: Date.now(), error: "Transaction receipt status is reverted." };
        }
        if (canonicalReceipt && (canonicalReceipt.blockHash !== receipt.blockHash || canonicalReceipt.blockNumber !== receipt.blockNumber)) {
          observations.push({ state: "reorged", observedAt: Date.now(), transactionHash: trackedHash, blockOrSlot: receipt.blockNumber, blockHash: receipt.blockHash });
          return { confirmed: false, state: "reorged", signature: trackedHash, observations, finishedAt: Date.now(), error: "Receipt moved to a different block during confirmation." };
        }
        canonicalReceipt = receipt;
        const canonicalBlock = await this.#rpc.getBlock(receipt.blockNumber, signal);
        if (canonicalBlock.hash !== receipt.blockHash) {
          observations.push({ state: "reorged", observedAt: Date.now(), transactionHash: trackedHash, blockOrSlot: receipt.blockNumber, blockHash: receipt.blockHash });
          return { confirmed: false, state: "reorged", signature: trackedHash, observations, finishedAt: Date.now(), error: "Receipt block is not canonical." };
        }
        const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
        if (confirmations >= this.#confirmations) {
          const finalizedBlock = await this.#rpc.getFinalizedBlockNumber(signal);
          const state = finalizedBlock !== null && finalizedBlock >= receipt.blockNumber ? "finalized" : "confirmed";
          observations.push({ state, observedAt: Date.now(), transactionHash: trackedHash, blockOrSlot: receipt.blockNumber, blockHash: receipt.blockHash });
          return { confirmed: true, state, signature: trackedHash, observations, finishedAt: Date.now() };
        }
        observations.push({ state: "processed", observedAt: Date.now(), transactionHash: trackedHash, blockOrSlot: receipt.blockNumber, blockHash: receipt.blockHash });
      } else if (canonicalReceipt) {
        observations.push({ state: "reorged", observedAt: Date.now(), transactionHash: trackedHash, blockOrSlot: canonicalReceipt.blockNumber, blockHash: canonicalReceipt.blockHash });
        return { confirmed: false, state: "reorged", signature: trackedHash, observations, finishedAt: Date.now(), error: "Previously observed receipt disappeared during confirmation." };
      }

      const scanThrough = head;
      for (let blockNumber = lastScannedBlock + 1n; blockNumber <= scanThrough; blockNumber += 1n) {
        const block = await this.#rpc.getBlock(blockNumber, signal);
        const replacement = block.transactions.find((candidate) =>
          candidate.from.toLowerCase() === payload.account.toLowerCase()
          && candidate.nonce === lifetime.nonce
          && candidate.hash.toLowerCase() !== trackedHash.toLowerCase());
        if (replacement) {
          observations.push({ state: "replaced", observedAt: Date.now(), transactionHash: trackedHash, replacementHash: replacement.hash, blockOrSlot: blockNumber, blockHash: block.hash });
          trackedHash = replacement.hash;
        }
      }
      lastScannedBlock = scanThrough;
      if (lifetime.validUntilBlock !== undefined && head > lifetime.validUntilBlock && !canonicalReceipt) {
        observations.push({ state: "expired", observedAt: Date.now(), transactionHash: trackedHash, blockOrSlot: head });
        return { confirmed: false, state: "expired", signature: trackedHash, observations, finishedAt: Date.now(), error: "No receipt before the bounded EVM validity window elapsed." };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.#pollIntervalMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Operation aborted", "AbortError"));
        }, { once: true });
      });
    }
    return {
      confirmed: false,
      state: "submitted",
      signature: trackedHash,
      observations,
      finishedAt: Date.now(),
      error: signal?.aborted ? "Confirmation aborted." : "Confirmation timed out before a canonical receipt reached the required depth.",
    };
  }
}

export class FlashbotsProtectRelayAdapter implements RelayAdapter {
  readonly id = "flashbots-protect";
  readonly kind = "flashbots-protect" as const;
  readonly networks: readonly ChainNetworkId[];
  readonly #endpoint?: string;
  readonly #authHeader?: (body: string) => Promise<string>;
  readonly #fetcher: typeof fetch;
  readonly #timeoutMs: number;
  #latencyMs = 250;
  #successes = 0;
  #failures = 0;
  #lastSuccessAt?: number;

  constructor(options: {
    readonly network: EvmNetworkId;
    readonly endpoint?: string;
    readonly authHeader?: (body: string) => Promise<string>;
    readonly fetcher?: typeof fetch;
    readonly timeoutMs?: number;
  }) {
    this.networks = Object.freeze([options.network]);
    this.#endpoint = options.endpoint;
    this.#authHeader = options.authHeader;
    this.#fetcher = options.fetcher ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  health(): RelayHealth {
    const attempts = this.#successes + this.#failures;
    return Object.freeze({
      relayId: this.id,
      kind: this.kind,
      networks: this.networks,
      enabled: Boolean(this.#endpoint),
      latencyMs: this.#latencyMs,
      failureRate: attempts === 0 ? 0 : this.#failures / attempts,
      lastSuccessAt: this.#lastSuccessAt,
      reason: this.#endpoint ? undefined : "endpoint-unconfigured",
    });
  }

  async submit(transaction: SignedTransaction, signal?: AbortSignal): Promise<RelayReceipt> {
    if (!this.#endpoint) return { relayId: this.id, kind: this.kind, accepted: false, latencyMs: 0, error: "endpoint-unconfigured" };
    if (!/^0x[0-9a-fA-F]+$/.test(transaction.wireTransaction)) {
      return { relayId: this.id, kind: this.kind, accepted: false, latencyMs: 0, error: "A signed raw EVM transaction is required." };
    }
    const usePrivateMethod = Boolean(this.#authHeader);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: transaction.draft.idempotencyKey,
      method: usePrivateMethod ? "eth_sendPrivateTransaction" : "eth_sendRawTransaction",
      params: usePrivateMethod
        ? [{ tx: transaction.wireTransaction, preferences: { fast: true } }]
        : [transaction.wireTransaction],
    });
    const startedAt = performance.now();
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.#authHeader) headers["x-flashbots-signature"] = await this.#authHeader(body);
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await this.#fetcher(this.#endpoint, { method: "POST", headers, body, signal: requestSignal });
      const latencyMs = performance.now() - startedAt;
      this.#latencyMs = this.#latencyMs * 0.7 + latencyMs * 0.3;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { readonly result?: string; readonly error?: { readonly message?: string } };
      if (payload.error) throw new Error(payload.error.message ?? "Flashbots JSON-RPC error");
      this.#successes += 1;
      this.#lastSuccessAt = Date.now();
      return { relayId: this.id, kind: this.kind, accepted: true, acceptedAt: Date.now(), latencyMs, responseId: payload.result };
    } catch (error) {
      this.#failures += 1;
      const name = error instanceof Error ? error.name : "RelayError";
      const detail = errorMessage(error)
        .replace(/https?:\/\/[^\s)\]}]+/giu, "[redacted-endpoint]")
        .replace(/\b(token|key|auth|signature)=([^&\s]+)/giu, "$1=[redacted]")
        .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]");
      return { relayId: this.id, kind: this.kind, accepted: false, latencyMs: performance.now() - startedAt, error: `${name}: ${detail}`.slice(0, 512) };
    }
  }
}

export interface EvmAdapterConfig {
  readonly network: EvmNetworkId;
  readonly rpcUrl: string;
  readonly wallet: WalletAdapter;
  readonly rpc?: EvmRpc;
  readonly uniswapV2Router?: Address;
  readonly quoter?: Address;
  readonly v4Quoter?: Address;
  readonly router?: Address;
  readonly universalRouter?: Address;
  readonly defaultVenue?: EvmVenue;
  readonly flashbotsEndpoint?: string;
  readonly flashbotsAuthHeader?: (body: string) => Promise<string>;
  readonly enableFlashbotsProtect?: boolean;
  readonly confirmationDepth?: number;
  readonly confirmationTimeoutMs?: number;
}

export function createEvmRelayAdapters(config: Pick<EvmAdapterConfig, "network" | "rpcUrl" | "flashbotsEndpoint" | "flashbotsAuthHeader" | "enableFlashbotsProtect">): readonly RelayAdapter[] {
  const flashbotsEndpoint = config.enableFlashbotsProtect
    ? config.flashbotsEndpoint ?? EVM_DEPLOYMENTS[config.network].flashbotsProtect
    : config.flashbotsEndpoint;
  return Object.freeze([
    new HttpRelayAdapter({
      id: "evm-standard-rpc",
      kind: "evm-rpc",
      networks: [config.network],
      endpoint: config.rpcUrl,
      rpcMethod: "eth_sendRawTransaction",
    }),
    new FlashbotsProtectRelayAdapter({
      network: config.network,
      endpoint: flashbotsEndpoint,
      authHeader: config.flashbotsAuthHeader,
    }),
  ]);
}

export function createEvmChainAdapter(config: EvmAdapterConfig): ChainAdapter {
  const rpc = config.rpc ?? new ViemEvmRpc(config.network, config.rpcUrl);
  const quoteVenues = Object.freeze({
    v2: new UniswapV2QuoteAdapter({ network: config.network, rpc, router: config.uniswapV2Router }),
    v3: new UniswapV3QuoteAdapter({ network: config.network, rpc, quoter: config.quoter }),
    v4: new UniswapV4QuoteAdapter({ network: config.network, rpc, quoter: config.v4Quoter }),
  });
  const transactionVenues = Object.freeze({
    v2: new UniswapV2TransactionAdapter({ network: config.network, rpc, router: config.uniswapV2Router }),
    v3: new UniswapV3TransactionAdapter({ network: config.network, rpc, router: config.router }),
    v4: new UniswapV4TransactionAdapter({ network: config.network, rpc, router: config.universalRouter }),
  });
  return Object.freeze({
    chain: CHAIN_DESCRIPTORS[config.network],
    quote: new EvmVenueQuoteAdapter({ network: config.network, venues: quoteVenues, defaultVenue: config.defaultVenue }),
    transaction: new EvmVenueTransactionAdapter({ network: config.network, venues: transactionVenues, defaultVenue: config.defaultVenue }),
    wallet: config.wallet,
    relays: new HealthWeightedRelayRouter(createEvmRelayAdapters(config)),
    confirmation: new EvmConfirmationAdapter({
      network: config.network,
      rpc,
      confirmations: config.confirmationDepth,
      timeoutMs: config.confirmationTimeoutMs,
    }),
  });
}

export function rawTransactionHash(rawTransaction: Hex): Hex {
  return keccak256(rawTransaction);
}

export function flashbotsAuthDigest(body: string): Hex {
  return keccak256(stringToHex(body));
}
