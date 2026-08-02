import safeRegex from "safe-regex2";
import type { RuleDecision, RuleEvaluator, SniperEvent, SniperRule } from "./types.js";

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

interface MatchResult {
  readonly accepted: boolean;
  readonly reasons: readonly string[];
}

function rejected(reason: string): MatchResult {
  return { accepted: false, reasons: [reason] };
}

function matchesRule(event: SniperEvent, rule: SniperRule): MatchResult {
  const reasons: string[] = [];
  if (!rule.enabled) return rejected("rule-disabled");
  if (!rule.networks.includes(event.network)) return rejected("network-mismatch");
  if (!rule.eventKinds.includes(event.kind)) return rejected("event-kind-mismatch");
  if (rule.requireMedia && !event.hasMedia) return rejected("media-required");

  if (rule.accounts.length > 0) {
    const normalizedAccount = normalize(event.sourceAccount ?? event.account ?? "");
    if (!rule.accounts.some((account) => normalize(account) === normalizedAccount)) {
      return rejected("account-mismatch");
    }
    reasons.push("account-match");
  }

  const text = normalize(event.text ?? "");
  if (rule.keywords.length > 0) {
    const matchingKeyword = rule.keywords.find((keyword) => text.includes(normalize(keyword)));
    if (!matchingKeyword) return rejected("keyword-mismatch");
    reasons.push(`keyword:${matchingKeyword}`);
  }

  if (rule.regex) {
    if (rule.regex.length > 256 || !safeRegex(rule.regex)) return rejected("unsafe-regex");
    let expression: RegExp;
    try {
      expression = new RegExp(rule.regex, "iu");
    } catch {
      return rejected("invalid-regex");
    }
    if (!expression.test((event.text ?? "").slice(0, 4_096))) return rejected("regex-mismatch");
    reasons.push("regex-match");
  }

  const target = event.target ?? event.mint;
  if (target && rule.denyTargets.includes(target)) return rejected("target-denied");
  if (rule.allowTargets.length > 0 && (!target || !rule.allowTargets.includes(target))) {
    return rejected("target-not-allowed");
  }

  return { accepted: true, reasons: reasons.length > 0 ? reasons : ["deterministic-match"] };
}

export class DeterministicRuleEvaluator implements RuleEvaluator {
  evaluate(event: SniperEvent, rules: readonly SniperRule[], now = Date.now()): RuleDecision {
    for (const rule of rules) {
      const match = matchesRule(event, rule);
      if (match.accepted) {
        return Object.freeze({ matched: true, rule, reasons: match.reasons, evaluatedAt: now });
      }
    }
    return Object.freeze({ matched: false, reasons: ["no-rule-matched"], evaluatedAt: now });
  }
}
