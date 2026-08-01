import type { RuleDecision, RuleEvaluator, SniperEvent, SniperRule } from "./types.js";

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function matchesRule(event: SniperEvent, rule: SniperRule): readonly string[] {
  const reasons: string[] = [];
  if (!rule.enabled) return ["rule-disabled"];
  if (!rule.networks.includes(event.network)) return ["network-mismatch"];
  if (!rule.eventKinds.includes(event.kind)) return ["event-kind-mismatch"];
  if (rule.requireMedia && !event.hasMedia) return ["media-required"];

  if (rule.accounts.length > 0) {
    const normalizedAccount = normalize(event.account ?? "");
    if (!rule.accounts.some((account) => normalize(account) === normalizedAccount)) {
      return ["account-mismatch"];
    }
    reasons.push("account-match");
  }

  const text = normalize(event.text ?? "");
  if (rule.keywords.length > 0) {
    const matchingKeyword = rule.keywords.find((keyword) => text.includes(normalize(keyword)));
    if (!matchingKeyword) return ["keyword-mismatch"];
    reasons.push(`keyword:${matchingKeyword}`);
  }

  if (rule.regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(rule.regex, "iu");
    } catch {
      return ["invalid-regex"];
    }
    if (!expression.test(event.text ?? "")) return ["regex-mismatch"];
    reasons.push("regex-match");
  }

  const target = event.target ?? event.mint;
  if (target && rule.denyTargets.includes(target)) return ["target-denied"];
  if (rule.allowTargets.length > 0 && (!target || !rule.allowTargets.includes(target))) {
    return ["target-not-allowed"];
  }

  return reasons.length > 0 ? reasons : ["deterministic-match"];
}

export class DeterministicRuleEvaluator implements RuleEvaluator {
  evaluate(event: SniperEvent, rules: readonly SniperRule[], now = Date.now()): RuleDecision {
    for (const rule of rules) {
      const reasons = matchesRule(event, rule);
      const rejected = reasons.some((reason) =>
        reason.endsWith("mismatch") || reason === "rule-disabled" || reason === "media-required" || reason === "invalid-regex" || reason === "target-denied" || reason === "target-not-allowed",
      );
      if (!rejected) {
        return Object.freeze({ matched: true, rule, reasons, evaluatedAt: now });
      }
    }
    return Object.freeze({ matched: false, reasons: ["no-rule-matched"], evaluatedAt: now });
  }
}
