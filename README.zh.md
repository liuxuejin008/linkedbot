# LinkedBot — 运行在 Cloudflare Workers 上的 Webhook 中继服务

LinkedBot 是一个运行在 Cloudflare Workers 上的 Webhook 服务器。它能接收外部系统的 HTTP 回调，并通过安全的长连接将请求中继给防火墙或 NAT 后面的本地客户端——客户端无需公网 IP。

**典型使用场景：**
- 本地开发时调试微信支付、支付宝等支付回调
- 接收来自 GitHub、Vercel、飞书、钉钉、Telegram、Slack、Discord 等系统的 Webhook
- 将外部事件桥接到本地的自动化工具，如 Dify、N8N
- 为 AI Agent 构建统一消息中心

> 📖 [English Documentation → README.md](./README.md)

---

## 工作原理

LinkedBot 的核心单元是 **Channel（频道）**，支持两种工作模式：

| 模式 | 行为说明 |
|------|---------|
| **代理模式 (Proxy)** | 外部 Webhook 到达后，实时中继给本地客户端，等待处理结果后同步返回给外部调用方。 |
| **邮箱模式 (Mailbox)** | 外部 Webhook 到达后，立即将消息存入 D1 数据库并向调用方返回预设响应，随后异步投递给本地客户端。 |

**ChannelClient** 运行在你的本地机器上，通过持久化 SSE 连接与 ChannelServer 保持通信，并将收到的事件转发给本地的 Webhook 接收端（如 `localhost:9999/webhook`）。

---

## 架构技术栈

| 层级 | 技术选型 |
|------|---------|
| 运行时 | Cloudflare Workers（TypeScript，Hono） |
| 数据库 | D1（SQLite） |
| 文件存储 | R2 |
| 消息队列 | Cloudflare Queues |
| 认证 | JWT（Web Crypto HMAC-SHA256）+ 签名 Cookie 会话 |
| 密码哈希 | bcryptjs |
| 前端 UI | React（Vite，客户端 SPA） |

---

## 环境要求

- Node.js 18+
- Cloudflare 账号（免费套餐即可）
- Wrangler CLI（`npm install -g wrangler` 或使用 `npx`）

---

## 本地开发快速上手

1. **安装依赖：**

```bash
npm install
```

2. **创建本地 D1 数据库并执行迁移脚本：**

```bash
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql
# 依次执行 0002 ... 0005
```

3. **创建 `.dev.vars` 文件并配置密钥：**

```
SECRET_KEY=local-dev-secret-change-me
JWT_SECRET=local-dev-jwt-secret-change-me
```

4. **启动开发服务器：**

```bash
npm run dev
```

打开 `http://localhost:8787` 进入 Web 界面，注册账号、创建 Channel、发送测试 Webhook。

---

## 部署到 Cloudflare

### 方式 A：自动化初始化脚本（推荐）

```bash
bash init-cloudflare.sh
```

脚本将自动创建 D1 数据库、R2 存储桶、KV 命名空间和 Cloudflare 队列。按照脚本输出的提示，将生成的 ID 填入 `wrangler.jsonc`。

### 方式 B：手动逐步操作

1. **创建 D1 数据库：**

```bash
npx wrangler d1 create linkedbot
```

将输出的 `database_id` 填入 `wrangler.jsonc` → `d1_databases[0].database_id`。

2. **创建 R2 存储桶：**

```bash
npx wrangler r2 bucket create images
```

3. **创建 KV 命名空间：**

```bash
npx wrangler kv namespace create "linkedbot-sse"
```

将输出的 `id` 填入 `wrangler.jsonc` → `kv_namespaces[0].id`。

4. **创建消息队列：**

```bash
npx wrangler queues create linkedbot-mailbox
npx wrangler queues create linkedbot-dlq
```

5. **执行 D1 数据库迁移：**

```bash
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0001_initial.sql
# 依次执行 0002 ... 0005
```

6. **设置密钥：**

```bash
npx wrangler secret put SECRET_KEY
npx wrangler secret put JWT_SECRET
```

7. **更新 `wrangler.jsonc`** 中的 `PUBLIC_BASE_URL` 为你的 Worker 地址（如 `https://linkedbot.<subdomain>.workers.dev`）。

8. **部署：**

```bash
npm run deploy
```

---

## API 接口一览

| 方法 | 路径 | 认证方式 |
|------|------|---------|
| POST | `/api/auth/register` | 无 |
| POST | `/api/auth/login` | 无 |
| POST | `/api/channels` | Bearer JWT |
| GET | `/api/channels` | Bearer JWT |
| PATCH | `/api/channels/:id` | Bearer JWT |
| POST | `/w/:webhook_secret` | 无（secret 在路径中） |
| GET | `/api/channels/:id/messages` | Bearer JWT |
| GET | `/api/sse/:channel_id` | Bearer JWT（SSE 流） |
| POST | `/api/callback` | Bearer JWT |

---

## 项目结构

```
src/
  index.tsx               Hono 入口
  types.ts                环境绑定、数据库行类型定义
  lib/
    crypto.ts             bcryptjs + Web Crypto JWT
    helpers.ts            通用工具函数
  middleware/
    jwt.ts                API 路由的 Bearer JWT 鉴权
    session.ts            UI 的签名 Cookie 会话
  routes/
    auth.ts               POST /api/auth/register, /login
    channels.ts           CRUD /api/channels
    webhook.ts            POST /w/:secret（代理模式 & 邮箱模式入口）
    sse.ts                GET /api/sse/:channel_id
    callback.ts           POST /api/callback
    ui.tsx                服务端渲染外壳
  pages/
    Layout.tsx            基础 HTML 框架
    Login.tsx             登录表单
    Register.tsx          注册表单
    Dashboard.tsx         Channel 列表
    ChannelDetail.tsx     Channel 详情 + 消息历史
migrations/d1/
  0001_initial.sql
  0002_...sql
  0003_...sql
  0004_...sql
  0005_rename_sendbox_to_mailbox.sql
```

---

## 示例：通过 curl 拉取消息

调用 `POST /api/auth/login` 后，使用返回的 `access_token` 和你的 Channel ID：

```bash
API_BASE="https://linkedbot.<subdomain>.workers.dev"
TOKEN="eyJ..."          # 登录返回的 access_token
CHANNEL_ID=1

curl -sS "$API_BASE/api/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 免费套餐限额

| 资源 | 免费额度 | 本应用使用情况 |
|------|---------|--------------|
| Workers 请求数 | 10万/天 | 远低于上限 |
| D1 读取行数 | 500万/天 | 每次请求约 1–5 行 |
| D1 写入行数 | 10万/天 | 仅在 Webhook / 注册 / 拉取时写入 |
| D1 存储 | 5 GB | 消息体以 TEXT 存储 |
| R2 操作数 | 1000万/月 | 头像上传与读取 |
| R2 存储 | 10 GB | 头像图片 |
| Queues 消息数 | 100万/月 | 邮箱模式异步投递 |

---

## 延伸阅读

- [DEPLOY.md](./DEPLOY.md) — 完整部署步骤与配置参考
- [PRD.md](./PRD.md) — 产品需求文档与架构图（中英双语）
- [README.md](./README.md) — English Documentation
