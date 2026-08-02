import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PUMP_PROGRAM_ID, pumpIdl } from "@pump-fun/pump-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { parseSignerConfig, type SignerConfig } from "./config.js";
import { loadKeypair } from "./keystore.js";
import { loadSignerPolicy, type SignerPolicy } from "./policy.js";

const MAX_REQUEST_BYTES = 4_100_000;
const atomicSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).transform((value) => BigInt(value));
const baseRequestSchema = z.object({ version: z.literal(1), requestId: z.string().uuid() });
const statusRequestSchema = baseRequestSchema.extend({ method: z.literal("status") });
const signRequestSchema = baseRequestSchema.extend({
  method: z.literal("signTransaction"),
  network: z.enum(["solana:devnet", "solana:mainnet"]),
  idempotencyKey: z.string().min(1).max(512),
  lifetime: z.object({
    kind: z.literal("solana-blockhash"),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: atomicSchema,
  }),
  feePolicy: z.object({
    kind: z.literal("solana"),
    computeUnitLimit: z.number().int().min(10_000).max(1_400_000),
    computeUnitPriceMicroLamports: atomicSchema,
    tipLamports: atomicSchema,
  }),
  manifest: z.array(z.object({
    program: z.string().min(1).max(128),
    action: z.string().min(1).max(128),
    accounts: z.array(z.string().max(128)).max(64),
    dataDigest: z.string().max(128),
  })).min(1).max(64),
  unsignedPayload: z.string().min(1).max(4_000_000),
});
const requestSchema = z.discriminatedUnion("method", [statusRequestSchema, signRequestSchema]);

type SignRequest = z.infer<typeof signRequestSchema>;
type SignResponse = Readonly<{ version: 1; requestId: string; signature: string; wireTransaction: string }>;

function integer(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    const rendered = String(value);
    if (/^(?:0|[1-9][0-9]*)$/.test(rendered)) return BigInt(rendered);
  }
  throw new Error(`${label} is not an unsigned integer.`);
}

function u32(data: Buffer, offset: number): number {
  if (data.length < offset + 4) throw new Error("Truncated instruction data.");
  return data.readUInt32LE(offset);
}

function u64(data: Buffer, offset: number): bigint {
  if (data.length < offset + 8) throw new Error("Truncated instruction data.");
  return data.readBigUInt64LE(offset);
}

function pumpSpend(instruction: TransactionInstruction, coder: BorshInstructionCoder): bigint {
  const decoded = coder.decode(instruction.data);
  if (!decoded) throw new Error("Signer could not decode the Pump instruction.");
  const data = decoded.data as Readonly<Record<string, unknown>>;
  switch (decoded.name) {
    case "buy":
    case "buy_v2":
      return integer(data.maxSolCost ?? data.max_sol_cost, "Pump max_sol_cost");
    case "buy_exact_sol_in":
      return integer(data.spendableSolIn ?? data.spendable_sol_in, "Pump spendable_sol_in");
    case "buy_exact_quote_in_v2":
      return integer(data.spendableQuoteIn ?? data.spendable_quote_in, "Pump spendable_quote_in");
    default:
      throw new Error(`Pump instruction ${decoded.name} is not allowed by the sniper signer policy.`);
  }
}

function validateAssociatedTokenInstruction(instruction: TransactionInstruction, publicKey: string): void {
  const data = Buffer.from(instruction.data);
  if (!(data.length === 0 || (data.length === 1 && data[0] === 1))) {
    throw new Error("Only create and create-idempotent Associated Token instructions are allowed.");
  }
  const payer = instruction.keys[0]?.pubkey.toBase58();
  const owner = instruction.keys[2]?.pubkey.toBase58();
  const systemProgram = instruction.keys[4]?.pubkey;
  const tokenProgram = instruction.keys[5]?.pubkey;
  if (payer !== publicKey || owner !== publicKey) {
    throw new Error("Associated Token account payer and owner must match the signer policy public key.");
  }
  if (!systemProgram?.equals(SystemProgram.programId)) {
    throw new Error("Associated Token instruction has an invalid System Program account.");
  }
  if (!tokenProgram || (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new Error("Associated Token instruction has an invalid token program account.");
  }
}

function validateTransaction(request: SignRequest, policy: SignerPolicy): Transaction {
  if (!policy.networks.includes(request.network)) throw new Error(`Signer policy does not allow ${request.network}.`);
  const raw = Buffer.from(request.unsignedPayload, "base64");
  if (raw.length === 0 || raw.toString("base64").replace(/=+$/u, "") !== request.unsignedPayload.replace(/=+$/u, "")) {
    throw new Error("Unsigned transaction is not canonical base64.");
  }
  const transaction = Transaction.from(raw);
  const message = transaction.compileMessage();
  if (message.header.numRequiredSignatures !== 1) throw new Error("Signer policy requires exactly one transaction signer.");
  if (message.accountKeys[0]?.toBase58() !== policy.publicKey || transaction.feePayer?.toBase58() !== policy.publicKey) {
    throw new Error("Transaction fee payer does not match the signer policy public key.");
  }
  if (transaction.recentBlockhash !== request.lifetime.blockhash) throw new Error("Transaction blockhash does not match the signed request lifetime.");
  if (transaction.signatures.some((entry) => entry.signature !== null)) throw new Error("Signer accepts only unsigned Solana transactions.");
  const actualPrograms = transaction.instructions.map((instruction) => instruction.programId.toBase58());
  const manifestPrograms = request.manifest.map((item) => item.program);
  if (actualPrograms.length !== manifestPrograms.length || actualPrograms.some((program, index) => program !== manifestPrograms[index])) {
    throw new Error("Transaction instruction programs do not match the executor manifest.");
  }

  const coder = new BorshInstructionCoder(pumpIdl as unknown as Idl);
  const allowedPrograms = new Set([
    ComputeBudgetProgram.programId.toBase58(),
    SystemProgram.programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    PUMP_PROGRAM_ID.toBase58(),
  ]);
  let computeUnitLimit: number | undefined;
  let computeUnitPrice: bigint | undefined;
  let pumpInstructions = 0;
  let totalTipLamports = 0n;
  for (const instruction of transaction.instructions) {
    const program = instruction.programId.toBase58();
    if (!allowedPrograms.has(program)) throw new Error(`Program ${program} is not allowed by the signer policy.`);
    if (instruction.programId.equals(ComputeBudgetProgram.programId)) {
      const data = Buffer.from(instruction.data);
      const kind = data[0];
      if (kind === 2) computeUnitLimit = u32(data, 1);
      else if (kind === 3) computeUnitPrice = u64(data, 1);
      else throw new Error(`Compute Budget instruction ${String(kind)} is not allowed.`);
      continue;
    }
    if (instruction.programId.equals(SystemProgram.programId)) {
      const data = Buffer.from(instruction.data);
      if (u32(data, 0) !== 2) throw new Error("Only SystemProgram transfer tips are allowed.");
      const destination = instruction.keys[1]?.pubkey.toBase58();
      if (!destination || !policy.jitoTipAccounts.includes(destination)) throw new Error("System transfer destination is not an approved Jito tip account.");
      totalTipLamports += u64(data, 4);
      continue;
    }
    if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      validateAssociatedTokenInstruction(instruction, policy.publicKey);
      continue;
    }
    if (instruction.programId.equals(PUMP_PROGRAM_ID)) {
      pumpInstructions += 1;
      const spend = pumpSpend(instruction, coder);
      if (spend > policy.maxPumpSpendLamports) throw new Error("Pump transaction exceeds signer max spend policy.");
    }
  }
  if (pumpInstructions !== 1) throw new Error("A sniper transaction must contain exactly one approved Pump buy instruction.");
  if (computeUnitLimit === undefined || computeUnitPrice === undefined) throw new Error("Explicit compute unit limit and price are required.");
  if (computeUnitLimit !== request.feePolicy.computeUnitLimit || BigInt(computeUnitPrice) !== request.feePolicy.computeUnitPriceMicroLamports) {
    throw new Error("Raw compute budget does not match the executor fee policy.");
  }
  if (totalTipLamports !== request.feePolicy.tipLamports) throw new Error("Raw Jito tip does not match the executor fee policy.");
  if (computeUnitLimit > policy.maxComputeUnitLimit) throw new Error("Compute unit limit exceeds signer policy.");
  if (computeUnitPrice > policy.maxComputeUnitPriceMicroLamports) throw new Error("Compute unit price exceeds signer policy.");
  if (totalTipLamports > policy.maxTipLamports) throw new Error("Jito tip exceeds signer policy.");
  return transaction;
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket()) throw new Error(`Refusing to replace non-socket path ${path}.`);
    await unlink(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function reply(socket: Socket, body: unknown): void {
  socket.end(`${JSON.stringify(body)}\n`);
}

export async function startSignerServer(environment: NodeJS.ProcessEnv = process.env): Promise<Readonly<{
  server: Server;
  config: SignerConfig;
  publicKey: string;
  close(): Promise<void>;
}>> {
  const config = parseSignerConfig(environment);
  const [policy, keypair] = await Promise.all([loadSignerPolicy(config.policyFile), loadKeypair(config)]);
  if (policy.publicKey !== keypair.publicKey.toBase58()) throw new Error("Signer policy and encrypted key public keys do not match.");
  await mkdir(dirname(config.socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(config.socketPath);
  const replay = new Map<string, Readonly<{ digest: string; response: SignResponse }>>();
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      const newline = chunk.indexOf(0x0a);
      const relevant = newline === -1 ? chunk : chunk.subarray(0, newline);
      bytes += relevant.length;
      if (bytes > MAX_REQUEST_BYTES) {
        handled = true;
        return reply(socket, { version: 1, requestId: crypto.randomUUID(), error: "request-too-large" });
      }
      chunks.push(relevant);
      if (newline === -1) return;
      handled = true;
      let requestId: string = crypto.randomUUID();
      try {
        const parsed = requestSchema.parse(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
        requestId = parsed.requestId;
        if (parsed.method === "status") {
          return reply(socket, {
            version: 1,
            requestId,
            status: "ready",
            service: "sunder-policy-signer",
            publicKey: policy.publicKey,
            networks: policy.networks,
            policy: {
              maxPumpSpendLamports: policy.maxPumpSpendLamports.toString(),
              maxTipLamports: policy.maxTipLamports.toString(),
              maxComputeUnitLimit: policy.maxComputeUnitLimit,
              maxComputeUnitPriceMicroLamports: policy.maxComputeUnitPriceMicroLamports.toString(),
            },
          });
        }
        const digest = createHash("sha256").update(parsed.unsignedPayload).digest("hex");
        const previous = replay.get(parsed.idempotencyKey);
        if (previous) {
          if (previous.digest !== digest) throw new Error("Idempotency key was reused with a different transaction.");
          return reply(socket, previous.response);
        }
        const transaction = validateTransaction(parsed, policy);
        transaction.sign(keypair);
        const signatureBytes = transaction.signature;
        if (!signatureBytes) throw new Error("Signer failed to produce a Solana signature.");
        const response: SignResponse = Object.freeze({
          version: 1,
          requestId,
          signature: bs58.encode(signatureBytes),
          wireTransaction: transaction.serialize().toString("base64"),
        });
        replay.set(parsed.idempotencyKey, Object.freeze({ digest, response }));
        while (replay.size > 10_000) {
          const oldest = replay.keys().next().value;
          if (!oldest) break;
          replay.delete(oldest);
        }
        return reply(socket, response);
      } catch (error) {
        return reply(socket, {
          version: 1,
          requestId,
          error: error instanceof Error ? error.message.slice(0, 512) : "signing-failed",
        });
      }
    });
    socket.setTimeout(5_000, () => socket.destroy());
  });
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(config.socketPath, 0o660);
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    server,
    config,
    publicKey: policy.publicKey,
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        server.close(async (error) => {
          keypair.secretKey.fill(0);
          try {
            await removeStaleSocket(config.socketPath);
          } catch {
            // The socket may already be gone during service shutdown.
          }
          if (error) reject(error); else resolve();
        });
      });
      return closePromise;
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const service = await startSignerServer();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await service.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
