export type ChainFamily = "solana" | "evm";

export type ChainNetworkId =
  | "solana:devnet"
  | "solana:mainnet"
  | "evm:sepolia"
  | "evm:mainnet";

export interface ChainDescriptor {
  readonly id: ChainNetworkId;
  readonly family: ChainFamily;
  readonly chainId: string;
  readonly name: string;
  readonly nativeSymbol: "SOL" | "ETH";
  readonly production: boolean;
  readonly explorerBaseUrl: string;
}

export const CHAIN_DESCRIPTORS: Readonly<Record<ChainNetworkId, ChainDescriptor>> = Object.freeze({
  "solana:devnet": Object.freeze({
    id: "solana:devnet",
    family: "solana",
    chainId: "devnet",
    name: "Solana Devnet",
    nativeSymbol: "SOL",
    production: false,
    explorerBaseUrl: "https://explorer.solana.com",
  }),
  "solana:mainnet": Object.freeze({
    id: "solana:mainnet",
    family: "solana",
    chainId: "mainnet-beta",
    name: "Solana Mainnet",
    nativeSymbol: "SOL",
    production: true,
    explorerBaseUrl: "https://explorer.solana.com",
  }),
  "evm:sepolia": Object.freeze({
    id: "evm:sepolia",
    family: "evm",
    chainId: "11155111",
    name: "Ethereum Sepolia",
    nativeSymbol: "ETH",
    production: false,
    explorerBaseUrl: "https://sepolia.etherscan.io",
  }),
  "evm:mainnet": Object.freeze({
    id: "evm:mainnet",
    family: "evm",
    chainId: "1",
    name: "Ethereum Mainnet",
    nativeSymbol: "ETH",
    production: true,
    explorerBaseUrl: "https://etherscan.io",
  }),
});

export type EventKind = "manual" | "new_mint" | "pool_created" | "x_post" | "program_log";
export type EventSourceKind = "manual" | "websocket" | "program-log" | "xid" | "pool";

export type ConfirmationState =
  | "prepared"
  | "signed"
  | "submitted"
  | "processed"
  | "confirmed"
  | "finalized"
  | "replaced"
  | "reorged"
  | "failed"
  | "expired";

export interface SniperEvent {
  readonly id: string;
  readonly source: EventSourceKind;
  readonly sourceCursor?: string;
  readonly sourceAccount?: string;
  readonly kind: EventKind;
  readonly network: ChainNetworkId;
  readonly receivedAt: number;
  readonly target?: string;
  readonly mint?: string;
  readonly account?: string;
  readonly text?: string;
  readonly hasMedia?: boolean;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface SniperRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly networks: readonly ChainNetworkId[];
  readonly eventKinds: readonly EventKind[];
  readonly accounts: readonly string[];
  readonly keywords: readonly string[];
  readonly regex?: string;
  readonly requireMedia: boolean;
  readonly allowTargets: readonly string[];
  readonly denyTargets: readonly string[];
  readonly maxSpendAtomic: bigint;
  readonly maxDailySpendAtomic: bigint;
  readonly maxSlippageBps: number;
  readonly maxPriceImpactBps: number;
  readonly cooldownMs: number;
  readonly maxAttempts: number;
  /**
   * Maximum number of canonically confirmed executions for one armed rule id.
   * A fresh arm must use a fresh rule id. Omit only for backwards-compatible,
   * explicitly unbounded test fixtures.
   */
  readonly maxConfirmedExecutions?: number;
}

export interface RuleDecision {
  readonly matched: boolean;
  readonly rule?: SniperRule;
  readonly reasons: readonly string[];
  readonly evaluatedAt: number;
}

export interface QuoteRequest {
  readonly chain: ChainDescriptor;
  readonly event: SniperEvent;
  readonly rule: SniperRule;
  readonly inputAmountAtomic: bigint;
}

export interface Quote {
  readonly id: string;
  readonly chain: ChainDescriptor;
  readonly inputAmountAtomic: bigint;
  readonly expectedOutputAmount: bigint;
  readonly minimumOutputAmount: bigint;
  readonly priceImpactBps: number;
  readonly route: readonly string[];
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly provider: string;
}

export interface SolanaFeePolicy {
  readonly kind: "solana";
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: bigint;
  readonly tipLamports: bigint;
}

export interface EvmFeePolicy {
  readonly kind: "eip1559";
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly replacementBumpBps: number;
}

export type FeePolicy = SolanaFeePolicy | EvmFeePolicy;

export type ChainLifetime =
  | Readonly<{
    kind: "solana-blockhash";
    blockhash: string;
    lastValidBlockHeight: bigint;
  }>
  | Readonly<{
    kind: "evm-nonce";
    nonce: number;
    validUntilBlock?: bigint;
    replacementOf?: string;
  }>;

export interface InstructionManifestItem {
  readonly program: string;
  readonly action: string;
  readonly accounts: readonly string[];
  readonly dataDigest: string;
}

export interface TransactionDraft {
  readonly idempotencyKey: string;
  readonly chain: ChainDescriptor;
  readonly eventId: string;
  readonly quoteId: string;
  readonly lifetime: ChainLifetime;
  readonly feePolicy: FeePolicy;
  readonly instructions: readonly InstructionManifestItem[];
  readonly unsignedPayload: string;
  readonly createdAt: number;
}

export interface SimulationResult {
  readonly ok: boolean;
  readonly simulatedAt: number;
  readonly unitsConsumed: bigint;
  readonly estimatedFeeAtomic: bigint;
  readonly logs: readonly string[];
  readonly accountDiff: Readonly<Record<string, string>>;
  readonly error?: string;
}

export interface SignedTransaction {
  readonly draft: TransactionDraft;
  readonly signature: string;
  readonly wireTransaction: string;
  readonly signedAt: number;
}

export type RelayKind = "rpc" | "jito" | "nozomi" | "0slot" | "evm-rpc" | "flashbots-protect";

export interface RelayHealth {
  readonly relayId: string;
  readonly kind: RelayKind;
  readonly networks: readonly ChainNetworkId[];
  readonly enabled: boolean;
  readonly latencyMs: number;
  readonly failureRate: number;
  readonly lastSuccessAt?: number;
  readonly reason?: string;
}

export interface RelayReceipt {
  readonly relayId: string;
  readonly kind: RelayKind;
  readonly accepted: boolean;
  readonly latencyMs: number;
  readonly acceptedAt?: number;
  readonly responseId?: string;
  readonly error?: string;
}

export interface ConfirmationObservation {
  readonly state: ConfirmationState;
  readonly observedAt: number;
  readonly blockOrSlot?: bigint;
  readonly blockHash?: string;
  readonly transactionHash?: string;
  readonly replacementHash?: string;
  readonly error?: string;
}

export interface ConfirmationResult {
  readonly confirmed: boolean;
  readonly state: ConfirmationState;
  readonly signature: string;
  readonly observations: readonly ConfirmationObservation[];
  readonly finishedAt: number;
  readonly error?: string;
}

export interface RetryContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly confirmation?: ConfirmationResult;
  readonly relayReceipts: readonly RelayReceipt[];
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly refreshTransaction: boolean;
  readonly delayMs: number;
  readonly reason: string;
}

export type AuditStage =
  | "event"
  | "rule"
  | "risk"
  | "quote"
  | "build"
  | "simulation"
  | "signature"
  | "relay"
  | "confirmation"
  | "retry"
  | "complete";

export interface AuditRecord {
  readonly id: string;
  readonly executionId: string;
  readonly eventId: string;
  readonly network: ChainNetworkId;
  readonly stage: AuditStage;
  readonly state: ConfirmationState | "received" | "matched" | "rejected" | "passed" | "retrying";
  readonly timestamp: number;
  readonly latencyMs?: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ExecutionRequest {
  readonly event: SniperEvent;
  readonly rules: readonly SniperRule[];
  readonly inputAmountAtomic: bigint;
  readonly feePolicy: FeePolicy;
  readonly relayFanout: number;
}

export type ExecutionOutcome = "skipped" | "confirmed" | "failed" | "expired";

export interface ExecutionResult {
  readonly executionId: string;
  readonly eventId: string;
  readonly network: ChainNetworkId;
  readonly outcome: ExecutionOutcome;
  readonly confirmationState: ConfirmationState;
  readonly signature?: string;
  readonly attempts: number;
  readonly matchedRuleId?: string;
  readonly relayReceipts: readonly RelayReceipt[];
  readonly audit: readonly AuditRecord[];
  readonly error?: string;
}

export interface EventSource {
  readonly id: string;
  readonly networks: readonly ChainNetworkId[];
  start(onEvent: (event: SniperEvent) => void | Promise<void>): Promise<AbortController>;
}

export interface RuleEvaluator {
  evaluate(event: SniperEvent, rules: readonly SniperRule[], now?: number): RuleDecision;
}

export interface QuoteAdapter {
  readonly id: string;
  readonly networks: readonly ChainNetworkId[];
  quote(request: QuoteRequest, signal?: AbortSignal): Promise<Quote>;
}

export interface TransactionAdapter {
  readonly id: string;
  readonly networks: readonly ChainNetworkId[];
  build(input: {
    readonly chain: ChainDescriptor;
    readonly event: SniperEvent;
    readonly quote: Quote;
    readonly feePolicy: FeePolicy;
    readonly idempotencyKey: string;
    readonly previous?: TransactionDraft;
  }, signal?: AbortSignal): Promise<TransactionDraft>;
  simulate(transaction: TransactionDraft, signal?: AbortSignal): Promise<SimulationResult>;
}

export interface WalletAdapter {
  readonly id: string;
  readonly kind: "wallet-standard" | "eip1193" | "encrypted-external" | "test";
  readonly networks: readonly ChainNetworkId[];
  sign(transaction: TransactionDraft, signal?: AbortSignal): Promise<SignedTransaction>;
}

export interface RelayAdapter {
  readonly id: string;
  readonly kind: RelayKind;
  readonly networks: readonly ChainNetworkId[];
  health(): RelayHealth;
  submit(transaction: SignedTransaction, signal?: AbortSignal): Promise<RelayReceipt>;
}

export interface RelayRouter {
  route(transaction: SignedTransaction, fanout: number, signal?: AbortSignal): Promise<readonly RelayReceipt[]>;
  health(network?: ChainNetworkId): readonly RelayHealth[];
}

export interface ConfirmationAdapter {
  readonly id: string;
  readonly networks: readonly ChainNetworkId[];
  track(transaction: SignedTransaction, signal?: AbortSignal): Promise<ConfirmationResult>;
}

export interface ChainAdapter {
  readonly chain: ChainDescriptor;
  readonly quote: QuoteAdapter;
  readonly transaction: TransactionAdapter;
  readonly wallet: WalletAdapter;
  readonly relays: RelayRouter;
  readonly confirmation: ConfirmationAdapter;
}

export interface RetryController {
  decide(context: RetryContext): RetryDecision;
  wait(decision: RetryDecision, signal?: AbortSignal): Promise<void>;
}

export interface RiskEngine {
  assertEvent(event: SniperEvent, rule: SniperRule, spendAtomic: bigint, now?: number): string;
  assertQuote(rule: SniperRule, quote: Quote, now?: number): void;
  assertAttempt(event: SniperEvent, rule: SniperRule, attempt: number): void;
  recordConfirmed(reservationId: string, confirmedAt?: number): void;
  release(reservationId: string): void;
  setKillSwitch(enabled: boolean): void;
}

export interface AuditSink {
  record(record: AuditRecord): void | Promise<void>;
  records(executionId?: string): readonly AuditRecord[];
}
