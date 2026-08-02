import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditRecord, AuditSink } from "../../sniper-engine/src/index.js";

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
  #initialized?: Promise<void>;

  constructor(file: string) {
    this.#file = file;
  }

  async #initialize(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const handle = await open(this.#file, "a", 0o600);
    await handle.close();
    await chmod(this.#file, 0o600);
  }

  async record(record: AuditRecord): Promise<void> {
    this.#initialized ??= this.#initialize();
    await this.#initialized;
    const frozen = Object.freeze({ ...record, detail: deepFreeze(structuredClone(record.detail)) });
    await appendFile(this.#file, serialize(frozen), { encoding: "utf8", mode: 0o600 });
    this.#records.push(frozen);
    while (this.#records.length > 10_000) this.#records.shift();
  }

  records(executionId?: string): readonly AuditRecord[] {
    const records = executionId
      ? this.#records.filter((record) => record.executionId === executionId)
      : this.#records;
    return Object.freeze([...records]);
  }
}
