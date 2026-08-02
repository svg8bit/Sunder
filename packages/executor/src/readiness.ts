import { open, stat } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import type { ChainNetworkId } from "../../sniper-engine/src/index.js";
import { loadAutomationPolicy } from "./automation-policy.js";
import { isProductionNetwork, type ExecutorConfig } from "./config.js";
import { querySignerStatus } from "./signer.js";

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
    if ((metadata.mode & 0o007) !== 0) return { id: "signer-socket", ready: false, detail: "world-accessible" };
    if ((metadata.mode & 0o600) !== 0o600) return { id: "signer-socket", ready: false, detail: "owner-rw-required" };
    const groupMode = metadata.mode & 0o070;
    if (groupMode !== 0 && groupMode !== 0o060) return { id: "signer-socket", ready: false, detail: "group-mode-must-be-none-or-rw" };
    return { id: "signer-socket", ready: true, detail: groupMode === 0o060 ? "available-to-runtime-group" : "owner-only" };
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

async function signerPolicyGate(config: ExecutorConfig, network: ChainNetworkId): Promise<ReadinessGate> {
  if (!config.signerSocket) return { id: "signer-policy", ready: false, detail: "socket-unconfigured" };
  const family = network.startsWith("solana:") ? "solana" : "evm";
  if (family !== "solana") return { id: "signer-policy", ready: false, detail: "evm-signer-not-configured" };
  try {
    const status = await querySignerStatus(config.signerSocket, AbortSignal.timeout(4_000));
    const fundingAddress = config.fundingAddress[family];
    if (!status.networks.includes(network as "solana:devnet" | "solana:mainnet")) return { id: "signer-policy", ready: false, detail: "network-not-allowed" };
    if (status.publicKey !== fundingAddress) return { id: "signer-policy", ready: false, detail: "public-key-mismatch" };
    return { id: "signer-policy", ready: true, detail: "verified-over-unix-socket" };
  } catch (error) {
    return { id: "signer-policy", ready: false, detail: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "unavailable-or-invalid" };
  }
}

async function rpcRequest(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "sunder-readiness", method, params }),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const payload = await response.json() as { readonly result?: unknown; readonly error?: unknown };
  if (payload.error || payload.result === undefined) throw new Error("RPC returned an error.");
  return payload.result;
}

async function liveProviderGates(config: ExecutorConfig, network: ChainNetworkId): Promise<readonly ReadinessGate[]> {
  if (!config.liveReadinessChecks) return Object.freeze([
    { id: "rpc-live", ready: true, detail: "not-enforced-outside-production" },
    { id: "funding-balance", ready: true, detail: "not-enforced-outside-production" },
  ]);
  const rpcUrl = config.rpc[network];
  if (!rpcUrl) return Object.freeze([
    { id: "rpc-live", ready: false, detail: "unconfigured" },
    { id: "funding-balance", ready: false, detail: "rpc-unconfigured" },
  ]);
  const family = network.startsWith("solana:") ? "solana" : "evm";
  const fundingAddress = config.fundingAddress[family];
  if (!fundingAddress) return Object.freeze([
    { id: "rpc-live", ready: false, detail: "funding-address-unconfigured" },
    { id: "funding-balance", ready: false, detail: "funding-address-unconfigured" },
  ]);
  try {
    if (family === "solana") {
      const [latest, balanceResponse] = await Promise.all([
        rpcRequest(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]),
        rpcRequest(rpcUrl, "getBalance", [fundingAddress, { commitment: "confirmed" }]),
      ]);
      const blockhash = (latest as { readonly value?: { readonly blockhash?: unknown } }).value?.blockhash;
      const balance = (balanceResponse as { readonly value?: unknown }).value;
      if (typeof blockhash !== "string" || typeof balance !== "number" || !Number.isSafeInteger(balance)) throw new Error("Unexpected Solana RPC response.");
      const maxSpend = config.mainnetMaxSpendAtomic["solana:mainnet"] ?? 0n;
      // A first Pump buy may also create an ATA; keep a bounded rent and fee reserve.
      const required = maxSpend + 3_000_000n;
      return Object.freeze([
        { id: "rpc-live", ready: true, detail: "latest-blockhash-ok" },
        { id: "funding-balance", ready: BigInt(balance) >= required, detail: BigInt(balance) >= required ? "bounded-spend-plus-fee-reserve" : "insufficient-for-budget-plus-fees" },
      ]);
    }
    const [chainId, balance] = await Promise.all([
      rpcRequest(rpcUrl, "eth_chainId", []),
      rpcRequest(rpcUrl, "eth_getBalance", [fundingAddress, "latest"]),
    ]);
    const expectedChainId = network === "evm:mainnet" ? "0x1" : "0xaa36a7";
    if (typeof chainId !== "string" || chainId.toLowerCase() !== expectedChainId || typeof balance !== "string" || !/^0x[0-9a-f]+$/iu.test(balance)) {
      throw new Error("Unexpected EVM RPC response.");
    }
    const maxSpend = config.mainnetMaxSpendAtomic["evm:mainnet"] ?? 0n;
    const required = maxSpend + 1_000_000_000_000_000n;
    return Object.freeze([
      { id: "rpc-live", ready: true, detail: "chain-id-ok" },
      { id: "funding-balance", ready: BigInt(balance) >= required, detail: BigInt(balance) >= required ? "bounded-spend-plus-fee-reserve" : "insufficient-for-budget-plus-fees" },
    ]);
  } catch (error) {
    const detail = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "provider-error";
    return Object.freeze([
      { id: "rpc-live", ready: false, detail },
      { id: "funding-balance", ready: false, detail: "not-verified" },
    ]);
  }
}

export async function evaluateReadiness(config: ExecutorConfig, killSwitch = config.killSwitch): Promise<ExecutorReadiness> {
  const [signer, apiToken, automationPolicy] = await Promise.all([
    signerSocketGate(config.signerSocket),
    restrictedFile(config.apiTokenFile, "api-token-file"),
    config.automationEnabled ? loadAutomationPolicy(config.automationRulesFile) : Promise.resolve(undefined),
  ]);
  const networks = await Promise.all(config.networks.map(async (network): Promise<NetworkReadiness> => {
    const production = isProductionNetwork(network);
    const gates: ReadinessGate[] = [
      { id: "kill-switch", ready: !killSwitch, detail: killSwitch ? "active" : "inactive" },
      { id: "rpc", ready: Boolean(config.rpc[network]), detail: config.rpc[network] ? "configured" : "unconfigured" },
      signer,
      apiToken,
      fundingGate(config, network),
    ];
    if (config.automationEnabled) {
      const applies = automationPolicy?.ready && automationPolicy.policy.network === network;
      gates.push({
        id: "automation-policy",
        ready: Boolean(automationPolicy?.ready && applies),
        detail: automationPolicy?.ready ? applies ? "configured-for-network" : "network-mismatch" : automationPolicy?.detail ?? "unconfigured",
      });
    }
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
        await signerPolicyGate(config, network),
        ...await liveProviderGates(config, network),
      );
    }
    return Object.freeze({ network, production, ready: gates.every((gate) => gate.ready), gates: Object.freeze(gates) });
  }));
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
