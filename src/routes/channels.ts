import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt";
import { webhookUrlForSecret } from "../lib/helpers";
import { checkChannelAccess } from "../lib/access";
import type { AppEnv, ChannelRow, ChannelMode } from "../types";

const ALLOWED_AVATAR_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VALID_MODES = new Set<ChannelMode>(["mailbox", "proxy", "email"]);

const channels = new Hono<AppEnv>();
channels.use("*", jwtAuth);

function channelJson(ch: ChannelRow, baseUrl: string) {
  return {
    id: ch.id,
    name: ch.name,
    avatar_url: ch.avatar_url,
    webhook_url: webhookUrlForSecret(baseUrl, ch.webhook_secret),
    webhook_secret: ch.webhook_secret,
    email_prefix: ch.email_prefix,
    mode: ch.mode,
    mailbox_response: ch.mailbox_response,
    created_at: ch.created_at,
  };
}

channels.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    name?: string;
    mode?: string;
    email_prefix?: string;
    mailbox_response?: string;
  }>().catch(() => ({ name: undefined, mode: undefined, email_prefix: undefined, mailbox_response: undefined }));

  let name = (body.name ?? "My Channel").trim();
  if (!name) name = "My Channel";
  if (name.length > 128) name = name.slice(0, 128);

  const mode: ChannelMode = VALID_MODES.has(body.mode as ChannelMode)
    ? (body.mode as ChannelMode)
    : "mailbox";

  const mailboxResponse = body.mailbox_response ?? '{"ok":true}';

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  let emailPrefix: string | null = null;
  if (body.email_prefix) {
    const p = body.email_prefix.trim().toLowerCase();
    if (/^[a-z0-9_-]{3,64}$/.test(p)) {
      emailPrefix = p;
    }
  }

  const row = await c.env.DB.prepare(
    "INSERT INTO channels (owner_user_id, name, webhook_secret, email_prefix, mode, mailbox_response) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
  )
    .bind(userId, name, secret.slice(0, 43), emailPrefix, mode, mailboxResponse)
    .first<ChannelRow>();

  return c.json(channelJson(row!, c.env.PUBLIC_BASE_URL), 201);
});

channels.get("/", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT ch.* FROM channels ch
     LEFT JOIN channel_members m ON m.channel_id = ch.id AND m.user_id = ?
     WHERE ch.owner_user_id = ? OR m.user_id IS NOT NULL
     ORDER BY ch.id`
  )
    .bind(userId, userId)
    .all<ChannelRow>();

  return c.json({
    channels: results.map((ch) => channelJson(ch, c.env.PUBLIC_BASE_URL)),
  });
});

channels.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const ch = await checkChannelAccess(c.env.DB, channelId, userId, "member");
  if (!ch) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<{
    name?: string;
    avatar_url?: string | null;
    mode?: string;
    email_prefix?: string;
    mailbox_response?: string;
  }>();

  let changed = false;

  if (body.name !== undefined) {
    const n = body.name.trim();
    if (n && n.length <= 128) {
      ch.name = n;
      changed = true;
    }
  }
  if (body.avatar_url !== undefined) {
    ch.avatar_url =
      body.avatar_url === null
        ? null
        : (body.avatar_url ?? "").trim().slice(0, 512) || null;
    changed = true;
  }
  if (body.mode !== undefined && VALID_MODES.has(body.mode as ChannelMode)) {
    ch.mode = body.mode as ChannelMode;
    changed = true;
  }
  if (body.mailbox_response !== undefined) {
    ch.mailbox_response = body.mailbox_response;
    changed = true;
  }
  if (body.email_prefix !== undefined) {
    const p = (body.email_prefix ?? "").trim().toLowerCase();
    if (p === "") {
      ch.email_prefix = null;
      changed = true;
    } else if (/^[a-z0-9_-]{3,64}$/.test(p)) {
      ch.email_prefix = p;
      changed = true;
    }
  }

  if (changed) {
    await c.env.DB.prepare(
      "UPDATE channels SET name = ?, avatar_url = ?, mode = ?, email_prefix = ?, mailbox_response = ? WHERE id = ?"
    )
      .bind(ch.name, ch.avatar_url, ch.mode, ch.email_prefix, ch.mailbox_response, channelId)
      .run();
  }

  return c.json(channelJson(ch, c.env.PUBLIC_BASE_URL));
});

channels.post("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const ch = await checkChannelAccess(c.env.DB, channelId, userId, "member");
  if (!ch) return c.json({ error: "not_found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file || !file.name) {
    return c.json({ error: "missing_file" }, 400);
  }

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!ext || !ALLOWED_AVATAR_EXT.has(ext)) {
    return c.json(
      { error: "unsupported_type", allowed: [...ALLOWED_AVATAR_EXT] },
      400
    );
  }

  const key = `${crypto.randomUUID()}.${ext}`;
  await c.env.AVATARS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || `image/${ext}` },
  });

  const avatarUrl = `${c.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/avatars/${key}`;
  await c.env.DB.prepare("UPDATE channels SET avatar_url = ? WHERE id = ?")
    .bind(avatarUrl, channelId)
    .run();

  ch.avatar_url = avatarUrl;
  return c.json(channelJson(ch, c.env.PUBLIC_BASE_URL));
});

export default channels;
