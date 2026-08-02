import { parseSignerConfig } from "./config.js";
import { initializeSignerMaterial } from "./keystore.js";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function atomicArgument(name: string, fallback: string): bigint {
  const value = argument(name, fallback);
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value)) throw new Error(`--${name} must be an unsigned integer.`);
  return BigInt(value);
}

const tipAccounts = argument("jito-tip-accounts", "").split(",").map((entry) => entry.trim()).filter(Boolean);
if (tipAccounts.length === 0) throw new Error("--jito-tip-accounts must contain at least one official Jito tip account.");
const network = argument("network", "solana:mainnet");
if (network !== "solana:mainnet" && network !== "solana:devnet") throw new Error("--network must be solana:mainnet or solana:devnet.");

const publicKey = await initializeSignerMaterial(parseSignerConfig(), {
  networks: Object.freeze([network]),
  maxPumpSpendLamports: atomicArgument("max-pump-spend-lamports", "1100000"),
  maxTipLamports: atomicArgument("max-tip-lamports", "10000"),
  maxComputeUnitLimit: Number(atomicArgument("max-compute-unit-limit", "300000")),
  maxComputeUnitPriceMicroLamports: atomicArgument("max-compute-unit-price-micro-lamports", "100000"),
  jitoTipAccounts: Object.freeze(tipAccounts),
});

process.stdout.write(`${JSON.stringify({ status: "created", publicKey })}\n`);
