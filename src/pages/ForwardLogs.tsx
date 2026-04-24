import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import type { ForwardLogRow, MessageRow, ChannelForwardRow } from "../types";

type Props = {
  email: string;
  channel: { id: number; name: string };
  logs: (ForwardLogRow & {
    message_payload?: string | null;
    forward_url?: string;
  })[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
  flashes?: { category: string; message: string }[];
};

function formatTime(ts: string | null): string {
  if (!ts) return "—";
  return ts.replace("T", " ").slice(0, 19);
}

function parsePayload(payload: string | null | undefined): string {
  if (!payload) return "—";
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

export const ForwardLogsPage: FC<Props> = ({
  email,
  channel,
  logs,
  total,
  page,
  pageSize,
  search,
  flashes,
}) => {
  const totalPages = Math.ceil(total / pageSize);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  return (
    <Layout title={`转发记录 — ${channel.name} — LinkedBot`} email={email} flashes={flashes}>
      <header class="page-head">
        <p class="breadcrumb">
          <a href="/dashboard">控制台</a> / <a href={`/channels/${channel.id}`}>{channel.name}</a> / <span aria-current="page">转发记录</span>
        </p>
        <div class="hero-row">
          <h1 class="ds-page-title">转发记录</h1>
          <span class="badge" title="总数">{total} 条</span>
        </div>
        <p class="ds-muted ds-small" style="margin-top:12px;">
          查看频道 #${channel.id} 的转发日志，支持搜索和删除。
        </p>
      </header>

      <section class="panel" aria-labelledby="logs-title">
        <div class="logs-toolbar">
          <h2 class="ds-panel-title" id="logs-title" style="margin:0;">日志列表</h2>
          <form class="search-form" method="get" action={`/channels/${channel.id}/logs`}>
            <input
              type="text"
              name="search"
              placeholder="搜索消息 ID / 转发 URL / error"
              value={search}
              class="search-input"
            />
            <button type="submit" class="btn">搜索</button>
            {search && (
              <a href={`/channels/${channel.id}/logs`} class="btn">清除</a>
            )}
          </form>
        </div>

        {logs.length === 0 ? (
          <p class="ds-muted" style="margin-top:16px;">暂无转发记录。</p>
        ) : (
          <div class="table-wrap" style="margin-top:16px;">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">消息 ID</th>
                  <th scope="col">转发目标</th>
                  <th scope="col">状态</th>
                  <th scope="col">HTTP</th>
                  <th scope="col">重试</th>
                  <th scope="col">时间</th>
                  <th scope="col">Payload</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td class="mono">{log.id}</td>
                    <td class="mono">{log.message_id}</td>
                    <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title={log.forward_url}>
                      {log.forward_url ?? "—"}
                    </td>
                    <td>
                      {log.delivered_at ? (
                        <span class="tag-pill" style="background:#ecfdf5;color:#059669;">成功</span>
                      ) : log.error ? (
                        <span class="tag-pill" style="background:#fef2f2;color:#dc2626;" title={log.error}>失败</span>
                      ) : (
                        <span class="tag-pill" style="background:#fffbeb;color:#d97706;">等待</span>
                      )}
                    </td>
                    <td class="mono">
                      {log.status_code ? (
                        <span style={`color:${log.status_code >= 200 && log.status_code < 300 ? "#059669" : log.status_code >= 400 ? "#dc2626" : "#d97706"}`}>
                          {log.status_code}
                        </span>
                      ) : "—"}
                    </td>
                    <td>{log.attempt}</td>
                    <td class="nowrap">{formatTime(log.created_at)}</td>
                    <td>
                      <details class="payload-details">
                        <summary class="mono-label" style="cursor:pointer;">查看</summary>
                        <pre class="payload-preview">{parsePayload(log.message_payload)}</pre>
                      </details>
                    </td>
                    <td>
                      <form
                        method="post"
                        action={`/channels/${channel.id}/logs/${log.id}/delete`}
                        onsubmit="return confirm('确定删除此记录？')"
                      >
                        <button type="submit" class="btn btn-sm btn-danger">删除</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <nav class="pagination" aria-label="分页">
            {hasPrev ? (
              <a
                class="btn"
                href={`/channels/${channel.id}/logs?page=${page - 1}${search ? `&search=${encodeURIComponent(search)}` : ""}`}
              >
                ← 上一页
              </a>
            ) : (
              <span class="btn" style="opacity:0.4;cursor:not-allowed;">← 上一页</span>
            )}
            <span class="page-info">
              第 {page} / {totalPages} 页，共 {total} 条
            </span>
            {hasNext ? (
              <a
                class="btn"
                href={`/channels/${channel.id}/logs?page=${page + 1}${search ? `&search=${encodeURIComponent(search)}` : ""}`}
              >
                下一页 →
              </a>
            ) : (
              <span class="btn" style="opacity:0.4;cursor:not-allowed;">下一页 →</span>
            )}
          </nav>
        )}
      </section>

      <style>{`
        .logs-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 12px;
        }
        .search-form {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .search-input {
          width: auto;
          min-width: 220px;
          padding: 8px 12px;
          border: none;
          border-radius: var(--radius-btn);
          background: var(--ds-white);
          box-shadow: var(--shadow-ring);
          font: inherit;
          font-size: 14px;
          color: var(--ds-black);
        }
        .search-input:focus {
          outline: 2px solid var(--ds-focus);
          outline-offset: 2px;
        }
        .pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 16px;
          margin-top: 24px;
          flex-wrap: wrap;
        }
        .page-info {
          font-size: 14px;
          color: var(--ds-gray-500);
          padding: 0 8px;
        }
        .payload-details {
          margin: 0;
        }
        .payload-details pre {
          margin-top: 8px;
        }
      `}</style>
    </Layout>
  );
};
