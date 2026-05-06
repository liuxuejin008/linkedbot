import type { FC } from "hono/jsx";
import type { Lang, TranslatorFunction } from "../i18n";
import { Layout } from "./Layout";

type Props = {
  lang: Lang;
  t: TranslatorFunction;
  nextUrl?: string;
  email?: string | null;
  flashes?: { category: string; message: string }[];
};

export const LoginPage: FC<Props> = ({ lang, t, nextUrl, email, flashes }) => (
  <Layout title={`${t("auth.loginTitle")} — LinkedBot`} email={email} flashes={flashes} lang={lang} t={t}>
    <div class="panel narrow">
      <h1 class="ds-section-title">{t("auth.loginTitle")}</h1>
      <p class="ds-muted ds-small" style="margin-top:8px;">{t("auth.loginDesc")}</p>
      <form method="post" class="stack-form" style="margin-top:24px;">
        <input type="hidden" name="next" value={nextUrl ?? ""} />
        <label>{t("common.email")}
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" />
        </label>
        <label>{t("common.password")}
          <input type="password" name="password" required autocomplete="current-password" minlength={8} />
        </label>
        <button type="submit" class="btn primary">{t("common.login")}</button>
      </form>
      <p class="auth-foot">{t("auth.noAccount")} <a href="/register">{t("common.register")}</a></p>
    </div>
  </Layout>
);
