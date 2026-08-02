import { createReadStream } from "node:fs";
import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { AuditRecord, AuditSink, BoundedRiskHydration, ChainNetworkId } from "../../sniper-engine/src/index.js";

function serialize(record: AuditRecord): string {
  return `${JSON.stringify(record, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}\n`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export class JsonlAuditSink implements AuditSink {
  readonly #file: string;
  readonly #records: AuditRecord[] = [];
  readonly #executionRisk = new Map<string, {
    ruleId?: string;
    network?: ChainNetworkId;
    spendAtomic?: bigint;
    reservationAt?: number;
    confirmedAt?: number;
  }>();
  #initialized?: Promise<void>;

  constructor(file: string) {
    this.#file = file;
  }

  async #initialize(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const handle = await open(this.#file, "a", 0o600);
    await handle.close();
    await chmod(this.#file, 0o600);
    const lines = createInterface({ input: createReadStream(this.#file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || line.length > 1_048_576) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!isAuditRecord(value)) continue;
        const frozen = Object.freeze({ ...value, detail: deepFreeze(structuredClone(value.detail)) });
        this.#index(frozen);
        this.#records.push(frozen);
        while (this.#records.length > 10_000) this.#records.shift();
      } catch {
        // A truncated final line or an untrusted record must not stop readiness.
      }
    }
  }

  initialize(): Promise<void> {
    this.#initialized ??= this.#initialize();
    return this.#initialized;
  }

  async record(record: AuditRecord): Promise<void> {
    await this.initialize();
    const frozen = Object.freeze({ ...record, detail: deepFreeze(structuredClone(record.detail)) });
    await appendFile(this.#file, serialize(frozen), { encoding: "utf8", mode: 0o600 });
    this.#index(frozen);
    this.#records.push(frozen);
    while (this.#records.length > 10_000) this.#records.shift();
  }

  records(executionId?: string): readonly AuditRecord[] {
    const records = executionId
      ? this.#records.filter((record) => record.executionId === executionId)
      : this.#records;
    return Object.freeze([...records]);
  }

  riskHydration(): BoundedRiskHydration {
    const confirmedExecutionsByRule: Record<string, number> = Object.create(null) as Record<string, number>;
    const lastExecutionByRule: Record<string, number> = Object.create(null) as Record<string, number>;
    const dailySpendByRule: Record<string, { day: string; atomic: bigint }> = Object.create(null) as Record<string, { day: string; atomic: bigint }>;
    const dailySpendByNetwork: Partial<Record<ChainNetworkId, { day: string; atomic: bigint }>> = {};
    for (const execution of this.#executionRisk.values()) {
      if (!execution.ruleId || !execution.network || execution.spendAtomic === undefined || execution.reservationAt === undefined || execution.confirmedAt === undefined) continue;
      const ruleId = execution.ruleId;
      confirmedExecutionsByRule[ruleId] = (confirmedExecutionsByRule[ruleId] ?? 0) + 1;
      lastExecutionByRule[ruleId] = Math.max(lastExecutionByRule[ruleId] ?? 0, execution.confirmedAt);
      const day = new Date(execution.reservationAt).toISOString().slice(0, 10);
      dailySpendByRule[ruleId] = addWindow(dailySpendByRule[ruleId], day, execution.spendAtomic);
      dailySpendByNetwork[execution.network] = addWindow(dailySpendByNetwork[execution.network], day, execution.spendAtomic);
    }
    return Object.freeze({
      confirmedExecutionsByRule: Object.freeze(confirmedExecutionsByRule),
      lastExecutionByRule: Object.freeze(lastExecutionByRule),
      dailySpendByRule: Object.freeze(dailySpendByRule),
      dailySpendByNetwork: Object.freeze(dailySpendByNetwork),
    });
  }

  #index(record: AuditRecord): void {
    const execution = this.#executionRisk.get(record.executionId) ?? {};
    if (record.stage === "rule" && record.state === "matched" && typeof record.detail.ruleId === "string" && record.detail.ruleId.trim()) {
      execution.ruleId = record.detail.ruleId;
    }
    if (record.stage === "risk" && record.state === "passed" && record.detail.phase === "event") {
      const spendAtomic = parseAtomic(record.detail.spendAtomic);
      if (spendAtomic !== undefined && spendAtomic >= 0n) {
        execution.network = record.network;
        execution.spendAtomic = spendAtomic;
        execution.reservationAt = record.timestamp;
      }
    }
    if (record.stage === "confirmation" && (record.state === "confirmed" || record.state === "finalized")) {
      execution.confirmedAt = Math.max(execution.confirmedAt ?? 0, record.timestamp);
    }
    this.#executionRisk.set(record.executionId, execution);
  }
}

const NETWORKS = new Set<ChainNetworkId>(["solana:devnet", "solana:mainnet", "evm:sepolia", "evm:mainnet"]);
const STAGES = new Set<AuditRecord["stage"]>(["event", "rule", "risk", "quote", "build", "simulation", "signature", "relay", "confirmation", "retry", "complete"]);
const STATES = new Set<AuditRecord["state"]>(["prepared", "signed", "submitted", "processed", "confirmed", "finalized", "replaced", "reorged", "failed", "expired", "received", "matched", "rejected", "passed", "retrying"]);

function isAuditRecord(value: unknown): value is AuditRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AuditRecord>;
  return typeof record.id === "string"
    && typeof record.executionId === "string"
    && typeof record.eventId === "string"
    && typeof record.network === "string" && NETWORKS.has(record.network as ChainNetworkId)
    && typeof record.stage === "string" && STAGES.has(record.stage as AuditRecord["stage"])
    && typeof record.state === "string" && STATES.has(record.state as AuditRecord["state"])
    && typeof record.timestamp === "number" && Number.isFinite(record.timestamp) && record.timestamp >= 0
    && Boolean(record.detail) && typeof record.detail === "object" && !Array.isArray(record.detail);
}

function parseAtomic(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

function addWindow(current: { readonly day: string; readonly atomic: bigint } | undefined, day: string, atomic: bigint) {
  if (!current || current.day < day) return Object.freeze({ day, atomic });
  if (current.day > day) return current;
  return Object.freeze({ day, atomic: current.atomic + atomic });
}
