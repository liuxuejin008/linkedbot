import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import type { ChannelRow, ChannelForwardRow, MessageRow } from "../types";

type DayStat = { date: string; count: number };
type TagStat = { tag: string; count: number };

type Props = {
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
  <Layout title={`${channel.name} — LinkedBot`} email={email} flashes={flashes}>
    <header class="page-head">
      <p class="breadcrumb">
        <a href="/dashboard">控制台</a> / <span aria-current="page">{channel.name}</span>
      </p>
      <div class="hero-row">
        <h1 class="ds-page-title">{channel.name}</h1>
        <span class="tag-pill" style="margin-left:12px;">{channel.mode}</span>
        <span class="badge" title="未读队列长度" style="margin-left:8px;">未读 {unseen}</span>
      </div>
      <p class="ds-muted ds-small" style="margin-top:12px;">
        频道 ID <code>#{channel.id}</code> · 模式 <code>{channel.mode}</code> · Webhook 与消息见下方。
      </p>
    </header>

    <section class="panel" aria-labelledby="webhook-title">
      <h2 class="ds-panel-title" id="webhook-title">Webhook</h2>
      <p class="ds-muted ds-small">向此 URL 发送 <code>POST</code>（JSON 或原始文本）。</p>
      <div class="copy-row" style="margin-top:16px;">
        <input id="webhook-url" class="mono-input" type="text" readonly value={webhookUrl} aria-label="Webhook URL" />
        <button type="button" class="btn" id="copy-btn">复制</button>
      </div>
      {channel.mode === "email" && channel.email_prefix && (
        <div class="copy-row" style="margin-top:12px;">
          <input id="email-url" class="mono-input" type="text" readonly value={`${channel.email_prefix}@linkedbot.io`} aria-label="Email Address" />
          <button type="button" class="btn" id="copy-email-btn">复制</button>
        </div>
      )}
      {channel.mode === "proxy" && (
        <p class="ds-muted ds-small" style="margin-top:8px;">
          Proxy 模式：外部请求将透传至本地 client，等待响应后返回给调用方。超时 25 秒返回 504。
        </p>
      )}
      {channel.mode === "sendbox" && (
        <p class="ds-muted ds-small" style="margin-top:8px;">
          Sendbox 模式：消息存入数据库，立即返回 <code>{channel.sendbox_response}</code>，再异步投递给 client。
        </p>
      )}
      {channel.mode === "email" && (
        <p class="ds-muted ds-small" style="margin-top:8px;">
          Email 模式：直接向专属邮箱发送邮件即可触发 Webhook，系统会自动解析邮件结构并异步投递。
        </p>
      )}
    </section>

    <section class="panel" aria-labelledby="curl-title">
      <h2 class="ds-panel-title" id="curl-title">示例 cURL</h2>
      <pre class="code-block" tabindex={0}>{curlExample}</pre>
    </section>

    {stats && (
      <section class="panel" aria-labelledby="stats-title">
        <h2 class="ds-panel-title" id="stats-title">统计（近 {stats.days} 天）</h2>
        <div class="stats-grid">
          <div class="stat-card">
            <span class="stat-value">{stats.total}</span>
            <span class="stat-label">消息总量</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">{stats.unread}</span>
            <span class="stat-label">当前未读</span>
          </div>
          {stats.forward_success_rate !== null && (
            <div class="stat-card">
              <span class="stat-value">{Math.round(stats.forward_success_rate * 100)}%</span>
              <span class="stat-label">转发成功率</span>
            </div>
          )}
        </div>

        {stats.by_day.length > 0 && (
          <div style="margin-top:20px;">
            <p class="ds-muted ds-small" style="margin-bottom:8px;">每日消息量</p>
            <div class="bar-chart" aria-label="每日消息量柱状图">
              {(() => {
                const max = Math.max(...stats.by_day.map((d) => d.count), 1);
                return stats.by_day.map((d) => (
                  <div class="bar-col" key={d.date} title={`${d.date}: ${d.count} 条`}>
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
            <p class="ds-muted ds-small" style="margin-bottom:8px;">标签分布</p>
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
      <h2 class="ds-panel-title" id="settings-title">设置</h2>
      <form method="post" action={`/channels/${channel.id}/settings`} class="stack-form">
        <label>名称
          <input type="text" name="name" value={channel.name} maxlength={128} required />
        </label>
        <label>模式
          <select id="settings-mode-select" name="mode">
            <option value="sendbox" selected={channel.mode === "sendbox"}>Sendbox</option>
            <option value="proxy" selected={channel.mode === "proxy"}>Proxy</option>
            <option value="email" selected={channel.mode === "email"}>Email</option>
          </select>
        </label>
        <label id="settings-email-prefix" style={{ display: channel.mode === "email" ? "block" : "none" }}>自定义邮箱前缀 (Email 模式专用)
          <input type="text" name="email_prefix" value={channel.email_prefix || ""} placeholder="例如：yhinhex" maxlength={64} pattern="^[a-z0-9_-]+$" title="只能包含小写字母、数字、下划线和连字符" />
        </label>
        {channel.mode === "sendbox" && (
          <label>Sendbox 响应 (JSON)
            <input type="text" name="sendbox_response" value={channel.sendbox_response} />
          </label>
        )}
        <button type="submit" class="btn primary">保存</button>
      </form>
      <form method="post" action={`/channels/${channel.id}/avatar`} enctype="multipart/form-data" class="stack-form mt">
        <label>头像（png / jpg / gif / webp）
          <input type="file" name="file" accept=".png,.jpg,.jpeg,.gif,.webp" />
        </label>
        <button type="submit" class="btn">上传头像</button>
      </form>
    </section>

    <section class="panel" aria-labelledby="forwards-title">
      <h2 class="ds-panel-title" id="forwards-title">转发目标</h2>
      <p class="ds-muted ds-small">
        收到 Webhook 后，消息将按顺序转发至以下地址。Python 客户端会自动同步此列表。
      </p>

      {forwards.length > 0 ? (
        <div class="table-wrap" style="margin-top:16px;">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">URL</th>
                <th scope="col">方法</th>
                <th scope="col">启用</th>
                <th scope="col">重试</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {forwards.map((fw) => (
                <tr key={fw.id}>
                  <td class="mono" style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title={fw.url}>{fw.url}</td>
                  <td>{fw.method}</td>
                  <td>{fw.enabled ? "是" : "否"}</td>
                  <td>{fw.retry_max}</td>
                  <td style="white-space:nowrap;">
                    <form method="post" action={`/channels/${channel.id}/forwards/${fw.id}/toggle`} style="display:inline;">
                      <button type="submit" class="btn btn-sm">{fw.enabled ? "禁用" : "启用"}</button>
                    </form>
                    {" "}
                    <form method="post" action={`/channels/${channel.id}/forwards/${fw.id}/delete`} style="display:inline;"
                      onsubmit="return confirm('确定删除此转发目标？')">
                      <button type="submit" class="btn btn-sm btn-danger">删除</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="ds-muted" style="margin-top:12px;">尚未配置转发目标。</p>
      )}

      <details style="margin-top:20px;">
        <summary class="ds-muted" style="cursor:pointer;font-weight:600;">添加转发目标</summary>
        <form method="post" action={`/channels/${channel.id}/forwards`} class="stack-form" style="margin-top:12px;">
          <label>转发 URL
            <input type="url" name="url" placeholder="http://localhost:9999/webhook" required />
          </label>
          <label>HTTP 方法
            <select name="method">
              <option value="GET">GET</option>
              <option value="POST" selected>POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
            </select>
          </label>
          <label>最大重试次数
            <input type="number" name="retry_max" value="3" min={0} max={10} />
          </label>
          <label>自定义请求头 (JSON, 可选)
            <input type="text" name="extra_headers" placeholder='{"Authorization":"Bearer xxx"}' />
          </label>
          <button type="submit" class="btn primary">添加</button>
        </form>
      </details>
    </section>

    <section class="panel" aria-labelledby="logs-link-title">
      <h2 class="ds-panel-title" id="logs-link-title">更多操作</h2>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;">
        <a class="btn" href={`/channels/${channel.id}/logs`}>转发记录</a>
        <a class="btn" href={`/channels/${channel.id}/members`}>成员管理</a>
      </div>
    </section>

    <section class="panel" aria-labelledby="consume-title">
      <h2 class="ds-panel-title" id="consume-title">消费未读队列</h2>
      <p class="ds-muted ds-small">
        从 D1 查询 <code>read_at IS NULL</code> 的消息并标记已读。
      </p>
      <form method="post" action={`/channels/${channel.id}/consume`} class="inline-create" style="margin-top:16px;">
        <label class="inline-label">条数
          <input type="number" name="limit" value="50" min={1} max={200} />
        </label>
        <button type="submit" class="btn primary">消费未读</button>
      </form>
    </section>

    <section class="panel" aria-labelledby="messages-title">
      <h2 class="ds-panel-title" id="messages-title">最近消息（最多 50 条）</h2>
      {messages.length === 0 ? (
        <p class="ds-muted">尚无消息。</p>
      ) : (
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">时间</th>
                <th scope="col">标签</th>
                <th scope="col">已读</th>
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
                    <td>{m.read_at ? "是" : "否"}</td>
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
                btn.textContent='已复制';setTimeout(function(){btn.textContent='复制';},1500);
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
