import { open } from "node:fs/promises";
import {
  BoundedRetryController,
  BoundedRiskEngine,
  DeterministicRuleEvaluator,
  SniperEngine,
  type ChainAdapter,
  type ChainNetworkId,
  type ExecutionRequest,
  type ExecutionResult,
  type RelayHealth,
} from "../../sniper-engine/src/index.js";
import { JsonlAuditSink } from "./audit.js";
import { type ExecutorConfig } from "./config.js";
import { type ExecutorReadiness, networkReadiness } from "./readiness.js";
import { UnixSocketWalletAdapter } from "./signer.js";

async function readRestrictedValue(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error(`Credential file ${path} must be a regular file readable only by its owner.`);
    }
    const value = (await handle.readFile("utf8")).trim();
    if (!value) throw new Error(`Credential file ${path} is empty.`);
    return value;
  } finally {
    await handle.close();
  }
}

export class ExecutorRuntimeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ExecutorRuntimeError";
    this.status = status;
    this.code = code;
  }
}

export interface ExecutorRuntime {
  readonly engine: SniperEngine;
  readonly configuredNetworks: readonly ChainNetworkId[];
  readonly audit: JsonlAuditSink;
  readonly risk: BoundedRiskEngine;
  execute(request: ExecutionRequest, readiness: ExecutorReadiness, signal?: AbortSignal): Promise<ExecutionResult>;
  relayHealth(network?: ChainNetworkId): readonly RelayHealth[];
  setKillSwitch(enabled: boolean): void;
  killSwitch(): boolean;
}

export async function createExecutorRuntime(config: ExecutorConfig, readiness: ExecutorReadiness): Promise<ExecutorRuntime> {
  const wallet = config.signerSocket ? new UnixSocketWalletAdapter(config.signerSocket, config.networks) : undefined;
  const jitoAuthorization = await readRestrictedValue(config.jitoAuthorizationFile);
  const adapters: ChainAdapter[] = [];
  for (const network of config.networks) {
    const rpcUrl = config.rpc[network];
    if (!rpcUrl || !wallet) continue;
    if (network === "solana:devnet" || network === "solana:mainnet") {
      const { createSolanaChainAdapter } = await import("../../chain-solana/src/index.js");
      adapters.push(createSolanaChainAdapter({
        network,
        rpcUrl,
        websocketUrl: config.websocket[network],
        wallet,
        jitoEndpoint: config.jitoEndpoint,
        jitoAuthorization,
        nozomiEndpoint: config.nozomiEndpoint,
        zeroSlotEndpoint: config.zeroSlotEndpoint,
        relayTipRecipient: config.solanaTipRecipient,
        confirmationTimeoutMs: config.confirmationTimeoutMs,
      }));
    } else {
      const { createEvmChainAdapter } = await import("../../chain-evm/src/index.js");
      adapters.push(createEvmChainAdapter({
        network,
        rpcUrl,
        wallet,
        flashbotsEndpoint: config.flashbots[network],
        enableFlashbotsProtect: Boolean(config.flashbots[network]),
        confirmationTimeoutMs: config.confirmationTimeoutMs,
      }));
    }
  }
  const unlockedProductionNetworks = readiness.networks
    .filter((network) => network.production && network.ready)
    .map((network) => network.network);
  const audit = new JsonlAuditSink(config.auditFile);
  await audit.initialize();
  const risk = new BoundedRiskEngine({
    unlockedProductionNetworks,
    hydration: audit.riskHydration(),
    networkDailyLimits: {
      "solana:mainnet": config.mainnetMaxDailySpendAtomic["solana:mainnet"],
      "evm:mainnet": config.mainnetMaxDailySpendAtomic["evm:mainnet"],
    },
  });
  risk.setKillSwitch(config.killSwitch);
  const engine = new SniperEngine({
    adapters,
    ruleEvaluator: new DeterministicRuleEvaluator(),
    retryController: new BoundedRetryController(),
    riskEngine: risk,
    auditSink: audit,
  });
  let killSwitch = config.killSwitch;

  const runtime: ExecutorRuntime = {
    engine,
    configuredNetworks: Object.freeze(adapters.map((adapter) => adapter.chain.id)),
    audit,
    risk,
    async execute(request, currentReadiness, signal) {
      const network = networkReadiness(currentReadiness, request.event.network);
      if (!network?.ready || killSwitch) {
        const failed = network?.gates.filter((gate) => !gate.ready).map((gate) => `${gate.id}:${gate.detail}`).join(", ") ?? "network-unconfigured";
        throw new ExecutorRuntimeError(409, "executor-not-ready", `Executor is not ready for ${request.event.network}: ${killSwitch ? "kill-switch:active" : failed}.`);
      }
      const family = request.event.network.startsWith("solana:") ? "solana" : "evm";
      const fundingAddress = config.fundingAddress[family];
      const account = request.event.account;
      const matchesFundingAddress = Boolean(fundingAddress) && Boolean(account) && (family === "evm"
        ? account!.toLowerCase() === fundingAddress!.toLowerCase()
        : account === fundingAddress);
      if (!matchesFundingAddress) {
        throw new ExecutorRuntimeError(409, "funding-address-mismatch", "Execution account must match the configured public funding address and signer policy.");
      }
      if (network.production) {
        const maxSpend = config.mainnetMaxSpendAtomic[request.event.network as "solana:mainnet" | "evm:mainnet"] ?? 0n;
        const maxDailySpend = config.mainnetMaxDailySpendAtomic[request.event.network as "solana:mainnet" | "evm:mainnet"] ?? 0n;
        if (request.inputAmountAtomic > maxSpend) throw new ExecutorRuntimeError(409, "mainnet-transaction-budget", "Execution exceeds the network-specific Mainnet transaction budget.");
        if (request.rules.some((rule) => rule.maxSpendAtomic > maxSpend || rule.maxDailySpendAtomic > maxDailySpend)) {
          throw new ExecutorRuntimeError(409, "mainnet-rule-budget", "Rule budgets cannot exceed the network-specific executor Mainnet envelopes.");
        }
      }
      return engine.execute(request, signal);
    },
    relayHealth(network) {
      return Object.freeze(adapters.flatMap((adapter) => network && adapter.chain.id !== network ? [] : adapter.relays.health(adapter.chain.id)));
    },
    setKillSwitch(enabled) {
      killSwitch = enabled;
      risk.setKillSwitch(enabled);
    },
    killSwitch: () => killSwitch,
  };
  return Object.freeze(runtime);
}
