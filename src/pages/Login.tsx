import type { FC } from "hono/jsx";
import { Layout } from "./Layout";

type Props = {
  nextUrl?: string;
  email?: string | null;
  flashes?: { category: string; message: string }[];
};

export const LoginPage: FC<Props> = ({ nextUrl, email, flashes }) => (
  <Layout title="登录 — LinkedBot" email={email} flashes={flashes}>
    <div class="panel narrow">
      <h1 class="ds-section-title">登录</h1>
      <p class="ds-muted ds-small" style="margin-top:8px;">使用邮箱与密码进入控制台。</p>
      <form method="post" class="stack-form" style="margin-top:24px;">
        <input type="hidden" name="next" value={nextUrl ?? ""} />
        <label>邮箱
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" />
        </label>
        <label>密码
          <input type="password" name="password" required autocomplete="current-password" minlength={8} />
        </label>
        <button type="submit" class="btn primary">登录</button>
      </form>
      <p class="auth-foot">没有账号？<a href="/register">注册</a></p>
    </div>
  </Layout>
);
