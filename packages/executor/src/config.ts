import { isIP } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";
import type { ChainNetworkId } from "../../sniper-engine/src/index.js";

const NETWORKS = ["solana:devnet", "solana:mainnet", "evm:sepolia", "evm:mainnet"] as const;

const optionalUrl = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.url().refine((value) => {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]");
  }, { message: "Provider URLs must use HTTPS unless they target loopback." }).optional(),
);

const optionalPath = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).transform((value) => resolve(value)).optional(),
);

const booleanString = z.preprocess(
  (value) => value === "" || value === undefined
    ? undefined
    : typeof value === "boolean" ? String(value) : String(value).toLowerCase(),
  z.enum(["true", "false"]).transform((value) => value === "true").default(false),
);

const rawSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  SUNDER_EXECUTOR_HOST: z.string().default("127.0.0.1"),
  SUNDER_EXECUTOR_PORT: z.coerce.number().int().min(0).max(65_535).refine((value) => value === 0 || value >= 1_024, "Port must be 0 for ephemeral test binding or at least 1024.").default(4_174),
  SUNDER_EXECUTOR_NETWORKS: z.string().default("solana:devnet,evm:sepolia"),
  SUNDER_EXECUTOR_API_TOKEN_FILE: optionalPath,
  SUNDER_EXECUTOR_AUDIT_FILE: z.string().default("/var/lib/sunder-executor/audit.jsonl").transform((value) => resolve(value)),
  SUNDER_SIGNER_SOCKET: optionalPath,
  SUNDER_KILL_SWITCH: booleanString,
  SUNDER_MAINNET_ENABLED: booleanString,
  SUNDER_OPERATOR_CONFIRMATION: z.string().optional(),
  SUNDER_SOLANA_DEVNET_RPC_URL: optionalUrl,
  SUNDER_SOLANA_MAINNET_RPC_URL: optionalUrl,
  SUNDER_SOLANA_DEVNET_WS_URL: optionalUrl,
  SUNDER_SOLANA_MAINNET_WS_URL: optionalUrl,
  SUNDER_JITO_ENDPOINT: optionalUrl,
  SUNDER_JITO_AUTHORIZATION_FILE: optionalPath,
  SUNDER_NOZOMI_ENDPOINT: optionalUrl,
  SUNDER_ZERO_SLOT_ENDPOINT: optionalUrl,
  SUNDER_SOLANA_TIP_RECIPIENT: z.string().optional(),
  SUNDER_SOLANA_FUNDING_ADDRESS: z.string().optional(),
  SUNDER_EVM_SEPOLIA_RPC_URL: optionalUrl,
  SUNDER_EVM_MAINNET_RPC_URL: optionalUrl,
  SUNDER_FLASHBOTS_SEPOLIA_ENDPOINT: optionalUrl,
  SUNDER_FLASHBOTS_MAINNET_ENDPOINT: optionalUrl,
  SUNDER_EVM_FUNDING_ADDRESS: z.string().optional(),
  SUNDER_SOLANA_MAINNET_MAX_SPEND_LAMPORTS: z.coerce.bigint().nonnegative().default(0n),
  SUNDER_SOLANA_MAINNET_MAX_DAILY_SPEND_LAMPORTS: z.coerce.bigint().nonnegative().default(0n),
  SUNDER_EVM_MAINNET_MAX_SPEND_WEI: z.coerce.bigint().nonnegative().default(0n),
  SUNDER_EVM_MAINNET_MAX_DAILY_SPEND_WEI: z.coerce.bigint().nonnegative().default(0n),
  SUNDER_CONFIRMATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
});

export interface ExecutorConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly networks: readonly ChainNetworkId[];
  readonly apiTokenFile?: string;
  readonly auditFile: string;
  readonly signerSocket?: string;
  readonly killSwitch: boolean;
  readonly mainnetEnabled: boolean;
  readonly operatorConfirmed: boolean;
  readonly rpc: Readonly<Partial<Record<ChainNetworkId, string>>>;
  readonly websocket: Readonly<Partial<Record<ChainNetworkId, string>>>;
  readonly jitoEndpoint?: string;
  readonly jitoAuthorizationFile?: string;
  readonly nozomiEndpoint?: string;
  readonly zeroSlotEndpoint?: string;
  readonly solanaTipRecipient?: string;
  readonly flashbots: Readonly<Partial<Record<"evm:sepolia" | "evm:mainnet", string>>>;
  readonly fundingAddress: Readonly<Partial<Record<"solana" | "evm", string>>>;
  readonly mainnetMaxSpendAtomic: Readonly<Partial<Record<"solana:mainnet" | "evm:mainnet", bigint>>>;
  readonly mainnetMaxDailySpendAtomic: Readonly<Partial<Record<"solana:mainnet" | "evm:mainnet", bigint>>>;
  readonly confirmationTimeoutMs: number;
}

function assertNoKeyMaterial(environment: NodeJS.ProcessEnv): void {
  const forbidden = Object.keys(environment).filter((name) =>
    name.startsWith("SUNDER_") && /(?:PRIVATE[_-]?KEY|SEED|MNEMONIC|SECRET[_-]?KEY)/i.test(name),
  );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden key-material environment variables detected: ${forbidden.join(", ")}. Use SUNDER_SIGNER_SOCKET.`);
  }
}

function parseNetworks(value: string): readonly ChainNetworkId[] {
  const values = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (values.length === 0) throw new Error("SUNDER_EXECUTOR_NETWORKS must include at least one network.");
  for (const value of values) {
    if (!(NETWORKS as readonly string[]).includes(value)) throw new Error(`Unsupported executor network: ${value}.`);
  }
  return Object.freeze(values as ChainNetworkId[]);
}

function assertLoopback(host: string): void {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
  const ip = isIP(host);
  if (ip === 4 && host.startsWith("127.")) return;
  throw new Error("The executor HTTP control plane must bind to loopback. Use a reviewed private proxy if remote access is required.");
}

export function parseExecutorConfig(environment: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  assertNoKeyMaterial(environment);
  const parsed = rawSchema.parse(environment);
  assertLoopback(parsed.SUNDER_EXECUTOR_HOST);
  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    host: parsed.SUNDER_EXECUTOR_HOST,
    port: parsed.SUNDER_EXECUTOR_PORT,
    networks: parseNetworks(parsed.SUNDER_EXECUTOR_NETWORKS),
    apiTokenFile: parsed.SUNDER_EXECUTOR_API_TOKEN_FILE,
    auditFile: parsed.SUNDER_EXECUTOR_AUDIT_FILE,
    signerSocket: parsed.SUNDER_SIGNER_SOCKET,
    killSwitch: parsed.SUNDER_KILL_SWITCH,
    mainnetEnabled: parsed.SUNDER_MAINNET_ENABLED,
    operatorConfirmed: parsed.SUNDER_OPERATOR_CONFIRMATION === "CONFIRM_MAINNET_EXECUTION",
    rpc: Object.freeze({
      "solana:devnet": parsed.SUNDER_SOLANA_DEVNET_RPC_URL,
      "solana:mainnet": parsed.SUNDER_SOLANA_MAINNET_RPC_URL,
      "evm:sepolia": parsed.SUNDER_EVM_SEPOLIA_RPC_URL,
      "evm:mainnet": parsed.SUNDER_EVM_MAINNET_RPC_URL,
    }),
    websocket: Object.freeze({
      "solana:devnet": parsed.SUNDER_SOLANA_DEVNET_WS_URL,
      "solana:mainnet": parsed.SUNDER_SOLANA_MAINNET_WS_URL,
    }),
    jitoEndpoint: parsed.SUNDER_JITO_ENDPOINT,
    jitoAuthorizationFile: parsed.SUNDER_JITO_AUTHORIZATION_FILE,
    nozomiEndpoint: parsed.SUNDER_NOZOMI_ENDPOINT,
    zeroSlotEndpoint: parsed.SUNDER_ZERO_SLOT_ENDPOINT,
    solanaTipRecipient: parsed.SUNDER_SOLANA_TIP_RECIPIENT,
    flashbots: Object.freeze({
      "evm:sepolia": parsed.SUNDER_FLASHBOTS_SEPOLIA_ENDPOINT,
      "evm:mainnet": parsed.SUNDER_FLASHBOTS_MAINNET_ENDPOINT,
    }),
    fundingAddress: Object.freeze({ solana: parsed.SUNDER_SOLANA_FUNDING_ADDRESS, evm: parsed.SUNDER_EVM_FUNDING_ADDRESS }),
    mainnetMaxSpendAtomic: Object.freeze({
      "solana:mainnet": parsed.SUNDER_SOLANA_MAINNET_MAX_SPEND_LAMPORTS,
      "evm:mainnet": parsed.SUNDER_EVM_MAINNET_MAX_SPEND_WEI,
    }),
    mainnetMaxDailySpendAtomic: Object.freeze({
      "solana:mainnet": parsed.SUNDER_SOLANA_MAINNET_MAX_DAILY_SPEND_LAMPORTS,
      "evm:mainnet": parsed.SUNDER_EVM_MAINNET_MAX_DAILY_SPEND_WEI,
    }),
    confirmationTimeoutMs: parsed.SUNDER_CONFIRMATION_TIMEOUT_MS,
  });
}

export function isProductionNetwork(network: ChainNetworkId): boolean {
  return network === "solana:mainnet" || network === "evm:mainnet";
}
