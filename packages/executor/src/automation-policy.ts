import { open } from "node:fs/promises";
import { z } from "zod";
import type { ExecutionRequest, SniperRule } from "../../sniper-engine/src/index.js";

const atomicSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).transform((value) => BigInt(value));
const solanaNetworkSchema = z.enum(["solana:devnet", "solana:mainnet"]);
const eventKindSchema = z.enum(["new_mint", "pool_created", "program_log"]);

const ruleSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  networks: z.array(solanaNetworkSchema).min(1).max(2),
  eventKinds: z.array(eventKindSchema).min(1).max(3),
  accounts: z.array(z.string().min(1).max(128)).max(128).default([]),
  keywords: z.array(z.string().min(1).max(128)).max(128).default([]),
  regex: z.string().max(256).optional(),
  requireMedia: z.boolean().default(false),
  allowTargets: z.array(z.string().min(1).max(128)).max(256).default([]),
  denyTargets: z.array(z.string().min(1).max(128)).max(256).default([]),
  maxSpendAtomic: atomicSchema,
  maxDailySpendAtomic: atomicSchema,
  maxSlippageBps: z.number().int().min(0).max(5_000),
  maxPriceImpactBps: z.number().int().min(0).max(10_000),
  cooldownMs: z.number().int().min(0).max(86_400_000),
  maxAttempts: z.number().int().min(1).max(5),
  maxConfirmedExecutions: z.number().int().min(1).max(3),
});

const policySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  network: solanaNetworkSchema,
  inputAmountLamports: atomicSchema,
  relayFanout: z.number().int().min(1).max(4),
  feePolicy: z.object({
    kind: z.literal("solana"),
    computeUnitLimit: z.number().int().min(10_000).max(1_400_000),
    computeUnitPriceMicroLamports: atomicSchema,
    tipLamports: atomicSchema,
  }),
  rules: z.array(ruleSchema).min(1).max(100),
}).superRefine((value, context) => {
  if (!value.rules.some((rule) => rule.enabled)) {
    context.addIssue({ code: "custom", message: "At least one automation rule must be enabled.", path: ["rules"] });
  }
  for (const [index, rule] of value.rules.entries()) {
    if (!rule.networks.includes(value.network)) {
      context.addIssue({ code: "custom", message: "Every rule must include the policy network.", path: ["rules", index, "networks"] });
    }
    if (!rule.eventKinds.includes("new_mint")) {
      context.addIssue({ code: "custom", message: "Pump automation rules must include new_mint.", path: ["rules", index, "eventKinds"] });
    }
    if (rule.maxSpendAtomic < value.inputAmountLamports) {
      context.addIssue({ code: "custom", message: "Rule maxSpendAtomic must cover inputAmountLamports.", path: ["rules", index, "maxSpendAtomic"] });
    }
    if (rule.maxDailySpendAtomic < rule.maxSpendAtomic) {
      context.addIssue({ code: "custom", message: "Rule daily budget must cover one transaction budget.", path: ["rules", index, "maxDailySpendAtomic"] });
    }
  }
});

export interface AutomationPolicy {
  readonly version: 1;
  readonly enabled: boolean;
  readonly network: "solana:devnet" | "solana:mainnet";
  readonly inputAmountLamports: bigint;
  readonly relayFanout: number;
  readonly feePolicy: Extract<ExecutionRequest["feePolicy"], { readonly kind: "solana" }>;
  readonly rules: readonly SniperRule[];
}

export type AutomationPolicyResult =
  | Readonly<{ ready: true; detail: "configured"; policy: AutomationPolicy }>
  | Readonly<{ ready: false; detail: string }>;

export async function loadAutomationPolicy(path: string | undefined): Promise<AutomationPolicyResult> {
  if (!path) return { ready: false, detail: "unconfigured" };
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { ready: false, detail: "not-a-regular-file" };
    if ((metadata.mode & 0o077) !== 0) return { ready: false, detail: "group-or-world-accessible" };
    const parsed = policySchema.parse(JSON.parse(await handle.readFile("utf8"))) as AutomationPolicy;
    if (!parsed.enabled) return { ready: false, detail: "policy-disabled" };
    return { ready: true, detail: "configured", policy: Object.freeze({
      ...parsed,
      feePolicy: Object.freeze({ ...parsed.feePolicy }),
      rules: Object.freeze(parsed.rules.map((rule) => Object.freeze({
        ...rule,
        networks: Object.freeze([...rule.networks]),
        eventKinds: Object.freeze([...rule.eventKinds]),
        accounts: Object.freeze([...rule.accounts]),
        keywords: Object.freeze([...rule.keywords]),
        allowTargets: Object.freeze([...rule.allowTargets]),
        denyTargets: Object.freeze([...rule.denyTargets]),
      }))),
    }) };
  } catch (error) {
    if (error instanceof z.ZodError) return { ready: false, detail: `invalid-policy:${error.issues[0]?.message ?? "schema"}` };
    if (error instanceof SyntaxError) return { ready: false, detail: "invalid-json" };
    return { ready: false, detail: error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unreadable" };
  } finally {
    await handle?.close();
  }
}
