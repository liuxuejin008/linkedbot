import { Hono } from "hono";
import type { AppEnv } from "./types";
import auth from "./routes/auth";
import channels from "./routes/channels";
import sync from "./routes/sync";
import stream from "./routes/stream";
import webhook from "./routes/webhook";
import rules from "./routes/rules";
import forwards from "./routes/forwards";
import members from "./routes/members";
import stats from "./routes/stats";
import ui from "./routes/ui";
import { cleanupTimedOutProxyRequests } from "./lib/forwarder";
import { handleMailboxQueue, handleDLQ } from "./queue-consumer";
import PostalMime from "postal-mime";
import type { Env, MailboxQueueMessage } from "./types";

const app = new Hono<AppEnv>();

// Health endpoints
app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/ping", (c) => c.json({ ok: true }));

// REST API
app.route("/api/auth", auth);
app.route("/api/channels", channels);
app.route("/api", sync);
app.route("/api", stream);
app.route("/api", rules);
app.route("/api", forwards);
app.route("/api", members);
app.route("/api", stats);

// Webhook (public, no auth)
app.route("/", webhook);

// R2 avatar serving
app.get("/avatars/:key", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.AVATARS.get(key);
  if (!obj) return c.notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
});

// UI (server-rendered JSX)
app.route("/", ui);

// ── Cron: 仅做过期数据清理（重试已由 Queue 托管）───────────────────
async function scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
  await cleanupTimedOutProxyRequests(env.DB);
}

export default {
  fetch: app.fetch,
  scheduled,

  // ── Queue Consumer ────────────────────────────────────────────
  async queue(batch: MessageBatch<MailboxQueueMessage>, env: Env): Promise<void> {
    switch (batch.queue) {
      case "linkedbot-mailbox":
        await handleMailboxQueue(batch, env);
        break;
      case "linkedbot-dlq":
        await handleDLQ(batch, env);
        break;
      default:
        console.warn(`[Queue] Unknown queue: ${batch.queue}`);
    }
  },

  // ── Email Worker (Cloudflare Email Routing) ───────────────────
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parser = new PostalMime();
      const parsedEmail = await parser.parse(rawEmail);

      // Email address should be <webhook_secret>@your-domain.com
      // Extract the secret from the local part of the recipient address
      const toAddress = message.to;
      const secret = toAddress.split("@")[0];

      if (!secret) {
        message.setReject("Invalid recipient address format.");
        return;
      }

      const payload = {
        from: message.from,
        to: message.to,
        subject: parsedEmail.subject,
        text: parsedEmail.text,
        html: parsedEmail.html,
        date: parsedEmail.date,
      };

      // Construct an internal request to hit the existing webhook route
      // We use `PUBLIC_BASE_URL` if configured, or just a dummy localhost URL
      // since the routing handles it locally anyway.
      const baseUrl = env.PUBLIC_BASE_URL || "http://localhost";
      const webhookUrl = `${baseUrl}/w/${secret}`;

      const req = new Request(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Adding a custom header to identify email routing
          "X-LinkedBot-Source": "Cloudflare-Email-Routing",
        },
        body: JSON.stringify(payload),
      });

      // Pass the request directly into our Hono app instance for zero-latency local routing
      const response = await app.fetch(req, env, ctx);

      if (!response.ok) {
        console.error(`Email webhook failed with status ${response.status}: ${await response.text()}`);
        message.setReject(`Webhook endpoint rejected the message with status ${response.status}`);
      }
    } catch (err) {
      console.error("Failed to parse or forward email:", err);
      message.setReject("Internal server error during email processing.");
    }
  },
};
