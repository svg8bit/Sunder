import type { EventSource, SniperEvent } from "./types.js";

export class ManualEventSource implements EventSource {
  readonly id = "manual";
  readonly networks = ["solana:devnet", "solana:mainnet", "evm:sepolia", "evm:mainnet"] as const;
  #onEvent?: (event: SniperEvent) => void | Promise<void>;
  #controller?: AbortController;

  async start(onEvent: (event: SniperEvent) => void | Promise<void>): Promise<AbortController> {
    this.#controller?.abort();
    this.#controller = new AbortController();
    this.#onEvent = onEvent;
    this.#controller.signal.addEventListener("abort", () => {
      this.#onEvent = undefined;
    }, { once: true });
    return this.#controller;
  }

  async emit(event: SniperEvent): Promise<void> {
    if (!this.#onEvent || this.#controller?.signal.aborted) {
      throw new Error("ManualEventSource is not started.");
    }
    await this.#onEvent(Object.freeze({ ...event, attributes: Object.freeze({ ...event.attributes }) }));
  }
}

export class JsonWebSocketEventSource implements EventSource {
  readonly id: string;
  readonly networks: EventSource["networks"];
  readonly #url: string;
  readonly #parse: (payload: unknown) => SniperEvent | null;

  constructor(options: { readonly id: string; readonly networks: EventSource["networks"]; readonly url: string; readonly parse: (payload: unknown) => SniperEvent | null }) {
    this.id = options.id;
    this.networks = options.networks;
    this.#url = options.url;
    this.#parse = options.parse;
  }

  async start(onEvent: (event: SniperEvent) => void | Promise<void>): Promise<AbortController> {
    const controller = new AbortController();
    const socket = new WebSocket(this.#url);
    socket.addEventListener("message", (message) => {
      try {
        const event = this.#parse(JSON.parse(String(message.data)) as unknown);
        if (event) void onEvent(Object.freeze(event));
      } catch {
        // Malformed provider payloads are ignored and must not enter the execution path.
      }
    });
    controller.signal.addEventListener("abort", () => socket.close(1000, "source stopped"), { once: true });
    return controller;
  }
}
