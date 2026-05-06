import type { FC } from "hono/jsx";
import type { Lang, TranslatorFunction } from "../i18n";
import { Layout } from "./Layout";
import type { ChannelRow, ChannelForwardRow, MessageRow } from "../types";

type DayStat = { date: string; count: number };
type TagStat = { tag: string; count: number };

type Props = {
  lang: Lang;
  t: TranslatorFunction;
  email: string;
  channel: ChannelRow;
  webhookUrl: string;
  curlExample: string;
  forwards: ChannelForwardRow[];
  messages: MessageRow[];
  unseen: number;
  flashes?: { category: string; message: string }[];
  stats?: {
    days: number;
    total: number;
    unread: number;
    by_day: DayStat[];
    by_tag: TagStat[];
    forward_success_rate: number | null;
  };
};

export const ChannelDetailPage: FC<Props> = ({
  lang,
  t,
  email,
  channel,
  webhookUrl,
  curlExample,
  forwards,
  messages,
  unseen,
  flashes,
  stats,
}) => (
  <Layout title={`${channel.name} — LinkedBot`} email={email} flashes={flashes} lang={lang} t={t}>
    <header class="page-head">
      <p class="breadcrumb">
        <a href="/dashboard">{t("common.dashboard")}</a> / <span aria-current="page">{channel.name}</span>
      </p>
      <div class="hero-row">
        <h1 class="ds-page-title">{channel.name}</h1>
        <span class="tag-pill" style="margin-left:12px;">{channel.mode}</span>
        <span class="badge" title={t("channel.unreadQueueLength")} style="margin-left:8px;">{t("channel.unread", { count: unseen })}</span>
      </div>
      <p class="ds-muted ds-small" style="margin-top:12px;">
        {t("channel.id")} <code>#{channel.id}</code> · {t("channel.mode")} <code>{channel.mode}</code> · {t("channel.desc")}
      </p>
    </header>

    <section class="panel" aria-labelledby="webhook-title">
      <h2 class="ds-panel-title" id="webhook-title">Webhook</h2>
      <p class="ds-muted ds-small">{t("channel.postDesc")}</p>
      <div class="copy-row" style="margin-top:16px;">
        <input id="webhook-url" class="mono-input" type="text" readonly value={webhookUrl} aria-label="Webhook URL" />
        <button type="button" class="btn" id="copy-btn">{t("common.copy")}</button>
      </div>
      {channel.mode === "email" && channel.email_prefix && (
        <div class="copy-row" style="margin-top:12px;">
          <input id="email-url" class="mono-input" type="text" readonly value={`${channel.email_prefix}@linkedbot.io`} aria-label="Email Address" />
          <button type="button" class="btn" id="copy-email-btn">{t("common.copy")}</button>
        </div>
      )}
      {channel.mode === "proxy" && (
        <p class="ds-muted ds-small" style="margin-top:8px;">
          {t("channel.proxyModeDesc")}
        </p>
      )}
      {channel.mode === "mailbox" && (
        <p class="ds-muted ds-small" style="margin-top:8px;">
          {t("channel.mailboxModeDesc", { response: channel.mailbox_response })}
        </p>
      )}
      {channel.mode === "email" && (
        <p class="ds-muted ds-small" style="margin-top:8px;">
          {t("channel.emailModeDesc")}
        </p>
      )}
    </section>

    <section class="panel" aria-labelledby="curl-title">
      <h2 class="ds-panel-title" id="curl-title">{t("channel.curlTitle")}</h2>
      <pre class="code-block" tabindex={0}>{curlExample}</pre>
    </section>

    {stats && (
      <section class="panel" aria-labelledby="stats-title">
        <h2 class="ds-panel-title" id="stats-title">{t("channel.statsTitle", { days: stats.days })}</h2>
        <div class="stats-grid">
          <div class="stat-card">
            <span class="stat-value">{stats.total}</span>
            <span class="stat-label">{t("channel.totalMessages")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">{stats.unread}</span>
            <span class="stat-label">{t("channel.currentUnread")}</span>
          </div>
          {stats.forward_success_rate !== null && (
            <div class="stat-card">
              <span class="stat-value">{Math.round(stats.forward_success_rate * 100)}%</span>
              <span class="stat-label">{t("channel.forwardSuccessRate")}</span>
            </div>
          )}
        </div>

        {stats.by_day.length > 0 && (
          <div style="margin-top:20px;">
            <p class="ds-muted ds-small" style="margin-bottom:8px;">{t("channel.dailyMessages")}</p>
            <div class="bar-chart" aria-label={`${t("channel.dailyMessages")}${t("channel.chart")}`}>
              {(() => {
                const max = Math.max(...stats.by_day.map((d) => d.count), 1);
                return stats.by_day.map((d) => (
                  <div class="bar-col" key={d.date} title={`${d.date}: ${d.count}`}>
                    <div class="bar-fill" style={`height:${Math.round((d.count / max) * 80)}px`} />
                    <span class="bar-label">{d.date.slice(5)}</span>
                  </div>
                ));
              })()}
            </div>
          </div>
        )}

        {stats.by_tag.length > 0 && (
          <div style="margin-top:16px;">
            <p class="ds-muted ds-small" style="margin-bottom:8px;">{t("channel.tagDistribution")}</p>
            <div class="tag-list">
              {stats.by_tag.map((t) => (
                <span class="tag-pill" key={t.tag}>{t.tag} <strong>{t.count}</strong></span>
              ))}
            </div>
          </div>
        )}
      </section>
    )}

    <section class="panel" aria-labelledby="settings-title">
      <h2 class="ds-panel-title" id="settings-title">{t("channel.settingsTitle")}</h2>
      <form method="post" action={`/channels/${channel.id}/settings`} class="stack-form">
        <label>{t("common.name")}
          <input type="text" name="name" value={channel.name} maxlength={128} required />
        </label>
        <label>{t("common.mode")}
          <select id="settings-mode-select" name="mode">
            <option value="mailbox" selected={channel.mode === "mailbox"}>Mailbox</option>
            <option value="proxy" selected={channel.mode === "proxy"}>Proxy</option>
            <option value="email" selected={channel.mode === "email"}>Email</option>
          </select>
        </label>
        <label id="settings-email-prefix" style={{ display: channel.mode === "email" ? "block" : "none" }}>{t("channel.customEmailPrefix")}
          <input type="text" name="email_prefix" value={channel.email_prefix || ""} placeholder={t("channel.emailPrefixExample")} maxlength={64} pattern="^[a-z0-9_-]+$" title={t("dashboard.emailPrefixPatternTitle")} />
        </label>
        {channel.mode === "mailbox" && (
          <label>{t("channel.mailboxResponse")}
            <input type="text" name="mailbox_response" value={channel.mailbox_response} />
          </label>
        )}
        <button type="submit" class="btn primary">{t("common.save")}</button>
      </form>
      <form id="avatar-form" method="post" action={`/channels/${channel.id}/avatar`} enctype="multipart/form-data" class="stack-form mt">
        <div class="avatar-dropzone" id="dropzone">
          <div class="dropzone-icon">📁</div>
          <div class="dropzone-text" id="dropzone-text">{t("channel.uploadAvatar")}</div>
          <div class="dropzone-hint">{t("channel.dropzoneHint")}</div>
          <input type="file" name="file" accept=".png,.jpg,.jpeg,.gif,.webp" onchange="document.getElementById('avatar-form').submit();" />
        </div>
      </form>
    </section>

    <section class="panel" aria-labelledby="forwards-title">
      <h2 class="ds-panel-title" id="forwards-title">{t("channel.forwardsTitle")}</h2>
      <p class="ds-muted ds-small">
        {t("channel.forwardsDesc")}
      </p>

      {forwards.length > 0 ? (
        <div class="table-wrap" style="margin-top:16px;">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">URL</th>
                <th scope="col">{t("common.method")}</th>
                <th scope="col">{t("common.enabled")}</th>
                <th scope="col">{t("common.retries")}</th>
                <th scope="col">{t("logs.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {forwards.map((fw) => (
                <tr key={fw.id}>
                  <td class="mono" style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title={fw.url}>{fw.url}</td>
                  <td>{fw.method}</td>
                  <td>{fw.enabled ? t("channel.yes") : t("channel.no")}</td>
                  <td>{fw.retry_max}</td>
                  <td style="white-space:nowrap;">
                    <form method="post" action={`/channels/${channel.id}/forwards/${fw.id}/toggle`} style="display:inline;">
                      <button type="submit" class="btn btn-sm">{fw.enabled ? t("channel.disable") : t("channel.enable")}</button>
                    </form>
                    {" "}
                    <form method="post" action={`/channels/${channel.id}/forwards/${fw.id}/delete`} style="display:inline;"
                      onsubmit={`return confirm('${t("channel.confirmDeleteForward")}')`}>
                      <button type="submit" class="btn btn-sm btn-danger">{t("common.delete")}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="ds-muted" style="margin-top:12px;">{t("channel.noForwards")}</p>
      )}

      <details style="margin-top:20px;">
        <summary class="ds-muted" style="cursor:pointer;font-weight:600;">{t("channel.addForwardTarget")}</summary>
        <form method="post" action={`/channels/${channel.id}/forwards`} class="stack-form" style="margin-top:12px;">
          <label>{t("channel.forwardUrl")}
            <input type="url" name="url" placeholder="http://localhost:9999/webhook" required />
          </label>
          <label>{t("channel.httpMethod")}
            <select name="method">
              <option value="GET">GET</option>
              <option value="POST" selected>POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
            </select>
          </label>
          <label>{t("channel.maxRetries")}
            <input type="number" name="retry_max" value="3" min={0} max={10} />
          </label>
          <label>{t("channel.customHeaders")}
            <input type="text" name="extra_headers" placeholder='{"Authorization":"Bearer xxx"}' />
          </label>
          <button type="submit" class="btn primary">{t("common.add")}</button>
        </form>
      </details>
    </section>

    <section class="panel" aria-labelledby="logs-link-title">
      <h2 class="ds-panel-title" id="logs-link-title">{t("channel.moreActions")}</h2>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;">
        <a class="btn" href={`/channels/${channel.id}/logs`}>{t("logs.title")}</a>
        <a class="btn" href={`/channels/${channel.id}/members`}>{t("channel.memberManagement")}</a>
      </div>
    </section>

    <section class="panel" aria-labelledby="consume-title">
      <h2 class="ds-panel-title" id="consume-title">{t("channel.consumeQueue")}</h2>
      <p class="ds-muted ds-small">
        {t("channel.consumeQueueDesc")}
      </p>
      <form method="post" action={`/channels/${channel.id}/consume`} class="inline-create" style="margin-top:16px;">
        <label class="inline-label">{t("channel.count")}
          <input type="number" name="limit" value="50" min={1} max={200} />
        </label>
        <button type="submit" class="btn primary">{t("channel.consumeUnread", { limit: "" }).replace(" ", "")}</button>
      </form>
    </section>

    <section class="panel" aria-labelledby="messages-title">
      <h2 class="ds-panel-title" id="messages-title">{t("channel.recentMessagesTitle")}</h2>
      {messages.length === 0 ? (
        <p class="ds-muted">{t("channel.noMessages")}</p>
      ) : (
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">{t("channel.time")}</th>
                <th scope="col">{t("channel.tag")}</th>
                <th scope="col">{t("channel.read")}</th>
                <th scope="col">Payload</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => {
                let pretty: string;
                try {
                  pretty = JSON.stringify(JSON.parse(m.payload_json), null, 2);
                } catch {
                  pretty = m.payload_json;
                }
                return (
                  <tr key={m.id} class={m.read_at ? "" : "row-unread"}>
                    <td class="mono">{m.id}</td>
                    <td class="nowrap">{m.created_at.replace("T", " ").slice(0, 19)}</td>
                    <td>{m.tag ? <span class="tag-pill">{m.tag}</span> : <span class="ds-muted">—</span>}</td>
                    <td>{m.read_at ? t("channel.yes") : t("channel.no")}</td>
                    <td><pre class="payload-preview">{pretty}</pre></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <script dangerouslySetInnerHTML={{
      __html: `(function(){
        function setupCopy(btnId, inputId) {
          var btn=document.getElementById(btnId),input=document.getElementById(inputId);
          if(!btn||!input)return;
          btn.addEventListener('click',function(){
            input.select();input.setSelectionRange(0,99999);
            var url=input.value;
            if(navigator.clipboard&&navigator.clipboard.writeText){
              navigator.clipboard.writeText(url).then(function(){
                btn.textContent='{t("common.copied")}';setTimeout(function(){btn.textContent='{t("common.copy")}';},1500);
              }).catch(function(){document.execCommand('copy');});
            }else{document.execCommand('copy');}
          });
        }
        setupCopy('copy-btn', 'webhook-url');
        setupCopy('copy-email-btn', 'email-url');
        
        var modeSelect = document.getElementById('settings-mode-select');
        var emailPrefixLabel = document.getElementById('settings-email-prefix');
        if (modeSelect && emailPrefixLabel) {
          modeSelect.addEventListener('change', function(e) {
            emailPrefixLabel.style.display = e.target.value === 'email' ? 'block' : 'none';
          });
        }
      })();`
    }} />
  </Layout>
);
