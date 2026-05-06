import type { FC } from "hono/jsx";
import type { Lang, TranslatorFunction } from "../i18n";
import { Layout } from "./Layout";
import type { ChannelRow } from "../types";

type Card = {
  channel: ChannelRow;
  webhookUrl: string;
  unseen: number;
};

type Props = {
  lang: Lang;
  t: TranslatorFunction;
  email: string;
  cards: Card[];
  flashes?: { category: string; message: string }[];
};

export const DashboardPage: FC<Props> = ({ lang, t, email, cards, flashes }) => (
  <Layout title={`${t("common.dashboard")} — LinkedBot`} email={email} flashes={flashes} lang={lang} t={t}>
    <header class="page-head">
      <h1 class="ds-page-title">{t("dashboard.title")}</h1>
      <p class="ds-lead">{t("dashboard.desc")}</p>
    </header>

    <section class="panel" aria-labelledby="create-channel-title">
      <h2 class="ds-panel-title" id="create-channel-title">{t("dashboard.newChannel")}</h2>
      <p class="ds-muted ds-small">{t("dashboard.newChannelDesc")}</p>
      <form method="post" action="/dashboard" class="inline-create" style="margin-top:16px;">
        <input type="text" name="name" placeholder={t("dashboard.channelNamePlaceholder")} maxlength={128} required aria-label={t("common.name")} />
        <select id="create-mode-select" name="mode" aria-label={t("common.mode")} style="margin-left:8px;">
          <option value="mailbox">Mailbox</option>
          <option value="proxy">Proxy</option>
          <option value="email">Email</option>
        </select>
        <input id="create-email-prefix" type="text" name="email_prefix" placeholder={t("dashboard.emailPrefixPlaceholder")} maxlength={64} aria-label={t("common.email")} style="display:none; margin-left:8px; width:160px;" pattern="^[a-z0-9_-]+$" title={t("dashboard.emailPrefixPatternTitle")} />
        <button type="submit" class="btn primary" style="margin-left:8px;">{t("dashboard.create")}</button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: `
        document.getElementById('create-mode-select').addEventListener('change', function(e) {
          var prefix = document.getElementById('create-email-prefix');
          if (e.target.value === 'email') {
            prefix.style.display = 'inline-block';
          } else {
            prefix.style.display = 'none';
            prefix.value = '';
          }
        });
      `}} />
    </section>

    {cards.length === 0 ? (
      <p class="empty-hint">{t("dashboard.empty")}</p>
    ) : (
      <ul class="channel-grid">
        {cards.map((item) => {
          const ch = item.channel;
          return (
            <li key={ch.id} class="channel-card">
              <a class="channel-card-link" href={`/channels/${ch.id}`}>
                <div class="channel-card-head">
                  {ch.avatar_url ? (
                    <img src={ch.avatar_url} alt="" class="avatar" width={48} height={48} />
                  ) : (
                    <div class="avatar placeholder" aria-hidden="true">{ch.name.charAt(0)}</div>
                  )}
                  <div>
                    <div class="channel-name">{ch.name}</div>
                    <div class="channel-meta">
                      <span class="mono-label" style="display:inline;margin-right:8px;">#{ch.id}</span>
                      <span class="tag-pill" style="margin-right:8px;">{ch.mode}</span>
                      {t("dashboard.queueUnread")}
                      <span class="badge" style="margin-left:8px;vertical-align:middle;">{item.unseen}</span>
                    </div>
                  </div>
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    )}
  </Layout>
);
