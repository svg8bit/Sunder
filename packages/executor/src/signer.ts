import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { z } from "zod";
import type { ChainNetworkId, SignedTransaction, TransactionDraft, WalletAdapter } from "../../sniper-engine/src/index.js";

const responseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  signature: z.string().min(1).max(256),
  wireTransaction: z.string().min(1).max(4_000_000),
});
const errorResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  error: z.string().min(1).max(512),
});
const statusResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  status: z.literal("ready"),
  service: z.literal("sunder-policy-signer"),
  publicKey: z.string().min(32).max(64),
  networks: z.array(z.enum(["solana:devnet", "solana:mainnet"])).min(1).max(2),
  policy: z.object({
    maxPumpSpendLamports: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    maxTipLamports: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    maxComputeUnitLimit: z.number().int().positive(),
    maxComputeUnitPriceMicroLamports: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  }),
});
const MAX_RESPONSE_BYTES = 4_100_000;

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function validateSignedPayload(transaction: TransactionDraft, signature: string, wireTransaction: string): void {
  if (transaction.chain.family === "evm") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(signature)) throw new Error("Signer returned an invalid EVM transaction hash.");
    if (!/^0x[0-9a-fA-F]+$/.test(wireTransaction) || wireTransaction.length % 2 !== 0) {
      throw new Error("Signer returned an invalid raw EVM transaction.");
    }
    return;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(signature)) throw new Error("Signer returned an invalid Solana signature.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(wireTransaction)) throw new Error("Signer returned an invalid base64 Solana transaction.");
}

function requestSocket(path: string, payload: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const responseChunks: Buffer[] = [];
    let responseBytes = 0;
    const deadline: { current?: NodeJS.Timeout } = {};
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (deadline.current) clearTimeout(deadline.current);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(abortError());
    deadline.current = setTimeout(() => finish(new Error("Signer request deadline exceeded.")), 5_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.connect({ path }, () => socket.write(`${payload}\n`));
    socket.setTimeout(5_000, () => finish(new Error("Signer socket timed out.")));
    socket.on("data", (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const relevant = newline === -1 ? chunk : chunk.subarray(0, newline);
      responseBytes += relevant.length;
      if (responseBytes > MAX_RESPONSE_BYTES) return finish(new Error("Signer response exceeded the size limit."));
      responseChunks.push(relevant);
      if (newline === -1) return;
      try {
        finish(undefined, JSON.parse(Buffer.concat(responseChunks, responseBytes).toString("utf8")) as unknown);
      } catch {
        finish(new Error("Signer returned malformed JSON."));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled) finish(new Error("Signer closed the socket before returning a response."));
    });
  });
}

export class UnixSocketWalletAdapter implements WalletAdapter {
  readonly id = "unix-socket-policy-signer";
  readonly kind = "encrypted-external" as const;
  readonly networks: readonly ChainNetworkId[];
  readonly #path: string;

  constructor(path: string, networks: readonly ChainNetworkId[]) {
    this.#path = path;
    this.networks = Object.freeze([...networks]);
  }

  async sign(transaction: TransactionDraft, signal?: AbortSignal): Promise<SignedTransaction> {
    if (!this.networks.includes(transaction.chain.id)) throw new Error(`Signer policy does not allow ${transaction.chain.id}.`);
    const requestId = randomUUID();
    const request = JSON.stringify({
      version: 1,
      requestId,
      method: "signTransaction",
      network: transaction.chain.id,
      idempotencyKey: transaction.idempotencyKey,
      lifetime: transaction.lifetime,
      feePolicy: transaction.feePolicy,
      manifest: transaction.instructions,
      unsignedPayload: transaction.unsignedPayload,
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    const rawResponse = await requestSocket(this.#path, request, signal);
    const failed = errorResponseSchema.safeParse(rawResponse);
    if (failed.success && failed.data.requestId === requestId) throw new Error(`Signer policy rejected the transaction: ${failed.data.error}`);
    const parsed = responseSchema.parse(rawResponse);
    if (parsed.requestId !== requestId) throw new Error("Signer response requestId mismatch.");
    validateSignedPayload(transaction, parsed.signature, parsed.wireTransaction);
    return Object.freeze({
      draft: transaction,
      signature: parsed.signature,
      wireTransaction: parsed.wireTransaction,
      signedAt: Date.now(),
    });
  }
}

export interface SignerStatus {
  readonly publicKey: string;
  readonly networks: readonly ("solana:devnet" | "solana:mainnet")[];
  readonly policy: Readonly<{
    maxPumpSpendLamports: bigint;
    maxTipLamports: bigint;
    maxComputeUnitLimit: number;
    maxComputeUnitPriceMicroLamports: bigint;
  }>;
}

export async function querySignerStatus(path: string, signal?: AbortSignal): Promise<SignerStatus> {
  const requestId = randomUUID();
  const response = statusResponseSchema.parse(await requestSocket(path, JSON.stringify({
    version: 1,
    requestId,
    method: "status",
  }), signal));
  if (response.requestId !== requestId) throw new Error("Signer status response requestId mismatch.");
  return Object.freeze({
    publicKey: response.publicKey,
    networks: Object.freeze([...response.networks]),
    policy: Object.freeze({
      maxPumpSpendLamports: BigInt(response.policy.maxPumpSpendLamports),
      maxTipLamports: BigInt(response.policy.maxTipLamports),
      maxComputeUnitLimit: response.policy.maxComputeUnitLimit,
      maxComputeUnitPriceMicroLamports: BigInt(response.policy.maxComputeUnitPriceMicroLamports),
    }),
  });
}
