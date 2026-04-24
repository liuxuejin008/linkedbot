import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt";
import { checkChannelAccess } from "../lib/access";
import type { AppEnv, ChannelRuleRow } from "../types";

const VALID_CONDITION_TYPES = new Set(["header", "payload_key", "source_ip", "content_type"]);
const VALID_CONDITION_OPS = new Set(["equals", "contains", "regex", "exists"]);
const VALID_ACTIONS = new Set(["accept", "reject", "tag"]);

const rules = new Hono<AppEnv>();
rules.use("*", jwtAuth);

rules.get("/channels/:id/rules", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "readonly")) {
    return c.json({ error: "not_found" }, 404);
  }

  const { results } = await c.env.DB
    .prepare("SELECT * FROM channel_rules WHERE channel_id = ? ORDER BY priority ASC, id ASC")
    .bind(channelId)
    .all<ChannelRuleRow>();

  return c.json({ rules: results });
});

rules.post("/channels/:id/rules", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "member")) {
    return c.json({ error: "not_found" }, 404);
  }

  const body = await c.req.json<{
    name?: string;
    priority?: number;
    condition_type?: string;
    condition_field?: string;
    condition_op?: string;
    condition_value?: string;
    action?: string;
    tag_value?: string;
    enabled?: boolean;
  }>();

  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name_required" }, 400);
  if (!VALID_CONDITION_TYPES.has(body.condition_type ?? "")) {
    return c.json({ error: "invalid_condition_type", valid: [...VALID_CONDITION_TYPES] }, 400);
  }
  if (!VALID_CONDITION_OPS.has(body.condition_op ?? "")) {
    return c.json({ error: "invalid_condition_op", valid: [...VALID_CONDITION_OPS] }, 400);
  }
  if (!VALID_ACTIONS.has(body.action ?? "")) {
    return c.json({ error: "invalid_action", valid: [...VALID_ACTIONS] }, 400);
  }
  if (body.action === "tag" && !body.tag_value?.trim()) {
    return c.json({ error: "tag_value_required_for_tag_action" }, 400);
  }

  const row = await c.env.DB.prepare(
    `INSERT INTO channel_rules
       (channel_id, name, priority, condition_type, condition_field, condition_op, condition_value, action, tag_value, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(
      channelId,
      name,
      body.priority ?? 0,
      body.condition_type,
      body.condition_field ?? null,
      body.condition_op,
      body.condition_value ?? null,
      body.action,
      body.tag_value ?? null,
      body.enabled === false ? 0 : 1
    )
    .first<ChannelRuleRow>();

  return c.json(row!, 201);
});

rules.patch("/channels/:id/rules/:rid", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const ruleId = parseInt(c.req.param("rid"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "member")) {
    return c.json({ error: "not_found" }, 404);
  }

  const existing = await c.env.DB
    .prepare("SELECT * FROM channel_rules WHERE id = ? AND channel_id = ?")
    .bind(ruleId, channelId)
    .first<ChannelRuleRow>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<Partial<ChannelRuleRow>>();

  const updated: ChannelRuleRow = {
    ...existing,
    name: (body.name ?? existing.name).toString().trim() || existing.name,
    priority: body.priority ?? existing.priority,
    condition_type: (VALID_CONDITION_TYPES.has(body.condition_type ?? "")
      ? body.condition_type
      : existing.condition_type) as ChannelRuleRow["condition_type"],
    condition_field: body.condition_field !== undefined ? body.condition_field : existing.condition_field,
    condition_op: (VALID_CONDITION_OPS.has(body.condition_op ?? "")
      ? body.condition_op
      : existing.condition_op) as ChannelRuleRow["condition_op"],
    condition_value: body.condition_value !== undefined ? body.condition_value : existing.condition_value,
    action: (VALID_ACTIONS.has(body.action ?? "")
      ? body.action
      : existing.action) as ChannelRuleRow["action"],
    tag_value: body.tag_value !== undefined ? body.tag_value : existing.tag_value,
    enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
  };

  await c.env.DB.prepare(
    `UPDATE channel_rules SET name=?, priority=?, condition_type=?, condition_field=?,
     condition_op=?, condition_value=?, action=?, tag_value=?, enabled=?
     WHERE id=?`
  )
    .bind(
      updated.name, updated.priority, updated.condition_type, updated.condition_field,
      updated.condition_op, updated.condition_value, updated.action, updated.tag_value,
      updated.enabled, ruleId
    )
    .run();

  return c.json(updated);
});

rules.delete("/channels/:id/rules/:rid", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const ruleId = parseInt(c.req.param("rid"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "member")) {
    return c.json({ error: "not_found" }, 404);
  }

  await c.env.DB
    .prepare("DELETE FROM channel_rules WHERE id = ? AND channel_id = ?")
    .bind(ruleId, channelId)
    .run();

  return c.json({ ok: true });
});

export default rules;
