export function parseDecimalAmount(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Token decimals must be an integer within [0, 18].");
  }
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized)) {
    throw new Error("Enter a positive decimal amount without exponent notation.");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`Amount supports at most ${decimals} decimal places.`);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals)
    + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (atomic <= 0n) throw new Error("Amount must be greater than zero.");
  return atomic;
}

export function applyPercentageBps(amount: bigint, percentageBps: number): bigint {
  if (amount < 0n) throw new Error("Balance cannot be negative.");
  if (!Number.isInteger(percentageBps) || percentageBps < 1 || percentageBps > 10_000) {
    throw new Error("Percentage must be an integer within [1, 10000] BPS.");
  }
  const result = (amount * BigInt(percentageBps)) / 10_000n;
  if (result <= 0n) throw new Error("Selected percentage rounds down to zero tokens.");
  return result;
}

export function formatAtomicAmount(amount: bigint, decimals: number, precision = 6): string {
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  if (decimals === 0 || precision === 0) return `${sign}${whole}`;
  const fraction = (absolute % base).toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}
