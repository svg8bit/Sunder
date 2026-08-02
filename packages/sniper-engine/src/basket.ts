export type WalletExecutionCapability = "wallet-standard" | "executor-signer" | "watch-only";

export interface WalletBasketMember {
  readonly id: string;
  readonly address: string;
  readonly label: string;
  readonly capability: WalletExecutionCapability;
  readonly enabled: boolean;
  readonly weightBps: number;
}

export interface WalletBasketStep {
  readonly sequence: number;
  readonly walletId: string;
  readonly address: string;
  readonly label: string;
  readonly capability: Exclude<WalletExecutionCapability, "watch-only">;
  readonly amountAtomic: bigint;
  readonly delayMs: number;
}

export interface WalletBasketExclusion {
  readonly walletId: string;
  readonly reason: "disabled" | "watch-only" | "zero-weight" | "burst-cap";
}

export interface WalletBasketPlan {
  readonly steps: readonly WalletBasketStep[];
  readonly exclusions: readonly WalletBasketExclusion[];
  readonly totalAtomic: bigint;
  readonly maxConfirmedExecutions: number;
}

function assertMember(member: WalletBasketMember): void {
  if (!member.id.trim() || !member.address.trim() || !member.label.trim()) {
    throw new Error("Wallet basket members require id, address and label.");
  }
  if (!Number.isInteger(member.weightBps) || member.weightBps < 0 || member.weightBps > 10_000) {
    throw new Error(`Wallet ${member.id} weightBps must be an integer within [0, 10000].`);
  }
}

/**
 * Builds a deterministic, signer-aware execution plan. Watch-only addresses
 * are deliberately excluded and the burst cap is applied before any signing.
 */
export function planWalletBasket(input: {
  readonly members: readonly WalletBasketMember[];
  readonly totalAtomic: bigint;
  readonly maxConfirmedExecutions?: number;
  readonly initialDelayMs?: number;
  readonly interWalletDelayMs?: number;
}): WalletBasketPlan {
  if (input.totalAtomic <= 0n) throw new Error("Wallet basket totalAtomic must be positive.");
  const maxConfirmedExecutions = input.maxConfirmedExecutions ?? 3;
  if (!Number.isInteger(maxConfirmedExecutions) || maxConfirmedExecutions < 1 || maxConfirmedExecutions > 3) {
    throw new Error("Wallet basket maxConfirmedExecutions must be within [1, 3].");
  }
  const initialDelayMs = input.initialDelayMs ?? 0;
  const interWalletDelayMs = input.interWalletDelayMs ?? 75;
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0 || !Number.isInteger(interWalletDelayMs) || interWalletDelayMs < 0) {
    throw new Error("Wallet basket delays must be non-negative integers.");
  }

  input.members.forEach(assertMember);
  const memberIds = new Set<string>();
  const memberAddresses = new Set<string>();
  for (const member of input.members) {
    const id = member.id.trim();
    const address = member.address.trim();
    const canonicalAddress = address.startsWith("0x") ? address.toLowerCase() : address;
    if (memberIds.has(id)) throw new Error(`Wallet basket contains duplicate member id: ${id}.`);
    if (memberAddresses.has(canonicalAddress)) throw new Error(`Wallet basket contains duplicate address: ${address}.`);
    memberIds.add(id);
    memberAddresses.add(canonicalAddress);
  }
  const exclusions: WalletBasketExclusion[] = [];
  const executable: WalletBasketMember[] = [];
  for (const member of input.members) {
    if (!member.enabled) {
      exclusions.push({ walletId: member.id, reason: "disabled" });
    } else if (member.capability === "watch-only") {
      exclusions.push({ walletId: member.id, reason: "watch-only" });
    } else if (member.weightBps === 0) {
      exclusions.push({ walletId: member.id, reason: "zero-weight" });
    } else if (executable.length >= maxConfirmedExecutions) {
      exclusions.push({ walletId: member.id, reason: "burst-cap" });
    } else {
      executable.push(member);
    }
  }
  if (executable.length === 0) throw new Error("Wallet basket has no enabled signing-capable members.");
  if (input.totalAtomic < BigInt(executable.length)) {
    throw new Error("Wallet basket totalAtomic cannot fund every selected execution with at least one atomic unit.");
  }
  const totalWeight = executable.reduce((sum, member) => sum + BigInt(member.weightBps), 0n);
  if (totalWeight <= 0n) throw new Error("Wallet basket signing-capable members require a positive total weight.");

  let allocated = 0n;
  const distributableAtomic = input.totalAtomic - BigInt(executable.length);
  const steps = executable.map((member, index): WalletBasketStep => {
    const amountAtomic = index === executable.length - 1
      ? input.totalAtomic - allocated
      : 1n + (distributableAtomic * BigInt(member.weightBps)) / totalWeight;
    if (amountAtomic <= 0n) throw new Error("Wallet basket allocation produced a zero-amount execution.");
    allocated += amountAtomic;
    return Object.freeze({
      sequence: index + 1,
      walletId: member.id,
      address: member.address,
      label: member.label,
      capability: member.capability as Exclude<WalletExecutionCapability, "watch-only">,
      amountAtomic,
      delayMs: initialDelayMs + index * interWalletDelayMs,
    });
  });

  return Object.freeze({
    steps: Object.freeze(steps),
    exclusions: Object.freeze(exclusions.map((entry) => Object.freeze(entry))),
    totalAtomic: input.totalAtomic,
    maxConfirmedExecutions,
  });
}
