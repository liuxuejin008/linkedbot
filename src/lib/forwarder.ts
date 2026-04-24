/**
 * Forwarder utilities
 *
 * 历史说明：forwardMessage / attemptForward / retryPendingForwards 已被
 * Cloudflare Queues consumer（queue-consumer.ts）替代，不再使用。
 *
 * 保留 cleanupTimedOutProxyRequests 用于 Cron 清理 Proxy 僵尸记录。
 */

/**
 * 清理超时的 Proxy 请求
 *
 * 将超过 60 秒仍为 pending 或 processing 的记录标记为 timeout。
 * 由 Cron 定时调用（每小时一次）。
 */
export async function cleanupTimedOutProxyRequests(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  await db
    .prepare(
      `UPDATE proxy_requests SET status = 'timeout', completed_at = datetime('now')
       WHERE status IN ('pending', 'processing') AND created_at <= ?`
    )
    .bind(cutoff)
    .run();
}
