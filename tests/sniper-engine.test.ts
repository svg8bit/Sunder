import { describe, expect, it, vi } from "vitest";
import {
  BoundedRetryController,
  BoundedRiskEngine,
  CHAIN_DESCRIPTORS,
  DeterministicRuleEvaluator,
  HealthWeightedRelayRouter,
  HttpRelayAdapter,
  ManifestTransactionAdapter,
  MemoryAuditSink,
  SniperEngine,
  StaticQuoteAdapter,
  TestWalletAdapter,
  type ChainAdapter,
  type ChainNetworkId,
  type ConfirmationAdapter,
  type ConfirmationResult,
  type ExecutionRequest,
  type QuoteAdapter,
  type RelayAdapter,
  type RelayReceipt,
  type RiskEngine,
  type SignedTransaction,
  type SniperRule,
  type TransactionAdapter,
  type WalletAdapter,
} from "../packages/sniper-engine/src/index.js";

function rule(network: ChainNetworkId, overrides: Partial<SniperRule> = {}): SniperRule {
  const base: SniperRule = {
    id: "rule-1",
    name: "Bounded entry",
    enabled: true,
    networks: [network],
    eventKinds: ["manual"],
    accounts: [],
    keywords: [],
    requireMedia: false,
    allowTargets: [],
    denyTargets: [],
    maxSpendAtomic: 1_000_000n,
    maxDailySpendAtomic: 5_000_000n,
    maxSlippageBps: 200,
    maxPriceImpactBps: 100,
    cooldownMs: 0,
    maxAttempts: 2,
  };
  return Object.freeze({ ...base, ...overrides });
}

function request(network: ChainNetworkId, overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const family = CHAIN_DESCRIPTORS[network].family;
  return {
    event: Object.freeze({
      id: "event-1",
      source: "manual",
      sourceCursor: "cursor-1",
      kind: "manual",
      network,
      receivedAt: Date.now(),
      target: family === "evm" ? "0x0000000000000000000000000000000000000002" : "mint",
      account: family === "evm" ? "0x0000000000000000000000000000000000000001" : "wallet",
      attributes: Object.freeze({}),
    }),
    rules: [rule(network)],
    inputAmountAtomic: 10_000n,
    feePolicy: family === "evm"
      ? { kind: "eip1559", gasLimit: 100_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n, replacementBumpBps: 1_250 }
      : { kind: "solana", computeUnitLimit: 200_000, computeUnitPriceMicroLamports: 1_000n, tipLamports: 0n },
    relayFanout: 1,
    ...overrides,
  };
}

function relay(network: ChainNetworkId, submit?: (transaction: SignedTransaction) => Promise<RelayReceipt>): RelayAdapter {
  return {
    id: "test-relay",
    kind: CHAIN_DESCRIPTORS[network].family === "evm" ? "evm-rpc" : "rpc",
    networks: [network],
    health: () => ({ relayId: "test-relay", kind: CHAIN_DESCRIPTORS[network].family === "evm" ? "evm-rpc" : "rpc", networks: [network], enabled: true, latencyMs: 2, failureRate: 0 }),
    submit: submit ?? (async () => ({ relayId: "test-relay", kind: CHAIN_DESCRIPTORS[network].family === "evm" ? "evm-rpc" : "rpc", accepted: true, acceptedAt: Date.now(), latencyMs: 2, responseId: "provider-accepted" })),
  };
}

function adapter(network: ChainNetworkId, confirmationResult: ConfirmationResult | readonly ConfirmationResult[], submit?: (transaction: SignedTransaction) => Promise<RelayReceipt>): ChainAdapter {
  const confirmations = Array.isArray(confirmationResult) ? [...confirmationResult] : [confirmationResult];
  const confirmation: ConfirmationAdapter = {
    id: "test-confirmation",
    networks: [network],
    track: vi.fn(async () => confirmations.shift() ?? confirmations.at(-1) ?? confirmationResult as ConfirmationResult),
  };
  const production = network.endsWith(":mainnet");
  const unreachable = async (): Promise<never> => { throw new Error("Production adapter should be unreachable while Mainnet is locked."); };
  const quote: QuoteAdapter = production
    ? { id: "production-boundary-quote", networks: [network], quote: unreachable }
    : new StaticQuoteAdapter([network]);
  const transaction: TransactionAdapter = production
    ? { id: "production-boundary-transaction", networks: [network], build: unreachable, simulate: unreachable }
    : new ManifestTransactionAdapter({
      networks: [network],
      getLifetime: async (_network, previous) => previous?.lifetime ?? (CHAIN_DESCRIPTORS[network].family === "evm"
        ? { kind: "evm-nonce", nonce: 4, validUntilBlock: 200n }
        : { kind: "solana-blockhash", blockhash: "blockhash", lastValidBlockHeight: 200n }),
    });
  const wallet: WalletAdapter = production
    ? { id: "production-boundary-wallet", kind: "encrypted-external", networks: [network], sign: unreachable }
    : new TestWalletAdapter([network]);
  return {
    chain: CHAIN_DESCRIPTORS[network],
    quote,
    transaction,
    wallet,
    relays: new HealthWeightedRelayRouter([relay(network, submit)]),
    confirmation,
  };
}

function engine(chainAdapter: ChainAdapter, risk: RiskEngine = new BoundedRiskEngine()): SniperEngine {
  let id = 0;
  return new SniperEngine({
    adapters: [chainAdapter],
    ruleEvaluator: new DeterministicRuleEvaluator(),
    retryController: new BoundedRetryController({ baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }),
    riskEngine: risk,
    auditSink: new MemoryAuditSink(),
    idFactory: () => `id-${++id}`,
  });
}

describe("SniperEngine confirmation invariant", () => {
  it("returns confirmed only after the confirmation adapter verifies the chain", async () => {
    const network = "evm:sepolia";
    const result = await engine(adapter(network, {
      confirmed: true,
      state: "confirmed",
      signature: "0xconfirmed",
      observations: [{ state: "confirmed", observedAt: Date.now(), transactionHash: "0xconfirmed" }],
      finishedAt: Date.now(),
    })).execute(request(network));

    expect(result.outcome).toBe("confirmed");
    expect(result.confirmationState).toBe("confirmed");
    expect(result.audit.at(-1)).toMatchObject({ stage: "complete", state: "confirmed" });
  });

  it("preserves canonical confirmation when risk settlement persistence fails", async () => {
    const network = "evm:sepolia";
    const backingRisk = new BoundedRiskEngine();
    const risk: RiskEngine = {
      assertEvent: (event, matchedRule, spendAtomic, now) => backingRisk.assertEvent(event, matchedRule, spendAtomic, now),
      assertQuote: (matchedRule, quote, now) => backingRisk.assertQuote(matchedRule, quote, now),
      assertAttempt: (event, matchedRule, attempt) => backingRisk.assertAttempt(event, matchedRule, attempt),
      recordConfirmed: () => { throw new Error("risk ledger unavailable"); },
      release: (reservationId) => backingRisk.release(reservationId),
      setKillSwitch: (enabled) => backingRisk.setKillSwitch(enabled),
    };
    const result = await engine(adapter(network, {
      confirmed: true,
      state: "confirmed",
      signature: "0xconfirmed",
      observations: [{ state: "confirmed", observedAt: Date.now() }],
      finishedAt: Date.now(),
    }), risk).execute(request(network));

    expect(result).toMatchObject({ outcome: "confirmed", confirmationState: "confirmed" });
    expect(result.audit).toContainEqual(expect.objectContaining({
      stage: "risk",
      state: "failed",
      detail: expect.objectContaining({ phase: "settlement", error: "risk ledger unavailable" }),
    }));
  });

  it("never treats relay HTTP acceptance as success when RPC has no receipt", async () => {
    const network = "solana:devnet";
    const submit = vi.fn(async () => ({
      relayId: "nozomi",
      kind: "nozomi" as const,
      accepted: true,
      acceptedAt: Date.now(),
      latencyMs: 1,
      responseId: undefined,
    }));
    const result = await engine(adapter(network, {
      confirmed: false,
      state: "submitted",
      signature: "signed-canonical-transaction-signature",
      observations: [{ state: "submitted", observedAt: Date.now() }],
      finishedAt: Date.now(),
      error: "RPC returned no signature status.",
    }, submit)).execute(request(network));

    expect(submit).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("failed");
    expect(result.confirmationState).toBe("failed");
    expect(result.error).toContain("no signature status");
    expect(result.audit.some((record) => record.stage === "complete" && record.state === "confirmed")).toBe(false);
  });

  it("deduplicates the same source cursor across concurrent and repeated delivery", async () => {
    const network = "evm:sepolia";
    const submit = vi.fn(async () => ({ relayId: "rpc", kind: "evm-rpc" as const, accepted: true, acceptedAt: Date.now(), latencyMs: 1 }));
    const instance = engine(adapter(network, {
      confirmed: true,
      state: "finalized",
      signature: "0xfinalized",
      observations: [{ state: "finalized", observedAt: Date.now() }],
      finishedAt: Date.now(),
    }, submit));
    const executionRequest = request(network);
    const [first, second] = await Promise.all([instance.execute(executionRequest), instance.execute(executionRequest)]);
    const third = await instance.execute(executionRequest);

    expect(first.executionId).toBe(second.executionId);
    expect(third.executionId).toBe(first.executionId);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("keeps both production networks locked unless explicitly enabled", async () => {
    for (const network of ["solana:mainnet", "evm:mainnet"] as const) {
      const result = await engine(adapter(network, {
        confirmed: true,
        state: "confirmed",
        signature: "unreachable",
        observations: [],
        finishedAt: Date.now(),
      })).execute(request(network));
      expect(result.outcome).toBe("failed");
      expect(result.error).toContain("locked by policy");
      expect(result.relayReceipts).toHaveLength(0);
    }
  });

  it("prevents deterministic test adapters from being wired to Mainnet", () => {
    expect(() => new StaticQuoteAdapter(["evm:mainnet"])).toThrow(/must not be used on production/);
    expect(() => new TestWalletAdapter(["solana:mainnet"])).toThrow(/must not be used on production/);
    expect(() => new ManifestTransactionAdapter({ networks: ["evm:mainnet"], getLifetime: async () => ({ kind: "evm-nonce", nonce: 1 }) })).toThrow(/must not be used on production/);
  });

  it("tracks the original signed transaction after a reorg without rebuilding or resubmitting", async () => {
    const network = "evm:sepolia";
    const submit = vi.fn(async () => ({ relayId: "rpc", kind: "evm-rpc" as const, accepted: true, acceptedAt: Date.now(), latencyMs: 1 }));
    const result = await engine(adapter(network, [
      { confirmed: false, state: "reorged", signature: "0xoriginal", observations: [{ state: "reorged", observedAt: Date.now() }], finishedAt: Date.now() },
      { confirmed: true, state: "confirmed", signature: "0xoriginal", observations: [{ state: "confirmed", observedAt: Date.now() }], finishedAt: Date.now() },
    ], submit)).execute(request(network));
    expect(result).toMatchObject({ outcome: "confirmed", attempts: 2, signature: expect.any(String) });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("revalidates the quote before every initial or replacement build", async () => {
    const network = "evm:sepolia";
    const risk = new BoundedRiskEngine();
    const quoteChecks = vi.spyOn(risk, "assertQuote");
    const result = await engine(adapter(network, [
      { confirmed: false, state: "expired", signature: "0xexpired", observations: [{ state: "expired", observedAt: Date.now() }], finishedAt: Date.now() },
      { confirmed: true, state: "confirmed", signature: "0xreplacement", observations: [{ state: "confirmed", observedAt: Date.now() }], finishedAt: Date.now() },
    ]), risk).execute(request(network));

    expect(result).toMatchObject({ outcome: "confirmed", attempts: 2 });
    expect(quoteChecks).toHaveBeenCalledTimes(3);
  });

  it("enforces a network-wide daily envelope across different rule ids", async () => {
    const network = "evm:sepolia";
    const instance = engine(adapter(network, {
      confirmed: true,
      state: "confirmed",
      signature: "0xconfirmed",
      observations: [{ state: "confirmed", observedAt: Date.now() }],
      finishedAt: Date.now(),
    }), new BoundedRiskEngine({ networkDailyLimits: { [network]: 15_000n } }));
    await expect(instance.execute(request(network))).resolves.toMatchObject({ outcome: "confirmed" });
    const second = request(network, {
      event: { ...request(network).event, id: "event-2", sourceCursor: "cursor-2" },
      rules: [rule(network, { id: "rule-2", maxDailySpendAtomic: 5_000_000n })],
    });
    await expect(instance.execute(second)).resolves.toMatchObject({ outcome: "failed", error: expect.stringContaining("network daily limit") });
  });

  it("reserves risk envelopes atomically and releases failed work", () => {
    const network = "evm:sepolia";
    const risk = new BoundedRiskEngine({ networkDailyLimits: { [network]: 15_000n } });
    const first = request(network).event;
    const second = { ...first, id: "event-2", sourceCursor: "cursor-2" };
    const reservation = risk.assertEvent(first, rule(network), 10_000n, 1_000);
    expect(() => risk.assertEvent(second, rule(network, { id: "rule-2" }), 10_000n, 1_000)).toThrow(/network daily limit/);
    risk.release(reservation);
    expect(risk.assertEvent(second, rule(network, { id: "rule-2" }), 10_000n, 1_001)).toMatch(/^rule-2:/);
  });

  it("keeps cooldown protection after a failed reservation is released", () => {
    const network = "evm:sepolia";
    const risk = new BoundedRiskEngine();
    const guardedRule = rule(network, { cooldownMs: 1_000 });
    const reservation = risk.assertEvent(request(network).event, guardedRule, 10_000n, 1_000);
    risk.release(reservation);

    expect(() => risk.assertEvent(request(network).event, guardedRule, 10_000n, 1_999)).toThrow(/cooldown/);
    expect(risk.assertEvent(request(network).event, guardedRule, 10_000n, 2_000)).toMatch(/^rule-1:/);
  });

  it("charges a confirmation to its reservation day rather than its later confirmation day", () => {
    const network = "evm:sepolia";
    const dayOne = Date.UTC(2026, 0, 1, 23, 59, 0);
    const dayTwo = Date.UTC(2026, 0, 2, 0, 1, 0);
    const risk = new BoundedRiskEngine({ networkDailyLimits: { [network]: 10_000n } });
    const reservation = risk.assertEvent(request(network).event, rule(network), 10_000n, dayOne);
    risk.recordConfirmed(reservation, dayTwo);
    const anotherRule = rule(network, { id: "rule-2" });

    expect(() => risk.assertEvent(request(network).event, anotherRule, 1n, dayOne + 1_000)).toThrow(/network daily limit/);
    expect(risk.assertEvent(request(network).event, anotherRule, 10_000n, dayTwo + 1_000)).toMatch(/^rule-2:/);
  });
});

describe("bounded infrastructure helpers", () => {
  it("removes the retry abort listener before a wait resolves", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const retry = new BoundedRetryController();
      const waiting = retry.wait({ retry: true, refreshTransaction: false, delayMs: 25, reason: "test" }, controller.signal);
      await vi.advanceTimersByTimeAsync(25);
      await waiting;
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds in-memory audit history by execution and keeps indexed reads", async () => {
    const sink = new MemoryAuditSink({ maxExecutions: 2 });
    for (const executionId of ["execution-1", "execution-2", "execution-3"]) {
      await sink.record({ id: executionId, executionId, eventId: executionId, network: "evm:sepolia", stage: "event", state: "received", timestamp: Date.now(), detail: {} });
    }
    expect(sink.records("execution-1")).toHaveLength(0);
    expect(sink.records("execution-2")).toHaveLength(1);
    expect(sink.records()).toHaveLength(2);
  });

  it("times out HTTP relays and redacts endpoint credentials from errors", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("relay failed: token=super-secret Bearer bearer-secret https://relay.example/send")), { once: true });
    }));
    const relay = new HttpRelayAdapter({ id: "bounded", kind: "rpc", networks: ["evm:sepolia"], endpoint: "https://relay.example", timeoutMs: 1, fetcher });
    const transaction = await adapter("evm:sepolia", { confirmed: false, state: "submitted", signature: "0xnone", observations: [], finishedAt: Date.now() }).wallet.sign(
      await adapter("evm:sepolia", { confirmed: false, state: "submitted", signature: "0xnone", observations: [], finishedAt: Date.now() }).transaction.build({
        chain: CHAIN_DESCRIPTORS["evm:sepolia"], event: request("evm:sepolia").event,
        quote: await new StaticQuoteAdapter(["evm:sepolia"]).quote({ chain: CHAIN_DESCRIPTORS["evm:sepolia"], event: request("evm:sepolia").event, rule: rule("evm:sepolia"), inputAmountAtomic: 1n }),
        feePolicy: request("evm:sepolia").feePolicy, idempotencyKey: "relay-test",
      }),
    );
    const receipt = await relay.submit(transaction);
    expect(receipt.accepted).toBe(false);
    expect(receipt.error).not.toContain("super-secret");
    expect(receipt.error).not.toContain("bearer-secret");
    expect(receipt.error).not.toContain("relay.example");
  });
});

describe("DeterministicRuleEvaluator", () => {
  it("matches explicit source accounts and rejects unsafe regex patterns", () => {
    const evaluator = new DeterministicRuleEvaluator();
    const baseRequest = request("evm:sepolia");
    const event = { ...baseRequest.event, sourceAccount: "@sunder", text: "launch token" };
    expect(evaluator.evaluate(event, [rule("evm:sepolia", { accounts: ["@sunder"], keywords: ["launch"] })]).matched).toBe(true);
    expect(evaluator.evaluate(event, [rule("evm:sepolia", { regex: "(a+)+$" })])).toMatchObject({ matched: false });
  });
});
