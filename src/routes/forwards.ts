import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt";
import { checkChannelAccess } from "../lib/access";
import type { AppEnv, ChannelForwardRow, ForwardLogRow } from "../types";

const forwards = new Hono<AppEnv>();
forwards.use("*", jwtAuth);

forwards.get("/channels/:id/forwards", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "readonly")) {
    return c.json({ error: "not_found" }, 404);
  }

  const { results } = await c.env.DB
    .prepare("SELECT * FROM channel_forwards WHERE channel_id = ? ORDER BY id")
    .bind(channelId)
    .all<ChannelForwardRow>();

  return c.json({ forwards: results });
});

forwards.post("/channels/:id/forwards", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "member")) {
    return c.json({ error: "not_found" }, 404);
  }

  const body = await c.req.json<{
    url?: string;
    method?: string;
    extra_headers_json?: string;
    enabled?: boolean;
    retry_max?: number;
  }>();

  const url = (body.url ?? "").trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return c.json({ error: "invalid_url" }, 400);
  }
  const method = (body.method ?? "POST").toUpperCase();
  const retryMax = Math.min(Math.max(parseInt(String(body.retry_max ?? 3)) || 3, 0), 10);

  const row = await c.env.DB.prepare(
    `INSERT INTO channel_forwards (channel_id, url, method, extra_headers_json, enabled, retry_max)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(
      channelId, url, method,
      body.extra_headers_json ?? null,
      body.enabled === false ? 0 : 1,
      retryMax
    )
    .first<ChannelForwardRow>();

  return c.json(row!, 201);
});

forwards.patch("/channels/:id/forwards/:fid", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const fwdId = parseInt(c.req.param("fid"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "member")) {
    return c.json({ error: "not_found" }, 404);
  }

  const existing = await c.env.DB
    .prepare("SELECT * FROM channel_forwards WHERE id = ? AND channel_id = ?")
    .bind(fwdId, channelId)
    .first<ChannelForwardRow>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  type PatchBody = {
    url?: string;
    method?: string;
    extra_headers_json?: string | null;
    enabled?: boolean;
    retry_max?: number;
  };
  const body = await c.req.json<PatchBody>().catch(() => ({} as PatchBody));

  let url = existing.url;
  if (body.url) {
    const u = body.url.trim();
    if (!u.startsWith("http://") && !u.startsWith("https://")) {
      return c.json({ error: "invalid_url" }, 400);
    }
    url = u;
  }

  await c.env.DB.prepare(
    `UPDATE channel_forwards SET url=?, method=?, extra_headers_json=?, enabled=?, retry_max=? WHERE id=?`
  )
    .bind(
      url,
      body.method ? body.method.toUpperCase() : existing.method,
      body.extra_headers_json !== undefined ? body.extra_headers_json : existing.extra_headers_json,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      body.retry_max !== undefined
        ? Math.min(Math.max(Number(body.retry_max) || 3, 0), 10)
        : existing.retry_max,
      fwdId
    )
    .run();

  const updated = await c.env.DB
    .prepare("SELECT * FROM channel_forwards WHERE id = ?")
    .bind(fwdId)
    .first<ChannelForwardRow>();

  return c.json(updated!);
});

forwards.delete("/channels/:id/forwards/:fid", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const fwdId = parseInt(c.req.param("fid"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "member")) {
    return c.json({ error: "not_found" }, 404);
  }

  await c.env.DB
    .prepare("DELETE FROM channel_forwards WHERE id = ? AND channel_id = ?")
    .bind(fwdId, channelId)
    .run();

  return c.json({ ok: true });
});

forwards.get("/channels/:id/forwards/:fid/log", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const fwdId = parseInt(c.req.param("fid"));
  if (!await checkChannelAccess(c.env.DB, channelId, userId, "readonly")) {
    return c.json({ error: "not_found" }, 404);
  }

  const { results } = await c.env.DB
    .prepare(
      `SELECT * FROM forward_log WHERE forward_id = ?
       ORDER BY id DESC LIMIT 100`
    )
    .bind(fwdId)
    .all<ForwardLogRow>();

  return c.json({ log: results });
});

export default forwards;
