import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PUMP_PROGRAM_ID, pumpIdl } from "@pump-fun/pump-sdk";
import { Connection, PublicKey, type Logs } from "@solana/web3.js";
import type { EventSource, SniperEvent } from "../../sniper-engine/src/index.js";

interface PumpEventSourceOptions {
  readonly network: "solana:devnet" | "solana:mainnet";
  readonly rpcUrl: string;
  readonly websocketUrl?: string;
  readonly fundingAddress: string;
  readonly commitment?: "processed" | "confirmed";
}

interface AnchorEvent {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function value(data: Readonly<Record<string, unknown>>, snake: string, camel: string): unknown {
  return data[snake] ?? data[camel];
}

function publicKey(valueToConvert: unknown): string | undefined {
  if (valueToConvert instanceof PublicKey) return valueToConvert.toBase58();
  if (valueToConvert && typeof valueToConvert === "object" && "toBase58" in valueToConvert) {
    const candidate = (valueToConvert as { readonly toBase58?: unknown }).toBase58;
    if (typeof candidate === "function") return String(candidate.call(valueToConvert));
  }
  if (typeof valueToConvert === "string") {
    try {
      return new PublicKey(valueToConvert).toBase58();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function compactText(valueToConvert: unknown, max: number): string {
  return typeof valueToConvert === "string" ? valueToConvert.trim().slice(0, max) : "";
}

function integerString(valueToConvert: unknown): string | undefined {
  if (typeof valueToConvert === "bigint") return valueToConvert.toString();
  if (typeof valueToConvert === "number" && Number.isSafeInteger(valueToConvert)) return String(valueToConvert);
  if (valueToConvert && typeof valueToConvert === "object" && "toString" in valueToConvert) {
    const rendered = String(valueToConvert);
    return /^-?[0-9]+$/.test(rendered) ? rendered : undefined;
  }
  return undefined;
}

function decodeCreateEvent(coder: BorshCoder, logs: readonly string[]): AnchorEvent | undefined {
  for (const log of logs) {
    if (!log.startsWith("Program data: ")) continue;
    try {
      const decoded = coder.events.decode(log.slice("Program data: ".length));
      if (decoded?.name === "CreateEvent") return decoded as AnchorEvent;
    } catch {
      // One Pump transaction can emit several unrelated events; malformed data is ignored.
    }
  }
  return undefined;
}

export class PumpProgramEventSource implements EventSource {
  readonly id = "pump-create-program-logs";
  readonly networks: readonly ("solana:devnet" | "solana:mainnet")[];
  readonly #connection: Connection;
  readonly #network: "solana:devnet" | "solana:mainnet";
  readonly #fundingAddress: string;
  readonly #commitment: "processed" | "confirmed";
  readonly #coder = new BorshCoder(pumpIdl as unknown as Idl);
  readonly #seen = new Set<string>();

  constructor(options: PumpEventSourceOptions) {
    this.networks = Object.freeze([options.network]);
    this.#network = options.network;
    this.#fundingAddress = new PublicKey(options.fundingAddress).toBase58();
    this.#commitment = options.commitment ?? "processed";
    this.#connection = new Connection(options.rpcUrl, {
      commitment: this.#commitment,
      wsEndpoint: options.websocketUrl,
      disableRetryOnRateLimit: true,
    });
  }

  async start(onEvent: (event: SniperEvent) => void | Promise<void>): Promise<AbortController> {
    const controller = new AbortController();
    const listenerId = this.#connection.onLogs(PUMP_PROGRAM_ID, (notification: Logs, context) => {
      if (notification.err || controller.signal.aborted) return;
      const decoded = decodeCreateEvent(this.#coder, notification.logs);
      if (!decoded) return;
      const mint = publicKey(value(decoded.data, "mint", "mint"));
      if (!mint) return;
      const cursor = `${notification.signature}:${mint}`;
      if (this.#seen.has(cursor)) return;
      this.#seen.add(cursor);
      while (this.#seen.size > 10_000) {
        const oldest = this.#seen.values().next().value;
        if (!oldest) break;
        this.#seen.delete(oldest);
      }
      const creator = publicKey(value(decoded.data, "creator", "creator"));
      const name = compactText(value(decoded.data, "name", "name"), 128);
      const symbol = compactText(value(decoded.data, "symbol", "symbol"), 32);
      const uri = compactText(value(decoded.data, "uri", "uri"), 1_024);
      const attributes: Record<string, string | number | boolean> = {
        signature: notification.signature,
        slot: context.slot,
        name,
        symbol,
        uri,
      };
      const virtualSolReserves = integerString(value(decoded.data, "virtual_sol_reserves", "virtualSolReserves"));
      const virtualTokenReserves = integerString(value(decoded.data, "virtual_token_reserves", "virtualTokenReserves"));
      const totalSupply = integerString(value(decoded.data, "token_total_supply", "tokenTotalSupply"));
      if (virtualSolReserves) attributes.virtualSolReserves = virtualSolReserves;
      if (virtualTokenReserves) attributes.virtualTokenReserves = virtualTokenReserves;
      if (totalSupply) attributes.tokenTotalSupply = totalSupply;
      const event: SniperEvent = Object.freeze({
        id: `pump-create:${cursor}`,
        source: "program-log",
        sourceCursor: cursor,
        sourceAccount: creator,
        kind: "new_mint",
        network: this.#network,
        receivedAt: Date.now(),
        target: mint,
        mint,
        account: this.#fundingAddress,
        text: `${name} ${symbol}`.trim(),
        hasMedia: Boolean(uri),
        attributes: Object.freeze(attributes),
      });
      void Promise.resolve(onEvent(event)).catch(() => undefined);
    }, this.#commitment);
    controller.signal.addEventListener("abort", () => {
      void this.#connection.removeOnLogsListener(listenerId).catch(() => undefined);
    }, { once: true });
    return controller;
  }
}
