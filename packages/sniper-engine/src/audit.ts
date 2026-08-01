import type { AuditRecord, AuditSink } from "./types.js";

export class MemoryAuditSink implements AuditSink {
  readonly #records: AuditRecord[] = [];

  record(record: AuditRecord): void {
    this.#records.push(Object.freeze({ ...record, detail: Object.freeze({ ...record.detail }) }));
  }

  records(executionId?: string): readonly AuditRecord[] {
    const records = executionId
      ? this.#records.filter((record) => record.executionId === executionId)
      : this.#records;
    return Object.freeze([...records]);
  }
}

export function toSerializableAudit(records: readonly AuditRecord[]): readonly Record<string, unknown>[] {
  return records.map((record) => JSON.parse(JSON.stringify(record, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  )) as Record<string, unknown>);
}
