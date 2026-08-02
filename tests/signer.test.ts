// @vitest-environment node

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PUMP_PROGRAM_ID, pumpIdl } from "@pump-fun/pump-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TransactionDraft } from "../packages/sniper-engine/src/index.js";
import { UnixSocketWalletAdapter, querySignerStatus } from "../packages/executor/src/signer.js";
import { parseSignerConfig } from "../packages/signer/src/config.js";
import { initializeSignerMaterial } from "../packages/signer/src/keystore.js";
import { startSignerServer } from "../packages/signer/src/server.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((operation) => operation()));
});

async function signerFixture(maxPumpSpendLamports = 1_100n) {
  const directory = await mkdtemp(join(tmpdir(), "sunder-signer-test-"));
  const environment = {
    SUNDER_SIGNER_SOCKET: join(directory, "signer.sock"),
    SUNDER_SIGNER_KEYSTORE_FILE: join(directory, "keystore.json"),
    SUNDER_SIGNER_KEK_FILE: join(directory, "kek"),
    SUNDER_SIGNER_POLICY_FILE: join(directory, "policy.json"),
  };
  const config = parseSignerConfig(environment);
  const tip = Keypair.generate().publicKey.toBase58();
  const publicKey = await initializeSignerMaterial(config, {
    networks: ["solana:mainnet"],
    maxPumpSpendLamports,
    maxTipLamports: 2_000n,
    maxComputeUnitLimit: 300_000,
    maxComputeUnitPriceMicroLamports: 100_000n,
    jitoTipAccounts: [tip],
  });
  const service = await startSignerServer(environment);
  cleanup.push(service.close);
  cleanup.push(async () => rm(directory, { recursive: true, force: true }));
  return { environment, config, publicKey, tip };
}

function draft(publicKey: string, tip: string, maxSolCost: bigint, extraInstruction?: TransactionInstruction): TransactionDraft {
  const feePolicy = {
    kind: "solana" as const,
    computeUnitLimit: 250_000,
    computeUnitPriceMicroLamports: 50_000n,
    tipLamports: 1_000n,
  };
  const coder = new BorshInstructionCoder(pumpIdl as unknown as Idl);
  const transaction = new Transaction({
    feePayer: new PublicKey(publicKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1,
  });
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: feePolicy.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: feePolicy.computeUnitPriceMicroLamports }),
    SystemProgram.transfer({ fromPubkey: transaction.feePayer!, toPubkey: new PublicKey(tip), lamports: feePolicy.tipLamports }),
  );
  if (extraInstruction) transaction.add(extraInstruction);
  transaction.add(new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [],
      data: coder.encode("buy", { amount: new BN(100), max_sol_cost: new BN(maxSolCost.toString()), track_volume: false }),
    }));
  return Object.freeze({
    idempotencyKey: `signer-test-${maxSolCost}-${extraInstruction?.programId.toBase58() ?? "plain"}`,
    chain: Object.freeze({ id: "solana:mainnet", family: "solana", chainId: "mainnet-beta", name: "Solana Mainnet", nativeSymbol: "SOL", production: true, explorerBaseUrl: "https://explorer.solana.com" }),
    eventId: "event-1",
    quoteId: "quote-1",
    lifetime: Object.freeze({ kind: "solana-blockhash", blockhash: transaction.recentBlockhash!, lastValidBlockHeight: 1n }),
    feePolicy: Object.freeze(feePolicy),
    instructions: Object.freeze(transaction.instructions.map((instruction) => Object.freeze({
      program: instruction.programId.toBase58(),
      action: instruction.programId.equals(PUMP_PROGRAM_ID) ? "pump-buy" : "solana-instruction",
      accounts: Object.freeze(instruction.keys.map((key) => key.pubkey.toBase58())),
      dataDigest: Buffer.from(instruction.data).subarray(0, 16).toString("hex"),
    }))),
    unsignedPayload: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    createdAt: Date.now(),
  });
}

describe("Sunder policy signer", () => {
  it("creates encrypted signer material without exposing a secret and reports the exact public policy", async () => {
    const fixture = await signerFixture();
    const status = await querySignerStatus(fixture.config.socketPath);
    expect(status.publicKey).toBe(fixture.publicKey);
    expect(status.networks).toEqual(["solana:mainnet"]);
    expect(status.policy).toMatchObject({ maxPumpSpendLamports: 1_100n, maxTipLamports: 2_000n });
  });

  it("signs an allowed Pump buy and rejects a Pump spend above the independent signer cap", async () => {
    const fixture = await signerFixture();
    const wallet = new UnixSocketWalletAdapter(fixture.config.socketPath, ["solana:mainnet"]);
    const signed = await wallet.sign(draft(fixture.publicKey, fixture.tip, 1_100n));
    expect(signed.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,128}$/);
    await expect(wallet.sign(draft(fixture.publicKey, fixture.tip, 1_101n))).rejects.toThrow(/max spend policy/i);
  });

  it("allows only the signer's own associated-token creation and rejects direct token transfers", async () => {
    const fixture = await signerFixture();
    const wallet = new UnixSocketWalletAdapter(fixture.config.socketPath, ["solana:mainnet"]);
    const owner = new PublicKey(fixture.publicKey);
    const mint = Keypair.generate().publicKey;
    const associated = getAssociatedTokenAddressSync(mint, owner);
    const createAssociated = createAssociatedTokenAccountIdempotentInstruction(owner, associated, owner, mint);
    await expect(wallet.sign(draft(fixture.publicKey, fixture.tip, 1_100n, createAssociated))).resolves.toMatchObject({ draft: { chain: { id: "solana:mainnet" } } });

    const directTransfer = createTransferInstruction(
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
      owner,
      1n,
      [],
      TOKEN_PROGRAM_ID,
    );
    await expect(wallet.sign(draft(fixture.publicKey, fixture.tip, 1_100n, directTransfer))).rejects.toThrow(/not allowed by the signer policy/i);
  });

  it("requires signer material and policy files to remain owner-only", async () => {
    const fixture = await signerFixture();
    await chmod(fixture.config.policyFile, 0o644);
    await expect(startSignerServer(fixture.environment)).rejects.toThrow(/mode 0600/);
  });
});
