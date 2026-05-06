import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt";
import { checkChannelAccess } from "../lib/access";
import type { AppEnv, MessageRow, ProxyRequestRow } from "../types";

const stream = new Hono<AppEnv>();
stream.use("*", jwtAuth);

/**
 * GET /api/channels/:id/messages/stream?since=<msg_id>&proxy_since=<req_id>
 *
 * ChannelServer → ChannelClient SSE 隧道
 *
 * ChannelClient 主动发起此连接，ChannelServer 通过该隧道下推事件：
 *
 * - event: proxy_request  （Proxy 模式）
 *     包含 ReqID + 外部请求载荷，ChannelClient 收到后调用 ChannelReceiver，
 *     再将结果 POST 到 /api/channels/:id/proxy-response/:reqId。
 *
 * - event: message         （Mailbox 模式）
 *     包含已存入 D1 的消息，ChannelClient 异步转发到 ChannelReceiver。
 *
 * - event: skip            数据库记录损坏，游标已推进，ChannelClient 忽略即可。
 * - event: reconnect       连接即将超时，ChannelClient 应主动断开并重连。
 * - :keepalive             注释行，维持连接活跃。
 *
 * 连接约 24 秒后主动发 reconnect 并关闭，ChannelClient 重连时通过
 * since / proxy_since 游标续取，避免重复处理已投递事件。
 */
stream.get("/channels/:id/messages/stream", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));

  const ch = await checkChannelAccess(c.env.DB, channelId, userId, "readonly");
  if (!ch) return c.json({ error: "not_found" }, 404);

  const sinceHeader = c.req.header("Last-Event-ID");
  let since = sinceHeader
    ? parseInt(sinceHeader)
    : parseInt(c.req.query("since") ?? "0") || 0;

  let proxySince = parseInt(c.req.query("proxy_since") ?? "0") || 0;

  const db = c.env.DB;
  const channelMode = ch.mode;

  // 生成连接 ID 与抢占锁
  // 使用 KV 实现 "新连接踢弃旧连接"，防止同一 Channel 开启多个 SSE 客户端导致重复消费
  const connectionId = crypto.randomUUID();
  const lockKey = `channel:${channelId}:sse_owner`;
  await c.env.SSE_CONNECTIONS.put(lockKey, connectionId, { expirationTtl: 60 });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const write = (chunk: string) => writer.write(enc.encode(chunk));

  const loop = async () => {
    const deadline = Date.now() + 24_000;
    const POLL_MS = channelMode === "proxy" ? 1000 : 2000;
    let lastLockCheck = Date.now();

    try {
      while (Date.now() < deadline) {
        let emitted = false;

        // 锁校验与续租 (每 10秒 校验一次，因为通常连接只持续 24秒)
        if (Date.now() - lastLockCheck >= 10_000) {
          const currentOwner = await c.env.SSE_CONNECTIONS.get(lockKey);
          if (currentOwner !== connectionId) {
            // 被此频道的更新近的连接覆盖（踢下线）
            await write(`event: conflict\ndata: {"message":"terminated_by_new_connection"}\n\n`);
            break;
          }
          await c.env.SSE_CONNECTIONS.put(lockKey, connectionId, { expirationTtl: 60 });
          lastLockCheck = Date.now();
        }

        // Mailbox messages
        if (channelMode === "mailbox") {
          const { results } = await db
            .prepare(
              `SELECT id, channel_id, payload_json, headers_json, source_ip, created_at, read_at, tag
               FROM messages WHERE channel_id = ? AND id > ? ORDER BY id LIMIT 20`
            )
            .bind(channelId, since)
            .all<MessageRow>();

          if (results.length > 0) {
            for (const m of results) {
              try {
                const data = JSON.stringify({
                  id: m.id,
                  channel_id: m.channel_id,
                  payload: JSON.parse(m.payload_json),
                  headers: m.headers_json ? JSON.parse(m.headers_json) : null,
                  tag: m.tag,
                  created_at: m.created_at,
                  read_at: m.read_at,
                });
                await write(`id: ${m.id}\nevent: message\ndata: ${data}\n\n`);
              } catch {
                // Corrupted record — advance cursor and skip to avoid infinite retry
                await write(`id: ${m.id}\nevent: skip\ndata: {"id":${m.id}}\n\n`);
              }
            }
            since = results[results.length - 1].id;
            emitted = true;
          }
        }

        // Proxy requests — 原子抢占，防止多 SSE 连接重复推送
        if (channelMode === "proxy") {
          const { results: proxyResults } = await db
            .prepare(
              `SELECT id FROM proxy_requests
               WHERE channel_id = ? AND id > ? AND status = 'pending'
               ORDER BY id LIMIT 10`
            )
            .bind(channelId, proxySince)
            .all<{ id: number }>();

          if (proxyResults.length > 0) {
            for (const { id: prId } of proxyResults) {
              // 原子标记为 processing，只有成功 RETURNING 的才推送
              const claimed = await db
                .prepare(
                  `UPDATE proxy_requests SET status = 'processing'
                   WHERE id = ? AND status = 'pending'
                   RETURNING *`
                )
                .bind(prId)
                .first<ProxyRequestRow>();

              if (!claimed) continue; // 已被其他连接抢占，跳过

              try {
                const data = JSON.stringify({
                  request_id: claimed.id,
                  channel_id: claimed.channel_id,
                  payload: JSON.parse(claimed.payload_json),
                  headers: claimed.headers_json ? JSON.parse(claimed.headers_json) : null,
                  source_ip: claimed.source_ip,
                  created_at: claimed.created_at,
                });
                await write(`id: p${claimed.id}\nevent: proxy_request\ndata: ${data}\n\n`);
              } catch {
                // Corrupted record — advance cursor and skip
                await write(`id: p${claimed.id}\nevent: skip\ndata: {"id":${claimed.id}}\n\n`);
              }
            }
            proxySince = proxyResults[proxyResults.length - 1].id;
            emitted = true;
          }
        }

        if (!emitted) {
          await write(`:keepalive\n\n`);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
      }

      await write(`event: reconnect\ndata: {}\n\n`);
    } catch {
      // Connection dropped or timeout
    } finally {
      await writer.close().catch(() => {});
    }
  };

  c.executionCtx.waitUntil(loop());

  return new Response(readable as unknown as BodyInit, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

/**
 * POST /api/channels/:id/proxy-response/:requestId
 *
 * Proxy 模式 步骤5：ChannelClient 回传 ChannelReceiver 的响应结果。
 *
 * ChannelClient 调用 ChannelReceiver 后，把响应 body / status / headers
 * 一并 POST 到此接口。ChannelServer 将对应 proxy_requests 记录更新为
 * status=completed，Webhook 入口的轮询随即检测到并返回给外部调用方（步骤6）。
 */
stream.post("/channels/:id/proxy-response/:requestId", async (c) => {
  const userId = c.get("userId");
  const channelId = parseInt(c.req.param("id"));
  const requestId = parseInt(c.req.param("requestId"));

  const ch = await checkChannelAccess(c.env.DB, channelId, userId, "member");
  if (!ch) return c.json({ error: "not_found" }, 404);

  const pr = await c.env.DB.prepare(
    "SELECT * FROM proxy_requests WHERE id = ? AND channel_id = ? AND status IN ('pending', 'processing')"
  )
    .bind(requestId, channelId)
    .first<ProxyRequestRow>();

  if (!pr) return c.json({ error: "not_found_or_expired" }, 404);

  const body = await c.req.json<{
    body?: string;
    status?: number;
    headers?: Record<string, string>;
  }>().catch(() => ({}));

  const responseBody = (body as { body?: string }).body ?? '{"ok":true}';
  const responseStatus = (body as { status?: number }).status ?? 200;
  const responseHeaders = (body as { headers?: Record<string, string> }).headers
    ? JSON.stringify((body as { headers?: Record<string, string> }).headers)
    : null;

  await c.env.DB.prepare(
    `UPDATE proxy_requests
     SET status = 'completed', response_body = ?, response_status = ?,
         response_headers_json = ?, completed_at = datetime('now')
     WHERE id = ?`
  )
    .bind(responseBody, responseStatus, responseHeaders, requestId)
    .run();

  return c.json({ ok: true });
});

export default stream;
