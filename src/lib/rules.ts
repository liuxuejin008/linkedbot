import type { ChannelRuleRow } from "../types";

export type RuleInput = {
  headers: Record<string, string>;
  payload: unknown;
  source_ip: string | null;
  content_type: string;
};

export type RuleResult =
  | { action: "accept"; tag?: undefined }
  | { action: "reject" }
  | { action: "tag"; tag: string };

function getField(input: RuleInput, rule: ChannelRuleRow): string | null {
  switch (rule.condition_type) {
    case "header":
      return rule.condition_field
        ? (input.headers[rule.condition_field.toLowerCase()] ?? null)
        : null;
    case "payload_key": {
      if (!rule.condition_field) return null;
      const p = input.payload as Record<string, unknown>;
      const val = p?.[rule.condition_field];
      return val !== undefined && val !== null ? String(val) : null;
    }
    case "source_ip":
      return input.source_ip;
    case "content_type":
      return input.content_type;
    default:
      return null;
  }
}

function matches(value: string | null, rule: ChannelRuleRow): boolean {
  switch (rule.condition_op) {
    case "exists":
      return value !== null && value !== "";
    case "equals":
      return value !== null && value === rule.condition_value;
    case "contains":
      return value !== null && rule.condition_value !== null
        ? value.includes(rule.condition_value)
        : false;
    case "regex":
      if (value === null || !rule.condition_value) return false;
      try {
        return new RegExp(rule.condition_value).test(value);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function evaluateRules(
  rules: ChannelRuleRow[],
  input: RuleInput
): RuleResult {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const value = getField(input, rule);
    if (!matches(value, rule)) continue;

    if (rule.action === "reject") return { action: "reject" };
    if (rule.action === "tag") return { action: "tag", tag: rule.tag_value ?? "" };
    return { action: "accept" };
  }
  return { action: "accept" };
}

export async function loadRules(
  db: D1Database,
  channelId: number
): Promise<ChannelRuleRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM channel_rules WHERE channel_id = ? AND enabled = 1 ORDER BY priority ASC, id ASC"
    )
    .bind(channelId)
    .all<ChannelRuleRow>();
  return results;
}
