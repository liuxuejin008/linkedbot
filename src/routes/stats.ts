import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt";
import { checkChannelAccess } from "../lib/access";
import type { AppEnv } from "../types";

const stats = new Hono<AppEnv>();
stats.use("*", jwtAuth);

stats.get("/channels/:id/stats", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const days = Math.max(1, Math.min(parseInt(c.req.query("days") ?? "7") || 7, 90));

  if (!await checkChannelAccess(c.env.DB, channelId, userId, "readonly")) {
    return c.json({ error: "not_found" }, 404);
  }

  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const totals = await c.env.DB
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
       FROM messages WHERE channel_id = ? AND created_at >= ?`
    )
    .bind(channelId, since)
    .first<{ total: number; unread: number }>();

  const { results: byDay } = await c.env.DB
    .prepare(
      `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
       FROM messages WHERE channel_id = ? AND created_at >= ?
       GROUP BY date ORDER BY date`
    )
    .bind(channelId, since)
    .all<{ date: string; count: number }>();

  const { results: byTag } = await c.env.DB
    .prepare(
      `SELECT COALESCE(tag, 'untagged') AS tag, COUNT(*) AS count
       FROM messages WHERE channel_id = ? AND created_at >= ?
       GROUP BY tag ORDER BY count DESC LIMIT 20`
    )
    .bind(channelId, since)
    .all<{ tag: string; count: number }>();

  const fwdStats = await c.env.DB
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered
       FROM forward_log fl
       JOIN messages m ON m.id = fl.message_id
       WHERE m.channel_id = ? AND fl.created_at >= ?`
    )
    .bind(channelId, since)
    .first<{ total: number; delivered: number }>();

  const forwardSuccessRate =
    fwdStats && fwdStats.total > 0
      ? Math.round((fwdStats.delivered / fwdStats.total) * 1000) / 1000
      : null;

  return c.json({
    days,
    total: totals?.total ?? 0,
    unread: totals?.unread ?? 0,
    by_day: byDay,
    by_tag: byTag,
    forward_success_rate: forwardSuccessRate,
  });
});

export default stats;
