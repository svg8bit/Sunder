import type { ExecutionResult, SniperEvent } from "../../sniper-engine/src/index.js";
import { loadAutomationPolicy, type AutomationPolicy } from "./automation-policy.js";
import type { ExecutorConfig } from "./config.js";
import type { ExecutorReadiness } from "./readiness.js";
import type { ExecutorRuntime } from "./runtime.js";

export interface AutomationStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly network?: "solana:devnet" | "solana:mainnet";
  readonly source?: string;
  readonly blocker?: string;
  readonly configuredRules: number;
  readonly queueDepth: number;
  readonly eventsSeen: number;
  readonly eventsDropped: number;
  readonly executionsStarted: number;
  readonly executionsConfirmed: number;
  readonly executionsFailed: number;
  readonly lastEventAt?: string;
  readonly lastExecution?: Readonly<{
    eventId: string;
    outcome: ExecutionResult["outcome"];
    confirmationState: ExecutionResult["confirmationState"];
    signature?: string;
    error?: string;
    finishedAt: string;
  }>;
}

export interface AutomationController {
  status(): AutomationStatus;
  close(): Promise<void>;
}

export async function startAutomationController(
  config: ExecutorConfig,
  runtime: ExecutorRuntime,
  initialReadiness: ExecutorReadiness,
  evaluate: (config: ExecutorConfig, killSwitch?: boolean) => Promise<ExecutorReadiness>,
): Promise<AutomationController> {
  let running = false;
  let blocker: string | undefined;
  let policy: AutomationPolicy | undefined;
  let sourceId: string | undefined;
  let sourceController: AbortController | undefined;
  let eventsSeen = 0;
  let eventsDropped = 0;
  let executionsStarted = 0;
  let executionsConfirmed = 0;
  let executionsFailed = 0;
  let lastEventAt: string | undefined;
  let lastExecution: AutomationStatus["lastExecution"];
  let draining = false;
  let closed = false;
  const queue: SniperEvent[] = [];

  if (!config.automationEnabled) {
    blocker = "disabled";
  } else {
    const loaded = await loadAutomationPolicy(config.automationRulesFile);
    if (!loaded.ready) {
      blocker = `automation-policy:${loaded.detail}`;
    } else {
      policy = loaded.policy;
      const network = initialReadiness.networks.find((candidate) => candidate.network === policy?.network);
      if (!config.networks.includes(policy.network)) blocker = "policy-network-not-configured";
      else if (!network?.ready) {
        blocker = network?.gates.filter((gate) => !gate.ready).map((gate) => `${gate.id}:${gate.detail}`).join(", ") ?? "network-unavailable";
      }
    }
  }

  const processQueue = async (): Promise<void> => {
    if (draining || closed || !policy) return;
    draining = true;
    try {
      while (!closed && queue.length > 0) {
        const event = queue.shift();
        if (!event) continue;
        if (runtime.killSwitch()) {
          blocker = "kill-switch:active";
          continue;
        }
        executionsStarted += 1;
        try {
          const currentReadiness = await evaluate(config, runtime.killSwitch());
          const result = await runtime.execute({
            event,
            rules: policy.rules,
            inputAmountAtomic: policy.inputAmountLamports,
            feePolicy: policy.feePolicy,
            relayFanout: policy.relayFanout,
          }, currentReadiness);
          if (result.outcome === "confirmed") executionsConfirmed += 1;
          else if (result.outcome === "failed" || result.outcome === "expired") executionsFailed += 1;
          lastExecution = Object.freeze({
            eventId: result.eventId,
            outcome: result.outcome,
            confirmationState: result.confirmationState,
            signature: result.signature,
            error: result.error,
            finishedAt: new Date().toISOString(),
          });
        } catch (error) {
          executionsFailed += 1;
          lastExecution = Object.freeze({
            eventId: event.id,
            outcome: "failed",
            confirmationState: "failed",
            error: error instanceof Error ? error.message : "Automation execution failed.",
            finishedAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      draining = false;
    }
  };

  if (policy && !blocker) {
    const rpcUrl = config.rpc[policy.network];
    const fundingAddress = config.fundingAddress.solana;
    if (!rpcUrl || !fundingAddress) {
      blocker = "rpc-or-funding-address-unconfigured";
    } else {
      const { PumpProgramEventSource } = await import("../../chain-solana/src/pump-event-source.js");
      const source = new PumpProgramEventSource({
        network: policy.network,
        rpcUrl,
        websocketUrl: config.websocket[policy.network],
        fundingAddress,
      });
      sourceId = source.id;
      sourceController = await source.start((event) => {
        eventsSeen += 1;
        lastEventAt = new Date().toISOString();
        if (queue.length >= config.automationMaxQueue) {
          eventsDropped += 1;
          return;
        }
        queue.push(event);
        void processQueue();
      });
      running = true;
    }
  }

  return Object.freeze({
    status: () => Object.freeze({
      enabled: config.automationEnabled,
      running,
      network: policy?.network,
      source: sourceId,
      blocker,
      configuredRules: policy?.rules.length ?? 0,
      queueDepth: queue.length,
      eventsSeen,
      eventsDropped,
      executionsStarted,
      executionsConfirmed,
      executionsFailed,
      lastEventAt,
      lastExecution,
    }),
    async close() {
      if (closed) return;
      closed = true;
      running = false;
      sourceController?.abort();
      queue.splice(0);
    },
  });
}
