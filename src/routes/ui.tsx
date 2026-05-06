import { Hono } from "hono";
import {
  sessionMiddleware,
  getSessionUserId,
  setSession,
  clearSession,
  loginRequired,
  setFlash,
  getFlashes,
} from "../middleware/session";
import { i18nMiddleware } from "../middleware/i18n";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { webhookUrlForSecret } from "../lib/helpers";
import { LoginPage } from "../pages/Login";
import { RegisterPage } from "../pages/Register";
import { DashboardPage } from "../pages/Dashboard";
import { ChannelDetailPage } from "../pages/ChannelDetail";
import { ForwardLogsPage } from "../pages/ForwardLogs";
import type { AppEnv, UserRow, ChannelRow, ChannelForwardRow, ChannelMode, MessageRow, ForwardLogRow } from "../types";

const ALLOWED_AVATAR_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VALID_MODES = new Set<ChannelMode>(["mailbox", "proxy", "email"]);

const ui = new Hono<AppEnv>();

ui.use("*", sessionMiddleware);
ui.use("*", i18nMiddleware);

ui.get("/set-lang", (c) => {
  const next = c.req.query("next") || "/dashboard";
  return c.redirect(safeNext(next));
});

async function getUserEmail(
  db: D1Database,
  uid: number | null
): Promise<string | null> {
  if (!uid) return null;
  const u = await db.prepare("SELECT email FROM users WHERE id = ?").bind(uid).first<UserRow>();
  return u?.email ?? null;
}

function safeNext(next: string | undefined): string {
  if (!next) return "/dashboard";
  if (next.startsWith("/") && !next.startsWith("//")) return next;
  return "/dashboard";
}

// --- Root ---
ui.get("/", (c) => {
  const uid = getSessionUserId(c);
  return c.redirect(uid ? "/dashboard" : "/login");
});

// --- Login ---
ui.get("/login", async (c) => {
  const email = await getUserEmail(c.env.DB, getSessionUserId(c));
  const next = c.req.query("next");
  return c.html(<LoginPage nextUrl={next} email={email} t={c.get("t")} lang={c.get("lang")} />);
});

ui.post("/login", async (c) => {
  const form = await c.req.formData();
  const email = (form.get("email") as string)?.trim().toLowerCase();
  const password = form.get("password") as string;
  const next = form.get("next") as string;

  if (!email || !password) {
    return c.html(
      <LoginPage nextUrl={next} flashes={[{ category: "error", message: c.get("t")("auth.fillEmailPassword") }]} t={c.get("t")} lang={c.get("lang")} />
    );
  }

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.html(
      <LoginPage nextUrl={next} flashes={[{ category: "error", message: c.get("t")("auth.invalidCredentials") }]} t={c.get("t")} lang={c.get("lang")} />
    );
  }

  await setSession(c, user.id);
  return c.redirect(safeNext(next));
});

// --- Register ---
ui.get("/register", async (c) => {
  const email = await getUserEmail(c.env.DB, getSessionUserId(c));
  return c.html(<RegisterPage email={email} t={c.get("t")} lang={c.get("lang")} />);
});

ui.post("/register", async (c) => {
  const form = await c.req.formData();
  const email = (form.get("email") as string)?.trim().toLowerCase();
  const password = form.get("password") as string;
  const password2 = form.get("password2") as string;

  const t = c.get("t");
  const flash = (msg: string) =>
    c.html(<RegisterPage flashes={[{ category: "error", message: msg }]} t={t} lang={c.get("lang")} />);

  if (!email || !email.includes("@")) return flash(t("auth.invalidEmail"));
  if (!password || password.length < 8) return flash(t("auth.passwordLength"));
  if (password !== password2) return flash(t("auth.passwordMismatch"));

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) return flash(t("auth.emailTaken"));

  const hash = await hashPassword(password);
  const row = await c.env.DB.prepare(
    "INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id"
  )
    .bind(email, hash)
    .first<{ id: number }>();

  await setSession(c, row!.id);
  return c.redirect("/dashboard");
});

// --- Logout ---
ui.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/login");
});

// --- Dashboard ---
ui.get("/dashboard", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const email = (await getUserEmail(c.env.DB, uid))!;

  const { results: channelRows } = await c.env.DB.prepare(
    "SELECT * FROM channels WHERE owner_user_id = ? ORDER BY id"
  )
    .bind(uid)
    .all<ChannelRow>();

  const cards = await Promise.all(
    channelRows.map(async (ch) => {
      const count = await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND read_at IS NULL"
      )
        .bind(ch.id)
        .first<{ cnt: number }>();
      return {
        channel: ch,
        webhookUrl: webhookUrlForSecret(c.env.PUBLIC_BASE_URL, ch.webhook_secret),
        unseen: count?.cnt ?? 0,
      };
    })
  );

  return c.html(<DashboardPage email={email} cards={cards} t={c.get("t")} lang={c.get("lang")} />);
});

ui.post("/dashboard", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const form = await c.req.formData();
  let name = ((form.get("name") as string) ?? "My Channel").trim();
  if (!name) name = "My Channel";
  if (name.length > 128) name = name.slice(0, 128);

  const modeInput = (form.get("mode") as string) ?? "mailbox";
  const mode: ChannelMode = VALID_MODES.has(modeInput as ChannelMode) ? (modeInput as ChannelMode) : "mailbox";

  let emailPrefix: string | null = null;
  const prefixInput = (form.get("email_prefix") as string)?.trim().toLowerCase();
  if (prefixInput && /^[a-z0-9_-]{3,64}$/.test(prefixInput)) {
    emailPrefix = prefixInput;
  }

  const secret =
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "");

  const row = await c.env.DB.prepare(
    "INSERT INTO channels (owner_user_id, name, webhook_secret, email_prefix, mode) VALUES (?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(uid, name, secret.slice(0, 43), emailPrefix, mode)
    .first<{ id: number }>();

  return c.redirect(`/channels/${row!.id}`);
});

// --- Channel detail ---
ui.get("/channels/:id", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));
  const email = (await getUserEmail(c.env.DB, uid))!;

  const channel = await c.env.DB.prepare(
    "SELECT * FROM channels WHERE id = ? AND owner_user_id = ?"
  )
    .bind(channelId, uid)
    .first<ChannelRow>();

  if (!channel) return c.redirect("/dashboard");

  const webhookUrl = webhookUrlForSecret(c.env.PUBLIC_BASE_URL, channel.webhook_secret);
  const curlExample = `curl -X POST ${webhookUrl} \\\n  -H "Content-Type: application/json" \\\n  -d '{"text":"hello from curl"}'`;

  const { results: forwards } = await c.env.DB.prepare(
    "SELECT * FROM channel_forwards WHERE channel_id = ? ORDER BY id"
  )
    .bind(channelId)
    .all<ChannelForwardRow>();

  const { results: messages } = await c.env.DB.prepare(
    "SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 50"
  )
    .bind(channelId)
    .all<MessageRow>();

  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND read_at IS NULL"
  )
    .bind(channelId)
    .first<{ cnt: number }>();

  const DAYS = 7;
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [totals, byDayRes, byTagRes, fwdRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
       FROM messages WHERE channel_id = ? AND created_at >= ?`
    ).bind(channelId, since).first<{ total: number; unread: number }>(),
    c.env.DB.prepare(
      `SELECT substr(created_at,1,10) AS date, COUNT(*) AS count
       FROM messages WHERE channel_id = ? AND created_at >= ?
       GROUP BY date ORDER BY date`
    ).bind(channelId, since).all<{ date: string; count: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(tag,'untagged') AS tag, COUNT(*) AS count
       FROM messages WHERE channel_id = ? AND created_at >= ?
       GROUP BY tag ORDER BY count DESC LIMIT 10`
    ).bind(channelId, since).all<{ tag: string; count: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered
       FROM forward_log fl JOIN messages m ON m.id = fl.message_id
       WHERE m.channel_id = ? AND fl.created_at >= ?`
    ).bind(channelId, since).first<{ total: number; delivered: number }>(),
  ]);

  const pageStats = {
    days: DAYS,
    total: totals?.total ?? 0,
    unread: totals?.unread ?? 0,
    by_day: byDayRes.results,
    by_tag: byTagRes.results,
    forward_success_rate:
      fwdRes && fwdRes.total > 0
        ? Math.round((fwdRes.delivered / fwdRes.total) * 1000) / 1000
        : null,
  };

  return c.html(
    <ChannelDetailPage
      email={email}
      channel={channel}
      webhookUrl={webhookUrl}
      curlExample={curlExample}
      forwards={forwards}
      messages={messages}
      unseen={count?.cnt ?? 0}
      stats={pageStats}
      t={c.get("t")}
      lang={c.get("lang")}
      flashes={getFlashes(c)}
    />
  );
});

// --- Channel forwards ---
ui.post("/channels/:id/forwards", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));

  const ch = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND owner_user_id = ?"
  )
    .bind(channelId, uid)
    .first<ChannelRow>();
  if (!ch) return c.redirect("/dashboard");

  const form = await c.req.formData();
  const url = ((form.get("url") as string) ?? "").trim();
  const method = ((form.get("method") as string) ?? "POST").toUpperCase();
  const retryMax = Math.max(0, Math.min(parseInt((form.get("retry_max") as string) ?? "3") || 3, 10));
  const extraHeaders = ((form.get("extra_headers") as string) ?? "").trim() || null;

  if (!url) return c.redirect(`/channels/${channelId}`);

  await c.env.DB.prepare(
    "INSERT INTO channel_forwards (channel_id, url, method, extra_headers_json, retry_max) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(channelId, url, method, extraHeaders, retryMax)
    .run();

  return c.redirect(`/channels/${channelId}`);
});

ui.post("/channels/:id/forwards/:fid/toggle", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));
  const fid = parseInt(c.req.param("fid"));

  const ch = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND owner_user_id = ?"
  )
    .bind(channelId, uid)
    .first<ChannelRow>();
  if (!ch) return c.redirect("/dashboard");

  await c.env.DB.prepare(
    "UPDATE channel_forwards SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE id = ? AND channel_id = ?"
  )
    .bind(fid, channelId)
    .run();

  return c.redirect(`/channels/${channelId}`);
});

ui.post("/channels/:id/forwards/:fid/delete", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));
  const fid = parseInt(c.req.param("fid"));

  const ch = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND owner_user_id = ?"
  )
    .bind(channelId, uid)
    .first<ChannelRow>();
  if (!ch) return c.redirect("/dashboard");

  await c.env.DB.prepare(
    "DELETE FROM channel_forwards WHERE id = ? AND channel_id = ?"
  )
    .bind(fid, channelId)
    .run();

  return c.redirect(`/channels/${channelId}`);
});

// --- Channel settings ---
ui.post("/channels/:id/settings", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));
  const form = await c.req.formData();
  const name = ((form.get("name") as string) ?? "").trim();
  const modeInput = form.get("mode") as string;
  const emailPrefixInput = form.get("email_prefix") as string | null;
  const mailboxResponse = form.get("mailbox_response") as string;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (name && name.length <= 128) {
    updates.push("name = ?");
    params.push(name);
  }
  if (modeInput && VALID_MODES.has(modeInput as ChannelMode)) {
    updates.push("mode = ?");
    params.push(modeInput);
  }
  if (emailPrefixInput !== null && emailPrefixInput !== undefined) {
    const p = emailPrefixInput.trim().toLowerCase();
    if (p === "") {
      updates.push("email_prefix = ?");
      params.push(null);
    } else if (/^[a-z0-9_-]{3,64}$/.test(p)) {
      updates.push("email_prefix = ?");
      params.push(p);
    }
  }
  if (mailboxResponse !== null && mailboxResponse !== undefined) {
    updates.push("mailbox_response = ?");
    params.push(mailboxResponse);
  }

  if (updates.length > 0) {
    await c.env.DB.prepare(
      `UPDATE channels SET ${updates.join(", ")} WHERE id = ? AND owner_user_id = ?`
    )
      .bind(...params, channelId, uid)
      .run();
  }

  return c.redirect(`/channels/${channelId}`);
});

// --- Channel avatar ---
ui.post("/channels/:id/avatar", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));

  const ch = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND owner_user_id = ?"
  )
    .bind(channelId, uid)
    .first<ChannelRow>();
  if (!ch) return c.redirect("/dashboard");

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const t = c.get("t");
  if (file && file.name) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext && ALLOWED_AVATAR_EXT.has(ext)) {
      const key = `${crypto.randomUUID()}.${ext}`;
      await c.env.AVATARS.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || `image/${ext}` },
      });
      const avatarUrl = `${c.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/avatars/${key}`;
      await c.env.DB.prepare("UPDATE channels SET avatar_url = ? WHERE id = ?")
        .bind(avatarUrl, channelId)
        .run();
      setFlash(c, "success", t("channel.uploadSuccess"));
    } else {
      setFlash(c, "error", t("channel.uploadInvalid"));
    }
  } else {
    setFlash(c, "error", t("channel.uploadMissing"));
  }

  return c.redirect(`/channels/${channelId}`);
});

// --- Consume unread ---
ui.post("/channels/:id/consume", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));
  const form = await c.req.formData();
  const limit = Math.max(1, Math.min(parseInt((form.get("limit") as string) ?? "50") || 50, 200));

  const ch = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND owner_user_id = ?"
  )
    .bind(channelId, uid)
    .first<ChannelRow>();
  if (!ch) return c.redirect("/dashboard");

  const { results } = await c.env.DB.prepare(
    "SELECT id FROM messages WHERE channel_id = ? AND read_at IS NULL ORDER BY id LIMIT ?"
  )
    .bind(channelId, limit)
    .all<{ id: number }>();

  if (results.length > 0) {
    const now = new Date().toISOString();
    const ids = results.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    await c.env.DB.prepare(
      `UPDATE messages SET read_at = ? WHERE id IN (${placeholders})`
    )
      .bind(now, ...ids)
      .run();
  }

  return c.redirect(`/channels/${channelId}`);
});

// --- Forward logs (paginated, searchable) ---
ui.get("/channels/:id/logs", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));
  const email = (await getUserEmail(c.env.DB, uid))!;

  const ch = await c.env.DB.prepare(
    "SELECT * FROM channels WHERE id = ? AND owner_user_id = ?"
  )
    .bind(channelId, uid)
    .first<ChannelRow>();
  if (!ch) return c.redirect("/dashboard");

  const page = Math.max(1, parseInt(c.req.query("page") ?? "1") || 1);
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const search = (c.req.query("search") ?? "").trim();

  let baseQuery = `
    SELECT fl.*,
           m.payload_json AS message_payload,
           cf.url AS forward_url
    FROM forward_log fl
    JOIN messages m ON m.id = fl.message_id
    JOIN channel_forwards cf ON cf.id = fl.forward_id
    WHERE m.channel_id = ?
  `;
  const params: unknown[] = [channelId];

  if (search) {
    baseQuery += ` AND (CAST(fl.message_id AS TEXT) LIKE ? OR cf.url LIKE ? OR fl.error LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  const countQuery = `SELECT COUNT(*) AS total FROM (${baseQuery})`;
  const countRow = await c.env.DB.prepare(countQuery).bind(...params).first<{ total: number }>();
  const total = countRow?.total ?? 0;

  const dataQuery = `${baseQuery} ORDER BY fl.id DESC LIMIT ? OFFSET ?`;
  const { results: rows } = await c.env.DB.prepare(dataQuery)
    .bind(...params, pageSize, offset)
    .all<ForwardLogRow & { message_payload: string | null; forward_url: string | null }>();

  return c.html(
    <ForwardLogsPage
      email={email}
      channel={ch}
      logs={rows}
      total={total}
      page={page}
      pageSize={pageSize}
      search={search}
      t={c.get("t")}
      lang={c.get("lang")}
    />
  );
});

ui.post("/channels/:id/logs/:logId/delete", async (c) => {
  const guard = loginRequired(c);
  if (guard) return guard;
  const uid = getSessionUserId(c)!;
  const channelId = parseInt(c.req.param("id"));
  const logId = parseInt(c.req.param("logId"));

  const ch = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND owner_user_id = ?"
  )
    .bind(channelId, uid)
    .first<ChannelRow>();
  if (!ch) return c.redirect("/dashboard");

  await c.env.DB.prepare("DELETE FROM forward_log WHERE id = ?")
    .bind(logId)
    .run();

  return c.redirect(`/channels/${channelId}/logs`);
});

export default ui;
