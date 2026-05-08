//! ChannelClient — 内网穿透代理，连接 ChannelServer 实现 Webhook 转发
//!
//! # 架构角色
//!
//! ```text
//! ChannelServer (公网端)
//!   接收第三方 Webhook → SSE 推送给 ChannelClient
//!
//! ChannelClient (本程序，内网端)
//!   主动建立 SSE 长连接 → 解析事件 → 转发到 ChannelReceiver
//!
//! ChannelReceiver (本地业务端)
//!   处理支付回调、告警、自动化等具体业务
//! ```
//!
//! # 两种频道模式
//!
//! - **proxy**: 同步透传，ChannelServer 挂起外部请求，等待 ChannelClient 回传结果
//! - **mailbox**: 异步投递，ChannelServer 立即返回静态响应，消息异步推送给 ChannelClient
//!
//! # 运行
//!
//! ```bash
//! cp .env.example .env  # 填写配置
//! cargo run
//! # 或指定配置文件和服务端地址
//! cargo run -- --config /path/to/.env --server https://your-server.example.com
//! ```

mod sse;

use anyhow::{Context, Result};
use clap::Parser;
use dotenvy::dotenv_override;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{signal, sync::watch, time::sleep};
use tracing::{error, info, warn};

// ── CLI ───────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "channel-client", about = "ChannelClient - Webhook 转发内网端")]
struct Cli {
    /// 指定配置文件 (.env) 路径
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// 指定服务端地址 (覆盖配置中的 CHANNEL_SERVER_URL)
    #[arg(short, long)]
    server: Option<String>,
}

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Config {
    server_url: String,
    email: String,
    password: String,
    channel_ids: Vec<u64>,
    receiver_url: String,
    receiver_method: String,
    sync_interval: u64,
}

impl Config {
    fn from_env(cli: &Cli) -> Result<Self> {
        // 加载 .env 文件（若指定了路径则优先使用）
        if let Some(path) = &cli.config {
            dotenvy::from_path_override(path)
                .with_context(|| format!("无法加载配置文件: {}", path.display()))?;
        } else {
            let _ = dotenv_override(); // 忽略文件不存在的错误
        }

        let server_url = cli
            .server
            .clone()
            .or_else(|| env::var("CHANNEL_SERVER_URL").ok())
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();

        let email = env::var("CHANNEL_EMAIL").unwrap_or_default();
        let password = env::var("CHANNEL_PASSWORD").unwrap_or_default();

        if server_url.is_empty() || email.is_empty() || password.is_empty() {
            anyhow::bail!(
                "以下环境变量为必填项: CHANNEL_SERVER_URL, CHANNEL_EMAIL, CHANNEL_PASSWORD"
            );
        }

        let channel_ids = env::var("CHANNEL_IDS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| s.trim().parse::<u64>().ok())
            .collect();

        let receiver_url = env::var("CHANNEL_RECEIVER_URL")
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();

        let receiver_method = env::var("CHANNEL_RECEIVER_METHOD")
            .unwrap_or_else(|_| "POST".to_string())
            .to_uppercase();

        let sync_interval = env::var("CHANNEL_SYNC_INTERVAL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60u64);

        Ok(Config {
            server_url,
            email,
            password,
            channel_ids,
            receiver_url,
            receiver_method,
            sync_interval,
        })
    }
}

// ── ChannelServer API ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LoginResp {
    access_token: String,
    user_id: u64,
    email: String,
}

#[derive(Debug, Deserialize, Clone)]
struct Channel {
    id: u64,
    name: String,
    #[serde(default)]
    mode: String,
}

#[derive(Debug, Deserialize, Clone)]
struct ForwardTarget {
    url: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    enabled: Option<i32>,
    #[serde(default)]
    extra_headers_json: Option<String>,
}

#[derive(Clone)]
struct Api {
    cfg: Config,
    client: Client,
    token: Arc<tokio::sync::RwLock<String>>,
}

impl Api {
    fn new(cfg: Config) -> Self {
        Self {
            cfg,
            client: Client::builder()
                .timeout(Duration::from_secs(90))
                .build()
                .expect("HTTP client build failed"),
            token: Arc::new(tokio::sync::RwLock::new(String::new())),
        }
    }

    async fn auth_header(&self) -> String {
        format!("Bearer {}", self.token.read().await)
    }

    async fn login(&self) -> Result<()> {
        #[derive(Serialize)]
        struct Req<'a> {
            email: &'a str,
            password: &'a str,
        }
        let resp = self
            .client
            .post(format!("{}/api/auth/login", self.cfg.server_url))
            .json(&Req {
                email: &self.cfg.email,
                password: &self.cfg.password,
            })
            .send()
            .await?;

        if resp.status().as_u16() == 401 {
            anyhow::bail!("[ChannelClient] 登录失败：邮箱或密码错误");
        }
        resp.error_for_status_ref()?;
        let data: LoginResp = resp.json().await?;
        *self.token.write().await = data.access_token;
        info!(
            "[ChannelClient] 已登录 ChannelServer，账号={} user_id={}",
            data.email, data.user_id
        );
        Ok(())
    }

    async fn list_channels(&self) -> Result<Vec<Channel>> {
        let resp = self
            .client
            .get(format!("{}/api/channels", self.cfg.server_url))
            .header("Authorization", self.auth_header().await)
            .send()
            .await?
            .error_for_status()?;
        let v: Value = resp.json().await?;
        let channels: Vec<Channel> = serde_json::from_value(v["channels"].clone())?;
        Ok(channels)
    }

    async fn get_forward_targets(&self, channel_id: u64) -> Result<Vec<ForwardTarget>> {
        let resp = self
            .client
            .get(format!(
                "{}/api/channels/{}/forwards",
                self.cfg.server_url, channel_id
            ))
            .header("Authorization", self.auth_header().await)
            .send()
            .await?
            .error_for_status()?;
        let v: Value = resp.json().await?;
        let targets: Vec<ForwardTarget> = serde_json::from_value(v["forwards"].clone())?;
        Ok(targets)
    }

    async fn ack_mailbox_message(&self, channel_id: u64) -> Result<()> {
        self.client
            .get(format!(
                "{}/api/channels/{}/messages/pull",
                self.cfg.server_url, channel_id
            ))
            .query(&[("limit", "1")])
            .header("Authorization", self.auth_header().await)
            .send()
            .await?;
        Ok(())
    }

    async fn submit_proxy_result(
        &self,
        channel_id: u64,
        req_id: u64,
        body: &str,
        status: u16,
        headers: Option<HashMap<String, String>>,
    ) -> Result<()> {
        let mut payload = serde_json::json!({ "body": body, "status": status });
        if let Some(h) = headers {
            payload["headers"] = serde_json::to_value(h)?;
        }
        self.client
            .post(format!(
                "{}/api/channels/{}/proxy-response/{}",
                self.cfg.server_url, channel_id, req_id
            ))
            .header("Authorization", self.auth_header().await)
            .json(&payload)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}

// ── ChannelReceiver 转发 ──────────────────────────────────────────────────────

const SKIP_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cdn-loop",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-real-ip",
];

struct ReceiverResult {
    ok: bool,
    body: String,
    status: u16,
    headers: HashMap<String, String>,
}

async fn call_receiver(
    client: &Client,
    target: &ForwardTarget,
    payload: &Value,
    channel_id: u64,
    req_id: &str,
    original_headers: Option<&HashMap<String, String>>,
) -> ReceiverResult {
    let url = &target.url;
    let method = if target.method.is_empty() {
        "POST"
    } else {
        &target.method
    };

    // 构建请求头
    let mut req_headers = HashMap::new();
    if let Some(oh) = original_headers {
        for (k, v) in oh {
            if !SKIP_HEADERS.contains(&k.to_lowercase().as_str()) {
                req_headers.insert(k.clone(), v.clone());
            }
        }
    }

    // 解析 extra_headers_json
    if let Some(raw) = &target.extra_headers_json {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) {
            for (k, v) in map {
                if let Value::String(s) = v {
                    req_headers.insert(k, s);
                }
            }
        }
    }

    req_headers.insert("X-LinkedBot-Channel-Id".to_string(), channel_id.to_string());
    req_headers.insert("X-LinkedBot-Request-Id".to_string(), req_id.to_string());

    // 判断 body / content-type
    let (body_str, ct) = if payload.get("_raw").is_some() {
        let ct = original_headers
            .and_then(|h| h.get("content-type"))
            .cloned()
            .unwrap_or_else(|| "application/octet-stream".to_string());
        (payload["_raw"].as_str().unwrap_or("").to_string(), ct)
    } else {
        (payload.to_string(), "application/json".to_string())
    };
    req_headers.insert("Content-Type".to_string(), ct);

    let t0 = Instant::now();
    let mut builder = client.request(
        method.parse().unwrap_or(reqwest::Method::POST),
        url,
    );
    for (k, v) in &req_headers {
        builder = builder.header(k, v);
    }

    let builder = if method.eq_ignore_ascii_case("GET") {
        // GET：将 payload 展平为查询参数
        if let Value::Object(map) = payload {
            let params: Vec<(String, String)> = map
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        match v {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        },
                    )
                })
                .collect();
            builder.query(&params)
        } else {
            builder
        }
    } else {
        builder.body(body_str)
    };

    match builder.send().await {
        Ok(resp) => {
            let elapsed = t0.elapsed().as_millis();
            let status = resp.status().as_u16();
            let ok = resp.status().is_success();
            let resp_headers: HashMap<String, String> = resp
                .headers()
                .iter()
                .filter(|(k, _)| {
                    !["transfer-encoding", "connection"]
                        .contains(&k.as_str().to_lowercase().as_str())
                })
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let body = resp.text().await.unwrap_or_default();
            if ok {
                info!(
                    "[ChannelClient] ReqID={} → {} {} [HTTP {}, {}ms]",
                    req_id, method, url, status, elapsed
                );
            } else {
                warn!(
                    "[ChannelClient] ReqID={} → {} {} [HTTP {}, {}ms]",
                    req_id, method, url, status, elapsed
                );
            }
            ReceiverResult { ok, body, status, headers: resp_headers }
        }
        Err(e) => {
            let elapsed = t0.elapsed().as_millis();
            warn!(
                "[ChannelClient] ReqID={} → {} {} 连接失败: {} ({}ms)",
                req_id, method, url, e, elapsed
            );
            ReceiverResult {
                ok: false,
                body: e.to_string(),
                status: 502,
                headers: HashMap::new(),
            }
        }
    }
}

// ── ChannelClient：单频道 SSE 代理 ────────────────────────────────────────────

struct ChannelWorker {
    api: Api,
    channel: Channel,
    since: u64,
    proxy_since: u64,
    receivers: Vec<ForwardTarget>,
    stats_ok: u64,
    stats_fail: u64,
}

impl ChannelWorker {
    fn new(api: Api, channel: Channel) -> Self {
        Self {
            api,
            channel,
            since: 0,
            proxy_since: 0,
            receivers: Vec::new(),
            stats_ok: 0,
            stats_fail: 0,
        }
    }

    async fn sync_receivers(&mut self) {
        match self.api.get_forward_targets(self.channel.id).await {
            Ok(targets) => {
                let enabled: Vec<ForwardTarget> = targets
                    .into_iter()
                    .filter(|t| t.enabled.unwrap_or(1) != 0)
                    .collect();
                if !enabled.is_empty() {
                    let urls: Vec<_> = enabled.iter().map(|t| t.url.as_str()).collect();
                    info!(
                        "[ChannelClient] 频道#{} 已同步 {} 个 ChannelReceiver: {}",
                        self.channel.id,
                        enabled.len(),
                        urls.join(", ")
                    );
                    self.receivers = enabled;
                } else if !self.api.cfg.receiver_url.is_empty() {
                    info!(
                        "[ChannelClient] 频道#{} 使用默认 ChannelReceiver: {}",
                        self.channel.id, self.api.cfg.receiver_url
                    );
                    self.receivers = vec![ForwardTarget {
                        url: self.api.cfg.receiver_url.clone(),
                        method: self.api.cfg.receiver_method.clone(),
                        enabled: Some(1),
                        extra_headers_json: None,
                    }];
                } else {
                    warn!(
                        "[ChannelClient] 频道#{} 未配置 ChannelReceiver",
                        self.channel.id
                    );
                    self.receivers = Vec::new();
                }
            }
            Err(e) => warn!(
                "[ChannelClient] 频道#{} 同步 ChannelReceiver 失败: {}",
                self.channel.id, e
            ),
        }
    }

    async fn on_mailbox_message(&mut self, message: &Value) {
        if self.receivers.is_empty() {
            self.stats_fail += 1;
            return;
        }
        let original_headers: Option<HashMap<String, String>> = message
            .get("headers")
            .and_then(|h| serde_json::from_value(h.clone()).ok());
        let payload = message.get("payload").unwrap_or(message);
        let msg_id = message
            .get("id")
            .and_then(|v| v.as_u64())
            .map(|v| v.to_string())
            .unwrap_or_default();

        let mut all_ok = true;
        for target in &self.receivers.clone() {
            let result = call_receiver(
                &self.api.client,
                target,
                payload,
                self.channel.id,
                &msg_id,
                original_headers.as_ref(),
            )
            .await;
            if !result.ok {
                all_ok = false;
            }
        }

        if all_ok {
            if let Err(e) = self.api.ack_mailbox_message(self.channel.id).await {
                warn!(
                    "[ChannelClient] 频道#{} 消息#{} 标读失败: {}",
                    self.channel.id, msg_id, e
                );
            } else {
                info!(
                    "[ChannelClient] 频道#{} 消息#{} 已标为已读",
                    self.channel.id, msg_id
                );
            }
            self.stats_ok += 1;
        } else {
            self.stats_fail += 1;
        }
    }

    async fn on_proxy_request(&mut self, pr: &Value) {
        let req_id = pr.get("request_id").and_then(|v| v.as_u64()).unwrap_or(0);
        let original_headers: Option<HashMap<String, String>> = pr
            .get("headers")
            .and_then(|h| serde_json::from_value(h.clone()).ok());

        if self.receivers.is_empty() {
            warn!(
                "[ChannelClient] 频道#{} ReqID={}：无 ChannelReceiver，返回 502",
                self.channel.id, req_id
            );
            let _ = self
                .api
                .submit_proxy_result(
                    self.channel.id,
                    req_id,
                    r#"{"error":"no_receiver_configured"}"#,
                    502,
                    None,
                )
                .await;
            self.stats_fail += 1;
            return;
        }

        let target = self.receivers[0].clone();
        let payload = pr.get("payload").unwrap_or(pr);
        let result = call_receiver(
            &self.api.client,
            &target,
            payload,
            self.channel.id,
            &req_id.to_string(),
            original_headers.as_ref(),
        )
        .await;

        match self
            .api
            .submit_proxy_result(
                self.channel.id,
                req_id,
                &result.body,
                result.status,
                if result.headers.is_empty() {
                    None
                } else {
                    Some(result.headers)
                },
            )
            .await
        {
            Ok(_) => info!(
                "[ChannelClient] 频道#{} ReqID={} 结果已回传 ChannelServer (HTTP {})",
                self.channel.id, req_id, result.status
            ),
            Err(e) => warn!(
                "[ChannelClient] 频道#{} ReqID={} 回传失败: {}",
                self.channel.id, req_id, e
            ),
        }

        if result.ok {
            self.stats_ok += 1;
        } else {
            self.stats_fail += 1;
        }
    }

    async fn run(mut self, mut stop_rx: watch::Receiver<bool>) {
        let mut backoff = Duration::from_secs(1);
        let mut next_sync = Instant::now();

        loop {
            if *stop_rx.borrow() {
                break;
            }

            if Instant::now() >= next_sync {
                self.sync_receivers().await;
                next_sync = Instant::now()
                    + Duration::from_secs(self.api.cfg.sync_interval);
            }

            let sse_url = format!(
                "{}/api/channels/{}/messages/stream?since={}&proxy_since={}",
                self.api.cfg.server_url, self.channel.id, self.since, self.proxy_since
            );
            info!(
                "[ChannelClient] 频道#{} SSE 连接中 (since={}, proxy_since={}, mode={})...",
                self.channel.id, self.since, self.proxy_since, self.channel.mode
            );

            let auth = self.api.auth_header().await;
            let req = self
                .api
                .client
                .get(&sse_url)
                .header("Authorization", auth)
                .header("Accept", "text/event-stream");

            match req.send().await {
                Ok(resp) if resp.status().as_u16() == 401 => {
                    warn!("[ChannelClient] SSE 401，重新登录...");
                    let _ = self.api.login().await;
                    continue;
                }
                Ok(resp) if !resp.status().is_success() => {
                    warn!(
                        "[ChannelClient] 频道#{} SSE HTTP 错误: {}",
                        self.channel.id,
                        resp.status()
                    );
                }
                Ok(resp) => {
                    info!("[ChannelClient] 频道#{} SSE 已连接", self.channel.id);
                    backoff = Duration::from_secs(1);

                    let mut stream = resp.bytes_stream();
                    let mut current = sse::SseEvent::default();
                    let mut buf = String::new();

                    'stream: loop {
                        tokio::select! {
                            chunk = stream.next() => {
                                match chunk {
                                    None => break 'stream,
                                    Some(Err(e)) => {
                                        warn!("[ChannelClient] 频道#{} 流读取错误: {}", self.channel.id, e);
                                        break 'stream;
                                    }
                                    Some(Ok(bytes)) => {
                                        buf.push_str(&String::from_utf8_lossy(&bytes));
                                        let mut events = Vec::new();
                                        while let Some(pos) = buf.find('\n') {
                                            let line = buf[..pos].to_string();
                                            buf.drain(..=pos);
                                            sse::feed_line(&line, &mut current, &mut events);
                                        }
                                        for evt in events {
                                            if *stop_rx.borrow() { break 'stream; }
                                            match evt.event.as_str() {
                                                "proxy_request" if !evt.data.is_empty() => {
                                                    if let Ok(pr) = serde_json::from_str::<Value>(&evt.data) {
                                                        if evt.id.starts_with('p') {
                                                            if let Ok(n) = evt.id[1..].parse::<u64>() {
                                                                self.proxy_since = self.proxy_since.max(n);
                                                            }
                                                        }
                                                        self.on_proxy_request(&pr).await;
                                                    }
                                                }
                                                "message" if !evt.data.is_empty() => {
                                                    if let Ok(msg) = serde_json::from_str::<Value>(&evt.data) {
                                                        if let Ok(n) = evt.id.parse::<u64>() {
                                                            self.since = self.since.max(n);
                                                        }
                                                        self.on_mailbox_message(&msg).await;
                                                    }
                                                }
                                                "reconnect" => break 'stream,
                                                _ => {}
                                            }
                                        }
                                    }
                                }
                            }
                            _ = stop_rx.changed() => {
                                if *stop_rx.borrow() { break 'stream; }
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!(
                        "[ChannelClient] 频道#{} SSE 连接失败: {}",
                        self.channel.id, e
                    );
                }
            }

            if *stop_rx.borrow() {
                break;
            }

            info!(
                "[ChannelClient] 频道#{} SSE 断开，{:.0}s 后重连...",
                self.channel.id,
                backoff.as_secs_f32()
            );
            tokio::select! {
                _ = sleep(backoff) => {}
                _ = stop_rx.changed() => {}
            }
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }

        info!(
            "[ChannelClient] 频道#{} 已退出。成功: {}，失败: {}",
            self.channel.id, self.stats_ok, self.stats_fail
        );
    }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_target(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    let cfg = Config::from_env(&cli)?;
    let api = Api::new(cfg.clone());

    api.login().await?;

    let all_channels = api.list_channels().await?;
    let channels: Vec<Channel> = if cfg.channel_ids.is_empty() {
        all_channels
    } else {
        let allowed: std::collections::HashSet<u64> =
            cfg.channel_ids.iter().cloned().collect();
        all_channels
            .into_iter()
            .filter(|ch| allowed.contains(&ch.id))
            .collect()
    };

    if channels.is_empty() {
        error!("[ChannelClient] 未找到频道，请先在 ChannelServer 上创建频道");
        return Ok(());
    }

    let names: Vec<String> = channels
        .iter()
        .map(|ch| {
            format!(
                "{} (#{}, {})",
                ch.name,
                ch.id,
                if ch.mode.is_empty() { "mailbox" } else { &ch.mode }
            )
        })
        .collect();
    info!(
        "[ChannelClient] 监听 {} 个频道: {}",
        channels.len(),
        names.join(", ")
    );

    let (stop_tx, stop_rx) = watch::channel(false);

    // 处理 Ctrl-C / SIGTERM
    tokio::spawn(async move {
        let _ = signal::ctrl_c().await;
        info!("[ChannelClient] 收到退出信号，正在关闭...");
        let _ = stop_tx.send(true);
    });

    let mut handles = Vec::new();
    for channel in channels {
        let worker = ChannelWorker::new(api.clone(), channel);
        let rx = stop_rx.clone();
        handles.push(tokio::spawn(async move { worker.run(rx).await }));
    }

    for h in handles {
        let _ = h.await;
    }

    info!("[ChannelClient] 所有频道已退出");
    Ok(())
}
