import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt";
import { checkChannelAccess } from "../lib/access";
import type { AppEnv, MessageRow } from "../types";

const sync = new Hono<AppEnv>();
sync.use("*", jwtAuth);

sync.get("/channels/:id/messages/pull", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const limitStr = c.req.query("limit") ?? "50";
  const limit = Math.max(1, Math.min(parseInt(limitStr) || 50, 200));

  const ch = await checkChannelAccess(c.env.DB, channelId, userId, "member");
  if (!ch) return c.json({ error: "not_found" }, 404);

  const now = new Date().toISOString();

  // 原子级批量拉取消息，防止并发拉取拿到相同数据的竞态条件
  const { results: messages } = await c.env.DB.prepare(
    `UPDATE messages
     SET read_at = ?
     WHERE id IN (
       SELECT id FROM messages
       WHERE channel_id = ? AND read_at IS NULL
       ORDER BY id LIMIT ?
     )
     RETURNING *`
  )
    .bind(now, channelId, limit)
    .all<MessageRow>();

  return c.json({
    messages: messages.map((m) => ({
      id: m.id,
      channel_id: m.channel_id,
      payload_json: JSON.parse(m.payload_json),
      headers_json: m.headers_json ? JSON.parse(m.headers_json) : null,
      source_ip: m.source_ip,
      tag: m.tag,
      created_at: m.created_at,
      read_at: m.read_at,
    })),
  });
});

sync.get("/channels/:id/messages", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const cursor = c.req.query("cursor")
    ? parseInt(c.req.query("cursor")!)
    : null;

  const ch = await checkChannelAccess(c.env.DB, channelId, userId, "readonly");
  if (!ch) return c.json({ error: "not_found" }, 404);

  const PAGE = 50;
  let query: string;
  const params: unknown[] = [channelId];

  if (cursor) {
    query = `SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?`;
    params.push(cursor, PAGE + 1);
  } else {
    query = `SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?`;
    params.push(PAGE + 1);
  }

  const { results } = await c.env.DB.prepare(query).bind(...params).all<MessageRow>();

  const hasMore = results.length > PAGE;
  const page = hasMore ? results.slice(0, PAGE) : results;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  return c.json({
    messages: page.map((m) => ({
      id: m.id,
      payload_json: JSON.parse(m.payload_json),
      tag: m.tag,
      created_at: m.created_at,
      read_at: m.read_at,
    })),
    next_cursor: nextCursor,
  });
});

export default sync;
