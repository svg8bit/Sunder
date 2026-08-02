import type { AuditRecord, AuditSink } from "./types.js";

export class MemoryAuditSink implements AuditSink {
  readonly #records: AuditRecord[] = [];
  readonly #byExecution = new Map<string, AuditRecord[]>();
  readonly #maxExecutions: number;

  constructor(options: { readonly maxExecutions?: number } = {}) {
    this.#maxExecutions = options.maxExecutions ?? 1_000;
    if (!Number.isSafeInteger(this.#maxExecutions) || this.#maxExecutions < 1) {
      throw new Error("maxExecutions must be a positive safe integer.");
    }
  }

  record(record: AuditRecord): void {
    const frozen = Object.freeze({ ...record, detail: Object.freeze({ ...record.detail }) });
    this.#records.push(frozen);
    const bucket = this.#byExecution.get(record.executionId);
    if (bucket) {
      bucket.push(frozen);
      return;
    }
    this.#byExecution.set(record.executionId, [frozen]);
    if (this.#byExecution.size <= this.#maxExecutions) return;
    const oldestExecutionId = this.#byExecution.keys().next().value;
    if (oldestExecutionId === undefined) return;
    this.#byExecution.delete(oldestExecutionId);
    for (let index = this.#records.length - 1; index >= 0; index -= 1) {
      if (this.#records[index]?.executionId === oldestExecutionId) this.#records.splice(index, 1);
    }
  }

  records(executionId?: string): readonly AuditRecord[] {
    const records = executionId ? this.#byExecution.get(executionId) ?? [] : this.#records;
    return Object.freeze([...records]);
  }
}

export function toSerializableAudit(records: readonly AuditRecord[]): readonly Record<string, unknown>[] {
  return records.map((record) => JSON.parse(JSON.stringify(record, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  )) as Record<string, unknown>);
}
