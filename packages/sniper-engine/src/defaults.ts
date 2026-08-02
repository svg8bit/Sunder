import type {
  ChainLifetime,
  ChainNetworkId,
  FeePolicy,
  Quote,
  QuoteAdapter,
  QuoteRequest,
  SignedTransaction,
  SimulationResult,
  TransactionAdapter,
  TransactionDraft,
  WalletAdapter,
} from "./types.js";

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash >>> 0).toString(16).padStart(8, "0");
}

function base64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

const PRODUCTION_NETWORKS: ReadonlySet<ChainNetworkId> = new Set(["solana:mainnet", "evm:mainnet"]);

function assertTestNetworks(adapterId: string, networks: readonly ChainNetworkId[]): void {
  const production = networks.filter((network) => PRODUCTION_NETWORKS.has(network));
  if (production.length > 0) {
    throw new Error(`${adapterId} must not be used on production networks: ${production.join(", ")}.`);
  }
}

export class StaticQuoteAdapter implements QuoteAdapter {
  readonly id = "deterministic-test-quote";
  readonly networks: readonly ChainNetworkId[];

  constructor(networks: readonly ChainNetworkId[] = ["solana:devnet", "evm:sepolia"]) {
    assertTestNetworks(this.id, networks);
    this.networks = Object.freeze([...networks]);
  }

  async quote(request: QuoteRequest): Promise<Quote> {
    const now = Date.now();
    return Object.freeze({
      id: `quote_${stableHash(`${request.event.id}:${request.inputAmountAtomic}`)}`,
      chain: request.chain,
      inputAmountAtomic: request.inputAmountAtomic,
      expectedOutputAmount: request.inputAmountAtomic * 100n,
      minimumOutputAmount: request.inputAmountAtomic * 99n,
      priceImpactBps: 25,
      route: ["deterministic-test-route"],
      receivedAt: now,
      expiresAt: now + 15_000,
      provider: this.id,
    });
  }
}

export class ManifestTransactionAdapter implements TransactionAdapter {
  readonly id = "manifest-test-transaction";
  readonly networks: readonly ChainNetworkId[];
  readonly #getLifetime: (network: ChainNetworkId, previous?: TransactionDraft) => Promise<ChainLifetime>;

  constructor(options: {
    readonly networks?: readonly ChainNetworkId[];
    readonly getLifetime: (network: ChainNetworkId, previous?: TransactionDraft) => Promise<ChainLifetime>;
  }) {
    const networks = options.networks ?? ["solana:devnet", "evm:sepolia"];
    assertTestNetworks(this.id, networks);
    this.networks = Object.freeze([...networks]);
    this.#getLifetime = options.getLifetime;
  }

  async build(input: Parameters<TransactionAdapter["build"]>[0]): Promise<TransactionDraft> {
    const lifetime = await this.#getLifetime(input.chain.id, input.previous);
    const payload = JSON.stringify({
      network: input.chain.id,
      eventId: input.event.id,
      quoteId: input.quote.id,
      lifetime,
      input: input.quote.inputAmountAtomic.toString(),
      minOutput: input.quote.minimumOutputAmount.toString(),
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    return Object.freeze({
      idempotencyKey: input.idempotencyKey,
      chain: input.chain,
      eventId: input.event.id,
      quoteId: input.quote.id,
      lifetime,
      feePolicy: Object.freeze({ ...input.feePolicy }) as FeePolicy,
      instructions: Object.freeze([
        Object.freeze({
          program: input.chain.family === "solana" ? "quote-router" : "uniswap-compatible-router",
          action: "swap-exact-in",
          accounts: Object.freeze([input.event.target ?? input.event.mint ?? "unresolved-target"]),
          dataDigest: stableHash(payload),
        }),
      ]),
      unsignedPayload: base64(payload),
      createdAt: Date.now(),
    });
  }

  async simulate(transaction: TransactionDraft): Promise<SimulationResult> {
    const gasOrUnits = transaction.feePolicy.kind === "solana"
      ? BigInt(Math.min(transaction.feePolicy.computeUnitLimit, 42_000))
      : transaction.feePolicy.gasLimit;
    const estimatedFeeAtomic = transaction.feePolicy.kind === "solana"
      ? 5_000n + transaction.feePolicy.tipLamports
      : transaction.feePolicy.gasLimit * transaction.feePolicy.maxFeePerGas;
    return Object.freeze({
      ok: transaction.instructions.length > 0,
      simulatedAt: Date.now(),
      unitsConsumed: gasOrUnits,
      estimatedFeeAtomic,
      logs: Object.freeze(["Deterministic test simulation", "Simulation passed"]),
      accountDiff: Object.freeze({}),
    });
  }
}

export class TestWalletAdapter implements WalletAdapter {
  readonly id = "test-wallet";
  readonly kind = "test" as const;
  readonly networks: readonly ChainNetworkId[];

  constructor(networks: readonly ChainNetworkId[] = ["solana:devnet", "evm:sepolia"]) {
    assertTestNetworks(this.id, networks);
    this.networks = Object.freeze([...networks]);
  }

  async sign(transaction: TransactionDraft): Promise<SignedTransaction> {
    const signature = `${transaction.chain.family === "evm" ? "0x" : "sig_"}${stableHash(transaction.unsignedPayload + JSON.stringify(transaction.lifetime, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value))}`;
    return Object.freeze({
      draft: transaction,
      signature,
      wireTransaction: transaction.chain.family === "evm" ? `0x${stableHash(transaction.unsignedPayload)}${stableHash(signature)}` : base64(`${transaction.unsignedPayload}:${signature}`),
      signedAt: Date.now(),
    });
  }
}
