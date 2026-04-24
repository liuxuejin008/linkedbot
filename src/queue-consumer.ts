/**
 * Queue Consumer — Cloudflare Queues 消费者
 *
 * 替代原 forwardMessage() + retryPendingForwards() 全部逻辑：
 * - 平台自动调度，无需 Cron
 * - 单条消息粒度的 ack/retry，无并发冲突
 * - 超过 max_retries 后自动进入 DLQ，零丢失
 */
import type { Env, SendboxQueueMessage, ChannelForwardRow, MessageRow } from "./types";

const MAX_BACKOFF_SECONDS = 1800; // 30 分钟

function backoffSeconds(attempts: number): number {
  return Math.min(Math.pow(2, attempts) * 10, MAX_BACKOFF_SECONDS);
}

/**
 * Sendbox Queue Consumer
 *
 * 当 webhook.ts 将 SendboxQueueMessage 入队后，由本 consumer 消费：
 * 1. 从 D1 读取原始消息 + channel_forwards 列表
 * 2. 逐个 HTTP 投递到转发目标
 * 3. 全部成功 → msg.ack()；任一失败 → msg.retry()
 * 4. 超过 max_retries 后平台自动将消息转入 DLQ
 */
export async function handleSendboxQueue(
  batch: MessageBatch<SendboxQueueMessage>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    const { messageId, channelId } = msg.body;

    try {
      const message = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
        .bind(messageId)
        .first<MessageRow>();

      if (!message) {
        // 消息已被删除，无需处理
        msg.ack();
        continue;
      }

      const { results: forwards } = await env.DB.prepare(
        "SELECT * FROM channel_forwards WHERE channel_id = ? AND enabled = 1"
      )
        .bind(channelId)
        .all<ChannelForwardRow>();

      if (forwards.length === 0) {
        msg.ack();
        continue;
      }

      // 逐个投递
      const errors: string[] = [];
      for (const fwd of forwards) {
        try {
          // 检查该目标是否已经投递成功过（防止重试时重复投递）
          const alreadyDelivered = await env.DB.prepare(
            "SELECT 1 FROM forward_log WHERE message_id = ? AND forward_id = ? AND status_code >= 200 AND status_code < 300 AND error IS NULL"
          )
            .bind(messageId, fwd.id)
            .first();

          if (alreadyDelivered) {
            continue; // 跳过已成功投递的目标
          }

          const extraHeaders: Record<string, string> = fwd.extra_headers_json
            ? JSON.parse(fwd.extra_headers_json)
            : {};

          const res = await fetch(fwd.url, {
            method: fwd.method,
            headers: {
              "Content-Type": "application/json",
              "X-LinkedBot-Channel-Id": String(channelId),
              "X-LinkedBot-Message-Id": String(messageId),
              ...extraHeaders,
            },
            body: message.payload_json,
          });

          // 记录投递日志
          await env.DB.prepare(
            `INSERT INTO forward_log (message_id, forward_id, attempt, status_code, delivered_at)
             VALUES (?, ?, ?, ?, ${res.ok ? "datetime('now')" : "NULL"})`
          )
            .bind(messageId, fwd.id, msg.attempts + 1, res.status)
            .run();

          if (!res.ok) {
            errors.push(`forward ${fwd.id}: HTTP ${res.status}`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`forward ${fwd.id}: ${errMsg}`);

          await env.DB.prepare(
            `INSERT INTO forward_log (message_id, forward_id, attempt, status_code, error)
             VALUES (?, ?, ?, NULL, ?)`
          )
            .bind(messageId, fwd.id, msg.attempts + 1, errMsg)
            .run();
        }
      }

      if (errors.length > 0) {
        // 有失败，交给 Queue 平台自动重试（含指数退避）
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
      } else {
        msg.ack();
      }
    } catch (err) {
      // 未预期的异常，也交给 Queue 重试
      msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    }
  }
}

/**
 * DLQ Consumer — 处理终态失败消息
 *
 * 超过 max_retries（5次）后由平台自动转入 linkedbot-dlq。
 * 在此记录日志，后续可扩展为发送告警通知。
 */
export async function handleDLQ(
  batch: MessageBatch<SendboxQueueMessage>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    const { messageId, channelId } = msg.body;

    // 最终失败告警
    // 注：由于重试期间的失败日志已分别通过前置逻辑写入 forward_log
    // 此处无需（也不能）再向 forward_log 写入 forward_id = 0 (会触发外键约束错误)

    // TODO: 可扩展 — 通过邮件/WebPush/SSE 通知用户有消息投递彻底失败
    console.error(
      `[DLQ] message ${messageId} channel ${channelId} exhausted all retries after ${msg.attempts + 1} attempts`
    );

    msg.ack();
  }
}
