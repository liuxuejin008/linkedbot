import type { FC } from "hono/jsx";

type Props = {
  title?: string;
  email?: string | null;
  flashes?: { category: string; message: string }[];
  children: unknown;
};

export const Layout: FC<Props> = ({ title, email, flashes, children }) => (
  <html lang="zh-CN">
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
          <nav class="nav" aria-label="主导航">
            {email ? (
              <>
                <span class="nav-email" title={email}>{email}</span>
                <a class="nav-link" href="/dashboard">控制台</a>
                <form class="inline-form" action="/logout" method="post">
                  <button type="submit" class="btn-text">退出</button>
                </form>
              </>
            ) : (
              <div class="nav-actions">
                <a class="btn compact" href="/login">登录</a>
                <a class="btn primary compact" href="/register">注册</a>
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
