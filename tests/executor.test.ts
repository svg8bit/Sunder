import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedRiskEngine, type ExecutionResult } from "../packages/sniper-engine/src/index.js";
import { JsonlAuditSink } from "../packages/executor/src/audit.js";
import { parseExecutorConfig } from "../packages/executor/src/config.js";
import { evaluateReadiness } from "../packages/executor/src/readiness.js";
import { ExecutorRuntimeError, type ExecutorRuntime } from "../packages/executor/src/runtime.js";
import { startExecutorServer } from "../packages/executor/src/server.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((operation) => operation()));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sunder-executor-test-"));
  const socketPath = join(directory, "signer.sock");
  const tokenPath = join(directory, "api-token");
  const auditPath = join(directory, "audit.jsonl");
  const signer: SocketServer = createSocketServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    signer.once("error", reject);
    signer.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  await writeFile(tokenPath, "test-token-with-at-least-24-characters", { mode: 0o600 });
  cleanup.push(async () => new Promise<void>((resolve) => signer.close(() => resolve())));
  cleanup.push(async () => rm(directory, { recursive: true, force: true }));
  return { directory, socketPath, tokenPath, auditPath };
}

function environment(paths: Awaited<ReturnType<typeof fixture>>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    SUNDER_EXECUTOR_HOST: "127.0.0.1",
    SUNDER_EXECUTOR_PORT: "0",
    SUNDER_EXECUTOR_NETWORKS: "evm:sepolia",
    SUNDER_EXECUTOR_API_TOKEN_FILE: paths.tokenPath,
    SUNDER_EXECUTOR_AUDIT_FILE: paths.auditPath,
    SUNDER_SIGNER_SOCKET: paths.socketPath,
    SUNDER_EVM_SEPOLIA_RPC_URL: "https://rpc.sepolia.org",
    SUNDER_EVM_FUNDING_ADDRESS: "0x0000000000000000000000000000000000000001",
  };
}

describe("executor configuration and readiness", () => {
  it("stores a detached, deeply immutable audit detail tree", async () => {
    const paths = await fixture();
    const audit = new JsonlAuditSink(paths.auditPath);
    const detail = { nested: { items: ["created"] } };
    await audit.record({
      id: "audit-1",
      executionId: "execution-1",
      eventId: "event-1",
      network: "evm:sepolia",
      stage: "event",
      state: "received",
      timestamp: Date.now(),
      detail,
    });
    detail.nested.items.push("caller-mutated");
    const stored = audit.records()[0];
    const nested = stored?.detail.nested as { readonly items: readonly string[] };

    expect(nested.items).toEqual(["created"]);
    expect(Object.isFrozen(stored?.detail)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.items)).toBe(true);
  });

  it("rebuilds canonical risk counters and spend windows from the append-only audit after restart", async () => {
    const paths = await fixture();
    const timestamp = Date.UTC(2026, 7, 2, 12, 0, 0);
    const audit = new JsonlAuditSink(paths.auditPath);
    await audit.record({ id: "rule", executionId: "execution-1", eventId: "event-1", network: "evm:sepolia", stage: "rule", state: "matched", timestamp, detail: { ruleId: "rule-1" } });
    await audit.record({ id: "risk", executionId: "execution-1", eventId: "event-1", network: "evm:sepolia", stage: "risk", state: "passed", timestamp: timestamp + 1, detail: { phase: "event", spendAtomic: 25_000n } });
    await audit.record({ id: "confirmation", executionId: "execution-1", eventId: "event-1", network: "evm:sepolia", stage: "confirmation", state: "confirmed", timestamp: timestamp + 2, detail: { signature: `0x${"a".repeat(64)}` } });

    const restarted = new JsonlAuditSink(paths.auditPath);
    await restarted.initialize();
    const hydration = restarted.riskHydration();
    expect(hydration.confirmedExecutionsByRule).toMatchObject({ "rule-1": 1 });
    expect(hydration.dailySpendByRule?.["rule-1"]).toEqual({ day: "2026-08-02", atomic: 25_000n });
    expect(hydration.dailySpendByNetwork?.["evm:sepolia"]).toEqual({ day: "2026-08-02", atomic: 25_000n });
    expect(new BoundedRiskEngine({ hydration }).confirmedExecutions("rule-1")).toBe(1);
  });

  it("rejects key material and public control-plane binding", () => {
    expect(() => parseExecutorConfig({ SUNDER_PRIVATE_KEY: "forbidden" })).toThrow(/Forbidden key-material/);
    expect(() => parseExecutorConfig({ SUNDER_EXECUTOR_HOST: "0.0.0.0" })).toThrow(/loopback/);
  });

  it("parses booleans and network-specific atomic budgets without unit ambiguity", () => {
    const config = parseExecutorConfig({
      SUNDER_KILL_SWITCH: true as unknown as string,
      SUNDER_MAINNET_ENABLED: "true",
      SUNDER_SOLANA_MAINNET_MAX_SPEND_LAMPORTS: "10",
      SUNDER_SOLANA_MAINNET_MAX_DAILY_SPEND_LAMPORTS: "20",
      SUNDER_EVM_MAINNET_MAX_SPEND_WEI: "30",
      SUNDER_EVM_MAINNET_MAX_DAILY_SPEND_WEI: "40",
    });
    expect(config).toMatchObject({ killSwitch: true, mainnetEnabled: true });
    expect(config.mainnetMaxSpendAtomic).toMatchObject({ "solana:mainnet": 10n, "evm:mainnet": 30n });
    expect(() => parseExecutorConfig({ SUNDER_EVM_SEPOLIA_RPC_URL: "http://localhost.example/" })).toThrow(/HTTPS unless they target loopback/);
  });

  it("keeps Mainnet locked until every independent gate is configured", async () => {
    const paths = await fixture();
    const config = parseExecutorConfig({
      ...environment(paths),
      SUNDER_EXECUTOR_NETWORKS: "evm:mainnet",
      SUNDER_EVM_MAINNET_RPC_URL: "https://ethereum-rpc.publicnode.com",
    });
    const readiness = await evaluateReadiness(config);
    expect(readiness.ready).toBe(false);
    expect(readiness.networks[0]?.gates.filter((gate) => !gate.ready).map((gate) => gate.id)).toEqual(expect.arrayContaining([
      "mainnet-enabled",
      "operator-confirmation",
      "per-transaction-budget",
      "daily-budget",
      "private-relay",
    ]));
  });

  it("reports an executable test-network control plane without unlocking Mainnet", async () => {
    const paths = await fixture();
    const readiness = await evaluateReadiness(parseExecutorConfig(environment(paths)));
    expect(readiness).toMatchObject({ ready: true, killSwitch: false });
    expect(readiness.networks[0]).toMatchObject({ network: "evm:sepolia", production: false, ready: true });
  });
});

describe("executor HTTP service", () => {
  it("serves liveness/readiness, protects control endpoints, and exposes a live kill switch", async () => {
    const paths = await fixture();
    const service = await startExecutorServer(environment(paths));
    cleanup.push(service.close);
    const address = service.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    await expect(fetch(`${base}/health`).then((response) => response.json())).resolves.toMatchObject({ status: "ok", service: "sunder-executor" });
    expect((await fetch(`${base}/ready`)).status).toBe(200);
    expect((await fetch(`${base}/v1/relay-health`)).status).toBe(401);
    const headers = { authorization: "Bearer test-token-with-at-least-24-characters" };
    expect((await fetch(`${base}/v1/relay-health`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/kill-switch`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
  });

  it("returns canonical execution results and typed runtime failures from the execution endpoint", async () => {
    const paths = await fixture();
    const config = parseExecutorConfig(environment(paths));
    const readiness = await evaluateReadiness(config);
    const confirmed: ExecutionResult = {
      executionId: "execution-confirmed",
      eventId: "event-1",
      network: "evm:sepolia",
      outcome: "confirmed",
      confirmationState: "confirmed",
      attempts: 1,
      relayReceipts: [],
      audit: [],
      signature: `0x${"a".repeat(64)}`,
    };
    const execute = vi.fn<ExecutorRuntime["execute"]>(async () => confirmed);
    const runtime: ExecutorRuntime = {
      engine: undefined as never,
      configuredNetworks: ["evm:sepolia"],
      audit: new JsonlAuditSink(paths.auditPath),
      risk: new BoundedRiskEngine(),
      execute,
      relayHealth: () => [],
      setKillSwitch: vi.fn(),
      killSwitch: () => false,
    };
    const service = await startExecutorServer(environment(paths), {
      evaluate: async () => readiness,
      createRuntime: async () => runtime,
    });
    cleanup.push(service.close);
    const address = service.server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1/executions`;
    const headers = { authorization: "Bearer test-token-with-at-least-24-characters", "content-type": "application/json" };
    const payload = executionPayload();

    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "confirmed", confirmationState: "confirmed", signature: confirmed.signature });
    expect(execute).toHaveBeenCalledTimes(1);

    execute.mockRejectedValueOnce(new ExecutorRuntimeError(409, "funding-address-mismatch", "Funding address does not match signer policy."));
    const failed = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...payload, event: { ...payload.event, id: "event-2", sourceCursor: "cursor-2" } }) });
    expect(failed.status).toBe(409);
    await expect(failed.json()).resolves.toMatchObject({ error: "funding-address-mismatch" });

    await expect(service.close()).resolves.toBeUndefined();
    await expect(service.close()).resolves.toBeUndefined();
  });
});

function executionPayload() {
  return {
    event: {
      id: "event-1",
      source: "manual",
      sourceCursor: "cursor-1",
      kind: "manual",
      network: "evm:sepolia",
      receivedAt: Date.now(),
      target: "0x0000000000000000000000000000000000000002",
      account: "0x0000000000000000000000000000000000000001",
      attributes: {},
    },
    rules: [{
      id: "rule-1", name: "Test rule", enabled: true, networks: ["evm:sepolia"], eventKinds: ["manual"], accounts: [], keywords: [], requireMedia: false,
      allowTargets: [], denyTargets: [], maxSpendAtomic: "100000", maxDailySpendAtomic: "1000000", maxSlippageBps: 100, maxPriceImpactBps: 100,
      cooldownMs: 0, maxAttempts: 2,
    }],
    inputAmountAtomic: "1000",
    feePolicy: { kind: "eip1559", gasLimit: "21000", maxFeePerGas: "100", maxPriorityFeePerGas: "2", replacementBumpBps: 1250 },
    relayFanout: 1,
  };
}
