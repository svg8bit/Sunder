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
    const refreshTransaction = context.confirmation?.state === "expired" || context.confirmation?.state === "reorged";
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (context.attempt - 1));
    const jitter = exponential * this.#jitterRatio * (this.#random() * 2 - 1);
    return {
      retry: true,
      refreshTransaction,
      delayMs: Math.max(0, Math.round(exponential + jitter)),
      reason: refreshTransaction ? "transaction-refresh-required" : "bounded-rebroadcast",
    };
  }

  async wait(decision: RetryDecision, signal?: AbortSignal): Promise<void> {
    if (!decision.retry || decision.delayMs === 0) return;
    if (signal?.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, decision.delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(abortError());
      }, { once: true });
    });
  }
}
