"""
LinkedBot 端到端测试脚本（使用 ChannelClient / ChannelServerAPI）
================================================================

架构角色：
  caller (本脚本)  ── HTTP POST ──►  ChannelServer (LinkedBot Worker)
                                          │ SSE proxy_request
                                          ▼
                                    ChannelClient (channel_client.py)
                                          │ HTTP POST
                                          ▼
                                    ChannelReceiver (LocalWebhookServer :9998)
                                          │ HTTP Response
                                          ▼
                                    ChannelClient → POST /proxy-response
                                          │
                                    ChannelServer → 返回给 caller

覆盖场景：
  1. JSON POST  — 标准 JSON 回调透传
  2. XML POST   — 微信支付 XML 回调，原样透传（Content-Type 保留）
  3. GET echostr — 微信公众号 GET 验证，query 并入 payload，echostr 原样返回
  4. 超时 504   — 无 ChannelClient 监听时 ChannelServer 返回 504

用法：
  # 先确保 wrangler dev 已经跑起来（npm run dev）
  python3 test_e2e.py

  # 指定 ChannelServer 地址（默认 http://localhost:8787）
  CHANNEL_SERVER_URL=http://localhost:8787 python3 test_e2e.py
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx

# 把 client/ 目录加入 path，以便 import channel_client
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "client"))
from channel_client import (  # noqa: E402
    ChannelClient,
    ChannelServerAPI,
    Config,
)

# ── 配置 ──────────────────────────────────────────────────────────────────────

CHANNEL_SERVER_URL = os.getenv("CHANNEL_SERVER_URL", "http://localhost:8787").rstrip("/")
TEST_EMAIL    = os.getenv("TEST_EMAIL",    "testuser_e2e@example.com")
TEST_PASSWORD = os.getenv("TEST_PASSWORD", "Test1234!")
RECEIVER_PORT = int(os.getenv("RECEIVER_PORT", "9998"))
RECEIVER_URL  = f"http://localhost:{RECEIVER_PORT}/webhook"

# ── 日志 ──────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("e2e")

PASS = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"
INFO = "\033[94m·\033[0m"


def ok(msg: str)   -> None: print(f"  {PASS} {msg}")
def fail(msg: str) -> None: print(f"  {FAIL} {msg}"); sys.exit(1)
def info(msg: str) -> None: print(f"  {INFO} {msg}")


# ── ChannelReceiver 模拟服务器（本地 Webhook 端） ─────────────────────────────

class ReceivedRequest:
    def __init__(self):
        self.requests: list[dict] = []
        self._lock = threading.Lock()

    def add(self, entry: dict) -> None:
        with self._lock:
            self.requests.append(entry)

    def last(self) -> dict | None:
        with self._lock:
            return self.requests[-1] if self.requests else None

    def clear(self) -> None:
        with self._lock:
            self.requests.clear()


received = ReceivedRequest()

_response_factory: dict = {
    "body": json.dumps({"return_code": "SUCCESS"}),
    "status": 200,
    "content_type": "application/json",
}


def make_handler(resp_factory: dict):
    class ReceiverHandler(BaseHTTPRequestHandler):
        """模拟 ChannelReceiver（本地业务 Webhook）。"""

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(length) if length else b""
            body_str = body_bytes.decode("utf-8", errors="replace")

            # ChannelServer 将 GET 的 query params 并入 JSON payload；
            # 若含 echostr，直接原样返回（公众号验签流程）。
            extracted_echostr: str | None = None
            try:
                body_json = json.loads(body_str)
                extracted_echostr = body_json.get("echostr")
            except Exception:
                pass

            received.add({
                "method": "POST",
                "path": self.path,
                "headers": dict(self.headers),
                "body": body_str,
                "echostr": extracted_echostr,
                "time": time.time(),
            })
            log.debug("[ChannelReceiver] POST %s body=%s", self.path, body_str[:200])

            if extracted_echostr is not None:
                resp_body = extracted_echostr.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
            else:
                resp_body = resp_factory["body"].encode()
                self.send_response(resp_factory["status"])
                self.send_header("Content-Type", resp_factory["content_type"])

            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)

        def log_message(self, *args):
            pass

    return ReceiverHandler


def start_receiver_server() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", RECEIVER_PORT), make_handler(_response_factory))
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    info(f"ChannelReceiver 模拟服务器启动：{RECEIVER_URL}")
    return server


# ── ChannelServer API 测试帮助函数 ────────────────────────────────────────────

async def register_or_login(http: httpx.AsyncClient) -> str:
    r = await http.post(f"{CHANNEL_SERVER_URL}/api/auth/register",
                        json={"email": TEST_EMAIL, "password": TEST_PASSWORD})
    if r.status_code not in (200, 201, 409):
        fail(f"注册失败: {r.status_code} {r.text}")
    r = await http.post(f"{CHANNEL_SERVER_URL}/api/auth/login",
                        json={"email": TEST_EMAIL, "password": TEST_PASSWORD})
    if r.status_code != 200:
        fail(f"登录失败: {r.status_code} {r.text}")
    token = r.json()["access_token"]
    ok(f"已登录 ChannelServer ({TEST_EMAIL})")
    return token


async def create_proxy_channel(http: httpx.AsyncClient, token: str, name: str) -> dict:
    r = await http.post(
        f"{CHANNEL_SERVER_URL}/api/channels",
        json={"name": name, "mode": "proxy"},
        headers={"Authorization": f"Bearer {token}"},
    )
    if r.status_code not in (200, 201):
        fail(f"创建频道失败: {r.status_code} {r.text}")
    ch = r.json()
    ok(f"创建 proxy 频道: {ch['name']} (id={ch['id']}, secret={ch['webhook_secret'][:8]}...)")
    return ch


async def add_receiver_target(
    http: httpx.AsyncClient, token: str, channel_id: int, url: str
) -> None:
    r = await http.post(
        f"{CHANNEL_SERVER_URL}/api/channels/{channel_id}/forwards",
        json={"url": url, "method": "POST", "retry_max": 0},
        headers={"Authorization": f"Bearer {token}"},
    )
    if r.status_code not in (200, 201):
        fail(f"添加 ChannelReceiver 目标失败: {r.status_code} {r.text}")
    ok(f"ChannelReceiver 目标已配置: {url}")


async def delete_channel(http: httpx.AsyncClient, token: str, channel_id: int) -> None:
    await http.delete(
        f"{CHANNEL_SERVER_URL}/api/channels/{channel_id}",
        headers={"Authorization": f"Bearer {token}"},
    )


# ── ChannelClient 启动帮助 ─────────────────────────────────────────────────────

def _make_channel_client_config(token: str, channel_id: int) -> Config:
    """为测试构造一个只监听单个频道的 ChannelClient Config。"""
    cfg = Config(
        server_url=CHANNEL_SERVER_URL,
        email=TEST_EMAIL,
        password=TEST_PASSWORD,
        channel_ids=[channel_id],
        receiver_url=RECEIVER_URL,
        sync_interval=10,
    )
    return cfg


async def start_channel_client(
    token: str,
    channel_id: int,
    stop: asyncio.Event,
) -> asyncio.Task:
    """在后台启动 ChannelClient，监听单个频道的 SSE。"""
    cfg = _make_channel_client_config(token, channel_id)
    api = ChannelServerAPI(cfg)
    api.token = token  # 直接注入 token，跳过登录
    channel_info = {"id": channel_id, "name": f"test-{channel_id}", "mode": "proxy"}
    client = ChannelClient(api, channel_info)
    task = asyncio.create_task(client.run(stop))
    await asyncio.sleep(0.6)  # 等 SSE 连接建立
    return task


# ── 断言帮助 ──────────────────────────────────────────────────────────────────

async def wait_for_receiver(timeout: float = 6.0) -> dict | None:
    """等待 ChannelReceiver 收到请求。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        req = received.last()
        if req:
            return req
        await asyncio.sleep(0.1)
    return None


# ── 测试用例 ──────────────────────────────────────────────────────────────────

async def run_tests() -> None:
    print()
    print("=" * 64)
    print("  LinkedBot Proxy 端到端测试")
    print(f"  ChannelServer  : {CHANNEL_SERVER_URL}")
    print(f"  ChannelReceiver: {RECEIVER_URL}")
    print("=" * 64)

    # 检查 ChannelServer 是否在线
    try:
        async with httpx.AsyncClient(timeout=5) as probe:
            r = await probe.post(f"{CHANNEL_SERVER_URL}/api/auth/login", json={})
            if r.status_code not in (200, 400, 401, 422):
                fail(f"ChannelServer 响应异常: {r.status_code}")
    except Exception as exc:
        fail(f"无法连接 ChannelServer ({CHANNEL_SERVER_URL}): {exc}\n请先运行: npm run dev")

    ok(f"ChannelServer 在线: {CHANNEL_SERVER_URL}")
    print()

    async with httpx.AsyncClient(timeout=30) as http:
        token = await register_or_login(http)
        print()

        # ── 测试 1：JSON POST ───────────────────────────────────────────────
        print("【测试 1】ChannelServer 接收 JSON POST → ChannelClient 透传 → ChannelReceiver")
        _response_factory["body"] = json.dumps({"return_code": "SUCCESS"})
        _response_factory["status"] = 200
        _response_factory["content_type"] = "application/json"
        received.clear()

        ch1 = await create_proxy_channel(http, token, "e2e-test-json")
        await add_receiver_target(http, token, ch1["id"], RECEIVER_URL)

        stop1 = asyncio.Event()
        task1 = await start_channel_client(token, ch1["id"], stop1)

        wh = f"{CHANNEL_SERVER_URL}/w/{ch1['webhook_secret']}"
        info(f"外部调用方 POST → {wh}")
        t0 = time.monotonic()
        resp1 = await http.post(wh, json={"order_id": "2024001", "amount": 100}, timeout=30)
        elapsed = int((time.monotonic() - t0) * 1000)
        info(f"  → HTTP {resp1.status_code} ({elapsed}ms): {resp1.text[:100]}")

        if resp1.status_code == 200: ok("外部调用方收到 200")
        else: fail(f"响应状态码异常: {resp1.status_code}")

        lr1 = await wait_for_receiver()
        if lr1:
            ok(f"ChannelReceiver 收到请求: {lr1['body'][:100]}")
        else:
            fail("ChannelReceiver 未收到请求（超时）")

        if resp1.json().get("return_code") == "SUCCESS":
            ok("响应内容正确透传：ChannelReceiver → ChannelClient → ChannelServer → 调用方")
        else:
            fail(f"响应内容不符: {resp1.text}")

        stop1.set(); task1.cancel()
        with contextlib.suppress(asyncio.CancelledError): await task1
        await delete_channel(http, token, ch1["id"])
        print()

        # ── 测试 2：XML POST（微信支付回调） ───────────────────────────────
        print("【测试 2】XML POST 微信支付回调 → Content-Type 原样透传 → XML 响应回传")
        _response_factory["body"] = "<xml><return_code>SUCCESS</return_code><return_msg>OK</return_msg></xml>"
        _response_factory["status"] = 200
        _response_factory["content_type"] = "application/xml"
        received.clear()

        ch2 = await create_proxy_channel(http, token, "e2e-test-xml")
        await add_receiver_target(http, token, ch2["id"], RECEIVER_URL)

        stop2 = asyncio.Event()
        task2 = await start_channel_client(token, ch2["id"], stop2)

        xml_body = "<xml><appid>wx123456</appid><out_trade_no>20240101001</out_trade_no></xml>"
        wh2 = f"{CHANNEL_SERVER_URL}/w/{ch2['webhook_secret']}"
        info(f"外部调用方 XML POST → {wh2}")
        t0 = time.monotonic()
        resp2 = await http.post(
            wh2, content=xml_body.encode(),
            headers={"Content-Type": "application/xml"}, timeout=30,
        )
        elapsed = int((time.monotonic() - t0) * 1000)
        info(f"  → HTTP {resp2.status_code} ({elapsed}ms) Content-Type: {resp2.headers.get('content-type','?')}")
        info(f"  body: {resp2.text[:120]}")

        if resp2.status_code == 200: ok("外部调用方收到 200")
        else: fail(f"响应状态码异常: {resp2.status_code}")

        lr2 = await wait_for_receiver()
        if lr2:
            ok(f"ChannelReceiver 收到请求: {lr2['body'][:100]}")
            if "<xml>" in lr2["body"]:
                ok("ChannelReceiver 收到了原始 XML（Content-Type 正确透传）")
            else:
                fail(f"ChannelReceiver 收到的不是 XML: {lr2['body']}")
        else:
            fail("ChannelReceiver 未收到请求")

        if "SUCCESS" in resp2.text:
            ok("XML 响应正确透传回外部调用方")
        else:
            fail(f"XML 响应不符: {resp2.text}")

        if "xml" in resp2.headers.get("content-type", "").lower():
            ok(f"响应 Content-Type 正确透传: {resp2.headers.get('content-type')}")

        stop2.set(); task2.cancel()
        with contextlib.suppress(asyncio.CancelledError): await task2
        await delete_channel(http, token, ch2["id"])
        print()

        # ── 测试 3：GET echostr（微信公众号验签） ──────────────────────────
        print("【测试 3】GET + echostr query → ChannelServer 并入 payload → ChannelClient → ChannelReceiver 返回 echostr")
        _response_factory["body"] = json.dumps({"ok": True})
        _response_factory["status"] = 200
        _response_factory["content_type"] = "application/json"
        received.clear()

        ch3 = await create_proxy_channel(http, token, "e2e-test-get")
        await add_receiver_target(http, token, ch3["id"], RECEIVER_URL)

        stop3 = asyncio.Event()
        task3 = await start_channel_client(token, ch3["id"], stop3)

        echostr_val = "hello_echostr_12345"
        wh3 = (
            f"{CHANNEL_SERVER_URL}/w/{ch3['webhook_secret']}"
            f"?echostr={echostr_val}&signature=abc&timestamp=1234&nonce=xyz"
        )
        info(f"外部调用方 GET → {wh3}")
        info("（ChannelServer 将 query params 并入 payload，ChannelClient 以 POST JSON 转发）")
        t0 = time.monotonic()
        resp3 = await http.get(wh3, timeout=30)
        elapsed = int((time.monotonic() - t0) * 1000)
        info(f"  → HTTP {resp3.status_code} ({elapsed}ms): {resp3.text[:120]}")

        if resp3.status_code == 200: ok("外部调用方收到 200")
        else: fail(f"响应状态码异常: {resp3.status_code}")

        lr3 = await wait_for_receiver(timeout=8)
        if lr3:
            ok(f"ChannelReceiver 收到 POST，body: {lr3['body'][:100]}")
            if lr3.get("echostr") == echostr_val:
                ok(f"ChannelReceiver 从 POST body 提取到 echostr: {echostr_val}")
            else:
                fail(f"echostr 不匹配，body={lr3['body']}")
        else:
            fail("ChannelReceiver 未收到请求")

        if echostr_val in resp3.text:
            ok(f"echostr 原样透传回外部调用方: {resp3.text}")
        else:
            fail(f"外部调用方未收到 echostr: {resp3.text}")

        stop3.set(); task3.cancel()
        with contextlib.suppress(asyncio.CancelledError): await task3
        await delete_channel(http, token, ch3["id"])
        print()

        # ── 测试 4：超时 504（无 ChannelClient 监听） ──────────────────────
        print("【测试 4】无 ChannelClient 监听 → ChannelServer 超时返回 504 Gateway Timeout")
        info("（等待约 25 秒…）")
        received.clear()

        ch4 = await create_proxy_channel(http, token, "e2e-test-timeout")
        wh4 = f"{CHANNEL_SERVER_URL}/w/{ch4['webhook_secret']}"
        info(f"外部调用方 POST → {wh4}（无 ChannelClient 监听）")
        t0 = time.monotonic()
        resp4 = await http.post(wh4, json={"test": "timeout"}, timeout=35)
        elapsed = int((time.monotonic() - t0) * 1000)
        info(f"  → HTTP {resp4.status_code} ({elapsed}ms)")

        if resp4.status_code == 504:
            ok(f"ChannelServer 正确返回 504 Gateway Timeout（{elapsed}ms）")
        else:
            fail(f"预期 504，实际 {resp4.status_code}")

        await delete_channel(http, token, ch4["id"])
        print()

    print("=" * 64)
    print(f"  {PASS} 全部 4 个测试通过！")
    print("=" * 64)
    print()


# ── 主入口 ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    server = start_receiver_server()
    try:
        asyncio.run(run_tests())
    except SystemExit:
        pass
    finally:
        server.shutdown()
