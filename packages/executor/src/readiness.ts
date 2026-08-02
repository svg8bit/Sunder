import { open, stat } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import type { ChainNetworkId } from "../../sniper-engine/src/index.js";
import { isProductionNetwork, type ExecutorConfig } from "./config.js";

export interface ReadinessGate {
  readonly id: string;
  readonly ready: boolean;
  readonly detail: string;
}

export interface NetworkReadiness {
  readonly network: ChainNetworkId;
  readonly production: boolean;
  readonly ready: boolean;
  readonly gates: readonly ReadinessGate[];
}

export interface ExecutorReadiness {
  readonly ready: boolean;
  readonly killSwitch: boolean;
  readonly checkedAt: string;
  readonly networks: readonly NetworkReadiness[];
}

async function restrictedFile(path: string | undefined, label: string): Promise<ReadinessGate> {
  if (!path) return { id: label, ready: false, detail: "unconfigured" };
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { id: label, ready: false, detail: "not-a-regular-file" };
    if ((metadata.mode & 0o077) !== 0) return { id: label, ready: false, detail: "group-or-world-accessible" };
    const value = (await handle.readFile("utf8")).trim();
    return { id: label, ready: value.length >= 24, detail: value.length >= 24 ? "configured" : "empty-or-too-short" };
  } catch (error) {
    return { id: label, ready: false, detail: error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unreadable" };
  } finally {
    await handle?.close();
  }
}

export async function signerSocketGate(path: string | undefined): Promise<ReadinessGate> {
  if (!path) return { id: "signer-socket", ready: false, detail: "unconfigured" };
  try {
    const metadata = await stat(path);
    if (!metadata.isSocket()) return { id: "signer-socket", ready: false, detail: "not-a-unix-socket" };
    if ((metadata.mode & 0o077) !== 0) return { id: "signer-socket", ready: false, detail: "group-or-world-accessible" };
    return { id: "signer-socket", ready: true, detail: "available" };
  } catch (error) {
    return { id: "signer-socket", ready: false, detail: error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unavailable" };
  }
}

function fundingGate(config: ExecutorConfig, network: ChainNetworkId): ReadinessGate {
  const family = network.startsWith("solana:") ? "solana" : "evm";
  const value = config.fundingAddress[family];
  if (!value) return { id: "funding-address", ready: false, detail: "unconfigured" };
  try {
    const valid = family === "solana" ? Boolean(new PublicKey(value)) : isAddress(value);
    return { id: "funding-address", ready: valid, detail: valid ? "configured-public-address" : "invalid-address" };
  } catch {
    return { id: "funding-address", ready: false, detail: "invalid-address" };
  }
}

function relayGate(config: ExecutorConfig, network: ChainNetworkId): ReadinessGate {
  const ready = network.startsWith("solana:")
    ? Boolean(config.jitoEndpoint || config.nozomiEndpoint || config.zeroSlotEndpoint)
    : Boolean(config.flashbots[network as "evm:sepolia" | "evm:mainnet"]);
  return { id: "private-relay", ready, detail: ready ? "configured" : "unconfigured" };
}

export async function evaluateReadiness(config: ExecutorConfig, killSwitch = config.killSwitch): Promise<ExecutorReadiness> {
  const [signer, apiToken] = await Promise.all([
    signerSocketGate(config.signerSocket),
    restrictedFile(config.apiTokenFile, "api-token-file"),
  ]);
  const networks = config.networks.map((network): NetworkReadiness => {
    const production = isProductionNetwork(network);
    const gates: ReadinessGate[] = [
      { id: "kill-switch", ready: !killSwitch, detail: killSwitch ? "active" : "inactive" },
      { id: "rpc", ready: Boolean(config.rpc[network]), detail: config.rpc[network] ? "configured" : "unconfigured" },
      signer,
      apiToken,
      fundingGate(config, network),
    ];
    if (production) {
      const productionNetwork = network as "solana:mainnet" | "evm:mainnet";
      const maxSpend = config.mainnetMaxSpendAtomic[productionNetwork] ?? 0n;
      const maxDailySpend = config.mainnetMaxDailySpendAtomic[productionNetwork] ?? 0n;
      gates.push(
        { id: "mainnet-enabled", ready: config.mainnetEnabled, detail: config.mainnetEnabled ? "enabled" : "locked" },
        { id: "operator-confirmation", ready: config.operatorConfirmed, detail: config.operatorConfirmed ? "confirmed" : "missing" },
        { id: "per-transaction-budget", ready: maxSpend > 0n, detail: maxSpend > 0n ? "bounded" : "zero-or-unconfigured" },
        { id: "daily-budget", ready: maxDailySpend >= maxSpend && maxDailySpend > 0n, detail: maxDailySpend >= maxSpend && maxDailySpend > 0n ? "bounded" : "invalid-or-unconfigured" },
        relayGate(config, network),
      );
    }
    return Object.freeze({ network, production, ready: gates.every((gate) => gate.ready), gates: Object.freeze(gates) });
  });
  return Object.freeze({
    ready: networks.some((network) => network.ready),
    killSwitch,
    checkedAt: new Date().toISOString(),
    networks: Object.freeze(networks),
  });
}

export function networkReadiness(readiness: ExecutorReadiness, network: ChainNetworkId): NetworkReadiness | undefined {
  return readiness.networks.find((candidate) => candidate.network === network);
}
