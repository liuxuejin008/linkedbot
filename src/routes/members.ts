import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt";
import { checkChannelAccess, getChannelRole } from "../lib/access";
import type { AppEnv, ChannelMemberRow, ChannelRole, UserRow } from "../types";

const VALID_ROLES: ChannelRole[] = ["member", "readonly"];

const members = new Hono<AppEnv>();
members.use("*", jwtAuth);

members.get("/channels/:id/members", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const ch = await checkChannelAccess(c.env.DB, channelId, userId, "readonly");
  if (!ch) return c.json({ error: "not_found" }, 404);

  const ownerRow = await c.env.DB
    .prepare("SELECT id, email FROM users WHERE id = ?")
    .bind(ch.owner_user_id)
    .first<Pick<UserRow, "id" | "email">>();

  const { results: memberRows } = await c.env.DB
    .prepare(
      `SELECT cm.*, u.email FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = ?
       ORDER BY cm.invited_at`
    )
    .bind(channelId)
    .all<ChannelMemberRow & { email: string }>();

  return c.json({
    members: [
      { user_id: ch.owner_user_id, email: ownerRow?.email, role: "owner" },
      ...memberRows.map((m) => ({ user_id: m.user_id, email: m.email, role: m.role })),
    ],
  });
});

members.post("/channels/:id/members", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));

  const role = await getChannelRole(c.env.DB, channelId, userId);
  if (role !== "owner") return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ email?: string; role?: string }>();
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid_email" }, 400);
  }

  const inviteRole = (body.role ?? "member") as ChannelRole;
  if (!VALID_ROLES.includes(inviteRole)) {
    return c.json({ error: "invalid_role", valid: VALID_ROLES }, 400);
  }

  const target = await c.env.DB
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<Pick<UserRow, "id">>();

  if (!target) return c.json({ error: "user_not_found" }, 404);
  if (target.id === userId) return c.json({ error: "cannot_invite_self" }, 400);

  const ch = await c.env.DB
    .prepare("SELECT owner_user_id FROM channels WHERE id = ?")
    .bind(channelId)
    .first<{ owner_user_id: number }>();
  if (ch?.owner_user_id === target.id) {
    return c.json({ error: "user_is_owner" }, 409);
  }

  await c.env.DB
    .prepare(
      `INSERT INTO channel_members (channel_id, user_id, role)
       VALUES (?, ?, ?)
       ON CONFLICT(channel_id, user_id) DO UPDATE SET role = excluded.role`
    )
    .bind(channelId, target.id, inviteRole)
    .run();

  return c.json({ ok: true, user_id: target.id, role: inviteRole }, 201);
});

members.patch("/channels/:id/members/:uid", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const targetId = parseInt(c.req.param("uid"));

  const role = await getChannelRole(c.env.DB, channelId, userId);
  if (role !== "owner") return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ role?: string }>();
  const newRole = (body.role ?? "") as ChannelRole;
  if (!VALID_ROLES.includes(newRole)) {
    return c.json({ error: "invalid_role", valid: VALID_ROLES }, 400);
  }

  const result = await c.env.DB
    .prepare("UPDATE channel_members SET role = ? WHERE channel_id = ? AND user_id = ?")
    .bind(newRole, channelId, targetId)
    .run();

  if (!result.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, user_id: targetId, role: newRole });
});

members.delete("/channels/:id/members/:uid", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const targetId = parseInt(c.req.param("uid"));

  const role = await getChannelRole(c.env.DB, channelId, userId);
  if (role !== "owner" && userId !== targetId) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!role) return c.json({ error: "not_found" }, 404);

  await c.env.DB
    .prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
    .bind(channelId, targetId)
    .run();

  return c.json({ ok: true });
});

export default members;
