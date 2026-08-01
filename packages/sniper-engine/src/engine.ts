import type {
  AuditRecord,
  AuditSink,
  ChainAdapter,
  ConfirmationResult,
  ExecutionRequest,
  ExecutionResult,
  RelayReceipt,
  RetryController,
  RiskEngine,
  RuleEvaluator,
  SignedTransaction,
  SniperRule,
} from "./types.js";

interface EngineDependencies {
  readonly adapters: readonly ChainAdapter[];
  readonly ruleEvaluator: RuleEvaluator;
  readonly retryController: RetryController;
  readonly riskEngine: RiskEngine;
  readonly auditSink: AuditSink;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adapterFor(dependencies: EngineDependencies, request: ExecutionRequest): ChainAdapter {
  const adapter = dependencies.adapters.find((candidate) => candidate.chain.id === request.event.network);
  if (!adapter) throw new Error(`No ChainAdapter is configured for ${request.event.network}.`);
  const network = request.event.network;
  const capabilities = [adapter.quote.networks, adapter.transaction.networks, adapter.wallet.networks, adapter.confirmation.networks];
  if (capabilities.some((networks) => !networks.includes(network))) {
    throw new Error(`ChainAdapter ${network} has an incomplete capability set.`);
  }
  return adapter;
}

export class SniperEngine {
  readonly #dependencies: EngineDependencies;
  readonly #clock: () => number;
  readonly #idFactory: () => string;

  constructor(dependencies: EngineDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? Date.now;
    this.#idFactory = dependencies.idFactory ?? (() => crypto.randomUUID());
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const executionId = this.#idFactory();
    const startedAt = this.#clock();
    let attempts = 0;
    let matchedRule: SniperRule | undefined;
    let signed: SignedTransaction | undefined;
    let lastConfirmation: ConfirmationResult | undefined;
    const relayReceipts: RelayReceipt[] = [];

    const audit = async (record: Omit<AuditRecord, "id" | "executionId" | "eventId" | "network" | "timestamp">): Promise<void> => {
      await this.#dependencies.auditSink.record({
        ...record,
        id: this.#idFactory(),
        executionId,
        eventId: request.event.id,
        network: request.event.network,
        timestamp: this.#clock(),
      });
    };

    const result = (overrides: Omit<ExecutionResult, "executionId" | "eventId" | "network" | "attempts" | "relayReceipts" | "audit" | "matchedRuleId">): ExecutionResult => ({
      executionId,
      eventId: request.event.id,
      network: request.event.network,
      attempts,
      matchedRuleId: matchedRule?.id,
      relayReceipts: Object.freeze([...relayReceipts]),
      audit: this.#dependencies.auditSink.records(executionId),
      ...overrides,
    });

    try {
      const adapter = adapterFor(this.#dependencies, request);
      await audit({ stage: "event", state: "received", detail: { source: request.event.source, kind: request.event.kind, chainFamily: adapter.chain.family } });
      const ruleStartedAt = this.#clock();
      const decision = this.#dependencies.ruleEvaluator.evaluate(request.event, request.rules, ruleStartedAt);
      if (!decision.matched || !decision.rule) {
        await audit({ stage: "rule", state: "rejected", latencyMs: this.#clock() - ruleStartedAt, detail: { reasons: decision.reasons } });
        return result({ outcome: "skipped", confirmationState: "failed", error: "No enabled rule matched the event." });
      }
      matchedRule = decision.rule;
      await audit({ stage: "rule", state: "matched", latencyMs: this.#clock() - ruleStartedAt, detail: { ruleId: matchedRule.id, reasons: decision.reasons } });

      this.#dependencies.riskEngine.assertEvent(request.event, matchedRule, request.inputAmountAtomic, this.#clock());
      await audit({ stage: "risk", state: "passed", detail: { phase: "event", spendAtomic: request.inputAmountAtomic } });

      const quoteStartedAt = this.#clock();
      const quote = await adapter.quote.quote({
        chain: adapter.chain,
        event: request.event,
        rule: matchedRule,
        inputAmountAtomic: request.inputAmountAtomic,
      }, signal);
      this.#dependencies.riskEngine.assertQuote(matchedRule, quote, this.#clock());
      await audit({ stage: "quote", state: "prepared", latencyMs: this.#clock() - quoteStartedAt, detail: { adapter: adapter.quote.id, quoteId: quote.id, expiresAt: quote.expiresAt, priceImpactBps: quote.priceImpactBps } });

      const buildAndSign = async (previous?: SignedTransaction): Promise<SignedTransaction> => {
        const buildStartedAt = this.#clock();
        const draft = await adapter.transaction.build({
          chain: adapter.chain,
          event: request.event,
          quote,
          feePolicy: request.feePolicy,
          idempotencyKey: `${executionId}:${quote.id}`,
          previous: previous?.draft,
        }, signal);
        await audit({ stage: "build", state: "prepared", latencyMs: this.#clock() - buildStartedAt, detail: { adapter: adapter.transaction.id, lifetime: draft.lifetime, feePolicy: draft.feePolicy, instructions: draft.instructions } });

        const simulationStartedAt = this.#clock();
        const simulation = await adapter.transaction.simulate(draft, signal);
        await audit({ stage: "simulation", state: simulation.ok ? "passed" : "failed", latencyMs: this.#clock() - simulationStartedAt, detail: { unitsConsumed: simulation.unitsConsumed, estimatedFeeAtomic: simulation.estimatedFeeAtomic, logs: simulation.logs, error: simulation.error } });
        if (!simulation.ok) throw new Error(simulation.error ?? "Pre-trade simulation failed.");

        const signStartedAt = this.#clock();
        const signedTransaction = await adapter.wallet.sign(draft, signal);
        await audit({ stage: "signature", state: "signed", latencyMs: this.#clock() - signStartedAt, detail: { walletAdapter: adapter.wallet.id, walletKind: adapter.wallet.kind, signature: signedTransaction.signature } });
        return signedTransaction;
      };

      signed = await buildAndSign();
      while (attempts < matchedRule.maxAttempts) {
        attempts += 1;
        this.#dependencies.riskEngine.assertAttempt(request.event, matchedRule, attempts);
        const relayStartedAt = this.#clock();
        const receipts = await adapter.relays.route(signed, request.relayFanout, signal);
        relayReceipts.push(...receipts);
        await audit({ stage: "relay", state: "submitted", latencyMs: this.#clock() - relayStartedAt, detail: { attempt: attempts, receipts } });

        if (receipts.some((receipt) => receipt.accepted)) {
          lastConfirmation = await adapter.confirmation.track(signed, signal);
          await audit({ stage: "confirmation", state: lastConfirmation.state, detail: { adapter: adapter.confirmation.id, attempt: attempts, signature: signed.signature, observations: lastConfirmation.observations, error: lastConfirmation.error } });
          if (lastConfirmation.confirmed && (lastConfirmation.state === "confirmed" || lastConfirmation.state === "finalized")) {
            this.#dependencies.riskEngine.recordConfirmed(matchedRule, request.inputAmountAtomic, lastConfirmation.finishedAt);
            await audit({ stage: "complete", state: lastConfirmation.state, latencyMs: this.#clock() - startedAt, detail: { signature: signed.signature, attempts } });
            return result({ outcome: "confirmed", confirmationState: lastConfirmation.state, signature: signed.signature });
          }
        }

        const retryDecision = this.#dependencies.retryController.decide({
          attempt: attempts,
          maxAttempts: matchedRule.maxAttempts,
          confirmation: lastConfirmation,
          relayReceipts: receipts,
        });
        await audit({ stage: "retry", state: retryDecision.retry ? "retrying" : "failed", detail: { attempt: attempts, ...retryDecision } });
        if (!retryDecision.retry) break;
        await this.#dependencies.retryController.wait(retryDecision, signal);
        if (retryDecision.refreshTransaction) signed = await buildAndSign(signed);
      }

      const finalState = lastConfirmation?.state === "expired" ? "expired" : "failed";
      await audit({ stage: "complete", state: finalState, latencyMs: this.#clock() - startedAt, detail: { attempts, error: lastConfirmation?.error ?? "No relay submission reached chain confirmation." } });
      return result({
        outcome: finalState,
        confirmationState: finalState,
        signature: signed?.signature,
        error: lastConfirmation?.error ?? "No relay submission reached chain confirmation.",
      });
    } catch (error) {
      const message = errorMessage(error);
      await audit({ stage: "complete", state: "failed", latencyMs: this.#clock() - startedAt, detail: { attempts, error: message } });
      return result({ outcome: "failed", confirmationState: "failed", signature: signed?.signature, error: message });
    }
  }
}
