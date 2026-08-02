import { open } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const atomicSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).transform((value) => BigInt(value));

const policySchema = z.object({
  version: z.literal(1),
  publicKey: z.string().transform((value, context) => {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      context.addIssue({ code: "custom", message: "Invalid Solana public key." });
      return z.NEVER;
    }
  }),
  networks: z.array(z.enum(["solana:devnet", "solana:mainnet"])).min(1).max(2),
  maxPumpSpendLamports: atomicSchema,
  maxTipLamports: atomicSchema,
  maxComputeUnitLimit: z.number().int().min(10_000).max(1_400_000),
  maxComputeUnitPriceMicroLamports: atomicSchema,
  jitoTipAccounts: z.array(z.string().transform((value, context) => {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      context.addIssue({ code: "custom", message: "Invalid Jito tip account." });
      return z.NEVER;
    }
  })).min(1).max(32),
});

export interface SignerPolicy {
  readonly version: 1;
  readonly publicKey: string;
  readonly networks: readonly ("solana:devnet" | "solana:mainnet")[];
  readonly maxPumpSpendLamports: bigint;
  readonly maxTipLamports: bigint;
  readonly maxComputeUnitLimit: number;
  readonly maxComputeUnitPriceMicroLamports: bigint;
  readonly jitoTipAccounts: readonly string[];
}

export async function readRestrictedFile(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${path} is not a regular file.`);
    if ((metadata.mode & 0o077) !== 0) throw new Error(`${path} must be mode 0600.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function loadSignerPolicy(path: string): Promise<SignerPolicy> {
  const parsed = policySchema.parse(JSON.parse((await readRestrictedFile(path)).toString("utf8"))) as SignerPolicy;
  return Object.freeze({
    ...parsed,
    networks: Object.freeze([...parsed.networks]),
    jitoTipAccounts: Object.freeze([...parsed.jitoTipAccounts]),
  });
}
