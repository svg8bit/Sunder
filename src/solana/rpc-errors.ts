export type SolanaFailureSafety = "not-submitted" | "submission-unknown" | "submitted";

export function stringifySolanaRpcValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error && value.message) return value.message;
  try {
    return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item) ?? String(value);
  } catch {
    return String(value);
  }
}

export function isSolanaTimeout(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  const detail = stringifySolanaRpcValue(error).toLowerCase();
  return detail.includes("timed out") || detail.includes("timeout") || detail.includes("signal timed out");
}

export function solanaStageError(stage: string, error: unknown, safety: SolanaFailureSafety = "not-submitted"): Error {
  const detail = stringifySolanaRpcValue(error);
  if (!isSolanaTimeout(error)) return new Error(`${stage} failed: ${detail}`);
  if (safety === "submission-unknown") {
    return new Error(`${stage} timed out. The RPC may have received the signed transaction; check Wallet activity before retrying.`);
  }
  if (safety === "submitted") {
    return new Error(`${stage} timed out. Sunder did not report success; check the submitted signature before retrying.`);
  }
  return new Error(`${stage} timed out before submission. No transaction was sent; retry now.`);
}
