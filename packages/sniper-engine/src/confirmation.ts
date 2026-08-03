import type { ChainNetworkId, ConfirmationAdapter, ConfirmationObservation, ConfirmationResult, ConfirmationState, SignedTransaction } from "./types.js";

export interface RpcSignatureStatus {
  readonly confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  readonly slot?: bigint;
  readonly error?: string;
}

export interface ConfirmationRpc {
  subscribeSignature?(
    signature: string,
    onStatus: (status: RpcSignatureStatus) => void,
    signal: AbortSignal,
  ): Promise<void> | void;
  getSignatureStatus(signature: string, signal?: AbortSignal): Promise<RpcSignatureStatus | null>;
  isBlockhashValid?(blockhash: string, signal?: AbortSignal): Promise<boolean>;
  getBlockHeight(signal?: AbortSignal): Promise<bigint>;
}

function observation(status: RpcSignatureStatus): ConfirmationObservation {
  const state: ConfirmationState = status.error ? "failed" : status.confirmationStatus ?? "submitted";
  return { state, observedAt: Date.now(), blockOrSlot: status.slot, error: status.error };
}

const STATUS_RANK: Readonly<Record<NonNullable<RpcSignatureStatus["confirmationStatus"]>, number>> = Object.freeze({
  processed: 1,
  confirmed: 2,
  finalized: 3,
});

function shouldReplaceStatus(next: RpcSignatureStatus, current: RpcSignatureStatus | null): boolean {
  if (!current || next.error) return true;
  if (current.error) return false;
  const nextRank = next.confirmationStatus ? STATUS_RANK[next.confirmationStatus] : 0;
  const currentRank = current.confirmationStatus ? STATUS_RANK[current.confirmationStatus] : 0;
  return nextRank >= currentRank;
}

function terminalResult(
  status: RpcSignatureStatus,
  signature: string,
  observations: ConfirmationObservation[],
): ConfirmationResult | undefined {
  observations.push(observation(status));
  if (status.error) {
    return {
      confirmed: false,
      state: "failed",
      signature,
      observations,
      finishedAt: Date.now(),
      error: status.error,
    };
  }
  if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
    return {
      confirmed: true,
      state: status.confirmationStatus,
      signature,
      observations,
      finishedAt: Date.now(),
    };
  }
  return undefined;
}

export class SolanaConfirmationAdapter implements ConfirmationAdapter {
  readonly id = "solana-rpc-confirmation";
  readonly networks: readonly ChainNetworkId[];
  readonly #rpc: ConfirmationRpc;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;

  constructor(rpc: ConfirmationRpc, options: { readonly networks?: readonly ChainNetworkId[]; readonly pollIntervalMs?: number; readonly timeoutMs?: number } = {}) {
    this.#rpc = rpc;
    this.networks = Object.freeze([...(options.networks ?? ["solana:devnet", "solana:mainnet"])]);
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async track(transaction: SignedTransaction, signal?: AbortSignal): Promise<ConfirmationResult> {
    if (transaction.draft.lifetime.kind !== "solana-blockhash") {
      throw new Error("SolanaConfirmationAdapter requires a Solana blockhash lifetime.");
    }
    const localController = new AbortController();
    const combined = signal ? AbortSignal.any([signal, localController.signal]) : localController.signal;
    const observations: ConfirmationObservation[] = [
      { state: "submitted", observedAt: Date.now() },
    ];
    let subscriptionStatus: RpcSignatureStatus | null = null;
    if (this.#rpc.subscribeSignature) {
      void Promise.resolve(this.#rpc.subscribeSignature(transaction.signature, (status) => {
        if (shouldReplaceStatus(status, subscriptionStatus)) subscriptionStatus = status;
      }, combined)).catch(() => {
        // Polling below is the required fallback when subscriptions fail.
      });
    }
    const startedAt = Date.now();
    try {
      while (!combined.aborted && Date.now() - startedAt < this.#timeoutMs) {
        const status = subscriptionStatus ?? await this.#rpc.getSignatureStatus(transaction.signature, combined);
        subscriptionStatus = null;
        if (status) {
          const result = terminalResult(status, transaction.signature, observations);
          if (result) return result;
        }
        const blockhashValid = this.#rpc.isBlockhashValid
          ? await this.#rpc.isBlockhashValid(transaction.draft.lifetime.blockhash, combined)
          : await this.#rpc.getBlockHeight(combined) <= transaction.draft.lifetime.lastValidBlockHeight;
        if (!blockhashValid) {
          const finalStatus = await this.#rpc.getSignatureStatus(transaction.signature, combined);
          if (finalStatus) {
            const result = terminalResult(finalStatus, transaction.signature, observations);
            if (result) return result;
          }
          observations.push({ state: "expired", observedAt: Date.now() });
          return {
            confirmed: false,
            state: "expired",
            signature: transaction.signature,
            observations,
            finishedAt: Date.now(),
            error: "Blockhash expired before confirmation.",
          };
        }
        await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
      }
      return {
        confirmed: false,
        state: "submitted",
        signature: transaction.signature,
        observations,
        finishedAt: Date.now(),
        error: combined.aborted ? "Confirmation aborted." : "Confirmation timed out.",
      };
    } finally {
      localController.abort();
    }
  }
}
