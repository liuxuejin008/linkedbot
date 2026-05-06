import os
import re

UI_FILE = "src/routes/ui.tsx"
with open(UI_FILE, "r") as f:
    ui_content = f.read()

# Add import
ui_content = ui_content.replace('from "../middleware/session";', 'from "../middleware/session";\nimport { i18nMiddleware } from "../middleware/i18n";')

# Add middleware and set-lang route
ui_content = ui_content.replace('ui.use("*", sessionMiddleware);', 'ui.use("*", sessionMiddleware);\nui.use("*", i18nMiddleware);\n\nui.get("/set-lang", (c) => {\n  const next = c.req.query("next") || "/dashboard";\n  return c.redirect(safeNext(next));\n});')

# Refactor c.html calls in ui.tsx
# Replace <LoginPage ... /> with <LoginPage ... t={c.get("t")} lang={c.get("lang")} />
ui_content = re.sub(r'(<LoginPage nextUrl=\{next\} email=\{email\}) />', r'\1 t={c.get("t")} lang={c.get("lang")} />', ui_content)

# Fix flash messages in login
ui_content = ui_content.replace('flashes={[{ category: "error", message: "请填写邮箱和密码。" }]}', 'flashes={[{ category: "error", message: c.get("t")("auth.fillEmailPassword") }]} t={c.get("t")} lang={c.get("lang")}')
ui_content = ui_content.replace('flashes={[{ category: "error", message: "邮箱或密码错误。" }]}', 'flashes={[{ category: "error", message: c.get("t")("auth.invalidCredentials") }]} t={c.get("t")} lang={c.get("lang")}')

# Refactor RegisterPage
ui_content = re.sub(r'(<RegisterPage email=\{email\}) />', r'\1 t={c.get("t")} lang={c.get("lang")} />', ui_content)

ui_content = re.sub(
    r'const flash = \(msg: string\) =>\n\s*c\.html\(<RegisterPage flashes=\{\[\{ category: "error", message: msg \}\]\} />\);',
    r'const t = c.get("t");\n  const flash = (msg: string) =>\n    c.html(<RegisterPage flashes={[{ category: "error", message: msg }]} t={t} lang={c.get("lang")} />);',
    ui_content
)

ui_content = ui_content.replace('flash("请输入有效邮箱。")', 'flash(t("auth.invalidEmail"))')
ui_content = ui_content.replace('flash("密码至少 8 位。")', 'flash(t("auth.passwordLength"))')
ui_content = ui_content.replace('flash("两次输入的密码不一致。")', 'flash(t("auth.passwordMismatch"))')
ui_content = ui_content.replace('flash("邮箱已被注册。")', 'flash(t("auth.emailTaken"))')

# Refactor DashboardPage
ui_content = re.sub(r'(<DashboardPage email=\{email\} cards=\{cards\}) />', r'\1 t={c.get("t")} lang={c.get("lang")} />', ui_content)

# Refactor ChannelDetailPage
ui_content = ui_content.replace('stats={pageStats}\n    />', 'stats={pageStats}\n      t={c.get("t")}\n      lang={c.get("lang")}\n    />')

# Refactor ForwardLogsPage
ui_content = ui_content.replace('search={search}\n    />', 'search={search}\n      t={c.get("t")}\n      lang={c.get("lang")}\n    />')

with open(UI_FILE, "w") as f:
    f.write(ui_content)

print("ui.tsx refactored.")
