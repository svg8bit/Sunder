import type { RiskEngine, SniperEvent, SniperRule, Quote } from "./types.js";

export class RiskViolation extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RiskViolation";
    this.code = code;
  }
}

interface SpendWindow {
  day: string;
  lamports: bigint;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class BoundedRiskEngine implements RiskEngine {
  #killSwitch = false;
  readonly #unlockedProductionNetworks: ReadonlySet<SniperEvent["network"]>;
  readonly #lastExecutionByRule = new Map<string, number>();
  readonly #dailySpendByRule = new Map<string, SpendWindow>();

  constructor(options: { readonly unlockedProductionNetworks?: readonly SniperEvent["network"][] } = {}) {
    this.#unlockedProductionNetworks = new Set(options.unlockedProductionNetworks ?? []);
  }

  assertEvent(event: SniperEvent, rule: SniperRule, spendAtomic: bigint, now = Date.now()): void {
    if (this.#killSwitch) throw new RiskViolation("kill-switch", "Execution kill switch is active.");
    if ((event.network === "solana:mainnet" || event.network === "evm:mainnet") && !this.#unlockedProductionNetworks.has(event.network)) {
      throw new RiskViolation("mainnet-locked", `${event.network} execution is locked by policy.`);
    }
    if (spendAtomic <= 0n) throw new RiskViolation("invalid-spend", "Spend must be positive.");
    if (spendAtomic > rule.maxSpendAtomic) {
      throw new RiskViolation("max-spend", "Requested spend exceeds the per-transaction limit.");
    }
    const previous = this.#lastExecutionByRule.get(rule.id);
    if (previous !== undefined && now - previous < rule.cooldownMs) {
      throw new RiskViolation("cooldown", "Rule cooldown has not elapsed.");
    }
    const day = utcDay(now);
    const window = this.#dailySpendByRule.get(rule.id);
    const spent = window?.day === day ? window.lamports : 0n;
    if (spent + spendAtomic > rule.maxDailySpendAtomic) {
      throw new RiskViolation("daily-spend", "Requested spend exceeds the daily limit.");
    }
  }

  assertQuote(rule: SniperRule, quote: Quote, now = Date.now()): void {
    if (quote.expiresAt <= now) throw new RiskViolation("stale-quote", "Quote expired before build.");
    if (quote.priceImpactBps > rule.maxPriceImpactBps) {
      throw new RiskViolation("price-impact", "Quote price impact exceeds the configured limit.");
    }
    const slippageBps = quote.expectedOutputAmount === 0n
      ? Number.POSITIVE_INFINITY
      : Number(((quote.expectedOutputAmount - quote.minimumOutputAmount) * 10_000n) / quote.expectedOutputAmount);
    if (slippageBps > rule.maxSlippageBps) {
      throw new RiskViolation("slippage", "Quote slippage exceeds the configured limit.");
    }
  }

  assertAttempt(_event: SniperEvent, rule: SniperRule, attempt: number): void {
    if (this.#killSwitch) throw new RiskViolation("kill-switch", "Execution kill switch is active.");
    if (attempt < 1 || attempt > rule.maxAttempts) {
      throw new RiskViolation("attempt-budget", "Relay attempt exceeds the configured budget.");
    }
  }

  recordConfirmed(rule: SniperRule, spendAtomic: bigint, confirmedAt = Date.now()): void {
    const day = utcDay(confirmedAt);
    const current = this.#dailySpendByRule.get(rule.id);
    const lamports = current?.day === day ? current.lamports + spendAtomic : spendAtomic;
    this.#dailySpendByRule.set(rule.id, { day, lamports });
    this.#lastExecutionByRule.set(rule.id, confirmedAt);
  }

  setKillSwitch(enabled: boolean): void {
    this.#killSwitch = enabled;
  }
}
