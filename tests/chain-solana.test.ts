// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, type AccountInfo, type Connection } from "@solana/web3.js";
import { PumpTransactionAdapter, resolvePumpTokenProgram } from "../packages/chain-solana/src/index.js";
import {
  SolanaConfirmationAdapter,
  type ConfirmationRpc,
  type SignedTransaction,
  type TransactionDraft,
} from "../packages/sniper-engine/src/index.js";
import { CHAIN_DESCRIPTORS } from "../packages/sniper-engine/src/types.js";

function transaction(lastValidBlockHeight = 200n): SignedTransaction {
  const draft: TransactionDraft = {
    idempotencyKey: "solana-test",
    chain: CHAIN_DESCRIPTORS["solana:devnet"],
    eventId: "event",
    quoteId: "quote",
    lifetime: { kind: "solana-blockhash", blockhash: "blockhash", lastValidBlockHeight },
    feePolicy: { kind: "solana", computeUnitLimit: 200_000, computeUnitPriceMicroLamports: 1_000n, tipLamports: 0n },
    instructions: [],
    unsignedPayload: "payload",
    createdAt: Date.now(),
  };
  return { draft, signature: "canonical-signature", wireTransaction: "wire", signedAt: Date.now() };
}

describe("SolanaConfirmationAdapter", () => {
  it("uses polling fallback and confirms only a real RPC signature status", async () => {
    const getSignatureStatus = vi.fn()
      .mockResolvedValueOnce({ confirmationStatus: "processed", slot: 10n })
      .mockResolvedValueOnce({ confirmationStatus: "confirmed", slot: 11n });
    const rpc: ConfirmationRpc = {
      subscribeSignature: vi.fn(async () => { throw new Error("websocket unavailable"); }),
      getSignatureStatus,
      getBlockHeight: vi.fn(async () => 100n),
    };
    const result = await new SolanaConfirmationAdapter(rpc, { networks: ["solana:devnet"], pollIntervalMs: 0, timeoutMs: 1_000 }).track(transaction());
    expect(result).toMatchObject({ confirmed: true, state: "confirmed", signature: "canonical-signature" });
    expect(getSignatureStatus).toHaveBeenCalledTimes(2);
  });

  it("does not regress a websocket status from confirmed back to processed", async () => {
    const getSignatureStatus = vi.fn(async () => null);
    const rpc: ConfirmationRpc = {
      subscribeSignature: vi.fn(async (_signature, onStatus) => {
        onStatus({ confirmationStatus: "confirmed", slot: 11n });
        onStatus({ confirmationStatus: "processed", slot: 10n });
      }),
      getSignatureStatus,
      getBlockHeight: vi.fn(async () => 100n),
    };
    const result = await new SolanaConfirmationAdapter(rpc, { networks: ["solana:devnet"], pollIntervalMs: 0, timeoutMs: 1_000 }).track(transaction());
    expect(result).toMatchObject({ confirmed: true, state: "confirmed" });
    expect(getSignatureStatus).not.toHaveBeenCalled();
  });

  it("expires when the blockhash lifetime passes without a signature status", async () => {
    const rpc: ConfirmationRpc = {
      getSignatureStatus: vi.fn(async () => null),
      getBlockHeight: vi.fn(async () => 201n),
    };
    const result = await new SolanaConfirmationAdapter(rpc, { networks: ["solana:devnet"], pollIntervalMs: 0 }).track(transaction());
    expect(result).toMatchObject({ confirmed: false, state: "expired" });
  });
});

describe("Pump transaction simulation", () => {
  it("includes compute-unit priority price and relay tip in estimated fees", async () => {
    const payer = new PublicKey("11111111111111111111111111111111");
    const unsigned = new Transaction({ feePayer: payer, recentBlockhash: "11111111111111111111111111111111" })
      .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 }))
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    const connection = {
      simulateTransaction: vi.fn(async () => ({ value: { err: null, logs: ["ok"], unitsConsumed: 42_000 } })),
    } as unknown as Connection;
    const adapter = new PumpTransactionAdapter({ network: "solana:devnet" }, connection);
    const draft: TransactionDraft = {
      ...transaction().draft,
      feePolicy: { kind: "solana", computeUnitLimit: 200_000, computeUnitPriceMicroLamports: 1_000n, tipLamports: 50n },
      unsignedPayload: unsigned,
    };
    await expect(adapter.simulate(draft)).resolves.toMatchObject({ ok: true, estimatedFeeAtomic: 5_250n, unitsConsumed: 42_000n });
  });
});

describe("Pump token-program resolution", () => {
  const mint = Keypair.generate().publicKey;
  const account = (owner: PublicKey): AccountInfo<Buffer> => ({
    data: Buffer.alloc(0),
    executable: false,
    lamports: 1,
    owner,
    rentEpoch: 0,
  });

  it.each([
    ["legacy Token Program", TOKEN_PROGRAM_ID],
    ["Token-2022", TOKEN_2022_PROGRAM_ID],
  ])("uses the actual mint owner for %s Pump tokens", async (_label, owner) => {
    const connection = { getAccountInfo: vi.fn(async () => account(owner)) } as unknown as Pick<Connection, "getAccountInfo">;
    await expect(resolvePumpTokenProgram(connection, mint)).resolves.toEqual(owner);
  });

  it("rejects missing and non-token mint accounts before a transaction is signed", async () => {
    const missing = { getAccountInfo: vi.fn(async () => null) } as unknown as Pick<Connection, "getAccountInfo">;
    await expect(resolvePumpTokenProgram(missing, mint)).rejects.toThrow(/mint account not found/i);

    const unsupportedOwner = Keypair.generate().publicKey;
    const unsupported = { getAccountInfo: vi.fn(async () => account(unsupportedOwner)) } as unknown as Pick<Connection, "getAccountInfo">;
    await expect(resolvePumpTokenProgram(unsupported, mint)).rejects.toThrow(/unsupported token program/i);
  });
});
