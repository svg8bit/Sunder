import { describe, expect, it } from "vitest";
import {
  CHAIN_DESCRIPTORS,
  DeterministicRuleEvaluator,
  HealthWeightedRelayRouter,
  ManifestTransactionAdapter,
  TestWalletAdapter,
  type RelayAdapter,
  type SniperEvent,
  type SniperRule,
} from "../../packages/sniper-engine/src/index.js";

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.POSITIVE_INFINITY;
}

const event: SniperEvent = {
  id: "benchmark",
  source: "manual",
  sourceCursor: "benchmark",
  kind: "manual",
  network: "evm:sepolia",
  receivedAt: 0,
  target: "0x0000000000000000000000000000000000000002",
  account: "0x0000000000000000000000000000000000000001",
  text: "launch sunder test token",
  hasMedia: true,
  attributes: {},
};

const rule: SniperRule = {
  id: "benchmark-rule",
  name: "benchmark",
  enabled: true,
  networks: ["evm:sepolia"],
  eventKinds: ["manual"],
  accounts: [],
  keywords: ["sunder"],
  regex: "launch\\s+sunder",
  requireMedia: true,
  allowTargets: [],
  denyTargets: [],
  maxSpendAtomic: 1_000_000n,
  maxDailySpendAtomic: 10_000_000n,
  maxSlippageBps: 200,
  maxPriceImpactBps: 500,
  cooldownMs: 0,
  maxAttempts: 2,
};

describe("local execution-path performance targets", () => {
  it("keeps hot rule evaluation p95 below 5 ms", () => {
    const evaluator = new DeterministicRuleEvaluator();
    const samples: number[] = [];
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const startedAt = performance.now();
      evaluator.evaluate(event, [rule], startedAt);
      samples.push(performance.now() - startedAt);
    }
    const p95 = percentile(samples, 0.95);
    console.info(`benchmark rule-evaluation p95=${p95.toFixed(3)}ms samples=${samples.length}`);
    expect(p95, `rule evaluation p95=${p95.toFixed(3)}ms`).toBeLessThan(5);
  });

  it("keeps in-memory transaction manifest build p95 below 25 ms", async () => {
    const builder = new ManifestTransactionAdapter({
      networks: ["evm:sepolia"],
      getLifetime: async () => ({ kind: "evm-nonce", nonce: 1, validUntilBlock: 100n }),
    });
    const quote = {
      id: "quote",
      chain: CHAIN_DESCRIPTORS["evm:sepolia"],
      inputAmountAtomic: 1_000n,
      expectedOutputAmount: 2_000n,
      minimumOutputAmount: 1_980n,
      priceImpactBps: 10,
      route: ["test"],
      receivedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      provider: "benchmark",
    };
    const samples: number[] = [];
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const startedAt = performance.now();
      await builder.build({
        chain: quote.chain,
        event,
        quote,
        feePolicy: { kind: "eip1559", gasLimit: 100_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n, replacementBumpBps: 1_250 },
        idempotencyKey: `benchmark-${iteration}`,
      });
      samples.push(performance.now() - startedAt);
    }
    const p95 = percentile(samples, 0.95);
    console.info(`benchmark transaction-build p95=${p95.toFixed(3)}ms samples=${samples.length}`);
    expect(p95, `transaction build p95=${p95.toFixed(3)}ms`).toBeLessThan(25);
  });

  it("dispatches to a healthy in-memory relay within 10 ms after signing", async () => {
    const relay: RelayAdapter = {
      id: "benchmark-relay",
      kind: "evm-rpc",
      networks: ["evm:sepolia"],
      health: () => ({ relayId: "benchmark-relay", kind: "evm-rpc", networks: ["evm:sepolia"], enabled: true, latencyMs: 1, failureRate: 0 }),
      submit: async () => ({ relayId: "benchmark-relay", kind: "evm-rpc", accepted: true, acceptedAt: Date.now(), latencyMs: 0 }),
    };
    const transaction = await new TestWalletAdapter(["evm:sepolia"]).sign({
      idempotencyKey: "benchmark",
      chain: CHAIN_DESCRIPTORS["evm:sepolia"],
      eventId: event.id,
      quoteId: "quote",
      lifetime: { kind: "evm-nonce", nonce: 1 },
      feePolicy: { kind: "eip1559", gasLimit: 100_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n, replacementBumpBps: 1_250 },
      instructions: [],
      unsignedPayload: "payload",
      createdAt: Date.now(),
    });
    const router = new HealthWeightedRelayRouter([relay]);
    const samples: number[] = [];
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const startedAt = performance.now();
      await router.route(transaction, 1);
      samples.push(performance.now() - startedAt);
    }
    const p95 = percentile(samples, 0.95);
    console.info(`benchmark relay-dispatch p95=${p95.toFixed(3)}ms samples=${samples.length}`);
    expect(p95, `relay dispatch p95=${p95.toFixed(3)}ms`).toBeLessThan(10);
  });
});
