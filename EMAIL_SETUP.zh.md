# Cloudflare 邮件接收 (Email Routing) 配置指南

> 📖 [English Version → EMAIL_SETUP.md](./EMAIL_SETUP.md)

通过 Cloudflare 的 Email Routing 功能，你可以让 LinkedBot 接收并发往你专属频道的邮件。通过开启“全部捕获 (Catch-all)”功能，你可以实现**无需提前在后台逐一创建邮箱地址**，就能动态接收任意前缀邮件的强大能力。

## 🌟 什么是 Catch-all (全部捕获)？

在初步设置 Cloudflare 邮件路由时，系统会强制要求你创建一个具体的测试地址（例如 `test@yourdomain.com`）。但对于 LinkedBot，我们希望系统能自动处理发给不同频道前缀的邮件（比如 `alert@yourdomain.com`、`my-bot@yourdomain.com`）。

开启 **Catch-all** 功能后，发往你域名下**任何**前缀的邮件，都会被系统统一捕获，并直接发送给我们的 Worker 自动解析和分发。

---

## 🛠️ 详细配置步骤

### 第一步：完成基础 DNS 指引
如果你是第一次使用该域名的 Email Routing：
1. 登录 Cloudflare 仪表板，进入你的域名管理页面。
2. 在左侧菜单点击 **Email (电子邮件)** -> **Email Routing (电子邮件路由)**。
3. 按照页面的初始化指引完成设置。系统会引导你一键添加必要的 DNS 记录，并要求你创建一个基础的测试路由地址。请先按照提示完成这一步。

### 第二步：开启 Catch-all 功能，指向 Worker
基础设置完成后，请按照以下步骤开启全部捕获功能：
1. 依然在 **Email Routing** 页面，点击顶部切换到 **Routing Rules (路由规则)** 选项卡。
2. 页面向下滚动，找到 **Catch-all address (全部捕获地址)** 模块。
3. 点击右侧的编辑按钮，确保开关状态为 **开启 (Enabled)**。
4. 关键设置：
   - **Action (操作)**：选择为 **Send to a Worker (发送至 Worker)**。
   - **Destination (目标)**：在下拉菜单中，选择你刚刚部署的 LinkedBot Worker 程序（默认名称通常是 `linkedbot`）。
5. 点击 **Save (保存)**。

🎉 **配置完成！** 

---

## 🚀 工作原理与测试

现在，你的 Cloudflare 邮件系统已经完全接管了整个域名。你可以尝试用你的个人邮箱发送一封测试邮件到：
👉 `随便什么名字@yourdomain.com` （注意替换为你自己的域名）

**接下来会发生什么？**
1. 邮件抵达 Cloudflare 后，会被 Catch-all 规则捕获。
2. Cloudflare 将这封邮件的完整内容（包括发件人、标题、正文等）传递给 LinkedBot Worker。
3. Worker 会自动提取 `@` 前面的前缀（例如 `随便什么名字`），并在数据库中寻找对应前缀的频道。
4. 如果匹配成功，这封邮件就会被瞬间推送到你配置好的内网接收端！
