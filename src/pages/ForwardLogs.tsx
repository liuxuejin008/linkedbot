import type { FC } from "hono/jsx";
import type { Lang, TranslatorFunction } from "../i18n";
import { Layout } from "./Layout";
import type { ForwardLogRow, MessageRow, ChannelForwardRow } from "../types";

type Props = {
  lang: Lang;
  t: TranslatorFunction;
  email: string;
  channel: { id: number; name: string };
  logs: (ForwardLogRow & {
    message_payload?: string | null;
    forward_url?: string | null;
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
  lang,
  t,
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
    <Layout title={`${t("logs.title")} — ${channel.name} — LinkedBot`} email={email} flashes={flashes} lang={lang} t={t}>
      <header class="page-head">
        <p class="breadcrumb">
          <a href="/dashboard">{t("common.dashboard")}</a> / <a href={`/channels/${channel.id}`}>{channel.name}</a> / <span aria-current="page">{t("logs.title")}</span>
        </p>
        <div class="hero-row">
          <h1 class="ds-page-title">{t("logs.title")}</h1>
          <span class="badge" title={t("logs.totalCount", { total: total })}>{total} {t("logs.items")}</span>
        </div>
        <p class="ds-muted ds-small" style="margin-top:12px;">
          {t("logs.desc", { id: channel.id })}
        </p>
      </header>

      <section class="panel" aria-labelledby="logs-title">
        <div class="logs-toolbar">
          <h2 class="ds-panel-title" id="logs-title" style="margin:0;">{t("logs.list")}</h2>
          <form class="search-form" method="get" action={`/channels/${channel.id}/logs`}>
            <input
              type="text"
              name="search"
              placeholder={t("logs.searchPlaceholder")}
              value={search}
              class="search-input"
            />
            <button type="submit" class="btn">{t("common.search")}</button>
            {search && (
              <a href={`/channels/${channel.id}/logs`} class="btn">{t("logs.clear")}</a>
            )}
          </form>
        </div>

        {logs.length === 0 ? (
          <p class="ds-muted" style="margin-top:16px;">{t("logs.noLogs")}</p>
        ) : (
          <div class="table-wrap" style="margin-top:16px;">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">{t("logs.messageId")}</th>
                  <th scope="col">{t("logs.target")}</th>
                  <th scope="col">{t("common.status")}</th>
                  <th scope="col">HTTP</th>
                  <th scope="col">{t("common.retries")}</th>
                  <th scope="col">{t("logs.time")}</th>
                  <th scope="col">Payload</th>
                  <th scope="col">{t("logs.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td class="mono">{log.id}</td>
                    <td class="mono">{log.message_id}</td>
                    <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title={log.forward_url ?? undefined}>
                      {log.forward_url ?? "—"}
                    </td>
                    <td>
                      {log.delivered_at ? (
                        <span class="tag-pill" style="background:#ecfdf5;color:#059669;">{t("logs.success")}</span>
                      ) : log.error ? (
                        <span class="tag-pill" style="background:#fef2f2;color:#dc2626;" title={log.error}>{t("logs.failed")}</span>
                      ) : (
                        <span class="tag-pill" style="background:#fffbeb;color:#d97706;">{t("logs.waiting")}</span>
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
                        <summary class="mono-label" style="cursor:pointer;">{t("logs.view")}</summary>
                        <pre class="payload-preview">{parsePayload(log.message_payload)}</pre>
                      </details>
                    </td>
                    <td>
                      <form
                        method="post"
                        action={`/channels/${channel.id}/logs/${log.id}/delete`}
                        onsubmit={`return confirm('${t("logs.confirmDelete")}')`}
                      >
                        <button type="submit" class="btn btn-sm btn-danger">{t("common.delete")}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <nav class="pagination" aria-label={t("logs.pagination")}>
            {hasPrev ? (
              <a
                class="btn"
                href={`/channels/${channel.id}/logs?page=${page - 1}${search ? `&search=${encodeURIComponent(search)}` : ""}`}
              >
                ← {t("logs.prevPage")}
              </a>
            ) : (
              <span class="btn" style="opacity:0.4;cursor:not-allowed;">← {t("logs.prevPage")}</span>
            )}
            <span class="page-info">
              {t("logs.pageInfoFull", { page: page, totalPages: totalPages, total: total })}
            </span>
            {hasNext ? (
              <a
                class="btn"
                href={`/channels/${channel.id}/logs?page=${page + 1}${search ? `&search=${encodeURIComponent(search)}` : ""}`}
              >
                {t("logs.nextPage")} →
              </a>
            ) : (
              <span class="btn" style="opacity:0.4;cursor:not-allowed;">{t("logs.nextPage")} →</span>
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
