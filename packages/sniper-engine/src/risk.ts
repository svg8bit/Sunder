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

export interface BoundedRiskHydration {
  readonly confirmedExecutionsByRule?: Readonly<Record<string, number>>;
  readonly lastExecutionByRule?: Readonly<Record<string, number>>;
  readonly dailySpendByRule?: Readonly<Record<string, SpendWindow>>;
  readonly dailySpendByNetwork?: Readonly<Partial<Record<ChainNetworkId, SpendWindow>>>;
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
  readonly #confirmedExecutionsByRule = new Map<string, number>();
  readonly #reservations = new Map<string, Reservation>();
  readonly #reservedByRule = new Map<string, number>();
  #reservationSequence = 0;

  constructor(options: {
    readonly unlockedProductionNetworks?: readonly SniperEvent["network"][];
    readonly networkDailyLimits?: Readonly<Partial<Record<ChainNetworkId, bigint>>>;
    readonly hydration?: BoundedRiskHydration;
  } = {}) {
    this.#unlockedProductionNetworks = new Set(options.unlockedProductionNetworks ?? []);
    this.#networkDailyLimits = Object.freeze({ ...options.networkDailyLimits });
    this.#hydrate(options.hydration);
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
    if (rule.maxConfirmedExecutions !== undefined) {
      if (!Number.isInteger(rule.maxConfirmedExecutions) || rule.maxConfirmedExecutions < 1 || rule.maxConfirmedExecutions > 3) {
        throw new RiskViolation("invalid-confirmed-execution-limit", "maxConfirmedExecutions must be an integer within [1, 3].");
      }
      const confirmed = this.#confirmedExecutionsByRule.get(rule.id) ?? 0;
      const reserved = this.#reservedByRule.get(rule.id) ?? 0;
      if (confirmed + reserved >= rule.maxConfirmedExecutions) {
        throw new RiskViolation("confirmed-execution-limit", "The armed rule reached its canonical confirmation limit.");
      }
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
    this.#reservedByRule.set(rule.id, (this.#reservedByRule.get(rule.id) ?? 0) + 1);
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
    this.#decrementReserved(reservation.ruleId);
    this.#confirmedExecutionsByRule.set(
      reservation.ruleId,
      (this.#confirmedExecutionsByRule.get(reservation.ruleId) ?? 0) + 1,
    );
    const previousExecution = this.#lastExecutionByRule.get(reservation.ruleId);
    if (previousExecution === undefined || confirmedAt > previousExecution) {
      this.#lastExecutionByRule.set(reservation.ruleId, confirmedAt);
    }
  }

  release(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) return;
    this.#reservations.delete(reservationId);
    this.#decrementReserved(reservation.ruleId);
    this.#subtractReservation(reservation);
  }

  setKillSwitch(enabled: boolean): void {
    this.#killSwitch = enabled;
  }

  confirmedExecutions(ruleId: string): number {
    return this.#confirmedExecutionsByRule.get(ruleId) ?? 0;
  }

  snapshot(): BoundedRiskHydration {
    return Object.freeze({
      confirmedExecutionsByRule: Object.freeze(Object.fromEntries(this.#confirmedExecutionsByRule)),
      lastExecutionByRule: Object.freeze(Object.fromEntries(this.#lastExecutionByRule)),
      dailySpendByRule: Object.freeze(Object.fromEntries([...this.#dailySpendByRule].map(([key, value]) => [key, Object.freeze({ ...value })]))),
      dailySpendByNetwork: Object.freeze(Object.fromEntries([...this.#dailySpendByNetwork].map(([key, value]) => [key, Object.freeze({ ...value })]))),
    });
  }

  #hydrate(hydration: BoundedRiskHydration | undefined): void {
    if (!hydration) return;
    for (const [ruleId, count] of Object.entries(hydration.confirmedExecutionsByRule ?? {})) {
      if (!ruleId.trim() || !Number.isInteger(count) || count < 0) throw new Error("Invalid confirmed-execution risk hydration.");
      this.#confirmedExecutionsByRule.set(ruleId, count);
    }
    for (const [ruleId, timestamp] of Object.entries(hydration.lastExecutionByRule ?? {})) {
      if (!ruleId.trim() || !Number.isFinite(timestamp) || timestamp < 0) throw new Error("Invalid last-execution risk hydration.");
      this.#lastExecutionByRule.set(ruleId, timestamp);
    }
    for (const [ruleId, window] of Object.entries(hydration.dailySpendByRule ?? {})) {
      this.#dailySpendByRule.set(ruleId, this.#validatedWindow(ruleId, window));
    }
    for (const [network, window] of Object.entries(hydration.dailySpendByNetwork ?? {})) {
      if (!(network in this.#networkDailyLimits) && !["solana:devnet", "solana:mainnet", "evm:sepolia", "evm:mainnet"].includes(network)) {
        throw new Error("Invalid network risk hydration.");
      }
      this.#dailySpendByNetwork.set(network as ChainNetworkId, this.#validatedWindow(network, window));
    }
  }

  #validatedWindow(key: string, value: SpendWindow): SpendWindow {
    const parsedDay = /^\d{4}-\d{2}-\d{2}$/.test(value.day)
      ? new Date(`${value.day}T00:00:00.000Z`)
      : undefined;
    const validDay = parsedDay !== undefined
      && Number.isFinite(parsedDay.getTime())
      && parsedDay.toISOString().slice(0, 10) === value.day;
    if (!key.trim() || !validDay || typeof value.atomic !== "bigint" || value.atomic < 0n) {
      throw new Error("Invalid daily-spend risk hydration.");
    }
    return Object.freeze({ day: value.day, atomic: value.atomic });
  }

  #decrementReserved(ruleId: string): void {
    const remaining = (this.#reservedByRule.get(ruleId) ?? 0) - 1;
    if (remaining > 0) this.#reservedByRule.set(ruleId, remaining);
    else this.#reservedByRule.delete(ruleId);
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
