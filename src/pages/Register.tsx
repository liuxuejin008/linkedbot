import type { FC } from "hono/jsx";
import { Layout } from "./Layout";

type Props = {
  email?: string | null;
  flashes?: { category: string; message: string }[];
};

export const RegisterPage: FC<Props> = ({ email, flashes }) => (
  <Layout title="注册 — LinkedBot" email={email} flashes={flashes}>
    <div class="panel narrow">
      <h1 class="ds-section-title">注册</h1>
      <p class="ds-muted ds-small" style="margin-top:8px;">创建账号后即可管理 Webhook 机器人。</p>
      <form method="post" class="stack-form" style="margin-top:24px;">
        <label>邮箱
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" />
        </label>
        <label>密码（至少 8 位）
          <input type="password" name="password" required autocomplete="new-password" minlength={8} />
        </label>
        <label>确认密码
          <input type="password" name="password2" required autocomplete="new-password" minlength={8} />
        </label>
        <button type="submit" class="btn primary">创建账号</button>
      </form>
      <p class="auth-foot">已有账号？<a href="/login">登录</a></p>
    </div>
  </Layout>
);
