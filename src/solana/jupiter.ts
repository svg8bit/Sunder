import type { SolanaClient, WalletSession } from "@solana/client";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type AddressesByLookupTableAddress,
  type Base64EncodedBytes,
  type Blockhash,
  type Instruction,
  type SendableTransaction,
  type Transaction,
} from "@solana/kit";
import { z } from "zod";
import { isSolanaTimeout, solanaStageError, stringifySolanaRpcValue } from "./rpc-errors";

export const JUPITER_SWAP_BUILD_ENDPOINT = "https://api.jup.ag/swap/v2/build";
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");
const COMPUTE_UNIT_LIMIT_MAX = 1_400_000;
const PROVIDER_TIMEOUT_MS = 15_000;
const JUPITER_BUILD_TIMEOUT_MS = 8_000;
const BALANCE_RPC_TIMEOUT_MS = 8_000;
const PUBLICNODE_SOLANA_MAINNET_RPC_URL = "https://solana-rpc.publicnode.com";
const atomicString = z.string().max(78).regex(/^[0-9]+$/);

function deadlineSignal(signal?: AbortSignal, timeoutMs = PROVIDER_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const apiInstructionSchema = z.object({
  programId: z.string().min(32).max(64),
  accounts: z.array(z.object({
    pubkey: z.string().min(32).max(64),
    isSigner: z.boolean(),
    isWritable: z.boolean(),
  })).max(256),
  data: z.string().min(1).max(16_384),
});

const buildResponseSchema = z.object({
  inputMint: z.string().min(32).max(64),
  outputMint: z.string().min(32).max(64),
  inAmount: atomicString,
  outAmount: atomicString,
  otherAmountThreshold: atomicString,
  swapMode: z.string().max(32),
  slippageBps: z.number().int().min(0).max(10_000),
  priceImpactPct: z.string().max(64).regex(/^-?[0-9]+(?:\.[0-9]+)?$/).optional(),
  routePlan: z.array(z.object({
    percent: z.number().min(0).max(100),
    bps: z.number().int().min(0).max(10_000),
    swapInfo: z.object({
      ammKey: z.string().min(20).max(128),
      label: z.string().min(1).max(128),
      inputMint: z.string().min(32).max(64),
      outputMint: z.string().min(32).max(64),
      inAmount: atomicString,
      outAmount: atomicString,
    }),
  })).min(1).max(16),
  computeBudgetInstructions: z.array(apiInstructionSchema).max(8),
  setupInstructions: z.array(apiInstructionSchema).max(32),
  swapInstruction: apiInstructionSchema,
  cleanupInstruction: apiInstructionSchema.nullish(),
  otherInstructions: z.array(apiInstructionSchema).max(32),
  tipInstruction: apiInstructionSchema.nullish(),
  addressesByLookupTableAddress: z.record(z.string(), z.array(z.string().min(32).max(64)).max(256))
    .refine((value) => Object.keys(value).length <= 64, "Too many address lookup tables.")
    .nullish(),
  blockhashWithMetadata: z.object({
    blockhash: z.array(z.number().int().min(0).max(255)).length(32),
    lastValidBlockHeight: z.number().int().positive(),
    fetchedAt: z.union([
      z.string().max(128),
      z.object({
        secs_since_epoch: z.number().int().nonnegative(),
        nanos_since_epoch: z.number().int().min(0).max(999_999_999),
      }),
    ]).optional(),
  }),
});

export type JupiterApiInstruction = z.infer<typeof apiInstructionSchema>;
export type JupiterBuildResponse = z.infer<typeof buildResponseSchema>;
export type PriorityProfile = "medium" | "high" | "veryHigh";

export interface JupiterSwapIntent {
  readonly direction: "buy" | "sell";
  readonly tokenMint: string;
  readonly amountAtomic: bigint;
  readonly taker: string;
  readonly slippageBps: number;
  readonly priorityProfile: PriorityProfile;
  readonly fastMode: boolean;
}

export function buildJupiterSwapUrl(intent: JupiterSwapIntent): string {
  if (intent.amountAtomic <= 0n) throw new Error("Swap amount must be positive.");
  if (!Number.isInteger(intent.slippageBps) || intent.slippageBps < 1 || intent.slippageBps > 5_000) {
    throw new Error("Slippage must be an integer within [1, 5000] BPS.");
  }
  const url = new URL(JUPITER_SWAP_BUILD_ENDPOINT);
  url.searchParams.set("inputMint", intent.direction === "buy" ? WRAPPED_SOL_MINT : intent.tokenMint);
  url.searchParams.set("outputMint", intent.direction === "buy" ? intent.tokenMint : WRAPPED_SOL_MINT);
  url.searchParams.set("amount", intent.amountAtomic.toString());
  url.searchParams.set("taker", intent.taker);
  url.searchParams.set("slippageBps", String(intent.slippageBps));
  url.searchParams.set("platformFeeBps", "0");
  url.searchParams.set("wrapAndUnwrapSol", "true");
  url.searchParams.set("computeUnitPricePercentile", intent.priorityProfile);
  if (intent.fastMode) url.searchParams.set("mode", "fast");
  return url.toString();
}

export async function requestJupiterBuild(
  intent: JupiterSwapIntent,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<JupiterBuildResponse> {
  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetcher(buildJupiterSwapUrl(intent), {
        method: "GET",
        credentials: "omit",
        headers: { accept: "application/json" },
        signal: deadlineSignal(signal, JUPITER_BUILD_TIMEOUT_MS),
      });
      if (response.ok || (response.status !== 429 && response.status < 500)) break;
      lastError = new Error(`Jupiter build returned retryable HTTP ${response.status}.`);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (!isSolanaTimeout(error) && attempt > 0) throw solanaStageError("Jupiter route build", error);
    }
    if (attempt === 0) continue;
  }
  if (!response?.ok) {
    if (!response || response.status === 429 || response.status >= 500) {
      throw solanaStageError("Jupiter route build", lastError ?? new Error("Provider unavailable."));
    }
    let detail = "Quote unavailable.";
    try {
      const payload = z.object({ error: z.string().max(512).optional() }).parse(await response.json());
      if (payload.error) detail = payload.error;
    } catch {
      // Keep the bounded generic error.
    }
    throw new Error(`Jupiter build failed (HTTP ${response.status}): ${detail}`);
  }
  const parsed = buildResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Jupiter build returned an invalid transaction manifest.");
  if (parsed.data.tipInstruction) {
    throw new Error("Jupiter build returned an unexpected tip instruction; Sunder did not authorize a tip recipient.");
  }
  if (parsed.data.inputMint === parsed.data.outputMint) throw new Error("Jupiter returned a same-mint route.");
  const expectedInput = intent.direction === "buy" ? WRAPPED_SOL_MINT : intent.tokenMint;
  const expectedOutput = intent.direction === "buy" ? intent.tokenMint : WRAPPED_SOL_MINT;
  if (parsed.data.inputMint !== expectedInput || parsed.data.outputMint !== expectedOutput) {
    throw new Error("Jupiter build mints do not match the requested swap intent.");
  }
  if (BigInt(parsed.data.inAmount) !== intent.amountAtomic || parsed.data.slippageBps !== intent.slippageBps) {
    throw new Error("Jupiter build amount or slippage does not match the requested swap intent.");
  }
  return Object.freeze(parsed.data);
}

function toInstruction(instruction: JupiterApiInstruction): Instruction {
  return Object.freeze({
    programAddress: address(instruction.programId),
    accounts: instruction.accounts.map((account) => ({
      address: address(account.pubkey),
      role: account.isSigner && account.isWritable
        ? AccountRole.WRITABLE_SIGNER
        : account.isSigner
          ? AccountRole.READONLY_SIGNER
          : account.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
    })),
    data: Uint8Array.from(getBase64Codec().encode(instruction.data as Base64EncodedBytes)),
  });
}

function computeUnitLimitInstruction(units: number): Instruction {
  const data = new Uint8Array(5);
  const view = new DataView(data.buffer);
  view.setUint8(0, 2);
  view.setUint32(1, units, true);
  return Object.freeze({ programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data });
}

function isComputeUnitLimitInstruction(instruction: JupiterApiInstruction): boolean {
  if (instruction.programId !== COMPUTE_BUDGET_PROGRAM) return false;
  const data = Uint8Array.from(getBase64Codec().encode(instruction.data as Base64EncodedBytes));
  return data[0] === 2;
}

function blockhash(build: JupiterBuildResponse): { readonly blockhash: Blockhash; readonly lastValidBlockHeight: bigint } {
  return Object.freeze({
    blockhash: getBase58Decoder().decode(Uint8Array.from(build.blockhashWithMetadata.blockhash)) as Blockhash,
    lastValidBlockHeight: BigInt(build.blockhashWithMetadata.lastValidBlockHeight),
  });
}

function lookupTables(build: JupiterBuildResponse): AddressesByLookupTableAddress {
  const raw = build.addressesByLookupTableAddress;
  if (!raw) return {};
  return Object.fromEntries(Object.entries(raw).map(([key, values]) => [
    address(key),
    values.map((value) => address(value)),
  ]));
}

function swapInstructions(build: JupiterBuildResponse): readonly Instruction[] {
  return Object.freeze([
    // Jupiter currently supplies a price instruction. If it also starts returning
    // a limit instruction, replace that limit with the simulation-derived value
    // instead of compiling conflicting ComputeBudget instructions.
    ...build.computeBudgetInstructions.filter((instruction) => !isComputeUnitLimitInstruction(instruction)).map(toInstruction),
    ...build.setupInstructions.map(toInstruction),
    toInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toInstruction),
  ]);
}

function compile(build: JupiterBuildResponse, feePayer: Address, computeUnitLimit: number): Transaction {
  const instructions = [computeUnitLimitInstruction(computeUnitLimit), ...swapInstructions(build)];
  return pipe(
    createTransactionMessage({ version: 0 }),
    (message) => appendTransactionMessageInstructions(instructions, message),
    (message) => compressTransactionMessageUsingAddressLookupTables(message, lookupTables(build)),
    (message) => setTransactionMessageFeePayer(feePayer, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(blockhash(build), message),
    (message) => compileTransaction(message),
  );
}

function computeUnitPriceMicroLamports(build: JupiterBuildResponse): bigint {
  for (const instruction of build.computeBudgetInstructions) {
    if (instruction.programId !== COMPUTE_BUDGET_PROGRAM) continue;
    const data = Uint8Array.from(getBase64Codec().encode(instruction.data as Base64EncodedBytes));
    if (data.length >= 9 && data[0] === 3) return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
  }
  return 0n;
}

export interface PreparedJupiterSwap {
  readonly intent: JupiterSwapIntent;
  readonly build: JupiterBuildResponse;
  readonly transaction: Transaction;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: bigint;
  readonly estimatedNetworkFeeLamports: bigint;
  readonly recentBlockhash: string;
  readonly preparedAt: number;
}

export async function prepareJupiterSwap(input: {
  readonly client: SolanaClient;
  readonly intent: JupiterSwapIntent;
  readonly signal?: AbortSignal;
}): Promise<PreparedJupiterSwap> {
  const build = await requestJupiterBuild(input.intent, input.signal);
  const simulationTransaction = compile(build, address(input.intent.taker), COMPUTE_UNIT_LIMIT_MAX);
  let simulation;
  try {
    simulation = await input.client.runtime.rpc.simulateTransaction(
      getBase64EncodedWireTransaction(simulationTransaction),
      {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
        replaceRecentBlockhash: false,
      },
    ).send({ abortSignal: deadlineSignal(input.signal) });
  } catch (error) {
    throw solanaStageError("Unsigned RPC simulation", error);
  }
  if (simulation.value.err) throw new Error(`RPC simulation failed: ${stringifySolanaRpcValue(simulation.value.err)}`);
  const consumed = Number(simulation.value.unitsConsumed ?? 0n);
  const computeUnitLimit = consumed > 0
    ? Math.min(Math.ceil(consumed * 1.2), COMPUTE_UNIT_LIMIT_MAX)
    : COMPUTE_UNIT_LIMIT_MAX;
  const transaction = computeUnitLimit === COMPUTE_UNIT_LIMIT_MAX
    ? simulationTransaction
    : compile(build, address(input.intent.taker), computeUnitLimit);
  if (transaction !== simulationTransaction) {
    let exactSimulation;
    try {
      exactSimulation = await input.client.runtime.rpc.simulateTransaction(
        getBase64EncodedWireTransaction(transaction),
        {
          encoding: "base64",
          commitment: "confirmed",
          sigVerify: false,
          replaceRecentBlockhash: false,
        },
      ).send({ abortSignal: deadlineSignal(input.signal) });
    } catch (error) {
      throw solanaStageError("Final unsigned RPC simulation", error);
    }
    if (exactSimulation.value.err) throw new Error(`Final RPC simulation failed: ${stringifySolanaRpcValue(exactSimulation.value.err)}`);
  }
  const unitPrice = computeUnitPriceMicroLamports(build);
  const estimatedPriority = (BigInt(computeUnitLimit) * unitPrice + 999_999n) / 1_000_000n;
  return Object.freeze({
    intent: input.intent,
    build,
    transaction,
    computeUnitLimit,
    computeUnitPriceMicroLamports: unitPrice,
    estimatedNetworkFeeLamports: 5_000n + estimatedPriority,
    recentBlockhash: blockhash(build).blockhash,
    preparedAt: Date.now(),
  });
}

interface RpcEnvelope<T> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message: string };
}

let rpcSequence = 0;
async function rpc<T>(rpcUrl: string, method: string, params: readonly unknown[], signal?: AbortSignal, fetcher: typeof fetch = fetch, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<T> {
  const response = await fetcher(rpcUrl, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcSequence, method, params }),
    signal: deadlineSignal(signal, timeoutMs),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method} returned HTTP ${response.status}.`);
  const envelope = await response.json() as RpcEnvelope<T>;
  if (envelope.error) throw new Error(`Solana RPC ${method} failed: ${envelope.error.message}`);
  if (envelope.result === undefined) throw new Error(`Solana RPC ${method} returned no result.`);
  return envelope.result;
}

const blockhashValiditySchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.boolean(),
});

export async function isJupiterBlockhashValid(input: {
  readonly rpcUrl: string;
  readonly blockhash: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}): Promise<boolean> {
  const result = await rpc<unknown>(
    input.rpcUrl,
    "isBlockhashValid",
    [input.blockhash, { commitment: "confirmed" }],
    input.signal,
    input.fetcher,
  );
  return blockhashValiditySchema.parse(result).value;
}

const tokenBalanceJsonSchema = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string().min(32).max(64),
  owner: z.string().min(32).max(64).optional(),
  uiTokenAmount: z.object({ amount: atomicString, decimals: z.number().int().min(0).max(18) }),
});

const confirmedTransactionJsonSchema = z.object({
  slot: z.number().int().positive(),
  blockTime: z.number().int().nullable(),
  meta: z.object({
    err: z.unknown().nullable(),
    fee: z.number().int().nonnegative(),
    preBalances: z.array(z.number().int().nonnegative()).max(512),
    postBalances: z.array(z.number().int().nonnegative()).max(512),
    logMessages: z.array(z.string().max(2_048)).max(2_048).nullable(),
    preTokenBalances: z.array(tokenBalanceJsonSchema).max(512).optional(),
    postTokenBalances: z.array(tokenBalanceJsonSchema).max(512).optional(),
  }).nullable(),
  transaction: z.object({
    message: z.object({
      accountKeys: z.array(z.union([
        z.string().min(32).max(64),
        z.object({ pubkey: z.string().min(32).max(64), signer: z.boolean().optional(), writable: z.boolean().optional() }),
      ])).min(1).max(512),
    }),
  }),
});

export type ConfirmedTransactionJson = z.infer<typeof confirmedTransactionJsonSchema>;
type TokenBalanceJson = z.infer<typeof tokenBalanceJsonSchema>;

function accountKey(value: string | { readonly pubkey: string }): string {
  return typeof value === "string" ? value : value.pubkey;
}

function tokenBalance(balances: readonly TokenBalanceJson[] | undefined, owner: string, mint: string): bigint {
  return (balances ?? []).filter((balance) => balance.owner === owner && balance.mint === mint)
    .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
}

export interface ConfirmedSwapReceipt {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly direction: "buy" | "sell";
  readonly tokenMint: string;
  readonly tokenDeltaAtomic: bigint;
  readonly walletSolDeltaLamports: bigint;
  readonly networkFeeLamports: bigint;
  readonly accountRentAndOtherLamports: bigint;
  readonly inputAmountAtomic: bigint;
  readonly quotedOutputAtomic: bigint;
  readonly minimumOutputAtomic: bigint;
  readonly route: readonly string[];
}

export class JupiterBlockhashExpiredError extends Error {
  constructor(message = "Jupiter transaction blockhash is no longer valid.") {
    super(message);
    this.name = "JupiterBlockhashExpiredError";
  }
}

export function analyzeJupiterSwapReceipt(prepared: PreparedJupiterSwap, signature: string, transaction: unknown): ConfirmedSwapReceipt {
  const parsed = confirmedTransactionJsonSchema.safeParse(transaction);
  if (!parsed.success) throw new Error("Confirmed transaction evidence has an invalid RPC shape.");
  const evidence = parsed.data;
  if (!evidence.meta) throw new Error("Confirmed transaction metadata is unavailable.");
  if (evidence.meta.err) throw new Error(`Confirmed transaction reverted: ${stringifySolanaRpcValue(evidence.meta.err)}`);
  const keys = evidence.transaction.message.accountKeys.map(accountKey);
  const tokenBalances = [...(evidence.meta.preTokenBalances ?? []), ...(evidence.meta.postTokenBalances ?? [])];
  if (tokenBalances.some((balance) => balance.accountIndex >= keys.length)) {
    throw new Error("Confirmed transaction token balance references an unknown account index.");
  }
  const ownerIndex = keys.indexOf(prepared.intent.taker);
  if (ownerIndex < 0) throw new Error("Confirmed transaction does not contain the expected wallet account.");
  const preBalance = evidence.meta.preBalances[ownerIndex];
  const postBalance = evidence.meta.postBalances[ownerIndex];
  if (preBalance === undefined || postBalance === undefined) throw new Error("Confirmed transaction wallet balances are incomplete.");
  const preSol = BigInt(preBalance);
  const postSol = BigInt(postBalance);
  const preToken = tokenBalance(evidence.meta.preTokenBalances, prepared.intent.taker, prepared.intent.tokenMint);
  const postToken = tokenBalance(evidence.meta.postTokenBalances, prepared.intent.taker, prepared.intent.tokenMint);
  const walletSolDeltaLamports = postSol - preSol;
  const networkFeeLamports = BigInt(evidence.meta.fee);
  const tokenDeltaAtomic = postToken - preToken;
  if (prepared.intent.direction === "buy" && tokenDeltaAtomic < BigInt(prepared.build.otherAmountThreshold)) {
    throw new Error("Confirmed buy token delta is below the quoted minimum output.");
  }
  if (prepared.intent.direction === "sell" && tokenDeltaAtomic !== -prepared.intent.amountAtomic) {
    throw new Error("Confirmed sell token delta does not match the requested input amount.");
  }
  if (prepared.intent.direction === "sell" && walletSolDeltaLamports + networkFeeLamports < BigInt(prepared.build.otherAmountThreshold)) {
    throw new Error("Confirmed sell SOL proceeds are below the quoted minimum output.");
  }
  const accountRentAndOtherLamports = prepared.intent.direction === "buy"
    ? (-walletSolDeltaLamports - prepared.intent.amountAtomic - networkFeeLamports > 0n
      ? -walletSolDeltaLamports - prepared.intent.amountAtomic - networkFeeLamports
      : 0n)
    : 0n;
  return Object.freeze({
    signature,
    slot: evidence.slot,
    blockTime: evidence.blockTime,
    direction: prepared.intent.direction,
    tokenMint: prepared.intent.tokenMint,
    tokenDeltaAtomic,
    walletSolDeltaLamports,
    networkFeeLamports,
    accountRentAndOtherLamports,
    inputAmountAtomic: prepared.intent.amountAtomic,
    quotedOutputAtomic: BigInt(prepared.build.outAmount),
    minimumOutputAtomic: BigInt(prepared.build.otherAmountThreshold),
    route: Object.freeze(prepared.build.routePlan.map((step) => step.swapInfo.label)),
  });
}

export type SwapExecutionState = "awaiting-signature" | "signed" | "submitted" | "processed" | "confirmed";

export async function executePreparedJupiterSwap(input: {
  readonly client: SolanaClient;
  readonly wallet: WalletSession;
  readonly prepared: PreparedJupiterSwap;
  readonly signal?: AbortSignal;
  readonly onState?: (state: SwapExecutionState, signature?: string) => void;
}): Promise<ConfirmedSwapReceipt> {
  if (input.wallet.account.address.toString() !== input.prepared.intent.taker) {
    throw new Error("Connected Wallet Standard account changed after quote preparation.");
  }
  if (!input.wallet.signTransaction) throw new Error("This Wallet Standard provider does not support signTransaction.");
  const rpcUrl = String(input.client.config.endpoint);
  // Some public providers currently return the slot for getBlockHeight. That
  // value cannot be compared with Jupiter's lastValidBlockHeight and rejected
  // fresh transactions in production. Ask the RPC about this exact blockhash.
  if (!await isJupiterBlockhashValid({ rpcUrl, blockhash: input.prepared.recentBlockhash, signal: input.signal })) {
    throw new JupiterBlockhashExpiredError();
  }
  input.onState?.("awaiting-signature");
  assertIsTransactionWithinSizeLimit(input.prepared.transaction);
  const signed = await input.wallet.signTransaction(input.prepared.transaction as SendableTransaction & Transaction);
  assertIsFullySignedTransaction(signed);
  input.onState?.("signed");
  const wire = getBase64EncodedWireTransaction(signed);
  let signedSimulation;
  try {
    signedSimulation = await input.client.runtime.rpc.simulateTransaction(wire, {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: true,
      replaceRecentBlockhash: false,
    }).send({ abortSignal: deadlineSignal(input.signal, 25_000) });
  } catch (error) {
    throw solanaStageError("Signed RPC simulation", error);
  }
  if (signedSimulation.value.err) throw new Error(`Signed transaction simulation failed: ${stringifySolanaRpcValue(signedSimulation.value.err)}`);
  let signature: string;
  try {
    signature = String(await input.client.runtime.rpc.sendTransaction(wire, {
      encoding: "base64",
      maxRetries: 2n,
      preflightCommitment: "confirmed",
      skipPreflight: false,
    }).send({ abortSignal: deadlineSignal(input.signal, 25_000) }));
  } catch (error) {
    throw solanaStageError("Signed transaction submission", error, "submission-unknown");
  }
  input.onState?.("submitted", signature);

  const startedAt = Date.now();
  let observedProcessed = false;
  let observedCanonicalStatus = false;
  let lastValidityCheckAt = startedAt;
  while (Date.now() - startedAt < 75_000) {
    const statuses = await input.client.runtime.rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send({ abortSignal: deadlineSignal(input.signal) });
    const status = statuses.value[0];
    if (status?.err) throw new Error(`On-chain transaction failed: ${stringifySolanaRpcValue(status.err)}`);
    if (status && !observedProcessed) {
      observedProcessed = true;
      input.onState?.("processed", signature);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      observedCanonicalStatus = true;
      const transaction = await rpc<ConfirmedTransactionJson | null>(rpcUrl, "getTransaction", [signature, {
        commitment: "confirmed",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      }], input.signal);
      if (transaction) {
        const receipt = analyzeJupiterSwapReceipt(input.prepared, signature, transaction);
        input.onState?.("confirmed", signature);
        return receipt;
      }
    }
    if (!observedCanonicalStatus && Date.now() - lastValidityCheckAt >= 5_000) {
      lastValidityCheckAt = Date.now();
      if (!await isJupiterBlockhashValid({ rpcUrl, blockhash: input.prepared.recentBlockhash, signal: input.signal })) {
        throw new JupiterBlockhashExpiredError("Transaction blockhash expired before canonical confirmation.");
      }
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        input.signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timeout = setTimeout(finish, 650);
      const abort = () => {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
        reject(new DOMException("Operation aborted", "AbortError"));
      };
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error(`Canonical Solana confirmation timed out for signature ${signature}.`);
}

const tokenAccountsByOwnerSchema = z.object({
  value: z.array(z.object({
    account: z.object({
      data: z.object({
        parsed: z.object({
          info: z.object({ tokenAmount: z.object({ amount: atomicString }) }),
        }),
      }),
    }),
  })).max(256),
});

export async function getWalletTokenBalanceAtomic(input: {
  readonly rpcUrl: string;
  readonly owner: string;
  readonly mint: string;
  readonly signal?: AbortSignal;
  readonly fallbackRpcUrls?: readonly string[];
  readonly fetcher?: typeof fetch;
}): Promise<bigint> {
  const rpcUrls = [...new Set([
    input.rpcUrl,
    ...(input.fallbackRpcUrls ?? [PUBLICNODE_SOLANA_MAINNET_RPC_URL]),
  ].filter(Boolean))];
  let lastError: unknown;
  for (const rpcUrl of rpcUrls) {
    try {
      const result = await rpc<unknown>(
        rpcUrl,
        "getTokenAccountsByOwner",
        [input.owner, { mint: input.mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
        input.signal,
        input.fetcher,
        BALANCE_RPC_TIMEOUT_MS,
      );
      const parsed = tokenAccountsByOwnerSchema.safeParse(result);
      if (!parsed.success) throw new Error("Solana RPC returned an invalid token-account balance payload.");
      return parsed.data.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw solanaStageError("Token balance lookup on all configured RPC providers", lastError ?? new Error("No RPC provider configured."));
}
