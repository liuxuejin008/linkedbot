import type { FC } from "hono/jsx";
import type { Lang, TranslatorFunction } from "../i18n";

type Props = {
  lang: Lang;
  t: TranslatorFunction;
  title?: string;
  email?: string | null;
  flashes?: { category: string; message: string }[];
  children: unknown;
};

export const Layout: FC<Props> = ({ lang, t, title, email, flashes, children }) => (
  <html lang={lang}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ?? "LinkedBot"}</title>
      <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin="" />
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <header class="topbar">
        <div class="topbar-inner">
          <a class="brand" href="/">LinkedBot</a>
          <div style={{ marginLeft: "auto", marginRight: "1rem" }}>
            <a href={`/set-lang?lang=${t("lang.switchTo")}&next=/dashboard`} style={{ fontSize: "14px", color: "var(--text-muted)", textDecoration: "none" }}>{t("lang.switch")}</a>
          </div>
          <nav class="nav" aria-label={t("common.dashboard")}>
            {email ? (
              <>
                <span class="nav-email" title={email}>{email}</span>
                <a class="nav-link" href="/dashboard">{t("common.dashboard")}</a>
                <form class="inline-form" action="/logout" method="post">
                  <button type="submit" class="btn-text">{t("common.logout")}</button>
                </form>
              </>
            ) : (
              <div class="nav-actions">
                <a class="btn compact" href="/login">{t("common.login")}</a>
                <a class="btn primary compact" href="/register">{t("common.register")}</a>
              </div>
            )}
          </nav>
        </div>
      </header>
      <main class="main">
        <div class="container">
          {flashes && flashes.length > 0 && (
            <ul class="flashes">
              {flashes.map((f, i) => (
                <li key={i} class={`flash flash-${f.category}`}>{f.message}</li>
              ))}
            </ul>
          )}
          {children}
        </div>
      </main>
    </body>
  </html>
);
