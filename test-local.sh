#!/usr/bin/env bash
# LinkedBot 本地端到端测试脚本
# 用法: 先启动 npm run dev，然后在另一个终端执行 bash test-local.sh
#
# 依赖: curl, jq (macOS: brew install jq)
set -euo pipefail

BASE="${API_BASE:-http://localhost:8787}"
PASS="testpass1234"
EMAIL="test-$(date +%s)@example.com"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
PASSED=0; FAILED=0

pass() { ((PASSED++)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { ((FAILED++)); echo -e "  ${RED}✗${NC} $1  →  $2"; }

check_status() {
  local label="$1" expected="$2" actual="$3" body="$4"
  if [ "$actual" = "$expected" ]; then pass "$label (HTTP $actual)"
  else fail "$label" "expected $expected, got $actual — $body"; fi
}

echo -e "\n${CYAN}═══════════════════════════════════════${NC}"
echo -e "${CYAN}  LinkedBot 本地测试  ($BASE)${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}\n"

# ────────────────────────────────────────
echo -e "${CYAN}[1/8] 健康检查${NC}"
# ────────────────────────────────────────
RESP=$(curl -sS -w "\n%{http_code}" "$BASE/health")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "GET /health" "200" "$CODE" "$BODY"

RESP=$(curl -sS -w "\n%{http_code}" "$BASE/ping")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "GET /ping" "200" "$CODE" "$BODY"

# ────────────────────────────────────────
echo -e "\n${CYAN}[2/8] 用户注册${NC}"
echo "      email: $EMAIL"
# ────────────────────────────────────────
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "POST /api/auth/register" "201" "$CODE" "$BODY"

TOKEN=$(echo "$BODY" | jq -r '.access_token // empty')
USER_ID=$(echo "$BODY" | jq -r '.user_id // empty')
if [ -n "$TOKEN" ]; then pass "拿到 access_token (user_id=$USER_ID)"
else fail "解析 access_token" "body=$BODY"; fi

# 重复注册 → 409
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "重复注册返回 409" "409" "$CODE" "$BODY"

# ────────────────────────────────────────
echo -e "\n${CYAN}[3/8] 用户登录${NC}"
# ────────────────────────────────────────
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "POST /api/auth/login" "200" "$CODE" "$BODY"

# 错误密码 → 401
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"wrongpass\"}")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "错误密码返回 401" "401" "$CODE" "$BODY"

AUTH="Authorization: Bearer $TOKEN"

# ────────────────────────────────────────
echo -e "\n${CYAN}[4/8] 创建机器人${NC}"
# ────────────────────────────────────────
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/api/channels" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"TestBot"}')
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "POST /api/channels" "201" "$CODE" "$BODY"

BOT_ID=$(echo "$BODY" | jq -r '.id // empty')
WEBHOOK_URL=$(echo "$BODY" | jq -r '.webhook_url // empty')
WEBHOOK_SECRET=$(echo "$BODY" | jq -r '.webhook_secret // empty')
if [ -n "$BOT_ID" ] && [ -n "$WEBHOOK_URL" ]; then
  pass "机器人创建成功 (id=$BOT_ID)"
  echo "      webhook: $WEBHOOK_URL"
else fail "解析机器人数据" "body=$BODY"; fi

# 无 token → 401
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/api/channels" \
  -H "Content-Type: application/json" \
  -d '{"name":"NoAuth"}')
CODE=$(echo "$RESP" | tail -1)
check_status "无 token 创建机器人返回 401" "401" "$CODE" ""

# 列出机器人
RESP=$(curl -sS -w "\n%{http_code}" "$BASE/api/channels" -H "$AUTH")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "GET /api/channels" "200" "$CODE" "$BODY"
BOT_COUNT=$(echo "$BODY" | jq '.channels | length')
if [ "$BOT_COUNT" -ge 1 ]; then pass "列表包含 $BOT_COUNT 个机器人"
else fail "机器人列表为空" "$BODY"; fi

# ────────────────────────────────────────
echo -e "\n${CYAN}[5/8] 更新机器人${NC}"
# ────────────────────────────────────────
RESP=$(curl -sS -w "\n%{http_code}" -X PATCH "$BASE/api/channels/$BOT_ID" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"RenamedBot"}')
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "PATCH /api/channels/$BOT_ID" "200" "$CODE" "$BODY"
NEW_NAME=$(echo "$BODY" | jq -r '.name // empty')
if [ "$NEW_NAME" = "RenamedBot" ]; then pass "名称已更新为 RenamedBot"
else fail "名称更新" "got name=$NEW_NAME"; fi

# ────────────────────────────────────────
echo -e "\n${CYAN}[6/8] Webhook 收消息${NC}"
# ────────────────────────────────────────
for i in 1 2 3; do
  RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/w/$WEBHOOK_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"hello #$i\",\"seq\":$i}")
  CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
  check_status "POST /w/:secret 消息 #$i" "202" "$CODE" "$BODY"
done

# 非 JSON body
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/w/$WEBHOOK_SECRET" \
  -H "Content-Type: text/plain" \
  -d "plain text payload")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "POST /w/:secret (text/plain)" "202" "$CODE" "$BODY"

# 错误 secret → 404
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$BASE/w/invalid-secret-12345" \
  -H "Content-Type: application/json" \
  -d '{"text":"nope"}')
CODE=$(echo "$RESP" | tail -1)
check_status "错误 secret 返回 404" "404" "$CODE" ""

# ────────────────────────────────────────
echo -e "\n${CYAN}[7/8] 拉取未读消息 (Pull)${NC}"
# ────────────────────────────────────────
RESP=$(curl -sS -w "\n%{http_code}" "$BASE/api/channels/$BOT_ID/messages/pull?limit=50" \
  -H "$AUTH")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "GET /api/channels/$BOT_ID/messages/pull" "200" "$CODE" ""
MSG_COUNT=$(echo "$BODY" | jq '.messages | length')
if [ "$MSG_COUNT" -eq 4 ]; then pass "拉到 $MSG_COUNT 条未读消息 (3 JSON + 1 text)"
else fail "未读消息数量" "expected 4, got $MSG_COUNT"; fi

# 第一条的 read_at 应该有值
READ_AT=$(echo "$BODY" | jq -r '.messages[0].read_at // empty')
if [ -n "$READ_AT" ]; then pass "消息已标记 read_at=$READ_AT"
else fail "read_at 未设置" "$BODY"; fi

# 再拉一次 → 应该 0 条
RESP=$(curl -sS -w "\n%{http_code}" "$BASE/api/channels/$BOT_ID/messages/pull?limit=50" \
  -H "$AUTH")
BODY=$(echo "$RESP" | sed '$d')
MSG_COUNT=$(echo "$BODY" | jq '.messages | length')
if [ "$MSG_COUNT" -eq 0 ]; then pass "二次拉取返回 0 条 (全部已读)"
else fail "二次拉取" "expected 0, got $MSG_COUNT"; fi

# ────────────────────────────────────────
echo -e "\n${CYAN}[8/8] 消息历史 (分页)${NC}"
# ────────────────────────────────────────
RESP=$(curl -sS -w "\n%{http_code}" "$BASE/api/channels/$BOT_ID/messages" \
  -H "$AUTH")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check_status "GET /api/channels/$BOT_ID/messages (历史)" "200" "$CODE" ""
HIST_COUNT=$(echo "$BODY" | jq '.messages | length')
if [ "$HIST_COUNT" -eq 4 ]; then pass "历史返回 $HIST_COUNT 条 (含已读)"
else fail "历史消息数量" "expected 4, got $HIST_COUNT"; fi

NEXT_CURSOR=$(echo "$BODY" | jq -r '.next_cursor // "null"')
pass "next_cursor=$NEXT_CURSOR (无更多页时为 null)"

# ────────────────────────────────────────
echo -e "\n${CYAN}═══════════════════════════════════════${NC}"
TOTAL=$((PASSED + FAILED))
if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}  全部通过! $PASSED/$TOTAL 测试${NC}"
else
  echo -e "${RED}  $FAILED 项失败, $PASSED 项通过 (共 $TOTAL)${NC}"
fi
echo -e "${CYAN}═══════════════════════════════════════${NC}\n"

exit $FAILED
