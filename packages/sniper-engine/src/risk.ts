import type { ChainNetworkId, RiskEngine, SniperEvent, SniperRule, Quote } from "./types.js";

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
  atomic: bigint;
}

interface Reservation {
  readonly id: string;
  readonly ruleId: string;
  readonly network: ChainNetworkId;
  readonly day: string;
  readonly spendAtomic: bigint;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class BoundedRiskEngine implements RiskEngine {
  #killSwitch = false;
  readonly #unlockedProductionNetworks: ReadonlySet<SniperEvent["network"]>;
  readonly #networkDailyLimits: Readonly<Partial<Record<ChainNetworkId, bigint>>>;
  readonly #lastExecutionByRule = new Map<string, number>();
  readonly #dailySpendByRule = new Map<string, SpendWindow>();
  readonly #dailySpendByNetwork = new Map<ChainNetworkId, SpendWindow>();
  readonly #reservations = new Map<string, Reservation>();
  #reservationSequence = 0;

  constructor(options: {
    readonly unlockedProductionNetworks?: readonly SniperEvent["network"][];
    readonly networkDailyLimits?: Readonly<Partial<Record<ChainNetworkId, bigint>>>;
  } = {}) {
    this.#unlockedProductionNetworks = new Set(options.unlockedProductionNetworks ?? []);
    this.#networkDailyLimits = Object.freeze({ ...options.networkDailyLimits });
  }

  assertEvent(event: SniperEvent, rule: SniperRule, spendAtomic: bigint, now = Date.now()): string {
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
    const spent = window?.day === day ? window.atomic : 0n;
    if (spent + spendAtomic > rule.maxDailySpendAtomic) {
      throw new RiskViolation("daily-spend", "Requested spend exceeds the daily limit.");
    }
    const networkLimit = this.#networkDailyLimits[event.network];
    const networkWindow = this.#dailySpendByNetwork.get(event.network);
    const networkSpent = networkWindow?.day === day ? networkWindow.atomic : 0n;
    if (networkLimit !== undefined && networkSpent + spendAtomic > networkLimit) {
      throw new RiskViolation("network-daily-spend", "Requested spend exceeds the executor network daily limit.");
    }
    const reservationId = `${rule.id}:${now}:${++this.#reservationSequence}`;
    this.#dailySpendByRule.set(rule.id, { day, atomic: spent + spendAtomic });
    this.#dailySpendByNetwork.set(event.network, { day, atomic: networkSpent + spendAtomic });
    this.#lastExecutionByRule.set(rule.id, now);
    this.#reservations.set(reservationId, {
      id: reservationId,
      ruleId: rule.id,
      network: event.network,
      day,
      spendAtomic,
    });
    return reservationId;
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

  recordConfirmed(reservationId: string, confirmedAt = Date.now()): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) throw new RiskViolation("unknown-reservation", "Risk reservation is missing or already settled.");
    this.#reservations.delete(reservationId);
    const previousExecution = this.#lastExecutionByRule.get(reservation.ruleId);
    if (previousExecution === undefined || confirmedAt > previousExecution) {
      this.#lastExecutionByRule.set(reservation.ruleId, confirmedAt);
    }
  }

  release(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) return;
    this.#reservations.delete(reservationId);
    this.#subtractReservation(reservation);
  }

  setKillSwitch(enabled: boolean): void {
    this.#killSwitch = enabled;
  }

  #subtractReservation(reservation: Reservation): void {
    const ruleWindow = this.#dailySpendByRule.get(reservation.ruleId);
    if (ruleWindow?.day === reservation.day) {
      const remaining = ruleWindow.atomic - reservation.spendAtomic;
      if (remaining > 0n) this.#dailySpendByRule.set(reservation.ruleId, { ...ruleWindow, atomic: remaining });
      else this.#dailySpendByRule.delete(reservation.ruleId);
    }
    const networkWindow = this.#dailySpendByNetwork.get(reservation.network);
    if (networkWindow?.day === reservation.day) {
      const remaining = networkWindow.atomic - reservation.spendAtomic;
      if (remaining > 0n) this.#dailySpendByNetwork.set(reservation.network, { ...networkWindow, atomic: remaining });
      else this.#dailySpendByNetwork.delete(reservation.network);
    }
  }
}
