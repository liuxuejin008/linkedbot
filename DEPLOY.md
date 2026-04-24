# LinkedBot 部署文档 — Cloudflare Workers

本文档覆盖从零到生产的完整部署流程，包括本地开发、首次上线、日常运维、故障排查。

---

## 目录

1. [架构总览](#1-架构总览)
2. [环境要求](#2-环境要求)
3. [本地开发](#3-本地开发)
4. [生产部署](#4-生产部署)
5. [环境变量与密钥](#5-环境变量与密钥)
6. [数据库管理 (D1)](#6-数据库管理-d1)
7. [对象存储 (R2)](#7-对象存储-r2)
8. [自定义域名](#8-自定义域名)
9. [监控与日志](#9-监控与日志)
10. [安全加固](#10-安全加固)
11. [CI/CD 自动化](#11-cicd-自动化)
12. [免费层额度](#12-免费层额度)
13. [故障排查](#13-故障排查)
14. [API 速查](#14-api-速查)

---

## 1. 架构总览

```
客户端 (浏览器 / API 调用者 / Webhook 发送方)
         │
         ▼
┌─────────────────────────────────┐
│  Cloudflare Workers (Edge)      │
│  ┌───────────────────────────┐  │
│  │ Hono (TypeScript)         │  │
│  │  ├── /api/*   REST API    │  │
│  │  ├── /w/*     Webhook     │  │
│  │  ├── /*       Web UI      │  │
│  │  └── /avatars/* R2 代理   │  │
│  └───────────────────────────┘  │
│         │           │           │
│    ┌────▼────┐ ┌────▼────┐     │
│    │ D1      │ │ R2      │     │
│    │ (SQLite)│ │ (Bucket)│     │
│    └─────────┘ └─────────┘     │
└─────────────────────────────────┘
```

| 组件 | 用途 | Cloudflare 产品 |
|------|------|----------------|
| 应用逻辑 | HTTP 路由、业务处理、SSR 页面 | **Workers** |
| 关系型数据 | 用户、机器人、消息 | **D1** (SQLite) |
| 文件存储 | 头像图片 | **R2** |
| 静态资源 | CSS、字体 | **Workers Assets** (public/) |
| 密钥管理 | SECRET_KEY, JWT_SECRET | **Workers Secrets** |

---

## 2. 环境要求

### 必需

| 工具 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 18.0+ | Wrangler 运行时 |
| npm | 9.0+ | 随 Node.js 安装 |
| Wrangler CLI | 4.0+ | `npm install -g wrangler` 或 `npx wrangler` |

### Cloudflare 账号

- 注册地址：https://dash.cloudflare.com/sign-up
- **免费计划即可**，无需信用卡（Workers Free, D1 Free, R2 Free 各有免费额度）
- 首次使用 Wrangler 需执行 `npx wrangler login` 完成 OAuth 授权

### 验证环境

```bash
node --version    # >= 18.0.0
npm --version     # >= 9.0.0
npx wrangler --version  # >= 4.0.0
```

---

## 3. 本地开发

### 3.1 安装依赖

```bash
git clone <repo-url> linkedbot
cd linkedbot
npm install
```

### 3.2 初始化本地 D1

Wrangler 自动创建本地 SQLite 文件（`.wrangler/state/`），无需安装数据库：

```bash
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql
```

验证：

```bash
npx wrangler d1 execute linkedbot --local --command="SELECT name FROM sqlite_master WHERE type='table';"
```

预期输出包含 `users`、`bots`、`messages`。

### 3.3 配置本地密钥

创建 `.dev.vars` 文件（已在 `.gitignore` 中，不会提交）：

```bash
cat > .dev.vars << 'EOF'
SECRET_KEY=local-dev-secret-change-me-32chars-min
JWT_SECRET=local-dev-jwt-secret-change-me
EOF
```

### 3.4 启动开发服务器

```bash
npm run dev
```

默认监听 `http://localhost:8787`。Wrangler 提供：
- 本地 D1（SQLite 文件）
- 本地 R2（文件系统模拟）
- 热重载（修改 `src/` 后自动重启）

### 3.5 冒烟测试

```bash
# 健康检查
curl http://localhost:8787/health
# 预期: {"status":"ok"}

# 注册用户
curl -X POST http://localhost:8787/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test1234"}'
# 预期: {"user_id":1,"email":"test@example.com","access_token":"eyJ..."}

# 创建机器人（用上一步返回的 token）
curl -X POST http://localhost:8787/api/bots \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"TestBot"}'
# 预期: {"id":1,"name":"TestBot","webhook_url":"...","webhook_secret":"..."}
```

或直接在浏览器打开 `http://localhost:8787` 使用 Web UI。

---

## 4. 生产部署

### 4.1 创建 Cloudflare 资源

**D1 数据库：**

```bash
npx wrangler d1 create linkedbot
```

输出示例：

```
✅ Successfully created DB 'linkedbot'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

将 `database_id` 填入 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "linkedbot",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  // ← 替换这里
  }
]
```

**R2 存储桶：**

```bash
npx wrangler r2 bucket create linkedbot-avatars
```

### 4.2 应用数据库 Schema

```bash
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0001_initial.sql
```

验证：

```bash
npx wrangler d1 execute linkedbot --remote --command="SELECT name FROM sqlite_master WHERE type='table';"
```

### 4.3 设置生产密钥

```bash
npx wrangler secret put SECRET_KEY
# 提示输入时，粘贴一个 32+ 字符的随机字符串

npx wrangler secret put JWT_SECRET
# 提示输入时，粘贴另一个 32+ 字符的随机字符串
```

生成强随机密钥的方式：

```bash
# macOS / Linux
openssl rand -base64 32

# 或 Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 4.4 配置 PUBLIC_BASE_URL

在 `wrangler.jsonc` 中将 `PUBLIC_BASE_URL` 改为你的实际 Worker URL：

```jsonc
"vars": {
  "PUBLIC_BASE_URL": "https://linkedbot.<your-subdomain>.workers.dev",
  "JWT_EXPIRES_HOURS": "24"
}
```

如果使用自定义域名，填写自定义域名（见[第 8 节](#8-自定义域名)）。

### 4.5 部署

```bash
npm run deploy
```

输出示例：

```
⛅️ wrangler
Total Upload: ~170 KiB / gzip: ~43 KiB
Uploaded linkedbot
Published linkedbot
  https://linkedbot.<subdomain>.workers.dev
```

### 4.6 部署后验证

```bash
WORKER_URL="https://linkedbot.<subdomain>.workers.dev"

# 健康检查
curl $WORKER_URL/health

# 注册 + 登录
curl -X POST $WORKER_URL/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"secure-password-here"}'

# 浏览器访问 Web UI
open $WORKER_URL
```

---

## 5. 环境变量与密钥

### 变量分类

| 名称 | 类型 | 存储位置 | 说明 |
|------|------|---------|------|
| `PUBLIC_BASE_URL` | var | `wrangler.jsonc` | Worker 对外 HTTPS 基址（无尾部 `/`） |
| `JWT_EXPIRES_HOURS` | var | `wrangler.jsonc` | JWT 过期时间（小时），默认 `24` |
| `SECRET_KEY` | **secret** | `wrangler secret put` | Cookie 签名密钥，不可泄露 |
| `JWT_SECRET` | **secret** | `wrangler secret put` | JWT 签名密钥，不可泄露 |

### 绑定资源

| 名称 | 类型 | 说明 |
|------|------|------|
| `DB` | D1 Database | 用户、机器人、消息数据 |
| `AVATARS` | R2 Bucket | 头像图片存储 |

### 查看已设置的密钥

```bash
npx wrangler secret list
```

### 更新密钥

```bash
npx wrangler secret put SECRET_KEY
# 输入新值后，Worker 下次请求自动生效（无需重新部署）
```

> **注意**：更换 `SECRET_KEY` 会使所有现有登录会话失效（cookie 签名不匹配）。更换 `JWT_SECRET` 会使所有已发 JWT 失效。

---

## 6. 数据库管理 (D1)

### 查看数据库信息

```bash
npx wrangler d1 info linkedbot
```

### 执行 SQL 查询

```bash
# 生产
npx wrangler d1 execute linkedbot --remote --command="SELECT COUNT(*) FROM users;"

# 本地
npx wrangler d1 execute linkedbot --local --command="SELECT COUNT(*) FROM messages;"
```

### 新增迁移

1. 在 `migrations/d1/` 下创建新 SQL 文件（按编号递增）：

```bash
# 示例：添加一个新列
cat > migrations/d1/0002_add_bot_description.sql << 'EOF'
ALTER TABLE bots ADD COLUMN description TEXT;
EOF
```

2. 先在本地测试：

```bash
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0002_add_bot_description.sql
```

3. 应用到生产：

```bash
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0002_add_bot_description.sql
```

### 数据导出

```bash
npx wrangler d1 export linkedbot --remote --output=backup.sql
```

### D1 限制

| 限制项 | 值 |
|--------|-----|
| 单库大小 | 10 GB |
| 单行大小 | 100 KB (建议) |
| 单次查询结果 | 100 MB |
| 批量操作 | 100 条语句 / batch |
| 免费读行 | 5M / 天 |
| 免费写行 | 100K / 天 |
| 免费存储 | 5 GB |

---

## 7. 对象存储 (R2)

### 查看桶信息

```bash
npx wrangler r2 bucket list
```

### 列出对象

```bash
npx wrangler r2 object list linkedbot-avatars
```

### 手动上传/下载

```bash
# 上传
npx wrangler r2 object put linkedbot-avatars/test.png --file=./test.png

# 下载
npx wrangler r2 object get linkedbot-avatars/test.png --file=./downloaded.png
```

### 清理孤立头像

如果数据库中的 `avatar_url` 被更新，旧的 R2 对象不会自动删除。可定期清理：

```bash
# 列出所有 R2 key
npx wrangler r2 object list linkedbot-avatars --json | jq '.[].key'

# 与数据库中的 avatar_url 对比后，手动删除孤立对象
npx wrangler r2 object delete linkedbot-avatars/<orphan-key>
```

### R2 限制

| 限制项 | 免费额度 |
|--------|---------|
| 存储 | 10 GB |
| Class A 操作（写入） | 1M / 月 |
| Class B 操作（读取） | 10M / 月 |
| 单对象大小 | 5 TB |

---

## 8. 自定义域名

### 使用 workers.dev 子域（默认）

部署后自动获得 `https://linkedbot.<subdomain>.workers.dev`，无需额外配置。

### 使用自定义域名

1. 在 Cloudflare Dashboard 中将域名添加到你的账号（需修改 DNS 指向 Cloudflare）。

2. 在 Dashboard → Workers & Pages → linkedbot → Settings → Domains & Routes 添加自定义域名。

3. 或在 `wrangler.jsonc` 中添加：

```jsonc
"routes": [
  { "pattern": "linkedbot.yourdomain.com/*", "zone_name": "yourdomain.com" }
]
```

4. 更新 `PUBLIC_BASE_URL`：

```jsonc
"vars": {
  "PUBLIC_BASE_URL": "https://linkedbot.yourdomain.com"
}
```

5. 重新部署：

```bash
npm run deploy
```

---

## 9. 监控与日志

### 实时日志

```bash
npx wrangler tail
```

按 `Ctrl+C` 退出。支持过滤：

```bash
# 仅看错误
npx wrangler tail --format=json | jq 'select(.outcome != "ok")'

# 仅看特定路径
npx wrangler tail --search="/api/auth"
```

### Dashboard 监控

登录 https://dash.cloudflare.com → Workers & Pages → linkedbot：

- **Metrics**：请求量、错误率、CPU 时间、数据传输
- **Logs**：最近请求的详细日志（需开启 `observability`，已在 `wrangler.jsonc` 中启用）

### D1 监控

Dashboard → D1 → linkedbot：

- 查询次数、读/写行数
- 存储用量
- 慢查询（> 1ms）

---

## 10. 安全加固

### 密钥安全

- `SECRET_KEY` 和 `JWT_SECRET` **必须使用 `wrangler secret put`** 设置，**绝不放入** `wrangler.jsonc` 或代码
- 密钥长度建议 **32 字节以上**
- 定期轮换密钥（注意会使现有会话 / JWT 失效）

### HTTPS

- Workers 默认强制 HTTPS，无需额外配置
- Cookie 设置了 `Secure; HttpOnly; SameSite=Lax`

### 密码存储

- 使用 **bcrypt** (cost factor 10)，不存储明文
- 密码最短 8 位（API 和 UI 均校验）

### 头像上传

- 仅允许 `png / jpg / jpeg / gif / webp`
- 文件名使用 `crypto.randomUUID()` 防止路径穿越
- R2 对象 key 不包含用户输入

### Webhook

- Webhook secret 为 43 字符随机 UUID 拼接，暴力猜测不可行
- 请求头中 `Authorization`、`Cookie`、`Host` 不被记录

---

## 11. CI/CD 自动化

### GitHub Actions 示例

创建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - run: npm ci

      - run: npx tsc --noEmit

      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: deploy
```

### 获取 API Token

1. 前往 https://dash.cloudflare.com/profile/api-tokens
2. 创建 Token → 使用模板 "Edit Cloudflare Workers"
3. 将 Token 添加到 GitHub repo → Settings → Secrets → `CLOUDFLARE_API_TOKEN`

### 数据库迁移在 CI 中

在部署步骤之前添加：

```yaml
      - name: Apply D1 migrations
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: d1 execute linkedbot --remote --file=migrations/d1/0001_initial.sql
```

> 生产环境建议用 **编号递增** 的迁移文件，每个文件仅运行一次（使用 `IF NOT EXISTS` 保证幂等）。

---

## 12. 免费层额度

所有资源在 Cloudflare 免费计划下的限制：

| 资源 | 免费额度 | LinkedBot 预估用量 | 是否足够 |
|------|---------|----------------|---------|
| Workers 请求 | 100,000 / 天 | 页面浏览 + API + Webhook | 充裕 |
| Workers CPU 时间 | 10ms / 请求 | bcrypt ~5ms, 其余 < 1ms | 充裕 |
| D1 读行 | 5,000,000 / 天 | 每请求 1-5 行 | 充裕 |
| D1 写行 | 100,000 / 天 | Webhook + 注册 + Pull | 充裕 |
| D1 存储 | 5 GB | 消息 payload 为 TEXT | 充裕 |
| R2 Class A (写) | 1,000,000 / 月 | 仅头像上传 | 充裕 |
| R2 Class B (读) | 10,000,000 / 月 | 头像展示 | 充裕 |
| R2 存储 | 10 GB | 头像图片 | 充裕 |

**单一注意项**：Workers 免费计划的 CPU 时间为 **10ms/请求**。`bcryptjs` 哈希 (cost 10) 约 5ms，留有余量。如果升级到 Workers Paid ($5/月)，CPU 限制放宽到 30s。

---

## 13. 故障排查

### Worker 返回 500

```bash
# 查看实时日志
npx wrangler tail

# 检查最近部署
npx wrangler deployments list
```

常见原因：
- `SECRET_KEY` 或 `JWT_SECRET` 未设置 → `wrangler secret list` 检查
- D1 schema 未应用 → 重新执行 `--remote --file=migrations/d1/0001_initial.sql`
- `database_id` 在 `wrangler.jsonc` 中仍为 `"LOCAL"` → 替换为实际 ID

### D1 查询报错 "no such table"

```bash
npx wrangler d1 execute linkedbot --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table';"
```

如果表不存在，重新应用 schema：

```bash
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0001_initial.sql
```

### Cookie/Session 不工作

- 确认 `PUBLIC_BASE_URL` 与实际访问域名一致
- 确认使用 HTTPS（Workers 默认 HTTPS，但本地 dev 是 HTTP）
- 本地开发时 Cookie 的 `Secure` 属性会被 Wrangler 自动处理

### JWT 认证失败

- 确认 `Authorization: Bearer <token>` 格式正确
- 检查 Token 是否过期（默认 24 小时）
- 更换过 `JWT_SECRET` 后旧 Token 全部失效

### R2 头像 404

- 确认 R2 bucket 名称为 `linkedbot-avatars`
- 确认 `PUBLIC_BASE_URL` 正确（头像 URL = `PUBLIC_BASE_URL/avatars/<key>`）
- 检查 R2 中是否存在该 key：`npx wrangler r2 object list linkedbot-avatars`

### 回滚到上一版本

```bash
npx wrangler rollback
```

---

## 14. API 速查

### 认证

| 端点 | 方法 | 认证 | 请求体 | 响应 |
|------|------|------|--------|------|
| `/api/auth/register` | POST | 无 | `{"email":"...","password":"..."}` | `201` `{user_id, email, access_token}` |
| `/api/auth/login` | POST | 无 | `{"email":"...","password":"..."}` | `200` `{user_id, email, access_token}` |

### 机器人

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/bots` | POST | Bearer JWT | 创建机器人 `{"name":"..."}` |
| `/api/bots` | GET | Bearer JWT | 列出我的机器人 |
| `/api/bots/:id` | PATCH | Bearer JWT | 更新名称/头像 URL |
| `/api/bots/:id/avatar` | POST | Bearer JWT | 上传头像 (multipart) |

### Webhook & Email Webhook

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/w/:secret` | POST | 无 (secret in URL) | 接收普通 HTTP webhook 消息 |
| `[secret]@your-domain.com` | Email | 无 (secret in Email) | 接收并解析邮件 Webhook (通过 Cloudflare Email Routing) |

#### Email Webhook (邮件转发) 设置指南：
1. **绑定域名**：在 Cloudflare Dashboard 中将你的域名 DNS 托管在 Cloudflare。
2. **启用 Email Routing**：进入你的域名 -> Email -> Email Routing。
3. **配置 Catch-all 规则**：在 Email Routing 中设置 Catch-all address（或指定地址），将 Action 设置为 "Send to a Worker"，Destination 选择 `linkedbot`。
4. **原理与使用**：现在，向 `<webhook_secret>@your-domain.com` 发送任何邮件，LinkedBot Worker 都会自动捕获、解析（包含标题、正文文本和 HTML 内容），并以零延迟内部投递到对应的频道，实现 100% 免费、稳定且无缝的邮件聚合功能。

### 消息

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/bots/:id/messages/pull?limit=50` | GET | Bearer JWT | 拉取并标记已读 |
| `/api/bots/:id/messages?cursor=` | GET | Bearer JWT | 分页历史（不改已读状态） |

### 系统

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/ping` | GET | 轻量存活检查 |

---

## 快速命令参考

```bash
# 本地开发
npm run dev

# 首次部署：初始化 Cloudflare 资源
# 该脚本会自动创建 D1, R2, KV 和 Queues
./init-cloudflare.sh

# 部署到生产
npm run deploy

# 查看日志
npx wrangler tail

# 设置密钥
npx wrangler secret put SECRET_KEY
npx wrangler secret put JWT_SECRET

# 数据库操作
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0001_users.sql
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0002_bots.sql
npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0003_channels.sql
npx wrangler d1 export linkedbot --remote --output=backup.sql

# R2 操作
npx wrangler r2 bucket list
npx wrangler r2 object list linkedbot-avatars

# 部署管理
npx wrangler deployments list
npx wrangler rollback
```
