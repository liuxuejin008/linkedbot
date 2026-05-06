import type { FC } from "hono/jsx";
import type { Lang, TranslatorFunction } from "../i18n";
import { Layout } from "./Layout";

type Props = {
  lang: Lang;
  t: TranslatorFunction;
  email?: string | null;
  flashes?: { category: string; message: string }[];
};

export const RegisterPage: FC<Props> = ({ lang, t, email, flashes }) => (
  <Layout title={`${t("auth.registerTitle")} — LinkedBot`} email={email} flashes={flashes} lang={lang} t={t}>
    <div class="panel narrow">
      <h1 class="ds-section-title">{t("auth.registerTitle")}</h1>
      <p class="ds-muted ds-small" style="margin-top:8px;">{t("auth.registerManage")}</p>
      <form method="post" class="stack-form" style="margin-top:24px;">
        <label>{t("common.email")}
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" />
        </label>
        <label>{t("common.password")}{t("auth.passwordAtLeast")}
          <input type="password" name="password" required autocomplete="new-password" minlength={8} />
        </label>
        <label>{t("auth.confirmPassword")}
          <input type="password" name="password2" required autocomplete="new-password" minlength={8} />
        </label>
        <button type="submit" class="btn primary">{t("auth.createAccount")}</button>
      </form>
      <p class="auth-foot">{t("auth.alreadyHaveAccount")} <a href="/login">{t("common.login")}</a></p>
    </div>
  </Layout>
);
