import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import { z } from "zod";
import type { SignerConfig } from "./config.js";
import { readRestrictedFile, type SignerPolicy } from "./policy.js";

const keystoreSchema = z.object({
  version: z.literal(1),
  cipher: z.literal("aes-256-gcm"),
  publicKey: z.string(),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
});

async function assertMissing(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing signer material: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function writeAtomicRestricted(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function initializeSignerMaterial(
  config: SignerConfig,
  policyInput: Omit<SignerPolicy, "version" | "publicKey">,
): Promise<string> {
  await Promise.all([config.keystoreFile, config.kekFile, config.policyFile].map(assertMissing));
  const keypair = Keypair.generate();
  const kek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(keypair.secretKey), cipher.final()]);
  const publicKey = keypair.publicKey.toBase58();
  const keystore = {
    version: 1,
    cipher: "aes-256-gcm",
    publicKey,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  } as const;
  const policy = {
    version: 1,
    publicKey,
    ...policyInput,
    maxPumpSpendLamports: policyInput.maxPumpSpendLamports.toString(),
    maxTipLamports: policyInput.maxTipLamports.toString(),
    maxComputeUnitPriceMicroLamports: policyInput.maxComputeUnitPriceMicroLamports.toString(),
  } as const;
  await writeAtomicRestricted(config.kekFile, kek.toString("hex"));
  await writeAtomicRestricted(config.keystoreFile, `${JSON.stringify(keystore, null, 2)}\n`);
  await writeAtomicRestricted(config.policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  keypair.secretKey.fill(0);
  kek.fill(0);
  return publicKey;
}

export async function loadKeypair(config: SignerConfig): Promise<Keypair> {
  const [keystoreBytes, kekBytes] = await Promise.all([
    readRestrictedFile(config.keystoreFile),
    readRestrictedFile(config.kekFile),
  ]);
  const keystore = keystoreSchema.parse(JSON.parse(keystoreBytes.toString("utf8")));
  const kekText = kekBytes.toString("utf8").trim();
  if (!/^[0-9a-f]{64}$/iu.test(kekText)) throw new Error("Signer KEK file must contain exactly 32 hex-encoded bytes.");
  const kek = Buffer.from(kekText, "hex");
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(keystore.iv, "base64"));
  decipher.setAuthTag(Buffer.from(keystore.authTag, "base64"));
  const secret = Buffer.concat([decipher.update(Buffer.from(keystore.ciphertext, "base64")), decipher.final()]);
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  secret.fill(0);
  kek.fill(0);
  if (keypair.publicKey.toBase58() !== keystore.publicKey) throw new Error("Signer keystore public key mismatch.");
  return keypair;
}
