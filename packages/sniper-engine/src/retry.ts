import type { RetryContext, RetryController, RetryDecision } from "./types.js";

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

export class BoundedRetryController implements RetryController {
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #jitterRatio: number;
  readonly #random: () => number;

  constructor(options: {
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly jitterRatio?: number;
    readonly random?: () => number;
  } = {}) {
    this.#baseDelayMs = options.baseDelayMs ?? 120;
    this.#maxDelayMs = options.maxDelayMs ?? 1_000;
    this.#jitterRatio = options.jitterRatio ?? 0.2;
    this.#random = options.random ?? Math.random;
  }

  decide(context: RetryContext): RetryDecision {
    if (context.attempt >= context.maxAttempts) {
      return { retry: false, refreshTransaction: false, delayMs: 0, reason: "attempt-budget-exhausted" };
    }
    if (context.confirmation?.state === "confirmed" || context.confirmation?.state === "finalized") {
      return { retry: false, refreshTransaction: false, delayMs: 0, reason: "confirmed" };
    }
    if (context.confirmation?.state === "failed") {
      return { retry: false, refreshTransaction: false, delayMs: 0, reason: "onchain-failure" };
    }
    const refreshTransaction = context.confirmation?.state === "expired";
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (context.attempt - 1));
    const jitter = exponential * this.#jitterRatio * (this.#random() * 2 - 1);
    return {
      retry: true,
      refreshTransaction,
      delayMs: Math.max(0, Math.round(exponential + jitter)),
      reason: context.confirmation?.state === "reorged"
        ? "track-original-after-reorg"
        : refreshTransaction ? "transaction-refresh-required" : "bounded-rebroadcast",
    };
  }

  async wait(decision: RetryDecision, signal?: AbortSignal): Promise<void> {
    if (!decision.retry || decision.delayMs === 0) return;
    if (signal?.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(abortError()));
      const timeout = setTimeout(() => finish(resolve), decision.delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
