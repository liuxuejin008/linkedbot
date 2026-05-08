# LinkedBot — Webhook Relay on Cloudflare Workers

LinkedBot is a webhook server running on Cloudflare Workers. It receives HTTP callbacks from external systems and relays them securely to local clients behind a firewall or NAT — no public IP required on the client side.

**Typical use cases:**
- Payment callbacks (WeChat Pay, Alipay) during local development
- Receiving webhooks from GitHub, Vercel, Feishu, DingTalk, Telegram, Slack, Discord, etc.
- Bridging external events to local automation tools like Dify or N8N
- Building a unified message hub for AI Agents

> 📖 [中文文档 → README.zh.md](./README.zh.md)

---

## How It Works

LinkedBot introduces a **Channel** object with two operating modes:

| Mode | Behaviour |
|------|-----------|
| **Proxy** | Incoming webhook is relayed in real-time to the local client and the response is returned synchronously to the caller. |
| **Mailbox** | Incoming webhook is stored in D1 immediately and a preset response is returned to the caller. The payload is then delivered asynchronously to the local client. |

The **ChannelClient** runs on your local machine, maintains a persistent SSE connection to the ChannelServer, and forwards received events to a local webhook receiver (e.g. `localhost:9999/webhook`).

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (TypeScript, Hono) |
| Database | D1 (SQLite) |
| File storage | R2 |
| Message queue | Cloudflare Queues |
| Auth | JWT (Web Crypto HMAC-SHA256) + signed cookie sessions |
| Password hashing | bcryptjs |
| UI | React (Vite, client-side SPA) |

---

## Prerequisites

- Node.js 18+
- A Cloudflare account (free plan works)
- Wrangler CLI (`npm install -g wrangler` or use `npx`)

---

## Quick Start (Local Dev)

1. **Install dependencies:**

```bash
npm install
```

2. **Create a local D1 database and apply migrations:**

```bash
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql
# repeat for 0002 ... 0005 in order
```

3. **Create a `.dev.vars` file with secrets:**

```
SECRET_KEY=local-dev-secret-change-me
JWT_SECRET=local-dev-jwt-secret-change-me
```

4. **Start the dev server:**

```bash
npm run dev
```

Open `http://localhost:8787` to access the web UI. Register, create a channel, and send test webhooks.

---

## Deploy to Cloudflare

### Option A: Automated Init Script

```bash
bash init-cloudflare.sh
```

This creates the D1 database, R2 bucket, KV namespace, and Cloudflare Queues in one step. Follow the on-screen instructions to copy IDs into `wrangler.jsonc`.

### Option B: Manual Steps

1. **Create D1 database:**

```bash
npx wrangler d1 create linkedbot
```

Copy the `database_id` into `wrangler.jsonc` → `d1_databases[0].database_id`.

2. **Create R2 bucket:**

```bash
npx wrangler r2 bucket create images
```

3. **Create KV namespace:**

```bash
npx wrangler kv namespace create "linkedbot-sse"
```

Copy the `id` into `wrangler.jsonc` → `kv_namespaces[0].id`.

4. **Create Queues:**

```bash
npx wrangler queues create linkedbot-mailbox
npx wrangler queues create linkedbot-dlq
```

5. **Apply D1 migrations:**

```bash
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0001_initial.sql
# repeat for 0002 ... 0005 in order
```

6. **Set secrets:**

```bash
npx wrangler secret put SECRET_KEY
npx wrangler secret put JWT_SECRET
```

7. **Update `PUBLIC_BASE_URL`** in `wrangler.jsonc` to your Worker's URL (e.g. `https://linkedbot.<subdomain>.workers.dev`).

8. **Deploy:**

```bash
npm run deploy
```

---

## API Overview

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/auth/register` | none |
| POST | `/api/auth/login` | none |
| POST | `/api/channels` | Bearer JWT |
| GET | `/api/channels` | Bearer JWT |
| PATCH | `/api/channels/:id` | Bearer JWT |
| POST | `/w/:webhook_secret` | none (secret in path) |
| GET | `/api/channels/:id/messages` | Bearer JWT |
| GET | `/api/sse/:channel_id` | Bearer JWT (SSE stream) |
| POST | `/api/callback` | Bearer JWT |

---

## Project Structure

```
src/
  index.tsx               Hono entry point
  types.ts                Env bindings, DB row types
  lib/
    crypto.ts             bcryptjs + Web Crypto JWT
    helpers.ts            Utility functions
  middleware/
    jwt.ts                Bearer JWT auth for API routes
    session.ts            Signed cookie sessions for UI
  routes/
    auth.ts               POST /api/auth/register, /login
    channels.ts           CRUD /api/channels
    webhook.ts            POST /w/:secret  (Proxy & Mailbox entry)
    sse.ts                GET /api/sse/:channel_id
    callback.ts           POST /api/callback
    ui.tsx                Server-rendered shell
  pages/
    Layout.tsx            Base HTML shell
    Login.tsx             Login form
    Register.tsx          Registration form
    Dashboard.tsx         Channel grid
    ChannelDetail.tsx     Channel detail + message history
migrations/d1/
  0001_initial.sql
  0002_...sql
  0003_...sql
  0004_...sql
  0005_rename_sendbox_to_mailbox.sql
```

---

## Example: Pull Messages (curl)

After `POST /api/auth/login`, use the returned `access_token` and your channel ID:

```bash
API_BASE="https://linkedbot.<subdomain>.workers.dev"
TOKEN="eyJ..."          # access_token from login
CHANNEL_ID=1

curl -sS "$API_BASE/api/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Free Tier Limits

| Resource | Free Allowance | This App's Usage |
|----------|---------------|-----------------|
| Workers requests | 100K/day | Well within limits |
| D1 rows read | 5M/day | ~1–5 per request |
| D1 rows written | 100K/day | On webhook / register / pull |
| D1 storage | 5 GB | Message payloads as TEXT |
| R2 ops | 10M/month | Avatar uploads + reads |
| R2 storage | 10 GB | Avatar images |
| Queues messages | 1M/month | Mailbox mode deliveries |

---

## Further Reading

- [DEPLOY.md](./DEPLOY.md) — Full deployment steps and configuration reference
- [PRD.md](./PRD.md) — Product requirements and architecture diagrams (bilingual)
- [README.zh.md](./README.zh.md) — 中文文档
