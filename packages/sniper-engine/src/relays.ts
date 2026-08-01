import type { ChainNetworkId, RelayAdapter, RelayHealth, RelayKind, RelayReceipt, RelayRouter, SignedTransaction } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function score(health: RelayHealth): number {
  if (!health.enabled) return Number.NEGATIVE_INFINITY;
  const reliability = Math.max(0.01, 1 - health.failureRate);
  return (reliability * 1_000) / Math.max(1, health.latencyMs);
}

export class HealthWeightedRelayRouter implements RelayRouter {
  readonly #relays: readonly RelayAdapter[];

  constructor(relays: readonly RelayAdapter[]) {
    this.#relays = Object.freeze([...relays]);
  }

  health(network?: ChainNetworkId): readonly RelayHealth[] {
    const relays = network ? this.#relays.filter((relay) => relay.networks.includes(network)) : this.#relays;
    return Object.freeze(relays.map((relay) => relay.health()));
  }

  async route(transaction: SignedTransaction, fanout: number, signal?: AbortSignal): Promise<readonly RelayReceipt[]> {
    const selected = this.#relays
      .filter((relay) => relay.networks.includes(transaction.draft.chain.id) && relay.health().enabled)
      .toSorted((left, right) => score(right.health()) - score(left.health()))
      .slice(0, Math.max(1, fanout));
    if (selected.length === 0) {
      return Object.freeze([{ relayId: "none", kind: "rpc", accepted: false, latencyMs: 0, error: "No relay is configured." }]);
    }
    const settled = await Promise.allSettled(selected.map((relay) => relay.submit(transaction, signal)));
    return Object.freeze(settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const relay = selected[index];
      return {
        relayId: relay?.id ?? "unknown",
        kind: relay?.kind ?? "rpc",
        accepted: false,
        latencyMs: 0,
        error: errorMessage(result.reason),
      } satisfies RelayReceipt;
    }));
  }
}

interface HttpRelayOptions {
  readonly id: string;
  readonly kind: RelayKind;
  readonly networks: readonly ChainNetworkId[];
  readonly endpoint?: string;
  readonly authorization?: string;
  readonly initialLatencyMs?: number;
  readonly fetcher?: typeof fetch;
  readonly mode?: "json-rpc" | "plain-base64";
  readonly rpcMethod?: "sendTransaction" | "eth_sendRawTransaction";
}

export class HttpRelayAdapter implements RelayAdapter {
  readonly id: string;
  readonly kind: RelayKind;
  readonly networks: readonly ChainNetworkId[];
  readonly #endpoint?: string;
  readonly #authorization?: string;
  readonly #fetcher: typeof fetch;
  readonly #mode: "json-rpc" | "plain-base64";
  readonly #rpcMethod: "sendTransaction" | "eth_sendRawTransaction";
  #latencyMs: number;
  #successes = 0;
  #failures = 0;
  #lastSuccessAt?: number;

  constructor(options: HttpRelayOptions) {
    this.id = options.id;
    this.kind = options.kind;
    this.networks = Object.freeze([...options.networks]);
    this.#endpoint = options.endpoint;
    this.#authorization = options.authorization;
    this.#latencyMs = options.initialLatencyMs ?? 250;
    this.#fetcher = options.fetcher ?? fetch;
    this.#mode = options.mode ?? "json-rpc";
    this.#rpcMethod = options.rpcMethod ?? "sendTransaction";
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
    if (!this.#endpoint) {
      return { relayId: this.id, kind: this.kind, accepted: false, latencyMs: 0, error: "endpoint-unconfigured" };
    }
    const startedAt = performance.now();
    try {
      const headers: Record<string, string> = {
        "content-type": this.#mode === "plain-base64" ? "text/plain" : "application/json",
      };
      if (this.#authorization) headers.authorization = this.#authorization;
      const body = this.#mode === "plain-base64"
        ? transaction.wireTransaction
        : JSON.stringify({
          jsonrpc: "2.0",
          id: transaction.draft.idempotencyKey,
          method: this.#rpcMethod,
          params: this.#rpcMethod === "sendTransaction"
            ? [transaction.wireTransaction, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]
            : [transaction.wireTransaction],
        });
      const response = await this.#fetcher(this.#endpoint, { method: "POST", headers, body, signal });
      const latencyMs = performance.now() - startedAt;
      this.#latencyMs = this.#latencyMs * 0.7 + latencyMs * 0.3;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let responseId: string | undefined;
      if (this.#mode === "json-rpc") {
        const payload = await response.json() as { readonly result?: unknown; readonly error?: { readonly message?: string } };
        if (payload.error) throw new Error(payload.error.message ?? "Relay JSON-RPC error");
        responseId = typeof payload.result === "string" ? payload.result : undefined;
      }
      this.#successes += 1;
      this.#lastSuccessAt = Date.now();
      return { relayId: this.id, kind: this.kind, accepted: true, acceptedAt: Date.now(), latencyMs, responseId };
    } catch (error) {
      this.#failures += 1;
      return {
        relayId: this.id,
        kind: this.kind,
        accepted: false,
        latencyMs: performance.now() - startedAt,
        error: errorMessage(error),
      };
    }
  }
}

export function createSolanaRelayAdapters(config: {
  readonly network: "solana:devnet" | "solana:mainnet";
  readonly rpcEndpoint?: string;
  readonly jitoEndpoint?: string;
  readonly jitoAuthorization?: string;
  readonly nozomiEndpoint?: string;
  readonly zeroSlotEndpoint?: string;
  readonly fetcher?: typeof fetch;
}): readonly RelayAdapter[] {
  return Object.freeze([
    new HttpRelayAdapter({ id: "standard-rpc", kind: "rpc", networks: [config.network], endpoint: config.rpcEndpoint, fetcher: config.fetcher }),
    new HttpRelayAdapter({ id: "jito", kind: "jito", networks: [config.network], endpoint: config.jitoEndpoint, authorization: config.jitoAuthorization, fetcher: config.fetcher }),
    new HttpRelayAdapter({ id: "nozomi", kind: "nozomi", networks: [config.network], endpoint: config.nozomiEndpoint, fetcher: config.fetcher, mode: "plain-base64" }),
    new HttpRelayAdapter({ id: "0slot", kind: "0slot", networks: [config.network], endpoint: config.zeroSlotEndpoint, fetcher: config.fetcher }),
  ]);
}
