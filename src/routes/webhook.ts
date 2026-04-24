/**
 * ChannelServer — Webhook 入口路由
 *
 * 架构角色：ChannelServer（公网端）
 *
 * 职责：
 *  1. 接收外部系统（微信/支付宝/任意第三方）的 HTTP 回调
 *  2. 根据频道模式（proxy / sendbox）分支处理：
 *
 * Proxy 模式（同步透传）
 *  a. 生成唯一 ReqID，将请求存入 D1 `proxy_requests`（status=pending）
 *  b. 挂起当前 HTTP 连接（Request Parking），轮询 D1 等待 ChannelClient 回传
 *  c. ChannelClient 收到 SSE 事件后调用 ChannelReceiver，再把结果
 *     POST 到 /api/channels/:id/proxy-response/:reqId
 *  d. 本路由轮询到 status=completed，将结果同步返回给外部调用方
 *  e. 若超过 PROXY_TIMEOUT_MS 仍未收到回传，返回 504 Gateway Timeout
 *
 * Sendbox 模式（异步投递）
 *  a. 将消息写入 D1 `messages`
 *  b. 立即返回频道配置的静态响应（如 {"ok":true}）
 *  c. 将消息入队 Cloudflare Queue（linkedbot-sendbox），由 Queue Consumer
 *     负责投递 + 重试 + DLQ 兜底，替代原 waitUntil(forwardMessage)
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { loadRules, evaluateRules } from "../lib/rules";
import type { AppEnv, ChannelRow, ProxyRequestRow } from "../types";

/** 存储 headers 的最大字节数（防止超大 header 撑爆 D1） */
const HEADER_MAX_LEN = 8000;
/** 不向 ChannelClient 透传的敏感 / 基础设施 header */
const SKIP_HEADERS = new Set(["authorization", "cookie", "host"]);
/** Proxy 模式：等待 ChannelClient 回传的最大时长（毫秒） */
const PROXY_TIMEOUT_MS = 25_000;
/** Proxy 模式：D1 轮询间隔（毫秒） */
const PROXY_POLL_MS = 500;

type WebhookCtx = Context<AppEnv>;

const webhook = new Hono<AppEnv>();

function parseHeaders(raw: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  let len = 0;
  for (const [k, v] of raw.entries()) {
    if (SKIP_HEADERS.has(k.toLowerCase())) continue;
    len += k.length + v.length;
    if (len > HEADER_MAX_LEN) break;
    headers[k] = v;
  }
  return headers;
}

async function handleWebhook(c: WebhookCtx) {
  const secret = c.req.param("secret");
  const channel = await c.env.DB.prepare(
    "SELECT * FROM channels WHERE webhook_secret = ? OR email_prefix = ?"
  )
    .bind(secret, secret)
    .first<ChannelRow>();

  if (!channel) return c.json({ error: "not_found" }, 404);

  const ct = c.req.header("content-type") ?? "";
  const rawBody = await c.req.text();

  // Collect query params so GET-based verification flows (e.g. WeChat Official
  // Account echostr) arrive intact at the local service.
  const url = new URL(c.req.url);
  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const hasQuery = Object.keys(queryParams).length > 0;

  let payload: unknown;
  if (ct.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody);
      payload = hasQuery ? { ...queryParams, ...(parsed as object) } : parsed;
    } catch {
      payload = hasQuery ? { ...queryParams, _raw: rawBody } : { _raw: rawBody };
    }
  } else if (rawBody) {
    payload = hasQuery ? { ...queryParams, _raw: rawBody } : { _raw: rawBody };
  } else {
    // Pure GET with no body — expose query params directly
    payload = hasQuery ? queryParams : { _raw: "" };
  }

  const headers = parseHeaders(c.req.raw.headers);
  const sourceIp = c.req.header("cf-connecting-ip") ?? null;

  const channelRules = await loadRules(c.env.DB, channel.id);
  const ruleResult = evaluateRules(channelRules, {
    headers,
    payload,
    source_ip: sourceIp,
    content_type: ct,
  });

  if (ruleResult.action === "reject") {
    return c.json({ ok: true, dropped: true });
  }

  const tag = ruleResult.action === "tag" ? ruleResult.tag : null;

  if (channel.mode === "proxy") {
    // ── Proxy 模式 步骤a：生成 ReqID，将请求存入 D1（Request Parking 开始）──
    const row = await c.env.DB.prepare(
      `INSERT INTO proxy_requests (channel_id, payload_json, headers_json, source_ip, status)
       VALUES (?, ?, ?, ?, 'pending') RETURNING id`
    )
      .bind(channel.id, JSON.stringify(payload), JSON.stringify(headers), sourceIp)
      .first<{ id: number }>();

    // ReqID：ChannelServer 用于关联"挂起请求"与"ChannelClient 回传结果"的唯一标识
    const requestId = row!.id;
    const deadline = Date.now() + PROXY_TIMEOUT_MS;

    // ── 步骤b：Request Parking —— 轮询 D1 等待 ChannelClient 回传 ──────────
    // Cloudflare Workers 为无状态执行环境，将轮询放在 waitUntil 里，
    // 防止客户端提前断开连接导致 Worker 被干掉，使我们错过更新 timeout 状态。
    return new Promise<Response>((resolve) => {
      c.executionCtx.waitUntil(
        (async () => {
          while (Date.now() < deadline) {
            await new Promise<void>((r) => setTimeout(r, PROXY_POLL_MS));

            const pr = await c.env.DB.prepare(
              "SELECT * FROM proxy_requests WHERE id = ?"
            )
              .bind(requestId)
              .first<ProxyRequestRow>();

            if (pr && pr.status === "completed") {
              // ── 步骤d：ChannelClient 已回传，解除挂起，同步返回给外部调用方 ──
              const status = pr.response_status || 200;
              const respHeaders = new Headers();

              if (pr.response_headers_json) {
                try {
                  const extra = JSON.parse(pr.response_headers_json) as Record<string, string>;
                  for (const [k, v] of Object.entries(extra)) {
                    respHeaders.set(k, v);
                  }
                } catch { /* ignore malformed headers */ }
              }

              if (!respHeaders.has("content-type")) {
                respHeaders.set("Content-Type", "application/octet-stream");
              }

              resolve(
                new Response(pr.response_body ?? '{"ok":true}', {
                  status,
                  headers: respHeaders,
                })
              );
              return;
            }
          }

          // ── 步骤e：超时，ChannelClient 未在规定时间内回传 ───────────────────────
          await c.env.DB.prepare(
            "UPDATE proxy_requests SET status = 'timeout', completed_at = datetime('now') WHERE id = ? AND status IN ('pending', 'processing')"
          )
            .bind(requestId)
            .run();

          resolve(c.json({ error: "gateway_timeout", message: "Client did not respond in time" }, 504));
        })()
      );
    });
  }

  // ── Sendbox 模式 ─────────────────────────────────────────────────────────
  // 消息先落 D1 再入队，保证持久化。
  // 投递 + 重试 + DLQ 全部由 Cloudflare Queues 平台托管。
  const msgRow = await c.env.DB.prepare(
    `INSERT INTO messages (channel_id, payload_json, headers_json, source_ip, tag)
     VALUES (?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(channel.id, JSON.stringify(payload), JSON.stringify(headers), sourceIp, tag)
    .first<{ id: number }>();

  const messageId = msgRow!.id;

  // 入队：替代原 waitUntil(forwardMessage(...))
  await c.env.SENDBOX_QUEUE.send({
    messageId,
    channelId: channel.id,
  });

  let responseBody: unknown;
  try {
    responseBody = JSON.parse(channel.sendbox_response);
  } catch {
    responseBody = { ok: true };
  }

  return c.json(responseBody, 202);
}

webhook.post("/w/:secret", handleWebhook);
webhook.get("/w/:secret", handleWebhook);

export default webhook;
