import BN from "bn.js";
import {
  getBuyTokenAmountFromSolAmount,
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PumpSdk,
} from "@pump-fun/pump-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  CHAIN_DESCRIPTORS,
  HealthWeightedRelayRouter,
  SolanaConfirmationAdapter,
  createSolanaRelayAdapters,
  type ChainAdapter,
  type ChainLifetime,
  type ChainNetworkId,
  type ConfirmationRpc,
  type Quote,
  type QuoteAdapter,
  type QuoteRequest,
  type SignedTransaction,
  type SimulationResult,
  type TransactionAdapter,
  type TransactionDraft,
  type WalletAdapter,
} from "../../sniper-engine/src/index.js";

export { PumpProgramEventSource } from "./pump-event-source.js";

export const PUMP_PROGRAM_ADDRESS = PUMP_PROGRAM_ID.toBase58();
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

export interface SolanaAdapterConfig {
  readonly network: "solana:devnet" | "solana:mainnet";
  readonly rpcUrl: string;
  readonly websocketUrl?: string;
  readonly wallet: WalletAdapter;
  readonly jitoEndpoint?: string;
  readonly jitoAuthorization?: string;
  readonly nozomiEndpoint?: string;
  readonly zeroSlotEndpoint?: string;
  readonly relayTipRecipient?: string;
  readonly confirmationTimeoutMs?: number;
}

function assertSolanaNetwork(network: ChainNetworkId): asserts network is SolanaAdapterConfig["network"] {
  if (network !== "solana:devnet" && network !== "solana:mainnet") {
    throw new Error(`Expected a Solana network, received ${network}.`);
  }
}

function requirePublicKey(value: string | undefined, label: string): PublicKey {
  if (!value) throw new Error(`${label} is required.`);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Solana address.`);
  }
}

function priceImpactBps(input: BN, output: BN, probeInput: BN, probeOutput: BN): number {
  if (input.isZero() || output.isZero() || probeInput.isZero() || probeOutput.isZero()) return 10_000;
  const baselineOutput = probeOutput.mul(input).div(probeInput);
  if (baselineOutput.isZero() || output.gte(baselineOutput)) return 0;
  return baselineOutput.sub(output).muln(10_000).div(baselineOutput).toNumber();
}

async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Operation aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class PumpQuoteAdapter implements QuoteAdapter {
  readonly id = "pump-sdk-1.36.0";
  readonly networks: readonly ChainNetworkId[];
  readonly #connection: Connection;
  readonly #onlineSdk: OnlinePumpSdk;

  constructor(network: SolanaAdapterConfig["network"], connection: Connection) {
    this.networks = Object.freeze([network]);
    this.#connection = connection;
    this.#onlineSdk = new OnlinePumpSdk(this.#connection);
  }

  async quote(request: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
    assertSolanaNetwork(request.chain.id);
    if (request.rule.maxSlippageBps < 0 || request.rule.maxSlippageBps >= 10_000) {
      throw new Error("maxSlippageBps must be within [0, 10000).");
    }
    const mint = requirePublicKey(request.event.target ?? request.event.mint, "Pump mint");
    const [global, feeConfig, bondingCurve, supply] = await withAbort(Promise.all([
      this.#onlineSdk.fetchGlobal(),
      this.#onlineSdk.fetchFeeConfig(),
      this.#onlineSdk.fetchBondingCurve(mint),
      this.#connection.getTokenSupply(mint, "confirmed"),
    ]), signal);
    const mintSupply = new BN(supply.value.amount);
    const input = new BN(request.inputAmountAtomic.toString());
    const quoteMint = new PublicKey(WRAPPED_SOL_MINT);
    const expected = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply,
      bondingCurve,
      amount: input,
      quoteMint,
    });
    const probeInput = BN.max(new BN(10_000), input.divn(1_000));
    const probeOutput = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply,
      bondingCurve,
      amount: probeInput,
      quoteMint,
    });
    const minimum = expected.muln(10_000 - request.rule.maxSlippageBps).divn(10_000);
    const now = Date.now();
    return Object.freeze({
      id: `pump:${mint.toBase58()}:${now}`,
      chain: request.chain,
      inputAmountAtomic: request.inputAmountAtomic,
      expectedOutputAmount: BigInt(expected.toString()),
      minimumOutputAmount: BigInt(minimum.toString()),
      priceImpactBps: priceImpactBps(input, expected, probeInput, probeOutput),
      route: Object.freeze(["Pump bonding curve"]),
      receivedAt: now,
      expiresAt: now + 3_000,
      provider: this.id,
    });
  }
}

function instructionManifest(instruction: TransactionInstruction): TransactionDraft["instructions"][number] {
  return Object.freeze({
    program: instruction.programId.toBase58(),
    action: instruction.programId.equals(PUMP_PROGRAM_ID) ? "pump-buy" : "solana-instruction",
    accounts: Object.freeze(instruction.keys.map((key) => key.pubkey.toBase58())),
    dataDigest: Buffer.from(instruction.data).subarray(0, 16).toString("hex"),
  });
}

export class PumpTransactionAdapter implements TransactionAdapter {
  readonly id = "pump-transaction-builder";
  readonly networks: readonly ChainNetworkId[];
  readonly #connection: Connection;
  readonly #onlineSdk: OnlinePumpSdk;
  readonly #offlineSdk = new PumpSdk();
  readonly #tipRecipient?: PublicKey;

  constructor(config: Pick<SolanaAdapterConfig, "network" | "relayTipRecipient">, connection: Connection) {
    this.networks = Object.freeze([config.network]);
    this.#connection = connection;
    this.#onlineSdk = new OnlinePumpSdk(this.#connection);
    this.#tipRecipient = config.relayTipRecipient ? requirePublicKey(config.relayTipRecipient, "Relay tip recipient") : undefined;
  }

  async build(input: Parameters<TransactionAdapter["build"]>[0], signal?: AbortSignal): Promise<TransactionDraft> {
    assertSolanaNetwork(input.chain.id);
    if (input.feePolicy.kind !== "solana") throw new Error("PumpTransactionAdapter requires a Solana fee policy.");
    const mint = requirePublicKey(input.event.target ?? input.event.mint, "Pump mint");
    const user = requirePublicKey(input.event.account, "Wallet address");
    const [global, buyState] = await withAbort(Promise.all([
      this.#onlineSdk.fetchGlobal(),
      this.#onlineSdk.fetchBuyState(mint, user, TOKEN_PROGRAM_ID),
    ]), signal);
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = buyState;
    const tokenAmount = new BN(input.quote.expectedOutputAmount.toString());
    const solAmount = new BN(input.quote.inputAmountAtomic.toString());
    const slippage = Math.max(0, (input.quote.expectedOutputAmount === 0n
      ? 0
      : Number(((input.quote.expectedOutputAmount - input.quote.minimumOutputAmount) * 10_000n) / input.quote.expectedOutputAmount)) / 100);
    const instructions = await this.#offlineSdk.buyInstructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve,
      associatedUserAccountInfo,
      mint,
      user,
      amount: tokenAmount,
      solAmount,
      slippage,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    const feeInstructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: input.feePolicy.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.feePolicy.computeUnitPriceMicroLamports }),
    ];
    if (input.feePolicy.tipLamports > 0n) {
      if (!this.#tipRecipient) throw new Error("A verified relay tip recipient is required when tipLamports is non-zero.");
      feeInstructions.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: this.#tipRecipient, lamports: input.feePolicy.tipLamports }));
    }
    const lifetimeResponse = await withAbort(this.#connection.getLatestBlockhash("confirmed"), signal);
    const transaction = new Transaction({
      feePayer: user,
      blockhash: lifetimeResponse.blockhash,
      lastValidBlockHeight: lifetimeResponse.lastValidBlockHeight,
    }).add(...feeInstructions, ...instructions);
    const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const lifetime: ChainLifetime = Object.freeze({
      kind: "solana-blockhash",
      blockhash: lifetimeResponse.blockhash,
      lastValidBlockHeight: BigInt(lifetimeResponse.lastValidBlockHeight),
    });
    return Object.freeze({
      idempotencyKey: input.idempotencyKey,
      chain: input.chain,
      eventId: input.event.id,
      quoteId: input.quote.id,
      lifetime,
      feePolicy: input.feePolicy,
      instructions: Object.freeze([...feeInstructions, ...instructions].map(instructionManifest)),
      unsignedPayload: serialized,
      createdAt: Date.now(),
    });
  }

  async simulate(transaction: TransactionDraft, signal?: AbortSignal): Promise<SimulationResult> {
    if (transaction.chain.family !== "solana") throw new Error("Expected a Solana transaction.");
    const decoded = Transaction.from(Buffer.from(transaction.unsignedPayload, "base64"));
    const result = await withAbort(this.#connection.simulateTransaction(decoded), signal);
    const priorityFeeLamports = transaction.feePolicy.kind === "solana"
      ? (BigInt(transaction.feePolicy.computeUnitLimit) * transaction.feePolicy.computeUnitPriceMicroLamports + 999_999n) / 1_000_000n
      : 0n;
    return Object.freeze({
      ok: result.value.err === null,
      simulatedAt: Date.now(),
      unitsConsumed: BigInt(result.value.unitsConsumed ?? 0),
      estimatedFeeAtomic: transaction.feePolicy.kind === "solana" ? 5_000n + transaction.feePolicy.tipLamports + priorityFeeLamports : 0n,
      logs: Object.freeze(result.value.logs ?? []),
      accountDiff: Object.freeze({}),
      error: result.value.err === null ? undefined : JSON.stringify(result.value.err),
    });
  }
}

export class CallbackSolanaWalletAdapter implements WalletAdapter {
  readonly id: string;
  readonly kind: WalletAdapter["kind"];
  readonly networks: readonly ChainNetworkId[];
  readonly #sign: (transaction: TransactionDraft, signal?: AbortSignal) => Promise<SignedTransaction>;

  constructor(options: {
    readonly id: string;
    readonly kind: "wallet-standard" | "encrypted-external";
    readonly networks: readonly ("solana:devnet" | "solana:mainnet")[];
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

function createConfirmationRpc(connection: Connection): ConfirmationRpc {
  return {
    async subscribeSignature(signature, onStatus, signal) {
      const listener = connection.onSignature(signature, (result, context) => {
        onStatus({
          confirmationStatus: result.err ? null : "confirmed",
          slot: BigInt(context.slot),
          error: result.err ? JSON.stringify(result.err) : undefined,
        });
      }, "confirmed");
      signal.addEventListener("abort", () => {
        void connection.removeSignatureListener(listener);
      }, { once: true });
    },
    async getSignatureStatus(signature, signal) {
      if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
      const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const value = response.value[0];
      if (!value) return null;
      return {
        confirmationStatus: value.confirmationStatus ?? null,
        slot: BigInt(value.slot),
        error: value.err ? JSON.stringify(value.err) : undefined,
      };
    },
    async getBlockHeight(signal) {
      if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
      return BigInt(await connection.getBlockHeight("confirmed"));
    },
  };
}

export function createSolanaChainAdapter(config: SolanaAdapterConfig): ChainAdapter {
  const connection = new Connection(config.rpcUrl, { commitment: "confirmed", wsEndpoint: config.websocketUrl });
  const relays = createSolanaRelayAdapters({
    network: config.network,
    rpcEndpoint: config.rpcUrl,
    jitoEndpoint: config.jitoEndpoint,
    jitoAuthorization: config.jitoAuthorization,
    nozomiEndpoint: config.nozomiEndpoint,
    zeroSlotEndpoint: config.zeroSlotEndpoint,
  });
  return Object.freeze({
    chain: CHAIN_DESCRIPTORS[config.network],
    quote: new PumpQuoteAdapter(config.network, connection),
    transaction: new PumpTransactionAdapter(config, connection),
    wallet: config.wallet,
    relays: new HealthWeightedRelayRouter(relays),
    confirmation: new SolanaConfirmationAdapter(createConfirmationRpc(connection), {
      networks: [config.network],
      timeoutMs: config.confirmationTimeoutMs,
    }),
  });
}
