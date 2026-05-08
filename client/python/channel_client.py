"""ChannelClient — 内网穿透代理，连接 ChannelServer 实现 Webhook 转发

架构角色说明
-----------
ChannelServer (公网端)
    运行在云上/有公网 IP 的服务器，接收第三方 Webhook 回调，
    通过 SSE 推送给 ChannelClient，等待回调结果后同步返回给外部调用方。

ChannelClient (本文件，内网端)
    运行在办公室/内网，无公网地址。
    · 主动向 ChannelServer 发起 SSE 长连接（规避防火墙入站拦截）
    · 解析 SSE 事件流，将事件重构为本地 HTTP 请求
    · Proxy 模式：将 ChannelReceiver 的响应回传给 ChannelServer，完成同步透传
    · Mailbox 模式：收到消息后异步转发到 ChannelReceiver，无需等待

ChannelReceiver (本地业务端)
    运行在内网，处理具体业务逻辑（支付回调、告警、自动化等）。
    由 ChannelClient 以普通 HTTP 请求调用。

两种频道模式
-----------
proxy:
    外部 → ChannelServer（挂起请求）→ SSE → ChannelClient → ChannelReceiver
    → ChannelClient 回传结果 → ChannelServer 结束挂起 → 外部收到响应

mailbox:
    外部 → ChannelServer（保存消息，立即返回配置的静态响应）→ SSE →
    ChannelClient → ChannelReceiver（异步，无需等待）
"""
from __future__ import annotations

import asyncio
import argparse
import json
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from dotenv import load_dotenv

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("channel_client")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


# ── Config ────────────────────────────────────────────────────────────────────

@dataclass
class Config:
    """ChannelClient 运行配置，从 .env 文件或环境变量读取。"""
    server_url: str       # ChannelServer 公网地址
    email: str
    password: str
    channel_ids: list[int] = field(default_factory=list)
    receiver_url: str = ""   # 默认 ChannelReceiver 地址
    receiver_method: str = "POST" # 默认 ChannelReceiver 方法
    sync_interval: int = 60

    @classmethod
    def from_env(cls, env_file: str | None = None, server_override: str | None = None) -> "Config":
        env_path = Path(env_file).resolve() if env_file else Path(__file__).resolve().parent / ".env"
        load_dotenv(env_path)

        def _get(key: str, default: str = "") -> str:
            return (os.getenv(key) or default).strip()

        server_url = (server_override or _get("CHANNEL_SERVER_URL")).rstrip("/")
        email      = _get("CHANNEL_EMAIL")
        password   = _get("CHANNEL_PASSWORD")

        if not server_url or not email or not password:
            log.error(
                "以下环境变量为必填项: CHANNEL_SERVER_URL, CHANNEL_EMAIL, CHANNEL_PASSWORD"
            )
            sys.exit(1)

        raw_ids = _get("CHANNEL_IDS")
        channel_ids = [int(x) for x in raw_ids.split(",") if x.strip()] if raw_ids else []

        return cls(
            server_url=server_url,
            email=email,
            password=password,
            channel_ids=channel_ids,
            receiver_url=_get("CHANNEL_RECEIVER_URL").rstrip("/"),
            receiver_method=(_get("CHANNEL_RECEIVER_METHOD") or "POST").upper(),
            sync_interval=int(_get("CHANNEL_SYNC_INTERVAL") or "60"),
        )


# ── ChannelServer API 封装 ─────────────────────────────────────────────────────

class ChannelServerAPI:
    """与 ChannelServer REST API 通信的异步客户端。

    封装登录、频道查询、转发规则同步、消息拉取、
    以及 Proxy 模式下的回调结果提交（ReqID → 回传响应）。
    """

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.token: str = ""
        self.user_id: int = 0
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(30, read=90))

    @property
    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    async def login(self) -> None:
        resp = await self.http.post(
            f"{self.cfg.server_url}/api/auth/login",
            json={"email": self.cfg.email, "password": self.cfg.password},
        )
        if resp.status_code == 401:
            log.error("[ChannelClient] 登录失败：邮箱或密码错误")
            sys.exit(1)
        resp.raise_for_status()
        data = resp.json()
        self.token = data["access_token"]
        self.user_id = data["user_id"]
        log.info("[ChannelClient] 已登录 ChannelServer，账号=%s", data["email"])

    async def list_channels(self) -> list[dict]:
        resp = await self.http.get(
            f"{self.cfg.server_url}/api/channels", headers=self._auth
        )
        resp.raise_for_status()
        return resp.json()["channels"]

    async def get_receiver_targets(self, channel_id: int) -> list[dict]:
        """从 ChannelServer 拉取该频道配置的 ChannelReceiver 地址列表。"""
        resp = await self.http.get(
            f"{self.cfg.server_url}/api/channels/{channel_id}/forwards",
            headers=self._auth,
        )
        resp.raise_for_status()
        return resp.json()["forwards"]

    async def ack_mailbox_message(self, channel_id: int) -> None:
        """Mailbox 模式：将最早一条未读消息标为已读。"""
        await self.http.get(
            f"{self.cfg.server_url}/api/channels/{channel_id}/messages/pull",
            params={"limit": "1"},
            headers=self._auth,
        )

    async def submit_proxy_result(
        self,
        channel_id: int,
        req_id: int,
        body: str,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Proxy 模式 步骤5：把 ChannelReceiver 的结果回传给 ChannelServer。

        ChannelServer 凭 req_id 找到正在挂起的外部请求并解除挂起，
        将此结果作为响应同步返回给外部调用方（步骤6）。
        """
        payload: dict = {"body": body, "status": status}
        if headers:
            payload["headers"] = headers
        resp = await self.http.post(
            f"{self.cfg.server_url}/api/channels/{channel_id}/proxy-response/{req_id}",
            json=payload,
            headers=self._auth,
        )
        resp.raise_for_status()

    async def close(self) -> None:
        await self.http.aclose()


# ── SSE 解析器 ────────────────────────────────────────────────────────────────

@dataclass
class SSEEvent:
    event: str = "message"
    data: str = ""
    id: str = ""


async def _parse_sse(resp: httpx.Response):
    """从 httpx 流式响应中逐事件 yield SSEEvent。"""
    current = SSEEvent()
    async for raw_line in resp.aiter_lines():
        line = raw_line.rstrip("\n")

        if not line:
            if current.data:
                yield current
            current = SSEEvent()
            continue

        if line.startswith(":"):  # keepalive/comment
            continue

        if ":" in line:
            fld, _, value = line.partition(":")
            value = value.lstrip(" ")
        else:
            fld, value = line, ""

        if fld == "event":
            current.event = value
        elif fld == "data":
            current.data = value if not current.data else f"{current.data}\n{value}"
        elif fld == "id":
            current.id = value


# ── ChannelReceiver 转发工具函数 ──────────────────────────────────────────────

# ChannelServer 存储时过滤掉了 authorization/cookie/host；
# ChannelClient 转发到 ChannelReceiver 时还需屏蔽以下 Cloudflare 内部头。
_SKIP_HEADERS = frozenset({
    "host", "content-length", "transfer-encoding", "connection",
    "keep-alive", "upgrade", "cf-connecting-ip", "cf-ipcountry",
    "cf-ray", "cf-visitor", "cdn-loop", "x-forwarded-for",
    "x-forwarded-proto", "x-real-ip",
})


@dataclass
class ReceiverResult:
    """ChannelReceiver 的响应结果，供 Proxy 模式回传给 ChannelServer。"""
    ok: bool
    body: str
    status_code: int
    headers: dict[str, str] = field(default_factory=dict)


def _build_request_body(
    payload: dict,
    original_headers: dict[str, str] | None,
) -> tuple[str, str]:
    """根据 payload 类型决定发往 ChannelReceiver 的 body 和 Content-Type。

    ChannelServer 在接收非 JSON 请求（XML、表单等）时，会将原始 body
    存入 payload["_raw"]，Content-Type 保存在 headers 中。
    ChannelClient 在转发时需还原这两个信息，确保 ChannelReceiver
    收到的是与外部调用方原始发送一致的格式。
    """
    if isinstance(payload, dict) and "_raw" in payload:
        ct = "application/octet-stream"
        if original_headers:
            ct = original_headers.get("content-type", ct)
        return str(payload["_raw"]), ct
    return json.dumps(payload), "application/json"


def _build_forward_headers(
    original_headers: dict[str, str] | None,
    content_type: str,
    channel_id: int,
    req_id: str,
    extra_headers: dict[str, str],
) -> dict[str, str]:
    """构建发往 ChannelReceiver 的请求头。

    透传原始签名类 header（如 Wechatpay-Signature），
    过滤掉基础设施层的 header，并追加 LinkedBot 标识。
    """
    headers: dict[str, str] = {}
    if original_headers:
        for k, v in original_headers.items():
            if k.lower() not in _SKIP_HEADERS:
                headers[k] = v
    headers["Content-Type"] = content_type
    headers["X-LinkedBot-Channel-Id"] = str(channel_id)
    headers["X-LinkedBot-Request-Id"] = str(req_id)
    headers.update(extra_headers)
    return headers


async def _call_receiver(
    http: httpx.AsyncClient,
    target: dict,
    payload: dict,
    channel_id: int,
    req_id: str,
    original_headers: dict[str, str] | None = None,
) -> ReceiverResult:
    """步骤3/4：向 ChannelReceiver 发起 HTTP 请求并获取结果。"""
    url = target.get("url", "")
    method = (target.get("method") or "POST").upper()

    extra: dict = {}
    raw_extra = target.get("extra_headers_json")
    if raw_extra:
        try:
            extra = json.loads(raw_extra) if isinstance(raw_extra, str) else raw_extra
        except Exception:
            pass

    body_str, ct = _build_request_body(payload, original_headers)
    headers = _build_forward_headers(original_headers, ct, channel_id, req_id, extra)

    kwargs = {"headers": headers, "timeout": 15}
    if method == "GET":
        if isinstance(payload, dict):
            # Flatten payload to strings for query params
            kwargs["params"] = {k: (v if isinstance(v, str) else json.dumps(v) if isinstance(v, (dict, list)) else str(v)) for k, v in payload.items()}
    else:
        kwargs["content"] = body_str

    t0 = time.monotonic()
    try:
        resp = await http.request(method, url, **kwargs)
        elapsed = int((time.monotonic() - t0) * 1000)
        resp_body = resp.text
        resp_hdrs = {
            k: v for k, v in resp.headers.items()
            if k.lower() not in ("transfer-encoding", "connection")
        }
        level = log.info if resp.is_success else log.warning
        level(
            "[ChannelClient] ReqID=%s → %s %s [HTTP %d, %dms]",
            req_id, method, url, resp.status_code, elapsed,
        )
        return ReceiverResult(resp.is_success, resp_body, resp.status_code, resp_hdrs)
    except Exception as exc:
        elapsed = int((time.monotonic() - t0) * 1000)
        log.warning(
            "[ChannelClient] ReqID=%s → %s %s 连接失败: %s (%dms)",
            req_id, method, url, exc, elapsed,
        )
        return ReceiverResult(False, str(exc), 502)


# ── ChannelClient：单频道 SSE 代理 ────────────────────────────────────────────

class ChannelClient:
    """负责单个频道的 SSE 监听与本地转发。

    对应架构图中的 ChannelClient 角色：
    - 主动向 ChannelServer 建立 SSE 长连接
    - 解析 proxy_request / message 两类事件
    - Proxy 模式：收到事件 → 调用 ChannelReceiver → 回传结果给 ChannelServer
    - Mailbox 模式：收到事件 → 调用 ChannelReceiver（异步，无需等待结果回传）
    """

    def __init__(self, api: ChannelServerAPI, channel: dict) -> None:
        self.api = api
        self.channel_id: int = channel["id"]
        self.channel_name: str = channel["name"]
        self.mode: str = channel.get("mode", "mailbox")
        # SSE 游标，用于断线重连后续取
        self._since: int = 0          # mailbox message cursor
        self._proxy_since: int = 0    # proxy request cursor
        # ChannelReceiver 地址列表（从 ChannelServer 同步）
        self._receivers: list[dict] = []
        self.stats_ok: int = 0
        self.stats_fail: int = 0

    async def _sync_receivers(self) -> None:
        """从 ChannelServer 同步 ChannelReceiver 地址列表。"""
        try:
            targets = await self.api.get_receiver_targets(self.channel_id)
            enabled = [t for t in targets if t.get("enabled", 1)]
            if enabled:
                self._receivers = enabled
                urls = ", ".join(t["url"] for t in enabled)
                log.info(
                    "[ChannelClient] 频道#%d 已同步 %d 个 ChannelReceiver: %s",
                    self.channel_id, len(enabled), urls,
                )
            elif self.api.cfg.receiver_url:
                self._receivers = [{"url": self.api.cfg.receiver_url, "method": self.api.cfg.receiver_method}]
                log.info(
                    "[ChannelClient] 频道#%d 使用默认 ChannelReceiver: %s",
                    self.channel_id, self.api.cfg.receiver_url,
                )
            else:
                self._receivers = []
                log.warning("[ChannelClient] 频道#%d 未配置 ChannelReceiver", self.channel_id)
        except Exception as exc:
            log.warning("[ChannelClient] 频道#%d 同步 ChannelReceiver 失败: %s", self.channel_id, exc)

    # ── Mailbox 模式处理 ──────────────────────────────────────────────────────

    async def _on_mailbox_message(self, message: dict) -> None:
        """步骤2→3→4：收到 mailbox message 事件，转发至 ChannelReceiver。"""
        if not self._receivers:
            self.stats_fail += 1
            return

        original_headers = message.get("headers")
        all_ok = True

        for target in self._receivers:
            result = await _call_receiver(
                self.api.http, target, message.get("payload", message),
                self.channel_id, str(message.get("id", "")),
                original_headers=original_headers,
            )
            if not result.ok:
                all_ok = False

        if all_ok:
            try:
                await self.api.ack_mailbox_message(self.channel_id)
                log.info(
                    "[ChannelClient] 频道#%d 消息#%s 已标为已读",
                    self.channel_id, message.get("id"),
                )
            except Exception as exc:
                log.warning(
                    "[ChannelClient] 频道#%d 消息#%s 标读失败: %s",
                    self.channel_id, message.get("id"), exc,
                )
            self.stats_ok += 1
        else:
            self.stats_fail += 1

    # ── Proxy 模式处理 ────────────────────────────────────────────────────────

    async def _on_proxy_request(self, pr: dict) -> None:
        """步骤2→3→4→5：收到 proxy_request 事件，转发并回传结果给 ChannelServer。

        流程：
        1. ChannelServer 已生成 ReqID，外部请求被挂起
        2. SSE 推送 proxy_request 事件（本方法被调用）
        3. 调用 ChannelReceiver
        4. ChannelReceiver 返回结果
        5. 提交结果到 ChannelServer（submit_proxy_result）
        6. ChannelServer 解除挂起，将结果同步返回给外部调用方
        """
        req_id: int = pr.get("request_id", 0)
        original_headers = pr.get("headers")

        if not self._receivers:
            log.warning(
                "[ChannelClient] 频道#%d ReqID=%d：无 ChannelReceiver，返回 502",
                self.channel_id, req_id,
            )
            try:
                await self.api.submit_proxy_result(
                    self.channel_id, req_id,
                    body='{"error":"no_receiver_configured"}', status=502,
                )
            except Exception as exc:
                log.warning("[ChannelClient] 回传 502 失败: %s", exc)
            self.stats_fail += 1
            return

        # Proxy 模式只使用第一个 ChannelReceiver（需要唯一的同步响应）
        target = self._receivers[0]
        result = await _call_receiver(
            self.api.http, target, pr.get("payload", pr),
            self.channel_id, str(req_id),
            original_headers=original_headers,
        )

        # 步骤5：将 ChannelReceiver 的响应回传给 ChannelServer
        try:
            await self.api.submit_proxy_result(
                self.channel_id, req_id,
                body=result.body, status=result.status_code,
                headers=result.headers if result.headers else None,
            )
            log.info(
                "[ChannelClient] 频道#%d ReqID=%d 结果已回传 ChannelServer (HTTP %d)",
                self.channel_id, req_id, result.status_code,
            )
        except Exception as exc:
            log.warning(
                "[ChannelClient] 频道#%d ReqID=%d 回传失败: %s",
                self.channel_id, req_id, exc,
            )

        if result.ok:
            self.stats_ok += 1
        else:
            self.stats_fail += 1

    # ── SSE 主循环 ────────────────────────────────────────────────────────────

    async def run(self, stop: asyncio.Event) -> None:
        """主动向 ChannelServer 建立 SSE 长连接并持续监听。

        - 使用指数退避自动重连
        - 断线重连时通过 since/proxy_since 游标续取，避免重复处理
        - 定期（sync_interval）重新同步 ChannelReceiver 配置
        """
        backoff = 1.0
        sync_deadline = 0.0

        while not stop.is_set():
            now = time.monotonic()
            if now >= sync_deadline:
                await self._sync_receivers()
                sync_deadline = now + self.api.cfg.sync_interval

            sse_url = (
                f"{self.api.cfg.server_url}/api/channels/{self.channel_id}"
                f"/messages/stream?since={self._since}&proxy_since={self._proxy_since}"
            )
            log.info(
                "[ChannelClient] 频道#%d SSE 连接中 (since=%d, proxy_since=%d, mode=%s)...",
                self.channel_id, self._since, self._proxy_since, self.mode,
            )

            try:
                async with self.api.http.stream(
                    "GET", sse_url, headers=self.api._auth
                ) as resp:
                    if resp.status_code == 401:
                        log.warning("[ChannelClient] SSE 401，重新登录...")
                        await self.api.login()
                        continue
                    resp.raise_for_status()
                    log.info("[ChannelClient] 频道#%d SSE 已连接", self.channel_id)
                    backoff = 1.0

                    async for evt in _parse_sse(resp):
                        if stop.is_set():
                            break

                        if evt.event == "proxy_request" and evt.data:
                            try:
                                pr = json.loads(evt.data)
                            except json.JSONDecodeError:
                                continue
                            if evt.id and evt.id.startswith("p"):
                                self._proxy_since = max(
                                    self._proxy_since, int(evt.id[1:])
                                )
                            await self._on_proxy_request(pr)

                        elif evt.event == "message" and evt.data:
                            try:
                                msg = json.loads(evt.data)
                            except json.JSONDecodeError:
                                continue
                            if evt.id:
                                try:
                                    self._since = max(self._since, int(evt.id))
                                except ValueError:
                                    pass
                            await self._on_mailbox_message(msg)

                        elif evt.event == "reconnect":
                            break
                        # "skip" 事件：ChannelServer 跳过了损坏记录，只需推进游标
                        elif evt.event == "skip":
                            pass

            except httpx.HTTPStatusError as exc:
                log.warning("[ChannelClient] 频道#%d SSE HTTP 错误: %s", self.channel_id, exc)
            except (httpx.ReadError, httpx.RemoteProtocolError, httpx.ReadTimeout):
                pass
            except Exception as exc:
                log.warning("[ChannelClient] 频道#%d SSE 异常: %s", self.channel_id, exc)

            if not stop.is_set():
                log.info(
                    "[ChannelClient] 频道#%d SSE 断开，%.0fs 后重连...",
                    self.channel_id, backoff,
                )
                try:
                    await asyncio.wait_for(stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 30.0)


# ── 主入口 ────────────────────────────────────────────────────────────────────

async def main() -> None:
    parser = argparse.ArgumentParser(description="ChannelClient - Webhook 转发内网端")
    parser.add_argument("-c", "--config", help="指定配置文件 (.env) 路径")
    parser.add_argument("-s", "--server", help="指定服务端地址 (覆盖配置中的 CHANNEL_SERVER_URL)")
    args = parser.parse_args()

    cfg = Config.from_env(env_file=args.config, server_override=args.server)
    api = ChannelServerAPI(cfg)
    await api.login()

    all_channels = await api.list_channels()
    if cfg.channel_ids:
        allowed = set(cfg.channel_ids)
        channels = [ch for ch in all_channels if ch["id"] in allowed]
    else:
        channels = all_channels

    if not channels:
        log.error("[ChannelClient] 未找到频道，请先在 ChannelServer 上创建频道")
        await api.close()
        return

    names = ", ".join(
        f'{ch["name"]} (#{ch["id"]}, {ch.get("mode", "mailbox")})'
        for ch in channels
    )
    log.info("[ChannelClient] 监听 %d 个频道: %s", len(channels), names)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _on_signal() -> None:
        log.info("[ChannelClient] 收到退出信号，正在关闭...")
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _on_signal)
        except NotImplementedError:
            pass

    clients = [ChannelClient(api, ch) for ch in channels]
    tasks = [asyncio.create_task(c.run(stop)) for c in clients]
    await asyncio.gather(*tasks, return_exceptions=True)

    total_ok   = sum(c.stats_ok   for c in clients)
    total_fail = sum(c.stats_fail for c in clients)
    log.info("[ChannelClient] 退出。成功转发: %d，失败: %d", total_ok, total_fail)
    await api.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
