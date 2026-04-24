# LinkedBot 本地开发与测试指南

本文档覆盖从零开始的完整本地开发流程：环境准备、初始化、启动、类型检查、API 测试和 Web UI 测试。

---

## 目录

1. [环境要求](#1-环境要求)
2. [首次初始化（只需做一次）](#2-首次初始化只需做一次)
3. [编译检查](#3-编译检查)
4. [启动开发服务器](#4-启动开发服务器)
5. [本地资源说明](#5-本地资源说明)
6. [Web UI 测试流程](#6-web-ui-测试流程)
7. [API 自动化测试](#7-api-自动化测试)
8. [手动 API 测试（curl）](#8-手动-api-测试curl)
9. [查看本地数据库](#9-查看本地数据库)
10. [常见问题](#10-常见问题)
11. [重置本地环境](#11-重置本地环境)

---

## 1. 环境要求

| 工具 | 推荐版本 | 检查命令 |
|------|---------|---------|
| Node.js | 18.0+ | `node --version` |
| npm | 9.0+ | `npm --version` |

**不需要**安装 Cloudflare 账号、数据库或 Docker。所有云服务均由 Wrangler 在本地模拟。

---

## 2. 首次初始化（只需做一次）

### 2.1 安装依赖

```bash
npm install
```

### 2.2 创建本地密钥文件

Wrangler 从 `.dev.vars` 读取本地密钥（该文件在 `.gitignore` 中，不会提交）：

```bash
cp .env.example .dev.vars
```

`.dev.vars` 内容如下，本地开发使用这些占位值即可，**无需修改**：

```
SECRET_KEY=local-dev-secret-key-for-cookie-signing-32ch
JWT_SECRET=local-dev-jwt-secret-for-token-signing-ok
```

### 2.3 初始化本地 D1 数据库

Wrangler 会用本地 SQLite 文件模拟 D1，需要手动建表：

```bash
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql
```

成功输出：

```
🌀 Executing on local database linkedbot (LOCAL)
🚣 7 commands executed successfully.
```

> **注意**：`--local` 只操作本地 SQLite，与云端 D1 完全隔离，不需要 Cloudflare 账号。

---

## 3. 编译检查

在启动前，可以先做 TypeScript 类型检查（不产生构建产物，只做静态分析）：

```bash
npx tsc --noEmit
```

无任何输出表示通过。如有报错，按提示修复后再启动。

> Wrangler 本身在 `dev` 模式下会实时重新编译，无需手动 build 步骤。

---

## 4. 启动开发服务器

```bash
npm run dev
```

等待出现以下输出即表示启动成功：

```
⛅️ wrangler 4.x.x
Using secrets defined in .dev.vars
Your Worker has access to the following bindings:
  env.DB (linkedbot)              D1 Database      local
  env.AVATARS (linkedbot-avatars) R2 Bucket        local
  env.SECRET_KEY               Environment Variable  local
  env.JWT_SECRET               Environment Variable  local

⎔ Starting local server...
[wrangler:info] Ready on http://localhost:8787
```

**访问地址：**

| 地址 | 说明 |
|------|------|
| http://localhost:8787 | 根路径（自动跳转登录页） |
| http://localhost:8787/login | 登录页 |
| http://localhost:8787/register | 注册页 |
| http://localhost:8787/dashboard | 仪表盘（需登录） |
| http://localhost:8787/health | 健康检查（返回 JSON） |

> 修改 `src/` 下任意文件后，Wrangler 会**自动热重载**，无需重启。

---

## 5. 本地资源说明

`npm run dev` 启动后，所有 Cloudflare 服务均在本地模拟：

| 云服务 | 本地模拟方式 | 数据存放位置 |
|-------|------------|------------|
| D1 数据库 | SQLite 文件 | `.wrangler/state/v3/d1/` |
| R2 存储桶 | 本地文件目录 | `.wrangler/state/v3/r2/` |
| Secrets | `.dev.vars` 文件 | 项目根目录 |

**`wrangler.jsonc` 中的 `database_id` 在本地模式下完全被忽略**，填任意值均可，不影响本地测试。

---

## 6. Web UI 测试流程

在浏览器中打开 http://localhost:8787，按以下步骤操作：

### 步骤一：注册账号

1. 访问 http://localhost:8787/register
2. 填写邮箱和密码（密码至少 8 位）
3. 点击"注册"，成功后自动跳转到 Dashboard

### 步骤二：创建机器人

1. 在 Dashboard 页面，填写 Bot 名称，点击"创建"
2. 页面跳转到 Bot 详情页，可以看到：
   - **Webhook URL**：外部系统调用的地址
   - **curl 示例**：可直接复制到终端测试

### 步骤三：发送 Webhook 消息

复制 Bot 详情页上的 curl 示例，在终端中执行：

```bash
curl -X POST http://localhost:8787/w/<你的webhook_secret> \
  -H "Content-Type: application/json" \
  -d '{"text":"来自 curl 的测试消息"}'
```

成功返回：

```json
{"ok": true, "message_id": 1}
```

### 步骤四：查看和消费消息

1. 刷新 Bot 详情页，消息出现在列表中，标记为"未读"
2. 点击"标记已读"按钮，`read_at` 被设置，未读计数归零

### 步骤五：上传头像（可选）

在 Bot 详情页，选择一张图片（png/jpg/gif/webp），点击上传。头像存入本地 R2 模拟目录并展示在页面上。

---

## 7. API 自动化测试

项目已提供覆盖所有接口的自动化测试脚本 `test-local.sh`（需要安装 `jq`）。

### 安装 jq（如未安装）

```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt install jq
```

### 运行测试

**保持 `npm run dev` 在另一个终端运行**，然后执行：

```bash
bash test-local.sh
```

### 预期输出

```
═══════════════════════════════════════
  LinkedBot 本地测试  (http://localhost:8787)
═══════════════════════════════════════

[1/8] 健康检查
  ✓ GET /health (HTTP 200)
  ✓ GET /ping (HTTP 200)

[2/8] 用户注册
  ✓ POST /api/auth/register (HTTP 201)
  ✓ 拿到 access_token (user_id=1)
  ✓ 重复注册返回 409 (HTTP 409)

[3/8] 用户登录
  ✓ POST /api/auth/login (HTTP 200)
  ✓ 错误密码返回 401 (HTTP 401)

[4/8] 创建机器人
  ✓ POST /api/bots (HTTP 201)
  ✓ 机器人创建成功 (id=1)
  ✓ 无 token 创建机器人返回 401 (HTTP 401)
  ✓ GET /api/bots (HTTP 200)
  ✓ 列表包含 1 个机器人
...
═══════════════════════════════════════
  全部通过! 26/26 测试
═══════════════════════════════════════
```

### 测试覆盖范围

| # | 场景 | 检查项 |
|---|------|--------|
| 1 | 健康检查 | `/health` 200、`/ping` 200 |
| 2 | 用户注册 | 成功 201 + token、重复注册 409 |
| 3 | 用户登录 | 成功 200、错误密码 401 |
| 4 | 创建/列出机器人 | 创建 201、无 token 401、列表 GET |
| 5 | 更新机器人 | PATCH 改名验证 |
| 6 | Webhook 收消息 | 3 条 JSON + 1 条 text/plain、错误 secret 404 |
| 7 | 拉取未读 (Pull) | 首次拉 4 条 + read_at 标记、再拉 0 条 |
| 8 | 消息历史分页 | 返回 4 条含已读、next_cursor 验证 |

---

## 8. 手动 API 测试（curl）

如需单独测试某个接口，使用以下示例（假设 BASE=`http://localhost:8787`）。

### 注册 / 登录

```bash
# 注册
curl -X POST http://localhost:8787/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"mypassword"}'

# 登录（取 access_token）
curl -X POST http://localhost:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"mypassword"}'
```

### 机器人管理

```bash
TOKEN="eyJ..."   # 替换为登录返回的 access_token

# 创建机器人
curl -X POST http://localhost:8787/api/bots \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"MyBot"}'

# 列出机器人（取 webhook_secret）
curl http://localhost:8787/api/bots \
  -H "Authorization: Bearer $TOKEN"

# 改名
curl -X PATCH http://localhost:8787/api/bots/1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"NewName"}'
```

### Webhook 推送消息

```bash
SECRET="..."   # 替换为机器人的 webhook_secret

# 推送 JSON 消息
curl -X POST http://localhost:8787/w/$SECRET \
  -H "Content-Type: application/json" \
  -d '{"event":"order.created","amount":99}'

# 推送纯文本消息
curl -X POST http://localhost:8787/w/$SECRET \
  -H "Content-Type: text/plain" \
  -d "Alert: server CPU > 90%"
```

### 拉取与查看消息

```bash
BOT_ID=1

# 拉取未读消息（同时标记为已读）
curl "http://localhost:8787/api/bots/$BOT_ID/messages/pull?limit=50" \
  -H "Authorization: Bearer $TOKEN"

# 查看历史消息（不改变已读状态）
curl "http://localhost:8787/api/bots/$BOT_ID/messages" \
  -H "Authorization: Bearer $TOKEN"

# 分页：传入上一页的 next_cursor
curl "http://localhost:8787/api/bots/$BOT_ID/messages?cursor=42" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 9. 查看本地数据库

可以直接用 Wrangler 命令查询本地 SQLite，无需安装任何数据库工具：

```bash
# 查看所有用户
npx wrangler d1 execute linkedbot --local \
  --command="SELECT id, email, created_at FROM users;"

# 查看所有机器人
npx wrangler d1 execute linkedbot --local \
  --command="SELECT id, name, webhook_secret FROM bots;"

# 查看消息（含已读状态）
npx wrangler d1 execute linkedbot --local \
  --command="SELECT id, bot_id, payload_json, read_at FROM messages ORDER BY id DESC LIMIT 10;"

# 统计未读消息数
npx wrangler d1 execute linkedbot --local \
  --command="SELECT bot_id, COUNT(*) as unread FROM messages WHERE read_at IS NULL GROUP BY bot_id;"
```

---

## 10. 常见问题

### Q: 启动时提示 `Missing required variable: SECRET_KEY`

没有创建 `.dev.vars` 文件，执行：

```bash
cp .env.example .dev.vars
```

### Q: 启动时提示 `no such table: users`

本地 D1 未初始化，执行建表命令：

```bash
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql
```

### Q: `tsc --noEmit` 提示类型错误 `worker-configuration.d.ts not found`

先生成 Wrangler 类型文件：

```bash
npm run cf-types   # 等同于 npx wrangler types
```

### Q: 端口 8787 被占用

指定其他端口启动：

```bash
npx wrangler dev --port 8788
```

### Q: 修改代码后没有自动热重载

确认文件保存成功。Wrangler 监听 `src/` 目录，保存任意 `.ts` / `.tsx` 文件即可触发重载。

---

## 11. 新增功能测试要点

### SSE 实时推送

```bash
# 在终端订阅消息流（保持连接，25 秒后自动关闭）
curl -N "http://localhost:8787/api/bots/$BOT_ID/messages/stream?since=0" \
  -H "Authorization: Bearer $TOKEN"

# 在另一个终端发 webhook，可以看到 SSE 事件输出
curl -X POST "http://localhost:8787/w/$SECRET" \
  -H "Content-Type: application/json" -d '{"text":"realtime!"}'
```

### 过滤规则

```bash
# 创建拒绝规则：user-agent 包含 "bot" 则丢弃
curl -X POST "http://localhost:8787/api/bots/$BOT_ID/rules" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"drop bots","condition_type":"header","condition_field":"user-agent","condition_op":"contains","condition_value":"bot","action":"reject","priority":0}'

# 创建标签规则：content-type 为 json 时打 json 标签
curl -X POST "http://localhost:8787/api/bots/$BOT_ID/rules" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"tag json","condition_type":"content_type","condition_op":"contains","condition_value":"json","action":"tag","tag_value":"json","priority":10}'
```

### Webhook 转发

```bash
# 添加转发目标
curl -X POST "http://localhost:8787/api/bots/$BOT_ID/forwards" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://httpbin.org/post","retry_max":3}'

# 查看转发日志
curl "http://localhost:8787/api/bots/$BOT_ID/forwards/1/log" \
  -H "Authorization: Bearer $TOKEN"

# 手动触发 Cron 重试（本地 Wrangler 不自动执行，需手动触发）
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

### 统计

```bash
curl "http://localhost:8787/api/bots/$BOT_ID/stats?days=7" \
  -H "Authorization: Bearer $TOKEN"
```

### 成员管理

```bash
# 邀请其他已注册用户
curl -X POST "http://localhost:8787/api/bots/$BOT_ID/members" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"teammate@example.com","role":"member"}'

# 查看成员列表
curl "http://localhost:8787/api/bots/$BOT_ID/members" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 12. 重置本地环境

如需清空本地所有数据，重新开始：

```bash
# 删除本地 D1 和 R2 数据
rm -rf .wrangler/state

# 重新建表（两次 migration 都要执行）
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0002_enhancements.sql

# 重启服务器
npm run dev
```

---

## 快速参考

```bash
# 首次初始化
npm install
cp .env.example .dev.vars
npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql

# 日常开发
npm run dev                  # 启动开发服务器（含热重载）
npx tsc --noEmit             # 类型检查（不生成文件）
bash test-local.sh           # 运行自动化测试（需另开终端运行 dev）

# 查看本地数据
npx wrangler d1 execute linkedbot --local --command="SELECT * FROM users;"

# 重置数据（两次 migration）
rm -rf .wrangler/state \
  && npx wrangler d1 execute linkedbot --local --file=migrations/d1/0001_initial.sql \
  && npx wrangler d1 execute linkedbot --local --file=migrations/d1/0002_enhancements.sql
```
