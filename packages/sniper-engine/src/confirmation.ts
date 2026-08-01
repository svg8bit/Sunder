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
  getBlockHeight(signal?: AbortSignal): Promise<bigint>;
}

function observation(status: RpcSignatureStatus): ConfirmationObservation {
  const state: ConfirmationState = status.error ? "failed" : status.confirmationStatus ?? "submitted";
  return { state, observedAt: Date.now(), blockOrSlot: status.slot, error: status.error };
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
        subscriptionStatus = status;
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
          observations.push(observation(status));
          if (status.error) {
            return {
              confirmed: false,
              state: "failed",
              signature: transaction.signature,
              observations,
              finishedAt: Date.now(),
              error: status.error,
            };
          }
          if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
            return {
              confirmed: true,
              state: status.confirmationStatus,
              signature: transaction.signature,
              observations,
              finishedAt: Date.now(),
            };
          }
        }
        const blockHeight = await this.#rpc.getBlockHeight(combined);
        if (blockHeight > transaction.draft.lifetime.lastValidBlockHeight) {
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
