# LinkedBot — webhook inbox on Cloudflare Workers

LinkedBot是一个运行在服务端，例如Cloudflare的webhook服务器，可以用来接受其他系统的消息，比如其他系统的webhook信息，
1.处理 QQ、微信、企微、公众号、飞书、Telegram、Discord、Slack、钉钉等各类即时通信消息
2.监听 Gmail 邮件推送通知
3.基于 Telegram Bot API 接收消息更新，触发自动化流程。
4.监听 GitHub 仓库事件（如 push、issue、PR）并触发工作流
5.vercel的webhook
等等场景，目标是做一个给Agent使用的统一消息中心。

LinkedBot是server端，LinkedBotClient是客户端。客户端要跑在普通的PC上，和LinkedBot是server的连接。

当Botmsg收到信息的时候，LinkedBotClient通过长连接或者轮训给接受消息，LinkedBotClient再调用本地的类似Dify，N8N的webhook地址，这样Dify，N8N这些跑在本地机器但是没有公网IP的程序就可以收到外部信息，而且安全性也更好，而且LinkedBot能保存信息，保证信息不会丢。


A Telegram-style bot host: a **public URL** receives HTTP webhooks, stores payloads in **D1** (SQLite); a **local client** polls with JWT to fetch unread messages. Avatars stored in **R2**. The entire stack runs on Cloudflare's free tier (100,000 requests/day).

## Architecture

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (TypeScript, Hono) |
| Database | D1 (SQLite) |
| File storage | R2 |
| Auth | JWT (Web Crypto HMAC-SHA256) + signed cookie sessions |
| Password hashing | bcryptjs |
| UI | Server-rendered Hono JSX |

## Prerequisites

- Node.js 18+
- A Cloudflare account (free plan works)
- Wrangler CLI (`npm install -g wrangler` or use `npx`)

## Quick start (local dev)

1. Install dependencies:

```bash
npm install
```

2. Create a local D1 database and apply the schema:

```bash
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql
```

3. Create a `.dev.vars` file with secrets for local dev:

```
SECRET_KEY=local-dev-secret-change-me
JWT_SECRET=local-dev-jwt-secret-change-me
```

4. Start the dev server:

```bash
npm run dev
```

Open `http://localhost:8787` to access the web UI. Register, create a bot, send webhooks, pull messages.

## Deploy to Cloudflare

1. Create a D1 database:

```bash
npx wrangler d1 create linkedbot
```

Copy the `database_id` from the output into `wrangler.jsonc` under `d1_databases[0].database_id`.

2. Create an R2 bucket:

```bash
npx wrangler r2 bucket create linkedbot-avatars
```

3. Apply the D1 schema to production:

```bash
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0001_initial.sql
```

4. Set secrets:

```bash
npx wrangler secret put SECRET_KEY
npx wrangler secret put JWT_SECRET
```

5. Update `PUBLIC_BASE_URL` in `wrangler.jsonc` to your Worker's URL (e.g. `https://linkedbot.<subdomain>.workers.dev`).

6. Deploy:

```bash
npm run deploy
```

## API overview

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/auth/register` | none |
| POST | `/api/auth/login` | none |
| POST | `/api/bots` | Bearer JWT |
| GET | `/api/bots` | Bearer JWT |
| PATCH | `/api/bots/:id` | Bearer JWT |
| POST | `/api/bots/:id/avatar` | Bearer JWT (multipart) |
| POST | `/w/:webhook_secret` | none (secret in path) |
| GET | `/api/bots/:id/messages/pull?limit=50` | Bearer JWT |
| GET | `/api/bots/:id/messages?cursor=` | Bearer JWT |

## Web UI

Open the Worker URL in a browser. Register, log in (cookie session), create bots, view webhook URLs, consume unread messages — same functionality as the API.

## Free tier limits

| Resource | Free allowance | This app's usage |
|----------|---------------|-----------------|
| Workers requests | 100K/day | Well within limits |
| D1 rows read | 5M/day | ~1-5 per request |
| D1 rows written | 100K/day | Only on webhook/register/pull |
| D1 storage | 5 GB | Message payloads as TEXT |
| R2 ops | 10M/month | Avatar uploads + reads |
| R2 storage | 10 GB | Avatar images |

## Project structure

```
src/
  index.tsx           Hono entry point
  types.ts            Env bindings, DB row types
  lib/
    crypto.ts         bcryptjs + Web Crypto JWT
    helpers.ts        Utility functions
  middleware/
    jwt.ts            Bearer JWT auth for API routes
    session.ts        Signed cookie sessions for UI
  routes/
    auth.ts           POST /api/auth/register, /login
    bots.ts           CRUD /api/bots + avatar upload to R2
    webhook.ts        POST /w/:secret
    sync.ts           Pull unread + message history
    ui.tsx            Server-rendered UI pages
  pages/
    Layout.tsx        Base HTML shell
    Login.tsx         Login form
    Register.tsx      Registration form
    Dashboard.tsx     Bot grid
    BotDetail.tsx     Bot detail + messages table
public/
  style.css           Geist design system CSS
migrations/d1/
  0001_initial.sql    D1 schema
```

## Example: pull unread messages (curl)

After `POST /api/auth/login`, use the returned `access_token` and your bot id:

```bash
API_BASE="http://localhost:8787"   # or your Worker URL
TOKEN="eyJ..."                       # access_token from login
BOT_ID=1

curl -sS "$API_BASE/api/bots/$BOT_ID/messages/pull?limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

See [DEPLOY.md](./DEPLOY.md) for full deployment steps and API details.
# linkedbot
